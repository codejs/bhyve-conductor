import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildConfigCommand, FIELDS, formatChange, parseSetting } from '../../bot/config-command.ts';
import type { InputResult, MutableCommand, Step } from '../../bot/conversation.ts';
import { EDITABLE_ZONE_RULES, parseConductorConfig, type ConductorConfig } from '../../conductor/config.ts';
import { ConfigEditor, type ConfigCheck, type ZoneSettings } from '../../conductor/config-editor.ts';
import { log } from '../../log.ts';

const OWNER = { id: 4242, username: 'owner' };
const wellFormed = (html: string) => expect(html.replace(/<\/?(b|i|code)>/g, '')).not.toMatch(/[<>]/);
const field = (key: string) => {
  const f = FIELDS.find((x) => x.key === key);
  if (!f) throw new Error(key);
  return f;
};

const TWO_ZONES = {
  defaults: { thresholdPct: 30, targetPct: 40, criticalLowPct: 20, criticalHighPct: 60 },
  zones: [
    { name: 'Front lawn', deviceId: 'dev1', station: 1, sensorIds: ['s1'] },
    { name: 'Back lawn', deviceId: 'dev1', station: 2, sensorIds: ['s2'], thresholdPct: 25, targetPct: 35, criticalLowPct: 15 },
  ],
};
const ONE_ZONE_DERIVING = { zones: [{ name: 'Beds', deviceId: 'dev2', station: 1, sensorIds: ['s3'] }] };

/** Step helpers: answer an input/ask step and get the next step, or the reason it was refused. */
const answer = async (step: Step, text: string): Promise<Step | string> => {
  if (step.kind === 'ask') {
    const choice = step.choices.find((c) => c.words.includes(text));
    if (!choice) return `no choice "${text}"`;
    return choice.next();
  }
  if (step.kind !== 'input') throw new Error(`expected a question, got ${step.kind}: ${step.text}`);
  const result: InputResult = await step.read(text);
  return 'next' in result ? result.next : result.invalid;
};
const next = async (step: Step, ...texts: string[]): Promise<Step> => {
  let s = step;
  for (const text of texts) {
    const r = await answer(s, text);
    if (typeof r === 'string') throw new Error(`refused "${text}": ${r}`);
    s = r;
  }
  return s;
};
const run = async (step: Step) => {
  if (step.kind !== 'passphrase') throw new Error(`expected the passphrase step, got ${step.kind}: ${step.text}`);
  return step.run();
};

describe('parseSetting', () => {
  it.each([
    ['thresholdPct', '28', 28],
    ['thresholdPct', ' 28.5 ', 28.5],
    ['thresholdPct', '28%', 28],
    ['thresholdPct', '0', 0],
    ['thresholdPct', '100', 100],
    ['runMinutes', '12', 12],
    ['runMinutes', '12 min', 12],
    ['runMinutes', '12m', 12],
    ['runMinutes', '12 Minutes', 12],
    ['runMinutes', '0.5', 0.5],
    ['cooldownMinutes', '4h', 240],
    ['cooldownMinutes', '1.5 hours', 90],
    ['cooldownMinutes', '0', 0],
    ['maxMinutesPerDay', '1440', 1440],
    ['soakMinutes', '0', 0],
  ])('%s: %j → %d', (key, text, value) => {
    expect(parseSetting(text, field(key))).toBe(value);
  });

  it.each([
    ['thresholdPct', '101'],
    ['thresholdPct', '-5'],
    ['thresholdPct', '28 min'], // a percentage
    ['runMinutes', '12%'], // minutes
    ['runMinutes', '0'], // must be above 0
    ['runMinutes', '241'],
    ['runMinutes', '5h'], // 300 min
    ['maxMinutesPerDay', '1441'],
    ['cooldownMinutes', '10081'],
    ['runMinutes', '12.25'], // one decimal at most
    ['runMinutes', '1e2'],
    ['runMinutes', '0x10'],
    ['runMinutes', 'Infinity'],
    ['runMinutes', 'NaN'],
    ['runMinutes', '12,5'],
    ['runMinutes', '12 13'],
    ['runMinutes', ''],
    ['runMinutes', 'twelve'],
    ['runMinutes', '123456'],
    ['runMinutes', '１２'], // full-width digits
  ])('%s: refuses %j', (key, text) => {
    expect(parseSetting(text, field(key))).toEqual({ problem: expect.stringMatching(new RegExp(`^${key} must be a number`)) });
  });

  it('never echoes what was sent', () => {
    const result = parseSetting('<script>', field('runMinutes'));
    expect(JSON.stringify(result)).not.toContain('script');
  });

  it('has a field for every editable setting, in order', () => {
    expect(FIELDS.map((f) => f.key)).toEqual([...EDITABLE_ZONE_RULES]);
  });
});

