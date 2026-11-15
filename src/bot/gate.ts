import { createHash, timingSafeEqual } from 'node:crypto';
import { ANSWER_WORDS, normalizeAnswer } from './conversation.ts';

/**
 * The passphrase that guards every change, and the rules around guessing it:
 *  - it is kept only as a digest, and compared in constant time;
 *  - whether a text is an attempt at all is decided WITHOUT looking at the passphrase (classifyAttempt),
 *    so nothing the bot does with a message (deleting it, asking again) can reveal anything about it;
 *  - wrong attempts are counted; too many lock all changes, for longer each time (and not even the
 *    right passphrase is accepted while locked); the right one resets everything.
 */

export const MIN_PASSPHRASE_LENGTH = 8;
export const MAX_PASSPHRASE_LENGTH = 256;

/** Why a passphrase can't be used, or undefined if it's fine. The message never contains the passphrase. */
export const passphraseProblem = (passphrase: string): string | undefined => {
  if (passphrase.length < MIN_PASSPHRASE_LENGTH) return `must be at least ${MIN_PASSPHRASE_LENGTH} characters`;
  if (passphrase.length > MAX_PASSPHRASE_LENGTH) return `must be at most ${MAX_PASSPHRASE_LENGTH} characters`;
  if (passphrase !== passphrase.trim()) return 'must not start or end with spaces';
  // It would look like a command and never reach the passphrase check.
  if (passphrase.startsWith('/')) return 'must not start with "/"';
  if (ANSWER_WORDS.has(normalizeAnswer(passphrase))) return 'must not be an answer word such as "continue"';
  return undefined;
};

export type AttemptKind = 'attempt' | 'answer-word' | 'too-short';

/**
 * Could this text be the passphrase? Decided from its shape alone (never by comparing it), so acting on
 * the answer can't leak anything. Answer words and texts shorter than any valid passphrase can't be.
 */
export const classifyAttempt = (text: string): AttemptKind => {
  if (ANSWER_WORDS.has(normalizeAnswer(text))) return 'answer-word';
  if (text.trim().length < MIN_PASSPHRASE_LENGTH) return 'too-short';
  return 'attempt';
};

/** The passphrase itself: only its digest is kept. */
export class Passphrase {
  readonly #digest: Buffer;

  constructor(passphrase: string) {
    const problem = passphraseProblem(passphrase);
    if (problem) throw new Error(`TELEGRAM_COMMAND_PASSPHRASE ${problem}`);
    this.#digest = sha256(passphrase);
  }

  /** Is this answer the passphrase? Surrounding spaces are ignored; everything else must match exactly. */
  matches(answer: string): boolean {
    // Comparing fixed-length digests takes the same time whatever the answer, and however long it is.
    return timingSafeEqual(sha256(answer.trim()), this.#digest);
  }

  /** Never reveal anything by accident (logs, JSON, string templates). */
  toString(): string {
    return '[passphrase]';
  }

  toJSON(): string {
    return '[passphrase]';
  }
}

export interface GateOptions {
  /** Wrong attempts within `failureWindowMs` that lock changes... */
  maxFailures: number;
  failureWindowMs: number;
  /** ...for this long the first time, twice as long each time after (until a right attempt)... */
  lockoutMs: number;
  /** ...but never longer than this. */
  maxLockoutMs: number;
}

export type GateResult =
  | { ok: true }
  /** `lockedForMs` is set when this attempt locked changes (or they were locked already). */
  | { ok: false; failures: number; lockedForMs?: number; alreadyLocked?: boolean };

export class PassphraseGate {
  readonly #passphrase: Passphrase;
  readonly #opts: GateOptions;
  #failures: number[] = [];
  #lockedUntil = 0;
  /** Lockouts since the last right attempt: each one lasts twice as long as the one before. */
  #lockouts = 0;

  constructor(passphrase: string, opts: GateOptions) {
    this.#passphrase = new Passphrase(passphrase);
    this.#opts = opts;
  }

  /** How much longer changes are locked (0 if they aren't). */
  lockedForMs(nowMs: number): number {
    return Math.max(0, this.#lockedUntil - nowMs);
  }

  /** Checks an attempt (see classifyAttempt) and counts it. */
  check(answer: string, nowMs: number): GateResult {
    const locked = this.lockedForMs(nowMs);
    // Fail closed: while locked, not even the right passphrase is accepted (nor compared).
    if (locked > 0) return { ok: false, failures: 0, lockedForMs: locked, alreadyLocked: true };
    if (this.#passphrase.matches(answer)) {
      this.#failures = [];
      this.#lockouts = 0;
      return { ok: true };
    }
    this.#failures = [...this.#failures.filter((t) => nowMs - t < this.#opts.failureWindowMs), nowMs];
    const failures = this.#failures.length;
    if (failures < this.#opts.maxFailures) return { ok: false, failures };
    this.#lockouts++;
    const lockedForMs = Math.min(this.#opts.lockoutMs * 2 ** (this.#lockouts - 1), this.#opts.maxLockoutMs);
    this.#lockedUntil = nowMs + lockedForMs;
    this.#failures = [];
    return { ok: false, failures, lockedForMs };
  }

  toString(): string {
    return '[passphrase gate]';
  }
}

const sha256 = (s: string): Buffer => createHash('sha256').update(s, 'utf8').digest();
