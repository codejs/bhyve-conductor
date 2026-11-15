import { describe, expect, it, vi } from 'vitest';
import { buildControlCommands, formatPaused, formatResumed, type ConductorControl } from '../../bot/control.ts';
import type { MutableCommand, Step } from '../../bot/conversation.ts';
import type { ConductorStatus, PauseResult, ResumeResult, SequenceStatus } from '../../conductor/monitor.ts';
import { minutesAgo, NOW } from '../utils/conductor.ts';

const MIN = 60_000;
const OWNER = { id: 4242, username: 'owner' };
const at = (d: Date) => d.toISOString().slice(11, 16);
const wellFormed = (html: string) => expect(html.replace(/<\/?(b|i|code)>/g, '')).not.toMatch(/[<>]/);
const EVIL = '<b>x</b> & <script>';

const sequence = (overrides: Partial<SequenceStatus> = {}): SequenceStatus => ({
  id: 'seq1',
  deviceId: 'dev1',
  zoneNames: ['Front lawn'],
  nextCycle: 2,
  cycles: 3,
  dueAt: new Date(NOW.getTime() + 25 * MIN),
  attempts: 0,
  stale: false,
  ...overrides,
});

const status = (overrides: Partial<ConductorStatus> = {}): ConductorStatus => ({
  at: NOW,
  running: true,
  dryRun: false,
  pollIntervalMinutes: 15,
  polling: false,
  zones: [],
  sequences: [],
  wateringNow: [],
  outages: [],
  alerts: [],
  ...overrides,
});

const setup = (s: ConductorStatus = status()) => {
  const pauseResult: PauseResult = { changed: true, paused: { since: NOW, by: '@owner via Telegram' }, held: [], wateringNow: [], sendInProgress: false };
  const resumeResult: ResumeResult = { changed: true, pausedMinutes: 30, continued: [], discarded: [] };
  const control = {
    status: vi.fn(() => s),
    pause: vi.fn(async (_by: string) => pauseResult),
    resume: vi.fn(async (_by: string, _held: 'continue' | 'discard') => resumeResult),
  } satisfies ConductorControl;
  const [pause, resume] = buildControlCommands({ control, timeZone: 'UTC' }) as [MutableCommand, MutableCommand];
  return { control, pause, resume };
};

const begin = async (c: MutableCommand) => c.begin(OWNER, '');
/** Answers a question; returns the next step and what was chosen, or undefined if the answer isn't understood. */
const answer = async (step: Step, word: string): Promise<{ next: Step; choice?: string } | undefined> => {
  if (step.kind !== 'input') throw new Error(`expected a question, got ${step.kind}`);
  const result = await step.read(word);
  return 'next' in result ? result : undefined;
};
const choose = async (step: Step, word: string): Promise<Step> => {
  const result = await answer(step, word);
  if (!result) throw new Error(`no choice for ${word}`);
  return result.next;
};
const run = async (step: Step): Promise<string> => {
  if (step.kind !== 'passphrase') throw new Error(`expected the passphrase step, got ${step.kind}`);
  const result = await step.run();
  return typeof result === 'string' ? result : result.text;
};

