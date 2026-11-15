import { inspect } from 'node:util';
import { describe, expect, it } from 'vitest';
import { classifyAttempt, MIN_PASSPHRASE_LENGTH, PassphraseGate } from '../../bot/gate.ts';

const PASS = 'correct horse battery';
const MIN = 60_000;
const HOUR = 60 * MIN;
const gate = (overrides: Partial<ConstructorParameters<typeof PassphraseGate>[1]> = {}) =>
  new PassphraseGate(PASS, { maxFailures: 3, failureWindowMs: 15 * MIN, lockoutMs: 15 * MIN, maxLockoutMs: 24 * HOUR, ...overrides });

describe('classifyAttempt', () => {
  it.each([
    ['yes', 'answer-word'],
    ['Cancel!', 'answer-word'],
    ['continue', 'answer-word'],
    ['problems', 'answer-word'],
    ['28', 'too-short'],
    ['1234567', 'too-short'],
    ['   abc   ', 'too-short'],
    ['12345678', 'attempt'],
    [PASS, 'attempt'],
    ['yes please', 'attempt'],
    ['x'.repeat(5000), 'attempt'],
  ] as const)('%j → %s', (text, kind) => {
    expect(classifyAttempt(text)).toBe(kind);
  });

  it('never depends on the passphrase (it has no access to it)', () => {
    // The same text is classified the same way whatever the passphrase is.
    expect(classifyAttempt.length).toBe(1);
    expect(MIN_PASSPHRASE_LENGTH).toBe(8);
  });
});

describe('PassphraseGate', () => {
  it('accepts the passphrase', () => {
    expect(gate().check(PASS, 0)).toEqual({ ok: true });
    expect(gate().check(`  ${PASS}  `, 0)).toEqual({ ok: true });
  });

  it('counts wrong attempts, and locks after too many', () => {
    const g = gate();
    expect(g.check('wrong-one-1', 0)).toEqual({ ok: false, failures: 1 });
    expect(g.check('wrong-one-2', MIN)).toEqual({ ok: false, failures: 2 });
    expect(g.check('wrong-one-3', 2 * MIN)).toEqual({ ok: false, failures: 3, lockedForMs: 15 * MIN });
    expect(g.lockedForMs(2 * MIN)).toBe(15 * MIN);
    expect(g.lockedForMs(10 * MIN)).toBe(7 * MIN);
    expect(g.lockedForMs(17 * MIN)).toBe(0);
  });

  it('refuses even the right passphrase while locked, without counting it', () => {
    const g = gate({ maxFailures: 1 });
    g.check('wrong-one-1', 0);

    expect(g.check(PASS, MIN)).toEqual({ ok: false, failures: 0, lockedForMs: 14 * MIN, alreadyLocked: true });
    expect(g.check(PASS, 15 * MIN)).toEqual({ ok: true });
  });

  it('only counts failures within the window', () => {
    const g = gate();
    g.check('wrong-one-1', 0);
    g.check('wrong-one-2', MIN);
    expect(g.check('wrong-one-3', 15.5 * MIN)).toEqual({ ok: false, failures: 2 }); // the first one has expired, the second hasn't
  });

  it('locks for twice as long each time, up to the maximum', () => {
    const g = gate({ maxFailures: 1, lockoutMs: 15 * MIN, maxLockoutMs: 2 * HOUR });
    let now = 0;
    const lockouts: number[] = [];
    for (let i = 0; i < 6; i++) {
      const result = g.check(`wrong-try-${i}`, now);
      lockouts.push(result.ok ? 0 : (result.lockedForMs ?? 0));
      now += g.lockedForMs(now);
    }
    expect(lockouts.map((ms) => ms / MIN)).toEqual([15, 30, 60, 120, 120, 120]);
  });

  it('starts afresh after the right passphrase', () => {
    const g = gate({ maxFailures: 1, lockoutMs: 15 * MIN });
    g.check('wrong-one-1', 0);
    g.check('wrong-one-2', 15 * MIN); // second lockout: 30 min
    expect(g.check(PASS, 45 * MIN)).toEqual({ ok: true });

    expect(g.check('wrong-one-3', 50 * MIN)).toEqual({ ok: false, failures: 1, lockedForMs: 15 * MIN });
  });

  it('keeps nothing readable: no passphrase in strings, JSON or inspection', () => {
    const g = gate();
    expect(String(g)).toBe('[passphrase gate]');
    expect(inspect(g, { showHidden: true, depth: 10 })).not.toContain('horse');
    expect(JSON.stringify({ g })).not.toContain('horse');
  });

  it('refuses an unusable passphrase', () => {
    expect(() => new PassphraseGate('short', { maxFailures: 3, failureWindowMs: 1, lockoutMs: 1, maxLockoutMs: 1 })).toThrow(
      'TELEGRAM_COMMAND_PASSPHRASE must be at least 8 characters',
    );
  });
});
