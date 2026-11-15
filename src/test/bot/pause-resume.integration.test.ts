import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryAuditLog } from '../../audit/audit.ts';
import type { CommandPolicy } from '../../bot/auth.ts';
import { CommandBot } from '../../bot/bot.ts';
import { zonesBySensor } from '../../bot/commands.ts';
import { buildBotCommands } from '../../bot/registry.ts';
import { VirtualClock } from '../../clock.ts';
import type { ConductorConfig, ZoneConfig } from '../../conductor/config.ts';
import { ConfigEditor } from '../../conductor/config-editor.ts';
import { WateringHistory } from '../../conductor/history.ts';
import { Monitor } from '../../conductor/monitor.ts';
import type { ConductorState } from '../../conductor/state.ts';
import { log } from '../../log.ts';
import type { MoistureReading } from '../../sensors/types.ts';
import { bhyveDevice, NOW, reading, zone } from '../utils/conductor.ts';
import { fakeBhyve } from '../utils/fake-bhyve.ts';
import { fakeBotApi, OWNER, updates } from '../utils/fake-telegram.ts';

/**
 * The real conductor (Monitor, Sequencer) and the real bot and commands, in virtual time, driven only
 * through chat messages. The fakes are the edges: B-hyve, the sensors, and Telegram.
 */

const MIN = 60_000;
const PASS = 'open sesame 42';
const POLICY: CommandPolicy = { chatId: OWNER.id, userIds: new Set([OWNER.id]) };

// 35 min split into 11.7 + 11.7 + 11.6 with 30 min soaks: cycle 2 is due 41.7 min after cycle 1.
const FRONT: ZoneConfig = zone({ name: 'Front lawn', runMinutes: 35, maxCycleMinutes: 15, soakMinutes: 30, maxMinutesPerDay: 60 });
const CYCLE_GAP = 41.7 * MIN;

const config = (): ConductorConfig => ({
  pollIntervalMinutes: 15,
  dryRun: false,
  forecastHours: 72,
  recovery: { confirmTimeoutSeconds: 0, retryWindowMinutes: 30, resumeWindowMinutes: 60 },
  alerts: { lowBatteryPct: 20, deviceCheckMinutes: 0 },
  notifications: { minSeverity: 'info', cycles: false, connectionGraceMinutes: 5 },
  zones: [FRONT],
});

const setup = (saved?: ConductorState, clock = new VirtualClock(NOW)) => {
  const fake = fakeBhyve([bhyveDevice('dev1')]);
  const audit = new MemoryAuditLog(() => clock.now());
  let moisture = 10;
  const source = {
    id: 'fake',
    read: vi.fn(async (): Promise<MoistureReading[]> => [reading('s1', moisture, { at: clock.now() })]),
  };
  let state: ConductorState | undefined;
  const store = {
    save: vi.fn(async (s: ConductorState) => {
      state = { history: new WateringHistory([...s.history.runs]), sequences: structuredClone(s.sequences), alerts: { ...s.alerts }, ...(s.paused ? { paused: { ...s.paused } } : {}) };
    }),
  };
  const monitorConfig = config();
  const monitor = new Monitor({
    config: monitorConfig,
    source,
    bhyve: fake.control,
    history: saved?.history ?? new WateringHistory(),
    ...(saved ? { pendingSequences: saved.sequences, alertState: saved.alerts } : {}),
    ...(saved?.paused ? { paused: saved.paused } : {}),
    store,
    audit,
    clock,
  });
  const api = fakeBotApi();
  const replies: string[] = [];
  const bot = new CommandBot({
    api: api.bot,
    policy: POLICY,
    // Assembled exactly as index.ts does.
    commands: buildBotCommands({
      bhyve: { getDevices: () => fake.bhyve.getDevices() },
      sensors: source,
      zonesBySensor: zonesBySensor([FRONT]),
      status: () => monitor.status(),
      timeZone: 'UTC',
      now: () => clock.now(),
      readAudit: async () => ({ events: audit.events, skipped: 0, truncated: false }),
      changes: {
        control: { status: () => monitor.status(), pause: (by) => monitor.pause(by), resume: (by, held) => monitor.resume(by, held) },
        editor: new ConfigEditor({ path: '/nonexistent/conductor.json', config: monitorConfig }),
      },
    }),
    passphrase: PASS,
    reply: (html) => replies.push(html),
    audit,
    clock,
  });
  const msg = updates(clock);
  return {
    clock,
    fake,
    audit,
    source,
    monitor,
    bot,
    api,
    replies,
    state: () => state,
    setMoisture: (m: number) => {
      moisture = m;
    },
    start: async () => {
      monitor.start();
      bot.start();
      await clock.advanceBy(0);
    },
    stop: async () => {
      await bot.stop();
      await monitor.stop();
    },
    /** The owner types these, one after another. */
    say: async (...texts: string[]) => {
      for (const text of texts) {
        api.push(msg(text));
        await clock.advanceBy(0);
      }
    },
    lastSaid: () => api.last(),
    waterings: () => fake.bhyve.startWatering.mock.calls.length,
  };
};