describe('control commands', () => {
  it('are /pause and /resume, both mutable and saying they need the passphrase', () => {
    const { pause, resume } = setup();
    expect([pause.name, resume.name]).toEqual(['pause', 'resume']);
    for (const c of [pause, resume]) {
      expect(c.kind).toBe('mutable');
      expect(c.description).toContain('passphrase');
    }
  });

  describe('/pause', () => {
    it('when nothing is watering: straight to the passphrase', async () => {
      const t = setup();
      const step = await begin(t.pause);

      expect(step).toEqual({
        kind: 'passphrase',
        text: '⏸️ Pause automatic watering? Nothing is being watered right now.\n🔐 Send the passphrase to pause, or <b>cancel</b>.',
        run: expect.any(Function),
      });
      expect(t.control.pause).not.toHaveBeenCalled();

      await run(step);
      expect(t.control.pause).toHaveBeenCalledWith('@owner via Telegram');
    });

    it('names the user by id when they have no username', async () => {
      const t = setup();
      await run(await t.pause.begin({ id: 77 }, ''));
      expect(t.control.pause).toHaveBeenCalledWith('user 77 via Telegram');
    });

    it('when watering is in progress: asks to confirm first, explaining what a pause does and does not do', async () => {
      const t = setup(
        status({
          sequences: [sequence(), sequence({ id: 's2', deviceId: 'dev2', zoneNames: [], dueAt: minutesAgo(3), nextCycle: 1, cycles: 2 })],
          wateringNow: [{ deviceId: 'dev1', zoneNames: ['Front lawn'], cycle: 1, of: 3, until: new Date(NOW.getTime() + 8 * MIN) }],
        }),
      );
      const step = await begin(t.pause);

      expect(step.kind).toBe('input');
      if (step.kind !== 'input') return;
      expect(step.text).toBe(
        [
          '⚠️ <b>Watering in progress</b>',
          '• Front lawn: cycle 2/3, next cycle at Jul 1, 12:25',
          '• dev2: cycle 1/2, next cycle due since Jul 1, 11:57',
          '• 💧 Front lawn: water on until Jul 1, 12:08 (cycle 1/3)',
          '',
          'Pausing holds the remaining cycles until /resume. Water that is already on is <b>not</b> turned off (use the B-hyve app to stop it now).',
          '',
          'Pause anyway? Reply <b>yes</b> or <b>cancel</b>.',
        ].join('\n'),
      );
      expect(step.hint).toBe('Reply yes to pause, or cancel.');
      for (const word of ['yes', 'Y', 'ok!', 'confirm']) expect(await answer(step, word)).toMatchObject({ choice: 'yes', next: { kind: 'passphrase' } });
      for (const word of ['maybe', 'continue', 'yes please']) expect(await answer(step, word)).toBeUndefined();

      const next = await choose(step, 'yes');
      expect(next).toMatchObject({ kind: 'passphrase', text: '🔐 Send the passphrase to pause, or <b>cancel</b>.' });
      expect(t.control.pause).not.toHaveBeenCalled(); // only after the passphrase
      await run(next);
      expect(t.control.pause).toHaveBeenCalledOnce();
    });

    it('asks to confirm when only water from a finished sequence is still on', async () => {
      const t = setup(status({ wateringNow: [{ deviceId: 'dev1', zoneNames: ['Front'], cycle: 3, of: 3, until: new Date(NOW.getTime() + MIN) }] }));
      const step = await begin(t.pause);
      expect(step.kind).toBe('input');
      expect(step.text).toMatch(/^⚠️ <b>Watering in progress<\/b>/);
    });

    it('when already paused: says so, without asking for the passphrase', async () => {
      const t = setup(status({ paused: { since: minutesAgo(90), by: '@family via Telegram' } }));
      expect(await begin(t.pause)).toEqual({
        kind: 'done',
        text: '⏸️ Already paused since Jul 1, 10:30 (by @family via Telegram). Send /resume to resume.',
      });
    });

    it('escapes names in the question', async () => {
      const t = setup(
        status({
          sequences: [sequence({ zoneNames: [EVIL] })],
          wateringNow: [{ deviceId: EVIL, zoneNames: [], cycle: 1, of: 1, until: NOW }],
        }),
      );
      const step = await begin(t.pause);
      wellFormed(step.text);
    });
  });

  describe('/resume', () => {
    const paused = { since: minutesAgo(45), by: '@owner via Telegram' };

    it('when not paused: says so, without asking for the passphrase', async () => {
      const t = setup();
      expect(await begin(t.resume)).toEqual({ kind: 'done', text: '▶️ Not paused: automatic watering is on. Nothing to resume.' });
    });

    it('with nothing on hold: straight to the passphrase', async () => {
      const t = setup(status({ paused }));
      const step = await begin(t.resume);

      expect(step).toMatchObject({
        kind: 'passphrase',
        text: '▶️ Resume automatic watering? Paused since Jul 1, 11:15 by @owner via Telegram.\n🔐 Send the passphrase to resume, or <b>cancel</b>.',
      });
      await run(step);
      expect(t.control.resume).toHaveBeenCalledWith('@owner via Telegram', 'discard');
    });

    it('with watering on hold: asks whether to continue or discard it', async () => {
      const t = setup(status({ paused, sequences: [sequence()] }));
      const step = await begin(t.resume);

      expect(step.kind).toBe('input');
      if (step.kind !== 'input') return;
      expect(step.text).toBe(
        [
          'Paused since Jul 1, 11:15 by @owner via Telegram.',
          '<b>Watering on hold</b>:',
          '• Front lawn: cycle 2/3, next cycle at Jul 1, 12:25',
          '',
          'Reply:',
          '<b>continue</b>: continue the watering on hold, and resume',
          '<b>discard</b>: cancel the watering on hold, and resume (the zones are re-checked against their sensors)',
          '<b>cancel</b>: stay paused',
        ].join('\n'),
      );
      expect(step.hint).toBe('Reply continue, discard or cancel.');
      for (const [word, choice] of [['continue', 'continue'], ['1', 'continue'], ['discard', 'discard'], ['2', 'discard']]) {
        expect(await answer(step, word ?? '')).toMatchObject({ choice });
      }
      expect(await answer(step, 'yes')).toBeUndefined(); // "yes" would be ambiguous here
    });

    it.each([
      ['continue', 'continue', '▶️ Resume and continue the watering on hold.\n🔐 Send the passphrase to resume, or <b>cancel</b>.'],
      ['1', 'continue', '▶️ Resume and continue the watering on hold.\n🔐 Send the passphrase to resume, or <b>cancel</b>.'],
      ['discard', 'discard', '▶️ Resume and cancel the watering on hold.\n🔐 Send the passphrase to resume, or <b>cancel</b>.'],
      ['2', 'discard', '▶️ Resume and cancel the watering on hold.\n🔐 Send the passphrase to resume, or <b>cancel</b>.'],
    ] as const)('"%s" → resume and %s, after the passphrase', async (word, held, text) => {
      const t = setup(status({ paused, sequences: [sequence()] }));
      const next = await choose(await begin(t.resume), word);

      expect(next).toMatchObject({ kind: 'passphrase', text });
      expect(t.control.resume).not.toHaveBeenCalled();
      await run(next);
      expect(t.control.resume).toHaveBeenCalledWith('@owner via Telegram', held);
    });

    it('flags held watering that is too old to continue, alongside what can be continued', async () => {
      const t = setup(status({ paused, sequences: [sequence(), sequence({ id: 's2', zoneNames: ['Back lawn'], stale: true })] }));
      const step = await begin(t.resume);
      expect(step.text).toContain('• Front lawn: cycle 2/3, next cycle at Jul 1, 12:25\n• Back lawn: cycle 2/3, too late to continue; it will be cancelled');
    });

    it('when everything on hold is too old to continue: only offers to cancel it and resume', async () => {
      const t = setup(status({ paused, sequences: [sequence({ stale: true, dueAt: minutesAgo(200) })] }));
      const step = await begin(t.resume);

      expect(step.kind).toBe('input');
      if (step.kind !== 'input') return;
      expect(step.text).toBe(
        [
          'Paused since Jul 1, 11:15 by @owner via Telegram.',
          '<b>Watering on hold</b>, paused too long ago to continue safely:',
          '• Front lawn: cycle 2/3, too late to continue; it will be cancelled',
          'It will be cancelled, and the zones re-checked against their sensors.',
          '',
          'Resume? Reply <b>yes</b> or <b>cancel</b>.',
        ].join('\n'),
      );
      await run(await choose(step, 'yes'));
      expect(t.control.resume).toHaveBeenCalledWith('@owner via Telegram', 'discard');
    });

    it('escapes names in the question', async () => {
      const t = setup(status({ paused: { since: NOW, by: EVIL }, sequences: [sequence({ zoneNames: [EVIL] }), sequence({ deviceId: EVIL, zoneNames: [], stale: true })] }));
      wellFormed((await begin(t.resume)).text);
    });
  });

  it('reads the state afresh on every begin (no stale snapshot)', async () => {
    const t = setup();
    await begin(t.pause);
    await begin(t.resume);
    expect(t.control.status).toHaveBeenCalledTimes(2);
  });
});

