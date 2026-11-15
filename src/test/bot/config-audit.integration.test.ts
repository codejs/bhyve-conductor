import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FileAuditLog, readAuditTail } from '../../audit/audit.ts';
import type { CommandPolicy } from '../../bot/auth.ts';
import { CommandBot } from '../../bot/bot.ts';
import { zonesBySensor } from '../../bot/commands.ts';
import { buildBotCommands } from '../../bot/registry.ts';
import { VirtualClock } from '../../clock.ts';
import { parseConductorConfig } from '../../conductor/config.ts';
import { ConfigEditor } from '../../conductor/config-editor.ts';
import { WateringHistory } from '../../conductor/history.ts';
import { Monitor } from '../../conductor/monitor.ts';
import { log } from '../../log.ts';
import { bhyveDevice, NOW, reading } from '../utils/conductor.ts';
import { fakeBhyve } from '../utils/fake-bhyve.ts';
import { fakeBotApi, OWNER, updates } from '../utils/fake-telegram.ts';

/**
 * The real conductor, config editor, audit file and bot, driven through chat. The fakes are the edges:
 * B-hyve, the sensors and Telegram. conductor.json and the audit trail are real files.
 */

const MIN = 60_000;
const PASS = 'open sesame 42';
const POLICY: CommandPolicy = { chatId: OWNER.id, userIds: new Set([OWNER.id]) };
const FILE = {
  pollIntervalMinutes: 15,
  recovery: { confirmTimeoutSeconds: 0 },
  alerts: { deviceCheckMinutes: 0 },
  notifications: { timeZone: 'UTC' },
  defaults: { thresholdPct: 30, targetPct: 40, criticalLowPct: 20, criticalHighPct: 60, runMinutes: 10, maxCycleMinutes: 20 },
  zones: [{ name: 'Front lawn', deviceId: 'dev1', station: 1, sensorIds: ['s1'] }],
};

describe('/config and /audit through Telegram (integration)', () => {
  let dir: string;
  let configPath: string;
  let auditPath: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'conductor-it-'));
    configPath = join(dir, 'conductor.json');
    auditPath = join(dir, 'audit.jsonl');
    for (const level of ['debug', 'info', 'warn', 'error'] as const) vi.spyOn(log, level).mockImplementation(() => {});
  });

  const running: (() => Promise<void>)[] = [];
  afterEach(async () => {
    for (const stop of running.splice(0)) await stop();
    await rm(dir, { recursive: true, force: true });
  });

  const setup = async () => {
    await writeFile(configPath, JSON.stringify(FILE, null, 2));
    const clock = new VirtualClock(NOW);
    const config = parseConductorConfig(JSON.parse(await readFile(configPath, 'utf8')));
    const audit = new FileAuditLog(auditPath, () => clock.now());
    const fake = fakeBhyve([bhyveDevice('dev1')]);
    let moisture = 32;
    const source = { id: 'fake', read: vi.fn(async () => [reading('s1', moisture, { at: clock.now() })]) };
    const monitor = new Monitor({ config, source, bhyve: fake.control, history: new WateringHistory(), audit, clock });
    const api = fakeBotApi();
    const bot = new CommandBot({
      api: api.bot,
      policy: POLICY,
      // Assembled exactly as index.ts does.
      commands: buildBotCommands({
        bhyve: { getDevices: () => fake.bhyve.getDevices() },
        sensors: source,
        zonesBySensor: zonesBySensor(config.zones),
        status: () => monitor.status(),
        timeZone: 'UTC',
        now: () => clock.now(),
        readAudit: () => readAuditTail(auditPath, 2 * 1024 * 1024),
        changes: {
          control: { status: () => monitor.status(), pause: (by) => monitor.pause(by), resume: (by, held) => monitor.resume(by, held) },
          editor: new ConfigEditor({ path: configPath, config, audit }),
        },
      }),
      passphrase: PASS,
      reply: () => {},
      audit,
      clock,
    });
    monitor.start();
    bot.start();
    await clock.advanceBy(0);
    running.push(async () => {
      await bot.stop();
      await monitor.stop();
      await audit.flush();
    });
    const msg = updates(clock);
    /** Lets the bot finish: its steps read and write real files, which take real (thread-pool) time. */
    const settle = async () => {
      for (let i = 0; i < 20; i++) {
        await clock.advanceBy(0);
        await audit.flush();
        await new Promise((resolve) => setTimeout(resolve, 2));
      }
    };
    return {
      clock,
      fake,
      config,
      audit,
      setMoisture: (m: number) => {
        moisture = m;
      },
      say: async (...texts: string[]) => {
        for (const text of texts) {
          api.push(msg(text));
          await settle();
        }
      },
      lastSaid: () => api.last() ?? '',
    };
  };

  it('a /config change is saved to conductor.json and changes what the conductor does at the next poll', async () => {
    const t = await setup();
    expect(t.fake.bhyve.startWatering).not.toHaveBeenCalled(); // 32% is above the 30% threshold

    await t.say('/config');
    expect(t.lastSaid()).toContain('• thresholdPct: 30%');
    await t.say('35', 'done');
    expect(t.lastSaid()).toContain('• thresholdPct: 30% → <b>35%</b>');
    await t.say(PASS);
    expect(t.lastSaid()).toMatch(/^✅ <b>Saved<\/b> for Front lawn:/);

    const saved = JSON.parse(await readFile(configPath, 'utf8')) as typeof FILE;
    expect(saved.zones[0]).toMatchObject({ thresholdPct: 35 });
    expect(JSON.parse(await readFile(`${configPath}.bak`, 'utf8'))).toEqual(FILE);

    await t.clock.advanceBy(15 * MIN); // next poll: 32% is now below the 35% threshold
    await t.say(); // (let it finish)
    expect(t.fake.bhyve.startWatering).toHaveBeenCalledOnce();
  });

  it('a cancelled or wrongly confirmed /config changes nothing', async () => {
    const t = await setup();

    await t.say('/config', '35', 'done', 'cancel');
    await t.say('/config', '35', 'done', 'wrong passphrase');
    await t.clock.advanceBy(60 * MIN);

    expect(JSON.parse(await readFile(configPath, 'utf8'))).toEqual(FILE);
    expect(t.config.zones[0]?.thresholdPct).toBe(30);
    expect(t.fake.bhyve.startWatering).not.toHaveBeenCalled();
  });

  it('/audit shows what happened, including the change just made, from the real audit file', async () => {
    const t = await setup();
    await t.say('/config', '35', 'done', PASS);

    await t.say('/audit commands');

    const page = t.lastSaid();
    expect(page).toContain('📜 <b>Audit</b> · commands and changes · last 24 h');
    expect(page).toContain('⚙️ config changed\nsettings of zone dev1:1 (Front lawn) CHANGED by @owner via Telegram: thresholdPct 30 → 35');
    expect(page).toContain('🤖 command handled\ntelegram command /config from user 4242: ok');
    expect(page).not.toContain(PASS);
    expect(await readFile(auditPath, 'utf8')).not.toContain(PASS);

    await t.say('done');
    expect(t.lastSaid()).toBe('👋 /audit closed.');
  });
});
