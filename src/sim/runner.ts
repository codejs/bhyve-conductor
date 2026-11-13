import { MemoryAuditLog, teeAudit, type AuditEvent } from '../audit/audit.ts';
import { VirtualClock } from '../clock.ts';
import { parseConductorConfig, type ConductorConfig } from '../conductor/config.ts';
import { WateringHistory } from '../conductor/history.ts';
import { Monitor } from '../conductor/monitor.ts';
import type { ConductorState } from '../conductor/state.ts';
import { Notifier, type Notification } from '../notify/notifier.ts';
import { SimWorld, type WorldOptions } from './world.ts';

/**
 * Runs the real conductor (Monitor, Sequencer, alerts, Notifier) against a SimWorld in virtual time,
 * so hours of garden life, outages and crashes play out in milliseconds and leave a real audit trail.
 */

export interface SimContext {
  world: SimWorld;
  clock: VirtualClock;
  /** Marks something in the audit trail ("▶ B-hyve goes down"). */
  note(text: string): void;
  /** Kills the conductor without a clean shutdown (state on "disk" is whatever was last saved). */
  crash(): Promise<void>;
  /** Starts the conductor again from the saved state. */
  restart(): Promise<void>;
}

export interface Scenario {
  id: string;
  title: string;
  /** What happens, for the reader. */
  story: string;
  /** What the audit trail and notifications should show. */
  lookFor: string[];
  hours: number;
  /** Start of the simulated day (default 2026-07-01 06:00 America/Chicago). */
  start?: string;
  /** Use the (fake) weather forecast for amounts. */
  weather?: boolean;
  world?: Partial<WorldOptions>;
  /** Adjust the base configuration. */
  config?: (raw: BaseConfig) => BaseConfig;
  setup(world: SimWorld): void;
  /** Steps at minutes after the start. A step's `note` is recorded in the audit trail first. */
  timeline: { at: number; note?: string; run?: (ctx: SimContext) => void | Promise<void> }[];
}

export interface SimResult {
  scenario: Scenario;
  events: AuditEvent[];
  notifications: Notification[];
  timeZone: string;
}

export const SIM_TIME_ZONE = 'America/Chicago';
const DEFAULT_START = '2026-07-01T11:00:00.000Z'; // 06:00 in Chicago
const MINUTE_MS = 60_000;

/** The simulated garden's configuration (a conductor.json). */
export type BaseConfig = {
  pollIntervalMinutes: number;
  defaults: Record<string, unknown>;
  recovery?: Record<string, unknown>;
  alerts?: Record<string, unknown>;
  notifications: Record<string, unknown>;
  zones: Record<string, unknown>[];
};

export const baseConfig = (): BaseConfig => ({
  pollIntervalMinutes: 15,
  defaults: {
    thresholdPct: 30,
    targetPct: 40,
    runMinutes: 24,
    maxCycleMinutes: 8,
    soakMinutes: 20,
    cooldownMinutes: 240,
    maxMinutesPerDay: 48,
    precipRateInPerHour: 1.5,
    sensorAggregation: 'average',
  },
  notifications: { timeZone: SIM_TIME_ZONE, connectionGraceMinutes: 5 },
  zones: [
    { name: 'Front lawn', deviceId: 'timer-1', station: 1, sensorIds: ['front-a', 'front-b'] },
    { name: 'Back lawn', deviceId: 'timer-1', station: 2, sensorIds: ['back-a'] },
  ],
});

/** The simulated garden: two zones on one controller, three soil sensors, all moist to begin with. */
export const baseWorld = (world: SimWorld): void => {
  world.addDevice({ id: 'timer-1', name: 'Lawn timer', stations: [1, 2] });
  world.addSensor({ id: 'front-a', name: 'Front sensor A', zone: 'timer-1:1', moisture: 35 });
  world.addSensor({ id: 'front-b', name: 'Front sensor B', zone: 'timer-1:1', moisture: 36 });
  world.addSensor({ id: 'back-a', name: 'Back sensor', zone: 'timer-1:2', moisture: 37 });
};

const cloneState = (s: ConductorState): ConductorState => ({
  history: new WateringHistory(s.history.runs.map((r) => ({ ...r, at: new Date(r.at) }))),
  sequences: structuredClone(s.sequences),
  alerts: structuredClone(s.alerts),
});

export const runScenario = async (scenario: Scenario): Promise<SimResult> => {
  const start = new Date(scenario.start ?? DEFAULT_START);
  const clock = new VirtualClock(start);
  const world = new SimWorld(clock, scenario.world);
  baseWorld(world);
  scenario.setup(world);
  const config: ConductorConfig = parseConductorConfig((scenario.config ?? ((c) => c))(baseConfig()));

  const memory = new MemoryAuditLog(() => clock.now());
  const notifications: Notification[] = [];
  /** What's "on disk": the state as last saved. */
  let saved: ConductorState = { history: new WateringHistory(), sequences: [], alerts: {} };
  const store = {
    save: async (state: ConductorState) => {
      saved = cloneState(state);
    },
  };

  let monitor: Monitor | undefined;
  let notifier: Notifier | undefined;

  const boot = () => {
    notifier = new Notifier({ options: config.notifications, deliver: (n) => notifications.push(n), clock });
    const audit = teeAudit(memory, notifier);
    const last = memory.events.filter((e) => e.type !== 'simulation.note').at(-1);
    if (last && last.type !== 'service.stopped') {
      audit.record('service.unclean_shutdown', { lastEvent: last.type, lastEventAt: last.ts });
    }
    audit.record('service.started', { mode: 'continuous', dryRun: false, zones: config.zones.length });
    const state = cloneState(saved);
    monitor = new Monitor({
      config,
      source: world.source,
      bhyve: world.bhyve,
      history: state.history,
      pendingSequences: state.sequences,
      alertState: state.alerts,
      store,
      audit,
      clock,
      ...(scenario.weather ? { weather: world.weather } : {}),
    });
    monitor.start();
  };

  const halt = async () => {
    // A hung poll would keep stop() waiting forever; don't wait for it.
    const stopping = monitor?.stop();
    await Promise.race([stopping, clock.advanceBy(0)]);
    notifier?.stop();
    monitor = undefined;
  };

  const ctx: SimContext = {
    world,
    clock,
    note: (text) => memory.record('simulation.note', { note: text }),
    crash: halt,
    restart: async () => boot(),
  };

  boot();
  for (const step of [...scenario.timeline].sort((a, b) => a.at - b.at)) {
    await clock.advanceTo(new Date(start.getTime() + step.at * MINUTE_MS));
    if (step.note) ctx.note(step.note);
    await step.run?.(ctx);
    world.update();
  }
  await clock.advanceTo(new Date(start.getTime() + scenario.hours * 60 * MINUTE_MS));

  if (monitor) {
    await halt();
    memory.record('service.stopped', { reason: 'end of simulation' });
  }
  return { scenario, events: memory.events, notifications, timeZone: SIM_TIME_ZONE };
};