describe('formatPaused', () => {
  const base: PauseResult = { changed: true, paused: { since: NOW, by: '@owner via Telegram' }, held: [], wateringNow: [], sendInProgress: false };

  it('confirms the pause and what still happens', () => {
    expect(formatPaused(base, at)).toBe(
      '⏸️ <b>Paused</b> by @owner via Telegram. No supplemental watering until /resume.\n' +
        'Sensors are still read and alerts still sent; your B-hyve schedule runs as usual.',
    );
  });

  it('lists what is on hold, what is still on, and a send that was under way', () => {
    const html = formatPaused(
      {
        ...base,
        held: [sequence(), sequence({ zoneNames: [], deviceId: 'dev9' })],
        wateringNow: [{ deviceId: 'dev1', zoneNames: ['Front lawn'], cycle: 1, of: 3, until: new Date(NOW.getTime() + 8 * MIN) }],
        sendInProgress: true,
      },
      at,
    );
    expect(html).toContain('<b>On hold</b> (/resume can continue or cancel it):\n• Front lawn: cycle 2/3\n• dev9: cycle 2/3');
    expect(html).toContain('💧 <b>Still on</b> (not turned off; use the B-hyve app to stop it now):\n• Front lawn until 12:08');
    expect(html).toContain('⚠️ A cycle was being sent at that moment and may still start.');
  });

  it('says when it was already paused', () => {
    expect(formatPaused({ ...base, changed: false }, at)).toBe('⏸️ Already paused since 12:00 (by @owner via Telegram).');
  });

  it('escapes', () => {
    wellFormed(formatPaused({ ...base, paused: { since: NOW, by: EVIL }, held: [sequence({ zoneNames: [EVIL] })], wateringNow: [{ deviceId: EVIL, zoneNames: [], cycle: 1, of: 1, until: NOW }] }, at));
  });
});

describe('formatResumed', () => {
  it('confirms, with what was continued and cancelled', () => {
    const html = formatResumed({
      changed: true,
      pausedMinutes: 150,
      continued: [sequence()],
      discarded: [{ sequence: sequence({ zoneNames: [], deviceId: 'dev2' }), reason: 'too late to continue after the pause: cycle 2 was due 80 min ago' }],
    });
    expect(html).toBe(
      [
        '▶️ <b>Resumed</b> after 2.5 h. Automatic watering is on; the zones are being checked now.',
        '',
        '<b>Continued</b>:',
        '• Front lawn: cycle 2/3',
        '',
        '<b>Cancelled</b>:',
        '• dev2: too late to continue after the pause: cycle 2 was due 80 min ago',
      ].join('\n'),
    );
  });

  it('says when there was nothing to resume', () => {
    expect(formatResumed({ changed: false, pausedMinutes: 0, continued: [], discarded: [] })).toBe('▶️ Not paused anymore: nothing to do.');
  });

  it('escapes', () => {
    wellFormed(formatResumed({ changed: true, pausedMinutes: 1, continued: [sequence({ zoneNames: [EVIL] })], discarded: [{ sequence: sequence(), reason: EVIL }] }));
  });
});
