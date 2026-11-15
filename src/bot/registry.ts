import type { BhyveClient } from '../bhyve/client.ts';
import type { ConductorConfig } from '../conductor/config.ts';
import type { Monitor } from '../conductor/monitor.ts';
import type { MoistureSource } from '../sensors/types.ts';
import { buildAuditCommand, type AuditSnapshot } from './audit-command.ts';
import { buildCommands, type CommandDeps } from './commands.ts';
import { buildConfigCommand, type ConfigCommandDeps } from './config-command.ts';
import { buildControlCommands, type ConductorControl } from './control.ts';
import type { BotCommand } from './conversation.ts';
import type { ServiceInfo } from './format.ts';
import { buildStopCommand, type WaterStop } from './stop-command.ts';
import { buildZoneCommand, type ZoneView } from './zone-command.ts';

/**
 * Every command the bot offers, in one place (used by index.ts and the integration tests):
 *  - always, read-only: /health, /zone, /sensors_read, /bhyve_devices, /audit;
 *  - always, safety (confirm, no passphrase): /stop;
 *  - only with `changes` (i.e. a passphrase is set): /pause, /resume, /config.
 */
export interface BotCommandsDeps extends CommandDeps {
  /** Reads (the end of) the audit trail, for /audit. */
  readAudit: () => Promise<AuditSnapshot>;
  /** The zones and their details, for /zone. */
  zoneView: ZoneView;
  /** What /stop needs: nothing that could start watering. */
  waterStop: WaterStop;
  /** What the commands that change something work on. Leave out to offer no changes. */
  changes?: {
    control: ConductorControl;
    editor: ConfigCommandDeps['editor'];
  };
}

/** Commands that exist but aren't offered with these deps (or were replaced), with why (for /help). */
export const unavailableCommands = (deps: Pick<BotCommandsDeps, 'changes'>): Map<string, string> =>
  new Map([
    ['status', 'it was replaced by /health, which shows everything it did, and more.'],
    ...(deps.changes
      ? []
      : ['pause', 'resume', 'config'].map((name): [string, string] => [name, 'changes need a passphrase (TELEGRAM_COMMAND_PASSPHRASE on the conductor).'])),
  ]);

export const buildBotCommands = (deps: BotCommandsDeps): BotCommand[] => {
  const { readAudit, zoneView, waterStop, changes, ...query } = deps;
  const { timeZone, now } = deps;
  const [health, ...rest] = buildCommands(query);
  return [
    ...(health ? [health] : []),
    buildZoneCommand({ view: zoneView, timeZone }),
    ...rest,
    buildAuditCommand({ read: readAudit, timeZone, ...(now ? { now } : {}) }),
    buildStopCommand({ stop: waterStop, timeZone }),
    ...(changes
      ? [...buildControlCommands({ control: changes.control, timeZone, ...(now ? { now } : {}) }), buildConfigCommand({ editor: changes.editor })]
      : []),
  ];
};

export interface ConductorWiring {
  monitor: Pick<Monitor, 'status' | 'zoneStatus' | 'stopWatering' | 'pause' | 'resume'>;
  /** The config the monitor runs with (for the zones). */
  config: ConductorConfig;
  bhyve: Pick<BhyveClient, 'getDevices'>;
  /** Give the bot its own source instance, so its reads can't mix with the monitor's. */
  sensors: MoistureSource;
  zonesBySensor: ReadonlyMap<string, readonly string[]>;
  readAudit: () => Promise<AuditSnapshot>;
  service: () => ServiceInfo;
  timeZone?: string | undefined;
  now?: () => Date;
  /** Edits conductor.json and `config`. Only with a passphrase: its presence turns on /pause, /resume, /config. */
  editor?: ConfigCommandDeps['editor'];
}

/**
 * Wires the commands to a running conductor (index.ts and the integration tests). Each command gets only
 * the calls it needs, as plain functions, so it can't reach anything else even by mistake: B-hyve is a
 * device list (read-only); /stop gets the monitor's stop and nothing that could start watering; the
 * changes get status, pause and resume.
 */
export const conductorCommandDeps = (w: ConductorWiring): BotCommandsDeps => {
  const { monitor, config } = w;
  const zones = () => config.zones.map((z) => ({ key: z.key, name: z.name, deviceId: z.deviceId }));
  return {
    bhyve: { getDevices: () => w.bhyve.getDevices() },
    sensors: w.sensors,
    zonesBySensor: w.zonesBySensor,
    status: () => monitor.status(),
    service: w.service,
    timeZone: w.timeZone,
    ...(w.now ? { now: w.now } : {}),
    readAudit: w.readAudit,
    zoneView: { zones, zoneStatus: (key) => monitor.zoneStatus(key) },
    waterStop: {
      zones,
      status: () => monitor.status(),
      devices: () => w.bhyve.getDevices(),
      stopWatering: (deviceIds, by) => monitor.stopWatering(deviceIds, by),
    },
    ...(w.editor
      ? {
          changes: {
            control: { status: () => monitor.status(), pause: (by, opts) => monitor.pause(by, opts), resume: (by, held) => monitor.resume(by, held) },
            editor: w.editor,
          },
        }
      : {}),
  };
};
