import { inspect } from 'node:util';
import { describe, expect, it } from 'vitest';
import { actorName, ANSWER_WORDS, CANCEL_WORDS, normalizeAnswer, Passphrase, passphraseProblem, YES_WORDS } from '../../bot/conversation.ts';

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

  it('finds it inside other text', () => {
    const p = new Passphrase(SECRET);
    expect(p.occursIn(`/pause ${SECRET}`)).toBe(true);
    expect(p.occursIn(`my pass is ${SECRET}!`)).toBe(true);
    expect(p.occursIn('correct horse')).toBe(false);
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
