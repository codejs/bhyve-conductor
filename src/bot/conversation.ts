import { createHash, timingSafeEqual } from 'node:crypto';

/**
 * Conversations: the command describes a step, the bot (bot.ts) asks, checks the answer, and moves on.
 * The flow and all its edge cases (cancel, unexpected answers, no answer) are handled by the bot; a
 * command only says what to ask and what to do.
 *
 *  - `mutable` commands (/pause, /resume, /config) change something. Only their last step, after the
 *    passphrase, may change anything; every earlier step only reads.
 *  - `interactive` commands (/audit) only read, over several messages (e.g. pages). They can never reach
 *    a passphrase step (the bot refuses), aren't locked by wrong passphrases, and give way to anyone
 *    else's command.
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

/** What a free-form answer leads to: the next step, or why it can't be used (it is asked again). */
export type InputResult = { next: Step } | { invalid: string };

export type Step =
  /** Nothing (more) to do: the conversation ends with this message, without the passphrase. */
  | { kind: 'done'; text: string }
  /** A question; `hint` is repeated after an answer that isn't one of the choices. "cancel" always works. */
  | { kind: 'ask'; text: string; hint: string; choices: readonly Choice[] }
  /**
   * A question with a free-form answer (a number, "next"...), read by `read`. "cancel" always works before
   * `read` sees anything, and a message containing the passphrase is deleted and never passed to it.
   */
  | { kind: 'input'; text: string; hint: string; placeholder?: string; read: (answer: string) => InputResult | Promise<InputResult> }
  /**
   * The last step of a mutable command: `run` happens only after the right passphrase. It returns the reply,
   * or a reply and an error when it knows the change didn't happen (recorded as failed).
   */
  | { kind: 'passphrase'; text: string; run: () => Promise<string | { text: string; error: string }> };

interface ConversationCommandBase {
  /** Telegram command name: lowercase letters, digits and underscores, at most 32. */
  name: string;
  description: string;
  /**
   * Allow text after the command ("/audit 7d"); it's passed to `begin`, which must check it. Otherwise
   * the bot refuses arguments.
   */
  acceptsArgs?: boolean;
  /** Looks at the current state and returns the first step. Must not change anything. */
  begin(actor: Actor, args: string): Step | Promise<Step>;
}

/** A command that changes something: always a conversation, always ending with the passphrase. */
export interface MutableCommand extends ConversationCommandBase {
  kind: 'mutable';
}

/** A read-only command over several messages (e.g. pages). It never reaches a passphrase step. */
export interface InteractiveCommand extends ConversationCommandBase {
  kind: 'interactive';
}

export type ConversationCommand = MutableCommand | InteractiveCommand;

export const YES_WORDS = ['yes', 'y', 'confirm', 'ok'] as const;
/** Cancel the conversation at any step. */
export const CANCEL_WORDS: ReadonlySet<string> = new Set(['cancel', 'no', 'n', 'stop', 'abort', 'nope']);
/** Every word that answers a question; none of them may be the passphrase. */
export const ANSWER_WORDS: ReadonlySet<string> = new Set([
  ...YES_WORDS,
  ...CANCEL_WORDS,
  // /resume
  'continue',
  'discard',
  '1',
  '2',
  // /config
  'next',
  'done',
  'back',
  'edit',
  // /audit
  'more',
  'all',
  'problems',
  'watering',
  'commands',
  'summary',
]);

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