describe('/config', () => {
  let dir: string;
  let path: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'config-command-'));
    path = join(dir, 'conductor.json');
    vi.spyOn(log, 'info').mockImplementation(() => {});
    vi.spyOn(log, 'error').mockImplementation(() => {});
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const setup = async (file: unknown = TWO_ZONES) => {
    await writeFile(path, JSON.stringify(file, null, 2));
    const config: ConductorConfig = parseConductorConfig(file);
    const editor = new ConfigEditor({ path, config });
    const command = buildConfigCommand({ editor });
    return { config, editor, command, begin: () => Promise.resolve(command.begin(OWNER, '')) };
  };
  const onDisk = async () => JSON.parse(await readFile(path, 'utf8')) as typeof TWO_ZONES;

  it('is a mutable command', async () => {
    const t = await setup();
    expect(t.command).toMatchObject({ kind: 'mutable', name: 'config' });
    expect(t.command.description).toContain('passphrase');
  });

  it('asks which zone first when there are several', async () => {
    const t = await setup();
    const step = await t.begin();
    expect(step).toMatchObject({
      kind: 'input',
      text: '⚙️ <b>Which zone?</b>\n1. Front lawn\n2. Back lawn\n\nReply its number, or <b>cancel</b>.',
      hint: 'Reply a number from 1 to 2, or cancel.',
    });
    expect(await answer(step, '3')).toBe('That is not one of the zones.');
    expect(await answer(step, '0')).toBe('That is not one of the zones.');
    expect(await answer(step, 'Side lawn')).toBe('That is not one of the zones.');
    expect((await next(step, '2')).text).toContain('⚙️ <b>Back lawn</b>: settings in use');
    expect((await next(step, 'back LAWN')).text).toContain('⚙️ <b>Back lawn</b>: settings in use');
  });

  it('goes straight to the settings when there is one zone, showing them all first', async () => {
    const t = await setup(ONE_ZONE_DERIVING);
    const step = await t.begin();
    expect(step.kind).toBe('input');
    expect(step.text).toBe(
      [
        '⚙️ <b>Beds</b>: settings in use',
        '• thresholdPct: 30%',
        '• targetPct: 40%',
        '• runMinutes: 10 min',
        '• maxMinutesPerDay: 30 min',
        '• cooldownMinutes: 240 min (4 h)',
        '• maxCycleMinutes: 20 min',
        '• soakMinutes: 30 min',
        '',
        'For each one, reply a new value, <b>next</b> to keep it, <b>back</b>, <b>done</b> to finish, or <b>cancel</b>.',
        '',
        '1/7 <b>thresholdPct</b>: Water when the soil is below this.',
        'Now <b>30%</b>. Allowed: 0 to 100.',
      ].join('\n'),
    );
  });

  it('says so when there are no zones', async () => {
    const editor = { zones: () => [], preview: vi.fn(), apply: vi.fn() };
    expect(await buildConfigCommand({ editor }).begin(OWNER, '')).toEqual({ kind: 'done', text: 'No zones are configured.' });
  });

  it('walks through every setting, then shows the changes and asks for the passphrase', async () => {
    const t = await setup();
    let step = await next(await t.begin(), '1');
    const prompts: string[] = [];
    for (const reply of ['28', 'next', '12', 'next', '3h', 'next', 'next']) {
      prompts.push(step.text.split('\n').find((l) => /^\d\/7 /.test(l)) ?? '');
      step = await next(step, reply);
    }
    expect(prompts).toEqual([
      '1/7 <b>thresholdPct</b>: Water when the soil is below this.',
      '2/7 <b>targetPct</b>: Refill level: watering never goes above it.',
      '3/7 <b>runMinutes</b>: Length of a run (when no forecast is used).',
      '4/7 <b>maxMinutesPerDay</b>: Most watering in any 24 hours.',
      '5/7 <b>cooldownMinutes</b>: Least time between two runs.',
      '6/7 <b>maxCycleMinutes</b>: Longest single run; longer ones are split into cycles.',
      '7/7 <b>soakMinutes</b>: Pause between cycles, for the water to soak in.',
    ]);
    expect(step.kind).toBe('passphrase');
    expect(step.text).toBe(
      [
        '⚙️ <b>Front lawn</b>: changes to save',
        '• thresholdPct: 30% → <b>28%</b>',
        '• runMinutes: 10 min → <b>12 min</b>',
        '• cooldownMinutes: 240 min (4 h) → <b>180 min (3 h)</b>',
        '',
        '💧 <b>More watering</b>: runMinutes, cooldownMinutes.',
        '',
        'They are saved to conductor.json and used from the next poll. Watering already under way keeps its plan.',
        '',
        '🔐 Send the passphrase to save, or <b>cancel</b>.',
      ].join('\n'),
    );
    // Nothing saved before the passphrase.
    expect(await onDisk()).toEqual(TWO_ZONES);
    expect(t.config.zones[0]?.thresholdPct).toBe(30);

    const result = await run(step);

    expect(result).toBe(
      [
        '✅ <b>Saved</b> for Front lawn:',
        '• thresholdPct: 30% → <b>28%</b>',
        '• runMinutes: 10 min → <b>12 min</b>',
        '• cooldownMinutes: 240 min (4 h) → <b>180 min (3 h)</b>',
        '',
        'Used from the next poll.',
      ].join('\n'),
    );
    expect((await onDisk()).zones[0]).toEqual({ ...TWO_ZONES.zones[0], thresholdPct: 28, runMinutes: 12, cooldownMinutes: 180 });
    expect(t.config.zones[0]).toMatchObject({ thresholdPct: 28, runMinutes: 12, cooldownMinutes: 180 });
  });

  it('"done" skips the rest and goes to the summary', async () => {
    const t = await setup();
    const step = await next(await t.begin(), '1', 'next', '45', 'done');
    expect(step.kind).toBe('passphrase');
    expect(step.text).toContain('• targetPct: 40% → <b>45%</b>');
  });

  it('"back" goes to the previous setting, showing the value entered and the one in use', async () => {
    const t = await setup();
    const first = await next(await t.begin(), '1');
    expect(await answer(first, 'back')).toBe('This is the first setting.');
    const second = await next(first, '28');
    const again = await next(second, 'back');
    expect(again.text).toContain('1/7 <b>thresholdPct</b>');
    expect(again.text).toContain('Now <b>28%</b> (was 30%).');
    const fixed = await next(again, '29', 'done');
    expect(fixed.text).toContain('• thresholdPct: 30% → <b>29%</b>');
  });

  it('entering the value in use is not a change', async () => {
    const t = await setup();
    const step = await next(await t.begin(), '1', '28', 'back', '30', 'done');
    expect(step).toEqual({ kind: 'done', text: '⚙️ No changes for Front lawn: nothing was saved.' });
  });

  it('ends without the passphrase when nothing was changed', async () => {
    const t = await setup();
    expect(await next(await t.begin(), '1', 'done')).toEqual({ kind: 'done', text: '⚙️ No changes for Front lawn: nothing was saved.' });
  });

  it('refuses a bad value and asks again, without losing what was entered', async () => {
    const t = await setup();
    const step = await next(await t.begin(), '1', '28');
    expect(await answer(step, '150')).toBe('targetPct must be a number 0 to 100 (%), with at most one decimal.');
    expect(await answer(step, 'lots')).toMatch(/^targetPct must be a number/);
    const summary = await next(step, 'done');
    expect(summary.text).toContain('• thresholdPct: 30% → <b>28%</b>');
  });

  it('shows the settings that follow from a change', async () => {
    const t = await setup(ONE_ZONE_DERIVING);
    const step = await next(await t.begin(), '35', 'done');
    expect(step.text).toContain(
      [
        '• thresholdPct: 30% → <b>35%</b>',
        '• targetPct: 40% → <b>45%</b> <i>(follows from your changes)</i>',
        '• criticalLowPct: 20% → <b>25%</b> <i>(follows from your changes)</i>',
        '• criticalHighPct: 60% → <b>65%</b> <i>(follows from your changes)</i>',
      ].join('\n'),
    );
  });

  it('does not warn about more watering for changes that mean less', async () => {
    const t = await setup();
    const step = await next(await t.begin(), '1', '25', 'next', '8', 'next', '300', 'done');
    expect(step.text).not.toContain('More watering');
  });

  it("explains values that don't fit together, and lets them be fixed, keeping what was entered", async () => {
    const t = await setup();
    const bad = await next(await t.begin(), '1', '45', 'done');
    expect(bad).toMatchObject({
      kind: 'ask',
      text:
        "⚠️ <b>These values don't fit together:</b>\n• targetPct (40) must be above thresholdPct (45)\n\n" +
        'Reply <b>edit</b> to go through the settings again (your new values are kept), or <b>cancel</b>.',
    });
    const edit = await next(bad, 'edit');
    expect(edit.text).toContain('Now <b>45%</b> (was 30%).');
    const fixed = await next(edit, 'next', '55', 'done');
    expect(fixed.kind).toBe('passphrase');
    await run(fixed);
    expect((await onDisk()).zones[0]).toMatchObject({ thresholdPct: 45, targetPct: 55 });
  });

  it('stops, changing nothing, when conductor.json was edited by hand', async () => {
    const t = await setup();
    const step = await next(await t.begin(), '1', '28');
    await writeFile(path, JSON.stringify({ ...TWO_ZONES, defaults: { ...TWO_ZONES.defaults, thresholdPct: 33 } }));

    const end = await next(step, 'done');

    expect(end).toEqual({ kind: 'done', text: expect.stringMatching(/^⚠️ The settings can't be changed right now:\n• .*has changed since the conductor started.*\nNothing changed\.$/s) });
  });

  it('reports, as a failure, a change that could not be saved after the passphrase', async () => {
    const t = await setup();
    const step = await next(await t.begin(), '1', '28', 'done');
    await writeFile(path, '{ broken');

    const result = await run(step);

    expect(result).toEqual({ text: expect.stringMatching(/^❌ <b>Not saved<\/b>:\n• could not read .*\nNothing changed\.$/s), error: expect.stringMatching(/^could not read/) });
    expect(t.config.zones[0]?.thresholdPct).toBe(30);
  });

  it('says so if, by the time of the passphrase, there was nothing left to change', async () => {
    const zone: ZoneSettings = { key: 'dev1:1', name: 'Front', values: { thresholdPct: 30, targetPct: 40, runMinutes: 10, maxMinutesPerDay: 30, cooldownMinutes: 240, maxCycleMinutes: 20, soakMinutes: 30 } };
    const change: ConfigCheck = { ok: true, zone: { key: 'dev1:1', name: 'Front' }, changes: [{ key: 'runMinutes', from: 10, to: 12, derived: false }] };
    const editor = {
      zones: () => [zone],
      preview: vi.fn(async () => change),
      apply: vi.fn(async (): Promise<ConfigCheck> => ({ ok: true, zone: { key: 'dev1:1', name: 'Front' }, changes: [] })),
    };
    const command: MutableCommand = buildConfigCommand({ editor });
    const step = await next(await command.begin(OWNER, ''), 'next', 'next', '12', 'done');

    expect(await run(step)).toBe('⚙️ No changes for Front: nothing was saved.');
    expect(editor.apply).toHaveBeenCalledWith('dev1:1', { runMinutes: 12 }, '@owner via Telegram');
  });

  it('only ever passes the editable settings, as numbers, to the editor', async () => {
    const t = await setup();
    const preview = vi.spyOn(t.editor, 'preview');
    await next(await t.begin(), '1', '28', '45', '12', '60', '4h', '15', '20');
    // 4h = 240 min is the cooldown in use, so it isn't a change.
    expect(preview.mock.calls).toEqual([['dev1:1', { thresholdPct: 28, targetPct: 45, runMinutes: 12, maxMinutesPerDay: 60, maxCycleMinutes: 15, soakMinutes: 20 }]]);
  });

  it('escapes zone names and problems', async () => {
    const evil = '<b>x</b> & <script>';
    const editor = {
      zones: () => [
        { key: 'a', name: evil, values: { thresholdPct: 30, targetPct: 40, runMinutes: 10, maxMinutesPerDay: 30, cooldownMinutes: 240, maxCycleMinutes: 20, soakMinutes: 30 } },
        { key: 'b', name: evil, values: { thresholdPct: 30, targetPct: 40, runMinutes: 10, maxMinutesPerDay: 30, cooldownMinutes: 240, maxCycleMinutes: 20, soakMinutes: 30 } },
      ],
      preview: vi.fn(async (): Promise<ConfigCheck> => ({ ok: false, reason: 'invalid', problems: [evil] })),
      apply: vi.fn(),
    };
    const command = buildConfigCommand({ editor });
    const pick = await command.begin(OWNER, '');
    wellFormed(pick.text);
    const walk = await next(pick, '1');
    wellFormed(walk.text);
    wellFormed((await next(walk, '28', 'done')).text);
  });

  it('formats a change', () => {
    expect(formatChange({ key: 'maxMinutesPerDay', from: 30, to: 120, derived: false })).toBe('• maxMinutesPerDay: 30 min → <b>120 min (2 h)</b>');
  });
});