describe('pause and resume through Telegram (integration)', () => {
  beforeEach(() => {
    for (const level of ['debug', 'info', 'warn', 'error'] as const) vi.spyOn(log, level).mockImplementation(() => {});
  });
  let running: ReturnType<typeof setup>[] = [];
  const track = (t: ReturnType<typeof setup>) => {
    running.push(t);
    return t;
  };
  afterEach(async () => {
    for (const t of running) await t.stop();
    running = [];
  });

  it('pauses in the middle of a sequence (after confirmation), holds it, then continues it on resume', async () => {
    const t = track(setup());
    await t.start();
    expect(t.waterings()).toBe(1); // cycle 1 of 3 started by the first poll

    await t.say('/pause');
    expect(t.lastSaid()).toContain('⚠️ <b>Watering in progress</b>\n• Front lawn: cycle 2/3, next cycle at Jul 1, 12:41');
    expect(t.lastSaid()).toContain('• 💧 Front lawn: water on until Jul 1, 12:11 (cycle 1/3)');
    await t.say('yes');
    expect(t.monitor.paused).toBeUndefined(); // not before the passphrase
    await t.say(PASS);

    expect(t.monitor.paused).toEqual({ since: NOW, by: '@owner via Telegram' });
    expect(t.lastSaid()).toMatch(/^⏸️ <b>Paused<\/b> by @owner via Telegram\./);
    expect(t.state()?.paused).toEqual({ since: NOW, by: '@owner via Telegram' });

    await t.clock.advanceBy(CYCLE_GAP + 5 * MIN); // cycle 2 would have been due
    expect(t.waterings()).toBe(1);

    await t.say('/status');
    expect(t.replies.at(-1)).toContain('⏸️ <b>Paused</b> since Jul 1, 12:00 by @owner via Telegram');
    expect(t.replies.at(-1)).toContain('<b>Watering on hold</b>\n⏸️ Front lawn: cycle 2/3 due since Jul 1, 12:41');

    await t.say('/resume');
    expect(t.lastSaid()).toContain('<b>continue</b>: continue the watering on hold, and resume');
    await t.say('continue', PASS);

    expect(t.monitor.paused).toBeUndefined();
    expect(t.lastSaid()).toMatch(/^▶️ <b>Resumed<\/b> after 47 min\./);
    expect(t.lastSaid()).toContain('<b>Continued</b>:\n• Front lawn: cycle 2/3');
    await t.clock.advanceBy(0);
    expect(t.waterings()).toBe(2); // the overdue cycle 2 goes out straight away
    await t.clock.advanceBy(CYCLE_GAP);
    expect(t.waterings()).toBe(3);
    expect(t.audit.ofType('sequence.completed')).toHaveLength(1);
    expect(JSON.stringify(t.audit.events)).not.toContain(PASS);
  });

  it('discards the held sequence on resume, and the zones are re-checked at once', async () => {
    const t = track(setup());
    await t.start();
    await t.say('/pause', 'yes', PASS);
    const polls = t.source.read.mock.calls.length;

    await t.say('/resume', 'discard', PASS);
    await t.clock.advanceBy(0);

    expect(t.lastSaid()).toContain('<b>Cancelled</b>:\n• Front lawn: discarded by @owner via Telegram when resuming');
    expect(t.source.read.mock.calls.length).toBe(polls + 1); // polled straight away
    await t.clock.advanceBy(3 * 60 * MIN);
    expect(t.waterings()).toBe(1); // nothing more: cooldown after cycle 1, and the rest was discarded
    expect(t.audit.ofType('sequence.abandoned')).toHaveLength(1);
  });

  it('pauses without a confirmation when nothing is watering, and no new watering starts until resumed', async () => {
    const t = track(setup());
    t.setMoisture(50);
    await t.start();
    expect(t.waterings()).toBe(0);

    await t.say('/pause');
    expect(t.lastSaid()).toBe('⏸️ Pause automatic watering? Nothing is being watered right now.\n🔐 Send the passphrase to pause, or <b>cancel</b>.');
    await t.say(PASS);
    t.setMoisture(10);
    await t.clock.advanceBy(60 * MIN);

    expect(t.waterings()).toBe(0);
    expect(t.audit.ofType('zone.decision').at(-1)).toMatchObject({ reason: 'paused' });

    await t.say('/resume');
    expect(t.lastSaid()).toMatch(/^▶️ Resume automatic watering\? Paused since Jul 1, 12:00 by @owner via Telegram\./);
    await t.say(PASS);
    await t.clock.advanceBy(0);
    expect(t.waterings()).toBe(1);
  });

  it('a wrong passphrase leaves the conductor running as before', async () => {
    const t = track(setup());
    await t.start();

    await t.say('/pause', 'yes', 'open sesame 43');
    await t.clock.advanceBy(CYCLE_GAP);

    expect(t.monitor.paused).toBeUndefined();
    expect(t.waterings()).toBe(2);
    expect(t.lastSaid()).toBe('❌ Wrong passphrase: /pause was not run.');
  });

  it('no answer leaves the conductor running as before', async () => {
    const t = track(setup());
    await t.start();

    await t.say('/pause', 'yes');
    await t.clock.advanceBy(CYCLE_GAP);

    expect(t.monitor.paused).toBeUndefined();
    expect(t.waterings()).toBe(2);
    expect(t.api.texts()).toContain('⌛ No answer within 2 min: /pause cancelled. Nothing changed.');
  });

  it('cancelling /resume leaves it paused', async () => {
    const t = track(setup());
    await t.start();
    await t.say('/pause', 'yes', PASS);

    await t.say('/resume', 'cancel');
    await t.clock.advanceBy(3 * CYCLE_GAP);

    expect(t.monitor.paused).toBeDefined();
    expect(t.waterings()).toBe(1);
  });

  it('stays paused across a restart, and only offers to cancel watering that is too old to continue', async () => {
    const first = setup();
    await first.start();
    await first.say('/pause', 'yes', PASS);
    await first.stop();
    const saved = first.state();
    expect(saved?.paused).toBeDefined();
    expect(saved?.sequences).toHaveLength(1);

    // Back up 3 hours later.
    const clock = new VirtualClock(new Date(NOW.getTime() + 3 * 60 * MIN));
    const t = track(setup(saved, clock));
    await t.start();
    await t.clock.advanceBy(60 * MIN);
    expect(t.waterings()).toBe(0);

    await t.say('/resume');
    expect(t.lastSaid()).toContain('paused too long ago to continue safely');
    expect(t.lastSaid()).toContain('Resume? Reply <b>yes</b> or <b>cancel</b>.');
    await t.say('yes', PASS);

    expect(t.monitor.paused).toBeUndefined();
    expect(t.lastSaid()).toContain('<b>Cancelled</b>:\n• Front lawn: discarded by @owner via Telegram when resuming');
    const heldId = saved?.sequences[0]?.id;
    expect(t.audit.ofType('sequence.abandoned')).toEqual([expect.objectContaining({ sequence: heldId })]);
    // The zones were re-checked at once: still dry and past the cooldown, so a fresh plan starts (not the old one).
    await t.clock.advanceBy(0);
    expect(t.waterings()).toBe(1);
    expect(t.monitor.status().sequences.map((q) => q.id)).not.toContain(heldId);
  });
});
