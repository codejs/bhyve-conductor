import { chmod, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryAuditLog } from '../../audit/audit.ts';
import { EDITABLE_ZONE_RULES, parseConductorConfig, zoneRuleProblem, type ConductorConfig } from '../../conductor/config.ts';
import { ConfigEditor } from '../../conductor/config-editor.ts';
import { log } from '../../log.ts';

/** Front lawn inherits everything from `defaults`; Back lawn overrides some; Beds derives target/critical limits. */
const FILE = {
  pollIntervalMinutes: 15,
  notifications: { timeZone: 'America/Chicago' },
  defaults: { thresholdPct: 30, targetPct: 40, criticalLowPct: 20, criticalHighPct: 60, runMinutes: 10, maxCycleMinutes: 20, soakMinutes: 30 },
  zones: [
    { name: 'Front lawn', deviceId: 'dev1', station: 1, sensorIds: ['s1'] },
    { name: 'Back lawn', deviceId: 'dev1', station: 2, sensorIds: ['s2'], thresholdPct: 25, targetPct: 35, criticalLowPct: 15 },
  ],
};
const DERIVING = {
  zones: [{ name: 'Beds', deviceId: 'dev2', station: 1, sensorIds: ['s3'] }],
};

describe('ConfigEditor', () => {
  let dir: string;
  let path: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'conductor-config-'));
    path = join(dir, 'conductor.json');
    vi.spyOn(log, 'info').mockImplementation(() => {});
    vi.spyOn(log, 'error').mockImplementation(() => {});
  });

  afterEach(async () => {
    await chmod(dir, 0o700).catch(() => {});
    await rm(dir, { recursive: true, force: true });
  });

  /** Writes the file and starts a "running conductor" from it, as index.ts does. */
  const setup = async (file: unknown = FILE) => {
    const text = `${JSON.stringify(file, null, 2)}\n`;
    await writeFile(path, text, { mode: 0o600 });
    const config: ConductorConfig = parseConductorConfig(JSON.parse(text));
    const audit = new MemoryAuditLog(() => new Date('2026-07-01T12:00:00Z'));
    const editor = new ConfigEditor({ path, config, audit });
    return { config, audit, editor, text };
  };
  const onDisk = async () => JSON.parse(await readFile(path, 'utf8')) as typeof FILE;

  it('lists each zone with the editable settings in use', async () => {
    const t = await setup();
    expect(t.editor.zones()).toEqual([
      {
        key: 'dev1:1',
        name: 'Front lawn',
        values: { thresholdPct: 30, targetPct: 40, runMinutes: 10, maxMinutesPerDay: 30, cooldownMinutes: 240, maxCycleMinutes: 20, soakMinutes: 30 },
      },
      {
        key: 'dev1:2',
        name: 'Back lawn',
        values: { thresholdPct: 25, targetPct: 35, runMinutes: 10, maxMinutesPerDay: 30, cooldownMinutes: 240, maxCycleMinutes: 20, soakMinutes: 30 },
      },
    ]);
  });

  describe('preview', () => {
    it('shows what would change, and changes nothing', async () => {
      const t = await setup();

      const check = await t.editor.preview('dev1:1', { thresholdPct: 28, runMinutes: 12 });

      expect(check).toEqual({
        ok: true,
        zone: { key: 'dev1:1', name: 'Front lawn' },
        changes: [
          { key: 'thresholdPct', from: 30, to: 28, derived: false },
          { key: 'runMinutes', from: 10, to: 12, derived: false },
        ],
      });
      expect(await readFile(path, 'utf8')).toBe(t.text);
      expect(t.config.zones[0]?.thresholdPct).toBe(30);
      expect(t.audit.events).toEqual([]);
    });

    it('includes the settings that follow from a changed one', async () => {
      const t = await setup(DERIVING);

      const check = await t.editor.preview('dev2:1', { thresholdPct: 35 });

      expect(check).toMatchObject({
        ok: true,
        changes: [
          { key: 'thresholdPct', from: 30, to: 35, derived: false },
          { key: 'targetPct', from: 40, to: 45, derived: true },
          { key: 'criticalLowPct', from: 20, to: 25, derived: true },
          { key: 'criticalHighPct', from: 60, to: 65, derived: true },
        ],
      });
    });

    it('lists nothing for a value equal to the one in use', async () => {
      const t = await setup();
      expect(await t.editor.preview('dev1:1', { thresholdPct: 30, soakMinutes: 30 })).toMatchObject({ ok: true, changes: [] });
    });

    it.each([
      [{ thresholdPct: 45 }, 'targetPct (40) must be above thresholdPct (45)'],
      [{ thresholdPct: 15 }, 'criticalLowPct (20) must be below thresholdPct (15)'],
      [{ targetPct: 70 }, 'criticalHighPct (60) must be above targetPct (70)'],
    ])('refuses values that do not fit together: %j', async (changes, problem) => {
      const t = await setup();
      expect(await t.editor.preview('dev1:1', changes)).toEqual({ ok: false, reason: 'invalid', problems: [problem] });
    });

    it.each([
      [{ thresholdPct: 101 }, /^thresholdPct: /],
      [{ runMinutes: 0 }, /^runMinutes: /],
      [{ runMinutes: 241 }, /^runMinutes: /],
      [{ maxMinutesPerDay: 1441 }, /^maxMinutesPerDay: /],
      [{ cooldownMinutes: -1 }, /^cooldownMinutes: /],
      [{ soakMinutes: 241 }, /^soakMinutes: /],
      [{ maxCycleMinutes: 0 }, /^maxCycleMinutes: /],
    ])('refuses an out-of-range value %j', async (changes, problem) => {
      const t = await setup();
      const check = await t.editor.preview('dev1:1', changes);
      expect(check).toMatchObject({ ok: false, reason: 'invalid', problems: [expect.stringMatching(problem)] });
    });

    it.each([
      [{ sensorIds: 5 }, "sensorIds can't be changed here"],
      [{ __proto__: 1 } as unknown as Record<string, number>, undefined],
      [{ runMinutes: Number.NaN }, 'runMinutes must be a number'],
      [{ runMinutes: Number.POSITIVE_INFINITY }, 'runMinutes must be a number'],
      [{ runMinutes: '12' }, 'runMinutes must be a number'],
    ])('refuses anything but the editable settings, as finite numbers: %j', async (changes, problem) => {
      const t = await setup();
      const check = await t.editor.preview('dev1:1', changes as Record<string, number>);
      if (problem === undefined) expect(check).toMatchObject({ ok: true, changes: [] });
      else expect(check).toEqual({ ok: false, reason: 'invalid', problems: [problem] });
    });

    it('refuses an unknown zone', async () => {
      const t = await setup();
      expect(await t.editor.preview('dev9:9', { runMinutes: 5 })).toEqual({ ok: false, reason: 'unavailable', problems: ['zone dev9:9 is not configured'] });
    });

    it('refuses when the zone was edited in the file since the conductor started', async () => {
      const t = await setup();
      const edited = structuredClone(FILE);
      (edited.zones[0] as Record<string, unknown>).runMinutes = 15;
      await writeFile(path, JSON.stringify(edited));

      const check = await t.editor.preview('dev1:1', { thresholdPct: 28 });

      expect(check).toMatchObject({ ok: false, reason: 'conflict', problems: [expect.stringContaining('has changed since the conductor started')] });
    });

    it('refuses when a default the zone inherits was edited in the file', async () => {
      const t = await setup();
      await writeFile(path, JSON.stringify({ ...FILE, defaults: { ...FILE.defaults, soakMinutes: 45 } }));

      expect(await t.editor.preview('dev1:1', { runMinutes: 12 })).toMatchObject({ ok: false, reason: 'conflict' });
    });

    it('allows it when only another zone was edited in the file', async () => {
      const t = await setup();
      const edited = structuredClone(FILE);
      (edited.zones[1] as Record<string, unknown>).runMinutes = 15;
      await writeFile(path, JSON.stringify(edited));

      expect(await t.editor.preview('dev1:1', { runMinutes: 12 })).toMatchObject({ ok: true });
    });

    it.each([
      ['missing', null, 'unavailable', /could not read/],
      ['not JSON', '{ "zones": [', 'unavailable', /could not read/],
      ['no longer valid', JSON.stringify({ zones: [] }), 'conflict', /no longer valid \(edited by hand\?\)/],
    ])('refuses when the file is %s', async (_, content, reason, problem) => {
      const t = await setup();
      if (content === null) await rm(path);
      else await writeFile(path, content);

      expect(await t.editor.preview('dev1:1', { runMinutes: 12 })).toMatchObject({ ok: false, reason, problems: [expect.stringMatching(problem)] });
    });
  });

  describe('apply', () => {
    it('saves the new values in the zone, keeps a backup, and switches the conductor to them', async () => {
      const t = await setup();
      const before = t.config.zones[0];

      const result = await t.editor.apply('dev1:1', { thresholdPct: 28, runMinutes: 12 }, '@owner via Telegram');

      expect(result).toMatchObject({ ok: true, changes: [{ key: 'thresholdPct', to: 28 }, { key: 'runMinutes', to: 12 }] });
      const saved = await onDisk();
      expect(saved.zones[0]).toEqual({ ...FILE.zones[0], thresholdPct: 28, runMinutes: 12 });
      expect(saved.zones[1]).toEqual(FILE.zones[1]);
      expect(saved.defaults).toEqual(FILE.defaults);
      expect(await readFile(`${path}.bak`, 'utf8')).toBe(t.text);
      expect((await readdir(dir)).sort()).toEqual(['conductor.json', 'conductor.json.bak']);
      // The running conductor uses the new values; the old zone object (held by a poll under way) is untouched.
      expect(t.config.zones[0]).toMatchObject({ key: 'dev1:1', thresholdPct: 28, runMinutes: 12 });
      expect(t.config.zones[0]).not.toBe(before);
      expect(before?.thresholdPct).toBe(30);
      expect(t.audit.ofType('config.changed')).toEqual([
        expect.objectContaining({
          by: '@owner via Telegram',
          zone: 'dev1:1',
          name: 'Front lawn',
          changes: [
            { key: 'thresholdPct', from: 30, to: 28 },
            { key: 'runMinutes', from: 10, to: 12 },
          ],
        }),
      ]);
    });

    it('applies the settings that follow, and records them as such', async () => {
      const t = await setup(DERIVING);

      await t.editor.apply('dev2:1', { thresholdPct: 35 }, 'x');

      expect(t.config.zones[0]).toMatchObject({ thresholdPct: 35, targetPct: 45, criticalLowPct: 25, criticalHighPct: 65 });
      expect((await onDisk()).zones[0]).toEqual({ ...DERIVING.zones[0], thresholdPct: 35 }); // only what was entered
      expect(t.audit.ofType('config.changed')[0]?.changes).toContainEqual({ key: 'targetPct', from: 40, to: 45, derived: true });
    });

    it('keeps the file permissions', async () => {
      const t = await setup();
      await t.editor.apply('dev1:1', { runMinutes: 12 }, 'x');
      expect((await stat(path)).mode & 0o777).toBe(0o600);
      expect((await stat(`${path}.bak`)).mode & 0o777).toBe(0o600);
    });

    it('writes nothing when nothing would change', async () => {
      const t = await setup();

      expect(await t.editor.apply('dev1:1', { runMinutes: 10 }, 'x')).toMatchObject({ ok: true, changes: [] });

      expect(await readFile(path, 'utf8')).toBe(t.text);
      expect(await readdir(dir)).toEqual(['conductor.json']);
      expect(t.audit.events).toEqual([]);
    });

    it('checks again against the file as it is at that moment', async () => {
      const t = await setup();
      expect(await t.editor.preview('dev1:1', { runMinutes: 12 })).toMatchObject({ ok: true });
      const edited = structuredClone(FILE);
      (edited.zones[0] as Record<string, unknown>).soakMinutes = 5;
      await writeFile(path, JSON.stringify(edited));

      const result = await t.editor.apply('dev1:1', { runMinutes: 12 }, 'x');

      expect(result).toMatchObject({ ok: false, reason: 'conflict' });
      expect(t.config.zones[0]?.runMinutes).toBe(10);
      expect(JSON.parse(await readFile(path, 'utf8'))).toEqual(edited);
    });

    it('changes nothing, in the file or the conductor, when invalid', async () => {
      const t = await setup();

      expect(await t.editor.apply('dev1:1', { thresholdPct: 45 }, 'x')).toMatchObject({ ok: false, reason: 'invalid' });

      expect(await readFile(path, 'utf8')).toBe(t.text);
      expect(t.config.zones[0]?.thresholdPct).toBe(30);
    });

    it('leaves the conductor as it was when the file cannot be written', async () => {
      const t = await setup();
      await mkdir(`${path}.tmp`); // writing the temporary file fails

      const result = await t.editor.apply('dev1:1', { runMinutes: 12 }, 'x');

      expect(result).toMatchObject({ ok: false, reason: 'unavailable', problems: [expect.stringMatching(/^could not save .*conductor\.json: /)] });
      expect(await readFile(path, 'utf8')).toBe(t.text);
      expect(t.config.zones[0]?.runMinutes).toBe(10);
      expect(t.audit.events).toEqual([]);
    });

    it('makes one change at a time, each on top of the previous one', async () => {
      const t = await setup();

      const [a, b] = await Promise.all([
        t.editor.apply('dev1:1', { runMinutes: 12 }, 'x'),
        t.editor.apply('dev1:2', { soakMinutes: 40 }, 'y'),
      ]);

      expect(a).toMatchObject({ ok: true });
      expect(b).toMatchObject({ ok: true });
      const saved = await onDisk();
      expect(saved.zones[0]).toMatchObject({ runMinutes: 12 });
      expect(saved.zones[1]).toMatchObject({ soakMinutes: 40 });
    });

    it('carries on after a failed change', async () => {
      const t = await setup();
      await mkdir(`${path}.tmp`);
      await t.editor.apply('dev1:1', { runMinutes: 12 }, 'x');
      await rm(`${path}.tmp`, { recursive: true });

      expect(await t.editor.apply('dev1:1', { runMinutes: 13 }, 'x')).toMatchObject({ ok: true });
    });
  });
});

describe('zoneRuleProblem', () => {
  // The ranges /config tells the user about must be the ones the config file accepts.
  it.each([
    ['thresholdPct', 0, 100, true],
    ['targetPct', 0, 100, true],
    ['runMinutes', 0, 240, false],
    ['maxMinutesPerDay', 0, 1440, false],
    ['cooldownMinutes', 0, 10080, true],
    ['maxCycleMinutes', 0, 240, false],
    ['soakMinutes', 0, 240, true],
  ] as const)('%s: from %d (inclusive: %s) to %d', (key, min, max, minInclusive) => {
    expect(zoneRuleProblem(key, max)).toBeUndefined();
    expect(zoneRuleProblem(key, max + 0.1)).toBeDefined();
    expect(zoneRuleProblem(key, min - 0.1)).toBeDefined();
    expect(zoneRuleProblem(key, min) === undefined).toBe(minInclusive);
    expect(zoneRuleProblem(key, min + 0.1)).toBeUndefined();
  });

  it('covers every editable setting', () => {
    expect(EDITABLE_ZONE_RULES).toEqual(['thresholdPct', 'targetPct', 'runMinutes', 'maxMinutesPerDay', 'cooldownMinutes', 'maxCycleMinutes', 'soakMinutes']);
  });
});
