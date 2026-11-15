import { inspect } from 'node:util';
import { describe, expect, it, vi } from 'vitest';
import { actorName, ANSWER_WORDS, ask, CANCEL_WORDS, confirm, done, normalizeAnswer, passphraseStep, via, YES_WORDS, type Step } from '../../bot/conversation.ts';
import { Passphrase, passphraseProblem } from '../../bot/gate.ts';

const SECRET = 'correct horse battery';

describe('normalizeAnswer', () => {
  it.each([
    ['yes', 'yes'],
    ['  Yes ', 'yes'],
    ['YES!', 'yes'],
    ['yes?!', 'yes'],
    ['Cancel.', 'cancel'],
    ['yes please', 'yes please'], // not forgiven: it isn't exactly an answer
    ['y e s', 'y e s'],
    ['!yes', '!yes'],
    ['', ''],
  ])('%j → %j', (text, expected) => {
    expect(normalizeAnswer(text)).toBe(expected);
  });
});

describe('answer words', () => {
  it('never overlap between "yes" and "cancel"', () => {
    for (const w of YES_WORDS) expect(CANCEL_WORDS.has(w)).toBe(false);
  });

  it('include every word any question accepts', () => {
    for (const w of [...YES_WORDS, ...CANCEL_WORDS, 'continue', 'discard', '1', '2']) expect(ANSWER_WORDS.has(w)).toBe(true);
  });
});

describe('actorName', () => {
  it('prefers the username', () => {
    expect(actorName({ id: 42, username: 'owner' })).toBe('@owner');
    expect(actorName({ id: 42 })).toBe('user 42');
  });
});

describe('passphraseProblem', () => {
  it.each([SECRET, 'abcdefgh', 'ünïcødé-pässphrase', 'x'.repeat(256), 'has inner  spaces'])('accepts %j', (p) => {
    expect(passphraseProblem(p)).toBeUndefined();
  });

  it.each([
    ['short', 'must be at least 8 characters'],
    ['x'.repeat(257), 'must be at most 256 characters'],
    [' leading-space', 'must not start or end with spaces'],
    ['trailing-space ', 'must not start or end with spaces'],
    ['/command-like', 'must not start with "/"'],
    ['continue', 'must not be an answer word such as "continue"'],
    ['CONTINUE!', 'must not be an answer word such as "continue"'],
    // Would be read as the answer "continue" at the passphrase question, never checked as the passphrase.
    ['continue!!', 'must not be an answer word such as "continue"'],
  ])('rejects %j: %s', (p, problem) => {
    expect(passphraseProblem(p)).toBe(problem);
  });

  it('never includes the passphrase in the problem', () => {
    for (const p of ['sh0rt', ' secret-with-space', '/secret-slash']) expect(passphraseProblem(p)).not.toContain(p.trim());
  });
});

describe('Passphrase', () => {
  it('matches exactly, ignoring only surrounding spaces', () => {
    const p = new Passphrase(SECRET);
    expect(p.matches(SECRET)).toBe(true);
    expect(p.matches(`  ${SECRET}\n`)).toBe(true);
    expect(p.matches(SECRET.toUpperCase())).toBe(false);
    expect(p.matches(`${SECRET}x`)).toBe(false);
    expect(p.matches(SECRET.slice(0, -1))).toBe(false);
    expect(p.matches('correct  horse battery')).toBe(false);
    expect(p.matches('')).toBe(false);
    expect(p.matches('x'.repeat(100_000))).toBe(false);
  });

  it('cannot be searched for in other text (that would make deleting messages a guessing oracle)', () => {
    expect('occursIn' in new Passphrase(SECRET)).toBe(false);
  });

  it('refuses an unusable passphrase with a message that does not contain it', () => {
    expect(() => new Passphrase('tiny')).toThrow('TELEGRAM_COMMAND_PASSPHRASE must be at least 8 characters');
    try {
      new Passphrase(' secret-value');
    } catch (err) {
      expect(String(err)).not.toContain('secret-value');
    }
  });

  it('never shows the passphrase when logged, serialised or inspected', () => {
    const p = new Passphrase(SECRET);
    expect(String(p)).toBe('[passphrase]');
    expect(`${p}`).toBe('[passphrase]');
    expect(JSON.stringify({ p })).toBe('{"p":"[passphrase]"}');
    expect(inspect(p, { showHidden: true, depth: 5 })).not.toContain('horse');
  });
});

describe('step builders', () => {
  const read = async (step: Step, answer: string) => {
    if (step.kind !== 'input') throw new Error(step.kind);
    return step.read(answer);
  };

  it('done', () => {
    expect(done('bye')).toEqual({ kind: 'done', text: 'bye' });
  });

  it('ask: picks a choice by any of its words (forgiving case and punctuation), and says which', async () => {
    const next = vi.fn(() => done('picked'));
    const step = ask({ text: 'Which?', hint: 'Reply a or b.', choices: [{ words: ['a', '1'], label: 'first', next }, { words: ['b'], label: 'second', next: () => done('b') }] });

    expect(step).toMatchObject({ kind: 'input', text: 'Which?', hint: 'Reply a or b.' });
    expect(await read(step, ' A! ')).toEqual({ next: done('picked'), choice: 'first' });
    expect(await read(step, '1')).toEqual({ next: done('picked'), choice: 'first' });
    expect(await read(step, 'b')).toEqual({ next: done('b'), choice: 'second' });
  });

  it('ask: anything else is not understood (without saying what was typed)', async () => {
    const step = ask({ text: 'Which?', hint: 'h', choices: [{ words: ['a'], label: 'a', next: () => done('a') }] });
    expect(await read(step, 'c')).toEqual({});
    expect(await read(step, 'a please')).toEqual({});
  });

  it('ask: works out the next step only when chosen', async () => {
    const next = vi.fn(() => done('x'));
    const step = ask({ text: 'Q', hint: 'h', choices: [{ words: ['a'], label: 'a', next }] });
    await read(step, 'nope?');
    expect(next).not.toHaveBeenCalled();
  });

  it('confirm: yes (or y, ok, confirm) goes on', async () => {
    const step = confirm({ text: 'Sure?', hint: 'yes or cancel', then: () => done('go') });
    for (const word of YES_WORDS) expect(await read(step, word)).toEqual({ next: done('go'), choice: 'yes' });
    expect(await read(confirm({ text: 'Sure?', hint: 'h', label: 'discard', then: () => done('go') }), 'yes')).toMatchObject({ choice: 'discard' });
    expect(await read(step, 'sure')).toEqual({});
  });

  it('passphraseStep', async () => {
    const run = vi.fn(async () => 'ran');
    expect(passphraseStep({ action: 'pause', run })).toEqual({ kind: 'passphrase', text: '🔐 Send the passphrase to pause, or <b>cancel</b>.', run });
    expect(passphraseStep({ intro: 'Sure?\n', action: 'save', run }).text).toBe('Sure?\n🔐 Send the passphrase to save, or <b>cancel</b>.');
  });

  it('via', () => {
    expect(via({ id: 1, username: 'owner' })).toBe('@owner via Telegram');
    expect(via({ id: 7 })).toBe('user 7 via Telegram');
  });
});

describe('normalizeAnswer on hostile input', () => {
  it('takes linear time on a long run of punctuation (no regex backtracking)', () => {
    const started = performance.now();
    expect(normalizeAnswer(`${'.'.repeat(200_000)}x`)).toHaveLength(200_001);
    expect(normalizeAnswer(`x${'!'.repeat(200_000)}`)).toBe('x');
    expect(performance.now() - started).toBeLessThan(200);
  });
});
