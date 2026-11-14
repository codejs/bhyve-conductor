import { createHash, timingSafeEqual } from 'node:crypto';

/**
 * Commands that change something (/pause, /resume) are conversations: the command describes a step,
 * the bot (bot.ts) asks, checks the answer, and only the last step, after the passphrase, changes
 * anything. The flow and all its edge cases (cancel, unexpected answers, no answer) are handled by
 * the bot; a command only says what to ask and what to do.
 */

/** The Telegram user talking to the bot. */
export interface Actor {
  id: number;
  username?: string | undefined;
}

export const actorName = (a: Actor): string => (a.username ? `@${a.username}` : `user ${a.id}`);

export interface Choice {
  /** Answers that pick this choice (lowercase; see normalizeAnswer). */
  words: readonly string[];
  /** What was chosen, for the audit trail (e.g. "continue"). */
  label: string;
  next: () => Step | Promise<Step>;
}

export type Step =
  /** Nothing to do (e.g. already paused): the conversation ends without asking for the passphrase. */
  | { kind: 'done'; text: string }
  /** A question; `hint` is repeated after an answer that isn't one of the choices. "cancel" always works. */
  | { kind: 'ask'; text: string; hint: string; choices: readonly Choice[] }
  /** The last step: `run` happens only after the right passphrase. It returns the reply (Telegram HTML). */
  | { kind: 'passphrase'; text: string; run: () => Promise<string> };

/** A command that changes something: always a conversation, always ending with the passphrase. */
export interface MutableCommand {
  kind: 'mutable';
  /** Telegram command name: lowercase letters, digits and underscores, at most 32. */
  name: string;
  description: string;
  /** Looks at the current state and returns the first step. Must not change anything. */
  begin(actor: Actor): Step | Promise<Step>;
}

export const YES_WORDS = ['yes', 'y', 'confirm', 'ok'] as const;
/** Cancel the conversation at any step. */
export const CANCEL_WORDS: ReadonlySet<string> = new Set(['cancel', 'no', 'n', 'stop', 'abort', 'nope']);
/** Every word that answers a question; none of them may be the passphrase. */
export const ANSWER_WORDS: ReadonlySet<string> = new Set([...YES_WORDS, ...CANCEL_WORDS, 'continue', 'discard', '1', '2']);

/** "  Yes! " → "yes". Only surrounding space, case and trailing punctuation are forgiven. */
export const normalizeAnswer = (text: string): string =>
  text
    .trim()
    .toLowerCase()
    .replace(/[.!?]+$/, '');

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

/** Holds the passphrase and checks answers against it in constant time. */
export class Passphrase {
  readonly #text: string;
  readonly #digest: Buffer;

  constructor(passphrase: string) {
    const problem = passphraseProblem(passphrase);
    if (problem) throw new Error(`TELEGRAM_COMMAND_PASSPHRASE ${problem}`);
    this.#text = passphrase;
    this.#digest = sha256(passphrase);
  }

  /** Is this answer the passphrase? Surrounding spaces are ignored; everything else must match exactly. */
  matches(answer: string): boolean {
    // Comparing fixed-length digests takes the same time whatever the answer, and however long it is.
    return timingSafeEqual(sha256(answer.trim()), this.#digest);
  }

  /** Does the text contain the passphrase anywhere (so the message should be deleted)? */
  occursIn(text: string): boolean {
    return text.includes(this.#text);
  }

  /** Never reveal it by accident (logs, JSON, string templates). */
  toString(): string {
    return '[passphrase]';
  }

  toJSON(): string {
    return '[passphrase]';
  }
}

const sha256 = (s: string): Buffer => createHash('sha256').update(s, 'utf8').digest();
