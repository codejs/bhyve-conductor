/**
 * The bot's command model. Every command is one of:
 *
 *  - `query`: read-only, one reply (/status, /sensors_read, /bhyve_devices);
 *  - `interactive`: read-only, over several messages (/audit's pages). It can never reach a passphrase
 *    step (the bot refuses), isn't locked by wrong passphrases, and gives way to anyone else's command;
 *  - `mutable`: changes something (/pause, /resume, /config). Only its last step, after the passphrase,
 *    may change anything; every earlier step only reads.
 *  - `safety`: only ever makes things safer, i.e. less water (/stop). Its last step acts right after a
 *    confirmation, with no passphrase (it must be quick in an emergency), and works even while changes
 *    are locked. It must be given nothing that could start watering.
 *
 * Conversations (interactive and mutable) are steps: the command says what to ask and what an answer
 * leads to; the bot (bot.ts) asks, checks answers, and handles every edge case (cancel, unexpected
 * answers, no answer, the passphrase). The builders below make the common steps.
 */

/** The Telegram user talking to the bot. */
export interface Actor {
  id: number;
  username?: string | undefined;
}

/** "@owner", or "user 4242" without a username. */
export const actorName = (a: Actor): string => (a.username ? `@${a.username}` : `user ${a.id}`);

/** Who made a change, for messages and the audit trail. */
export const via = (actor: Actor): string => `${actorName(actor)} via Telegram`;

// ---------- steps ----------

/**
 * What an answer leads to: the next step (and, for the audit trail, what was chosen), or not understood
 * (`invalid` says why, if there's more to say than "I didn't get that"); the question is then asked again.
 */
export type InputResult = { next: Step; choice?: string } | { invalid?: string };

/** What a passphrase step's `run` returns: the reply, or a reply and an error when the change didn't happen. */
export type RunResult = string | { text: string; error: string };

export type Step =
  /** Nothing (more) to do: the conversation ends with this message, without the passphrase. */
  | { kind: 'done'; text: string }
  /**
   * A question. "cancel" always works before `read` sees anything. `read` must not change anything, and
   * must never repeat the answer back (it could be the passphrase, sent too early).
   */
  | { kind: 'input'; text: string; hint: string; placeholder?: string; read: (answer: string) => InputResult | Promise<InputResult> }
  /** The last step of a mutable command: `run` happens only after the right passphrase. */
  | { kind: 'passphrase'; text: string; run: () => Promise<RunResult> }
  /**
   * The last step of a safety command: as soon as it is reached (after a confirmation), `text` is said
   * ("Stopping…": the action may take a moment), then `run` happens.
   */
  | { kind: 'act'; text: string; run: () => Promise<RunResult> };

export const done = (text: string): Step => ({ kind: 'done', text });

export interface Choice {
  /** Answers that pick this choice (lowercase; see normalizeAnswer). */
  words: readonly string[];
  /** What was chosen, for the audit trail (e.g. "continue"). */
  label: string;
  next: () => Step | Promise<Step>;
}

/** A question answered with one of a few words ("continue", "discard"...). */
export const ask = (q: { text: string; hint: string; choices: readonly Choice[] }): Step => ({
  kind: 'input',
  text: q.text,
  hint: q.hint,
  read: async (answer): Promise<InputResult> => {
    const word = normalizeAnswer(answer);
    const choice = q.choices.find((c) => c.words.includes(word));
    return choice ? { next: await choice.next(), choice: choice.label } : {};
  },
});

/** "… Reply yes or cancel." */
export const confirm = (q: { text: string; hint: string; label?: string; then: () => Step | Promise<Step> }): Step =>
  ask({ text: q.text, hint: q.hint, choices: [{ words: YES_WORDS, label: q.label ?? 'yes', next: q.then }] });

/** The last step of a safety command: say what's happening, and do it now. */
export const act = (text: string, run: () => Promise<RunResult>): Step => ({ kind: 'act', text, run });

/** The last step of a change: "🔐 Send the passphrase to <action>, or cancel." */
export const passphraseStep = (q: { intro?: string; action: string; run: () => Promise<RunResult> }): Step => ({
  kind: 'passphrase',
  text: `${q.intro ?? ''}🔐 Send the passphrase to ${q.action}, or <b>cancel</b>.`,
  run: q.run,
});

// ---------- commands ----------

/** What `/help <command>` shows (see help.ts, which adds what follows from the command's kind). */
export interface CommandHelp {
  /** Ways to call it, each with what it does: { call: '/audit problems 7d', does: 'failures and recoveries, last 7 days' }. */
  usage: readonly { call: string; does: string }[];
  /** A few short lines: what it shows or asks, and what to reply. */
  details?: readonly string[];
}

interface CommandBase {
  /** Telegram command name: lowercase letters, digits and underscores, at most 32 (COMMAND_NAME). */
  name: string;
  /** Shown in /help and in the Telegram command menu. */
  description: string;
  /** For `/help <name>`. Without it, the usage is just the command and its description. */
  help?: CommandHelp;
}

/** Read-only, one reply. */
export interface QueryCommand extends CommandBase {
  kind: 'query';
  /** The npm script it mirrors, if any. */
  script?: string;
  /** Minimum time between two runs; it protects API quotas and the B-hyve account the conductor relies on. */
  cooldownSeconds: number;
  /** Produces the reply (Telegram HTML). May throw; the bot reports the error. */
  run(): Promise<string>;
}

interface ConversationBase extends CommandBase {
  /**
   * Allow text after the command ("/audit 7d"); it's passed to `begin`, which must check it (and never
   * repeat it back). Otherwise the bot refuses arguments.
   */
  acceptsArgs?: boolean;
  /** Looks at the current state and returns the first step. Must not change anything. */
  begin(actor: Actor, args: string): Step | Promise<Step>;
}

/** Read-only, over several messages (e.g. pages). Never reaches a passphrase step. */
export interface InteractiveCommand extends ConversationBase {
  kind: 'interactive';
}

/** Changes something: always a conversation, always ending with the passphrase. */
export interface MutableCommand extends ConversationBase {
  kind: 'mutable';
}

/** Only ever reduces watering: a conversation ending with a confirmation, then an `act` step. */
export interface SafetyCommand extends ConversationBase {
  kind: 'safety';
}

export type ConversationCommand = InteractiveCommand | MutableCommand | SafetyCommand;
export type BotCommand = QueryCommand | ConversationCommand;

export const COMMAND_NAME = /^[a-z0-9_]{1,32}$/;

// ---------- answers ----------

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

/**
 * "  Yes! " → "yes". Only surrounding space, case and trailing punctuation are forgiven. (A loop, not a
 * regex: /[.!?]+$/ takes quadratic time on a long run of dots, and every answer goes through here.)
 */
export const normalizeAnswer = (text: string): string => {
  const s = text.trim().toLowerCase();
  let end = s.length;
  while (end > 0 && '.!?'.includes(s.charAt(end - 1))) end--;
  return s.slice(0, end);
};
