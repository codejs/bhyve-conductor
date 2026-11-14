import { errorMessage, type AuditSink } from '../audit/audit.ts';
import { systemClock, type Clock, type TimerHandle } from '../clock.ts';
import { log } from '../log.ts';
import {
  TelegramConflictError,
  TelegramPermanentError,
  TelegramRateLimitError,
  type GetUpdatesOptions,
  type SendOptions,
  type TelegramMessage,
  type TelegramUpdate,
  type TelegramUser,
} from '../notify/telegram.ts';
import { authorize, type CommandPolicy, type RejectReason } from './auth.ts';
import type { BotCommand } from './commands.ts';
import {
  ANSWER_WORDS,
  CANCEL_WORDS,
  MIN_PASSPHRASE_LENGTH,
  normalizeAnswer,
  Passphrase,
  type Actor,
  type ConversationCommand,
  type Step,
} from './conversation.ts';
import { clip, duration, safe } from './format.ts';

/**
 * Answers commands sent to the Telegram bot, using long polling (getUpdates): the conductor only makes
 * outgoing requests, so no port is opened and there is no webhook URL to discover or spoof.
 *
 * Every message goes through, in order:
 *   1. authorization (auth.ts): the configured chat, an allowed user, no forwards/bots/anonymous senders.
 *      Rejected commands get no reply (the bot doesn't reveal anything to strangers); they are audited,
 *      throttled. Other messages from strangers are ignored silently;
 *   2. a message containing the passphrase is deleted from the chat, whatever else happens to it;
 *   3. freshness: messages older than `maxMessageAgeSeconds` (e.g. queued while the conductor was down,
 *      or replayed after a restart) are dropped;
 *   4. text that isn't a command is only an answer in a conversation (see below), otherwise ignored;
 *   5. commands: a global rate limit, then a per-command cooldown; each runs with a timeout, one at a time.
 *
 * Commands that change something (/pause, /resume; see conversation.ts and control.ts) are conversations
 * with one person: the bot asks, and only the right passphrase as the last answer runs the change.
 *   - "cancel" (or /cancel) ends it at any step; a wrong passphrase ends it too.
 *   - An answer that doesn't fit is asked again, up to `maxInvalidAnswers` times, then the command is dropped.
 *   - No answer within `conversationTimeoutMs` drops it. Nothing changes unless the passphrase step completes.
 *   - One conversation at a time. Read-only commands still work meanwhile; the same person starting another
 *     change replaces theirs; someone else has to wait.
 *   - `maxPassphraseFailures` wrong passphrases within `passphraseFailureWindowMs` lock all changes for `lockoutMs`.
 *   - Passphrase answers are deleted from the chat (best effort) and never logged or audited.
 *
 * Read-only replies go through the notification queue; conversation messages are sent directly (they ask
 * for a reply), falling back to the queue if that fails.
 */

/** The Telegram calls the bot makes (TelegramClient implements it; tests pass a fake). */
export interface BotApi {
  getMe(): Promise<TelegramUser>;
  getUpdates(opts: GetUpdatesOptions): Promise<TelegramUpdate[]>;
  setMyCommands(commands: readonly { command: string; description: string }[], chatId: number): Promise<void>;
  /** To the configured chat. */
  sendMessage(html: string, opts?: SendOptions): Promise<void>;
  /** In the configured chat. */
  deleteMessage(messageId: number): Promise<void>;
}

export interface CommandBotOptions {
  /** Long-poll wait per getUpdates call. */
  pollTimeoutSeconds: number;
  /** Messages older than this are ignored (stale or replayed). */
  maxMessageAgeSeconds: number;
  /** A command (or a conversation step) that takes longer is reported as timed out. */
  commandTimeoutMs: number;
  /** At most this many commands per `rateWindowMs`; the rest are ignored. */
  maxCommandsPerWindow: number;
  rateWindowMs: number;
  /** Waits after consecutive getUpdates failures (the last one repeats). */
  retryDelaysMs: number[];
  /** Wait after a 409 (another poller or a webhook on the same token). */
  conflictDelayMs: number;
  /**
   * Least time between two polls that return nothing. Telegram holds an empty poll open for
   * `pollTimeoutSeconds`; one that comes back at once (a proxy, an API change) must not become a busy loop.
   */
  minEmptyPollIntervalMs: number;
  /** A rejected sender is audited at most once per this interval... */
  rejectionAuditIntervalMs: number;
  /** ...and at most this many rejections are audited per interval in total (a flood can't fill the disk). */
  maxRejectionAuditsPerInterval: number;
  /** How long the bot waits for each answer in a conversation. */
  conversationTimeoutMs: number;
  /** Answers that fit no choice before the conversation is dropped. */
  maxInvalidAnswers: number;
  /** Wrong passphrases within `passphraseFailureWindowMs` that lock changes... */
  maxPassphraseFailures: number;
  passphraseFailureWindowMs: number;
  /** ...for this long. */
  lockoutMs: number;
  /** After a question expires, a late "yes"/"cancel" within this long gets told it came too late. */
  lateAnswerMs: number;
}

export const DEFAULT_BOT_OPTIONS: CommandBotOptions = {
  pollTimeoutSeconds: 50,
  maxMessageAgeSeconds: 120,
  commandTimeoutMs: 45_000,
  maxCommandsPerWindow: 10,
  rateWindowMs: 60_000,
  retryDelaysMs: [1_000, 5_000, 15_000, 60_000],
  conflictDelayMs: 60_000,
  minEmptyPollIntervalMs: 1_000,
  rejectionAuditIntervalMs: 3_600_000,
  maxRejectionAuditsPerInterval: 20,
  conversationTimeoutMs: 120_000,
  maxInvalidAnswers: 3,
  maxPassphraseFailures: 3,
  passphraseFailureWindowMs: 15 * 60_000,
  lockoutMs: 15 * 60_000,
  lateAnswerMs: 10 * 60_000,
};

export interface CommandBotDeps {
  api: BotApi;
  policy: CommandPolicy;
  commands: readonly (BotCommand | ConversationCommand)[];
  /** Required if any command is mutable (changes something). */
  passphrase?: string | undefined;
  /** Sends a reply (Telegram HTML) to the configured chat. Must not throw or block (e.g. DeliveryQueue.enqueue). */
  reply: (html: string) => void;
  audit?: AuditSink;
  clock?: Clock;
  options?: Partial<CommandBotOptions>;
}

export interface ParsedCommand {
  /** Lowercased command name, without the slash. */
  name: string;
  /** Bot username after "@", if the command was addressed to a specific bot. */
  target?: string;
  /** Anything after the command. */
  args: string;
}

/** Longest message text looked at; real commands are a few characters long. */
export const MAX_COMMAND_TEXT = 256;
const COMMAND = /^\/([A-Za-z0-9_]{1,32})(?:@([A-Za-z0-9_]{1,64}))?(?:\s+([\s\S]*))?$/;

/** "/status", "/status@MyBot", "/Status extra words". Returns undefined for anything else. */
export const parseCommand = (text: string): ParsedCommand | undefined => {
  if (text.length > MAX_COMMAND_TEXT) return undefined;
  const m = COMMAND.exec(text.trim());
  if (!m?.[1]) return undefined;
  return { name: m[1].toLowerCase(), ...(m[2] ? { target: m[2] } : {}), args: (m[3] ?? '').trim() };
};

/** Allows at most `max` events in any `windowMs`. */
export class SlidingWindowLimiter {
  readonly #max: number;
  readonly #windowMs: number;
  #times: number[] = [];

  constructor(max: number, windowMs: number) {
    this.#max = max;
    this.#windowMs = windowMs;
  }

  tryTake(nowMs: number): boolean {
    this.#times = this.#times.filter((t) => nowMs - t < this.#windowMs);
    if (this.#times.length >= this.#max) return false;
    this.#times.push(nowMs);
    return true;
  }
}

const HELP_NAMES = new Set(['help', 'start']);
const BUILT_IN = new Set([...HELP_NAMES, 'cancel']);
/** Reasons that mean someone other than the allowed users tried (worth telling the owner). */
const SUSPICIOUS: ReadonlySet<RejectReason> = new Set(['other-chat', 'user-not-allowed', 'anonymous', 'bot-sender', 'no-sender']);

const noAudit: AuditSink = { record: () => {} };

/** Told after deleting a message that contained the passphrase (outside the passphrase question)... */
const LEAK_DELETED = '🔐 I deleted your message because it contained the passphrase.';
/** ...or after failing to. */
const LEAK_NOT_DELETED =
  "⚠️ Your message contains the passphrase and I couldn't delete it (in a group I need the “Delete messages” admin right): please delete it yourself.";
/** After failing to delete an answer to the passphrase question. */
const ANSWER_NOT_DELETED =
  "⚠️ I couldn't delete your passphrase message (in a group I need the “Delete messages” admin right): please delete it yourself.";

type Outcome = 'ok' | 'failed' | 'timed_out' | 'stopped';
type Guarded<T> = { ok: true; value: T } | { ok: false; outcome: Exclude<Outcome, 'ok'>; error?: string };

/** How a conversation ended, for the audit trail. */
type ConversationOutcome =
  | 'ok'
  | 'nothing-to-do'
  | 'cancelled'
  | 'expired'
  | 'denied'
  | 'aborted'
  | 'superseded'
  | 'locked'
  | 'failed'
  | 'timed_out'
  | 'stopped';

interface Conversation {
  command: ConversationCommand;
  user: TelegramUser;
  startedMs: number;
  /** The step waiting for an answer (unset until the first one is asked). */
  step?: Exclude<Step, { kind: 'done' }>;
  /** Answers that fit no choice, at this step. */
  invalid: number;
  /** What was chosen along the way, for the audit trail. */
  choice?: string;
  timer?: TimerHandle;
}

export class CommandBot {
  readonly #deps: CommandBotDeps;
  readonly #opts: CommandBotOptions;
  readonly #clock: Clock;
  readonly #audit: AuditSink;
  readonly #commands: ReadonlyMap<string, BotCommand>;
  /** Commands that are conversations (mutable or interactive). */
  readonly #conversational: ReadonlyMap<string, ConversationCommand>;
  readonly #passphrase: Passphrase | undefined;
  readonly #limiter: SlidingWindowLimiter;
  readonly #lastRun = new Map<string, number>();
  /** Rejection audit throttle: sender key → last audited; reset every interval. */
  #rejections = new Map<string, number>();
  #rejectionWindowStart = 0;
  #rateLimitNoticeAt: number | undefined;
  #username: string | undefined;
  #offset: number | undefined;
  #loop: Promise<void> | undefined;
  #stopped = true;
  #abort: AbortController | undefined;
  #wake: (() => void) | undefined;
  #stopWaiters: (() => void)[] = [];
  #conversation: Conversation | undefined;
  /** Times of recent wrong passphrases. */
  #failures: number[] = [];
  #lockedUntil = 0;
  /** The last conversation that expired, to explain a late answer. */
  #lastExpired: { userId: number; command: string; atMs: number } | undefined;

  constructor(deps: CommandBotDeps) {
    this.#deps = deps;
    this.#opts = { ...DEFAULT_BOT_OPTIONS, ...deps.options };
    this.#clock = deps.clock ?? systemClock;
    this.#audit = deps.audit ?? noAudit;
    const readOnly = new Map<string, BotCommand>();
    const conversational = new Map<string, ConversationCommand>();
    for (const c of deps.commands) {
      if (BUILT_IN.has(c.name) || readOnly.has(c.name) || conversational.has(c.name)) throw new Error(`duplicate bot command /${c.name}`);
      if (isConversation(c)) conversational.set(c.name, c);
      else readOnly.set(c.name, c);
    }
    this.#commands = readOnly;
    this.#conversational = conversational;
    const mutable = [...conversational.values()].filter((c) => c.kind === 'mutable');
    if (mutable.length > 0 && deps.passphrase === undefined) {
      // Fail closed: a command that changes something must never run without the passphrase check.
      throw new Error(`/${mutable.map((c) => c.name).join(', /')} need a passphrase (TELEGRAM_COMMAND_PASSPHRASE)`);
    }
    this.#passphrase = deps.passphrase === undefined ? undefined : new Passphrase(deps.passphrase);
    this.#limiter = new SlidingWindowLimiter(this.#opts.maxCommandsPerWindow, this.#opts.rateWindowMs);
  }

  get running(): boolean {
    return this.#loop !== undefined;
  }

  /** The bot's @username, once Telegram has told us. */
  get username(): string | undefined {
    return this.#username;
  }

  /** The command being confirmed, if any (for tests and status). */
  get pendingConversation(): { command: string; userId: number } | undefined {
    const c = this.#conversation;
    return c ? { command: c.command.name, userId: c.user.id } : undefined;
  }

  /** Starts polling in the background. Never throws; problems are logged. */
  start(): void {
    if (this.#loop) return;
    this.#stopped = false;
    this.#abort = new AbortController();
    this.#loop = this.#run()
      .catch((err: unknown) => log.error('Telegram commands stopped unexpectedly', err))
      .finally(() => {
        this.#loop = undefined;
      });
  }

  /** Stops polling, abandoning a long poll, a running command or a conversation. */
  async stop(): Promise<void> {
    this.#stopped = true;
    this.#abort?.abort();
    this.#wake?.();
    for (const resolve of this.#stopWaiters.splice(0)) resolve();
    if (this.#conversation) this.#end(this.#conversation, 'stopped');
    await this.#loop;
  }

  async #run(): Promise<void> {
    let failures = 0;
    while (!this.#stopped) {
      try {
        if (this.#username === undefined) await this.#identify();
        const polledAt = this.#clock.now().getTime();
        const updates = await this.#deps.api.getUpdates({
          ...(this.#offset !== undefined ? { offset: this.#offset } : {}),
          timeoutSeconds: this.#opts.pollTimeoutSeconds,
          ...(this.#abort ? { signal: this.#abort.signal } : {}),
        });
        if (failures > 0) log.info(`Telegram commands: getUpdates works again after ${failures} failure(s)`);
        failures = 0;
        for (const update of updates) {
          if (this.#stopped) break;
          // Never handle an update twice, even if Telegram sends it again.
          if (this.#offset !== undefined && update.update_id < this.#offset) continue;
          this.#offset = update.update_id + 1;
          try {
            await this.#handle(update);
          } catch (err) {
            log.error(`Telegram commands: could not handle update ${update.update_id}`, err);
          }
        }
        if (updates.length === 0) {
          const elapsed = this.#clock.now().getTime() - polledAt;
          if (elapsed < this.#opts.minEmptyPollIntervalMs) await this.#sleep(this.#opts.minEmptyPollIntervalMs - elapsed);
        }
      } catch (err) {
        if (this.#stopped) break;
        if (err instanceof TelegramPermanentError) {
          // Fail closed: a bad token won't fix itself, and hammering the API could get the bot banned.
          log.error(`Telegram commands are off until restart: ${errorMessage(err)}`);
          this.#stopped = true;
          if (this.#conversation) this.#end(this.#conversation, 'stopped');
          break;
        }
        failures++;
        let delay: number;
        if (err instanceof TelegramRateLimitError) delay = err.retryAfterSeconds * 1000;
        else if (err instanceof TelegramConflictError) delay = this.#opts.conflictDelayMs;
        else delay = this.#opts.retryDelaysMs[Math.min(failures, this.#opts.retryDelaysMs.length) - 1] ?? 60_000;
        const message =
          err instanceof TelegramConflictError
            ? `${errorMessage(err)} (is another conductor running with this bot token, or a webhook set?)`
            : errorMessage(err);
        // One warning per outage; the rest go to debug so a long outage doesn't flood the log.
        if (failures === 1) log.warn(`Telegram commands: ${message}; retrying in ${duration(delay)}`);
        else log.debug(`Telegram commands: ${message} (${failures} failures); retrying in ${duration(delay)}`);
        await this.#sleep(delay);
      }
    }
  }

  async #identify(): Promise<void> {
    const me = await this.#deps.api.getMe();
    this.#username = me.username ?? '';
    log.info(`Telegram commands on${me.username ? ` for @${me.username}` : ''} (chat ${this.#deps.policy.chatId})`);
    const menu = [
      { command: 'help', description: 'List the commands' },
      ...[...this.#commands.values(), ...this.#conversational.values()].map((c) => ({ command: c.name, description: c.description })),
      ...(this.#conversational.size > 0 ? [{ command: 'cancel', description: 'Cancel a pending change' }] : []),
    ];
    try {
      await this.#deps.api.setMyCommands(menu, this.#deps.policy.chatId);
    } catch (err) {
      // Only the menu in the Telegram app; typed commands work regardless.
      log.warn(`Telegram commands: could not set the command menu: ${errorMessage(err)}`);
    }
  }

  async #handle(update: TelegramUpdate): Promise<void> {
    const message = update.message;
    const text = message?.text;
    if (!message || text === undefined) return;
    const isCommand = text.startsWith('/');

    const verdict = authorize(message, this.#deps.policy);
    if (!verdict.ok) {
      // Strangers' ordinary messages aren't worth a record; their commands are.
      if (isCommand) this.#reject(message, verdict.reason, text);
      return;
    }
    const user = verdict.user;
    const nowMs = this.#clock.now().getTime();
    const ageSeconds = nowMs / 1000 - message.date;
    const stale = ageSeconds > this.#opts.maxMessageAgeSeconds;

    // Whatever the message is (even a stale one), the passphrase must not stay in the chat. A fresh answer
    // to the passphrase question is deleted by the conversation itself, which expects it.
    const passphraseAnswer =
      !stale && !isCommand && this.#conversation?.user.id === user.id && this.#conversation.step?.kind === 'passphrase';
    let leak = '';
    if (!passphraseAnswer && this.#passphrase?.occursIn(text)) leak = (await this.#deleteMessage(message)) ? LEAK_DELETED : LEAK_NOT_DELETED;

    if (stale) {
      // Never log the text: it could be a passphrase.
      log.info(`Telegram commands: ignoring a ${isCommand ? 'command' : 'message'} from user ${user.id}, sent ${duration(ageSeconds * 1000)} ago (too old)`);
      if (leak) await this.#say(`${leak} It was too old to act on; nothing was run.`);
      return;
    }

    if (!isCommand) {
      await this.#onText(message, user, text, leak);
      return;
    }

    const parsed = parseCommand(text);
    // Addressed to another bot in the group: not ours to answer.
    if (parsed?.target !== undefined && parsed.target.toLowerCase() !== this.#username?.toLowerCase()) return;

    if (!this.#limiter.tryTake(nowMs)) {
      // Tell them once per window, then stay quiet (replies cost too).
      if (this.#rateLimitNoticeAt === undefined || nowMs - this.#rateLimitNoticeAt >= this.#opts.rateWindowMs) {
        this.#rateLimitNoticeAt = nowMs;
        this.#deps.reply(`🐢 Too many commands; ignoring them for up to ${duration(this.#opts.rateWindowMs)}.`);
      }
      log.warn(`Telegram commands: rate limit reached; ignoring a command from user ${user.id}`);
      return;
    }

    const known = parsed && (this.#commands.has(parsed.name) || this.#conversational.has(parsed.name) || BUILT_IN.has(parsed.name));
    if (!parsed || !known) {
      this.#deps.reply(`🤷 Unknown command${parsed ? ` /${safe(parsed.name, 32)}` : ''}. Send /help for the list.`);
      return;
    }
    if (HELP_NAMES.has(parsed.name)) {
      this.#deps.reply(this.#help());
      return;
    }
    const conversational = this.#conversational.get(parsed.name);
    if (leak) {
      // Never act on it: arguments could be echoed back (e.g. "can't read …"), and it can't be a valid one anyway.
      this.#deps.reply(`⚠️ /${parsed.name} was not run. ${leak} Send the command alone; I ask for the passphrase when it's needed.`);
      return;
    }
    if (parsed.args !== '' && !conversational?.acceptsArgs) {
      this.#deps.reply(`⚠️ /${parsed.name} takes no arguments.`);
      return;
    }
    if (parsed.name === 'cancel') {
      await this.#cancelCommand(user);
      return;
    }
    if (conversational) {
      await this.#startConversation(conversational, message, user, parsed.args);
      return;
    }
    const command = this.#commands.get(parsed.name);
    if (!command) return;
    const last = this.#lastRun.get(command.name);
    const cooldownMs = command.cooldownSeconds * 1000;
    if (last !== undefined && nowMs - last < cooldownMs) {
      this.#deps.reply(
        `⏳ /${command.name} ran ${duration(nowMs - last)} ago; it can run again in ${duration(cooldownMs - (nowMs - last))} ` +
          '(this keeps API use down).',
      );
      return;
    }
    this.#lastRun.set(command.name, nowMs);
    await this.#execute(command, user);
  }

  // ---------- read-only commands ----------

  async #execute(command: BotCommand, user: TelegramUser): Promise<void> {
    const started = this.#clock.now().getTime();
    log.info(`Telegram commands: /${command.name} from user ${user.id}`);
    const result = await this.#guard(() => command.run());
    let error: string | undefined;
    if (result.ok) {
      this.#deps.reply(result.value);
    } else if (result.outcome === 'failed') {
      error = result.error;
      log.warn(`Telegram commands: /${command.name} failed: ${error}`);
      this.#deps.reply(`❌ /${command.name} failed: ${safe(error, 300)}`);
    } else if (result.outcome === 'timed_out') {
      error = result.error;
      this.#deps.reply(`⌛ /${command.name} timed out (${error}). Try again later.`);
    }
    this.#audit.record('command.handled', {
      command: command.name,
      user: user.id,
      ...(user.username ? { userName: clip(user.username, 64) } : {}),
      outcome: result.ok ? 'ok' : result.outcome,
      ms: this.#clock.now().getTime() - started,
      ...(error ? { error } : {}),
    });
  }

  /**
   * Runs command code with a timeout. The outcome is always a value: code that fails after it has timed
   * out must not become an unhandled rejection (that would crash the whole conductor), and a synchronous
   * throw is caught too.
   */
  async #guard<T>(fn: () => T | Promise<T>): Promise<Guarded<T>> {
    let timer: TimerHandle | undefined;
    const run = Promise.resolve()
      .then(fn)
      .then(
        (value) => ({ value }),
        (err: unknown) => ({ err }),
      );
    try {
      const result = await Promise.race([
        run,
        new Promise<{ timedOut: true }>((resolve) => {
          timer = this.#clock.setTimeout(() => resolve({ timedOut: true }), this.#opts.commandTimeoutMs);
        }),
        new Promise<{ stopped: true }>((resolve) => this.#stopWaiters.push(() => resolve({ stopped: true }))),
      ]);
      if ('value' in result) return { ok: true, value: result.value };
      if ('err' in result) return { ok: false, outcome: 'failed', error: clip(errorMessage(result.err), 300) };
      if ('timedOut' in result) return { ok: false, outcome: 'timed_out', error: `no answer within ${duration(this.#opts.commandTimeoutMs)}` };
      return { ok: false, outcome: 'stopped' };
    } finally {
      this.#clock.clearTimeout(timer);
      this.#stopWaiters = [];
    }
  }

  // ---------- commands that change something ----------

  async #startConversation(command: ConversationCommand, message: TelegramMessage, user: TelegramUser, args: string): Promise<void> {
    const nowMs = this.#clock.now().getTime();
    log.info(`Telegram commands: /${command.name} from user ${user.id}`);
    if (command.kind === 'mutable' && this.#lockedUntil > nowMs) {
      await this.#say(
        `🔒 Changes are locked for another ${duration(this.#lockedUntil - nowMs)} after too many wrong passphrases. /${command.name} was not run.`,
      );
      this.#recordConversation(command, user, nowMs, 'locked');
      return;
    }
    const current = this.#conversation;
    if (current) {
      const other = current.user.id !== user.id;
      if (other && current.command.kind === 'mutable') {
        // Someone else's change in progress is never interfered with.
        await this.#say(`⏳ ${safe(actorOf(current.user).label)} is answering /${current.command.name}. Try again when that's done.`);
        return;
      }
      this.#end(current, 'superseded');
      if (other) {
        // Read-only browsing gives way (it must never hold up e.g. a /pause).
        await this.#say(`👋 ${safe(actorOf(current.user).label)}'s /${current.command.name} was closed for /${command.name}.`);
      } else if (current.command.kind === 'mutable') {
        await this.#say(`✋ The pending /${current.command.name} was cancelled.`);
      }
    }

    const conversation: Conversation = { command, user, startedMs: nowMs, invalid: 0 };
    this.#conversation = conversation;
    const actor: Actor = { id: user.id, ...(user.username ? { username: user.username } : {}) };
    const step = await this.#guard(() => command.begin(actor, args));
    if (this.#conversation !== conversation) return; // stopped meanwhile
    if (!step.ok) {
      this.#end(conversation, step.outcome, step.error);
      if (step.outcome !== 'stopped') await this.#say(`❌ /${command.name} failed: ${safe(step.error, 300)}. Nothing changed.`);
      return;
    }
    await this.#advance(conversation, step.value, message);
  }

  /** Moves to the next step: asks its question, or ends the conversation if there's nothing to do. */
  async #advance(conversation: Conversation, step: Step, replyTo: TelegramMessage): Promise<void> {
    if (step.kind === 'done') {
      this.#end(conversation, conversation.command.kind === 'mutable' ? 'nothing-to-do' : 'ok');
      await this.#say(step.text);
      return;
    }
    if (step.kind === 'passphrase' && conversation.command.kind !== 'mutable') {
      // Fail closed: only a command registered as mutable may run anything behind the passphrase.
      log.error(`Telegram commands: read-only /${conversation.command.name} asked for the passphrase; refused`);
      this.#end(conversation, 'failed', 'a read-only command asked for the passphrase');
      await this.#say(`❌ /${conversation.command.name} failed (internal error). Nothing changed.`);
      return;
    }
    conversation.step = step;
    conversation.invalid = 0;
    await this.#ask(conversation, step.text, replyTo);
  }

  /** Sends a question (as a reply that opens the answer box) and starts waiting for the answer. */
  async #ask(conversation: Conversation, html: string, replyTo: TelegramMessage): Promise<void> {
    const step = conversation.step;
    const placeholder = step?.kind === 'passphrase' ? 'passphrase or cancel' : step?.kind === 'input' && step.placeholder ? step.placeholder : 'your answer';
    await this.#say(html, { replyToMessageId: replyTo.message_id, forceReply: true, placeholder });
    if (this.#conversation !== conversation) return;
    this.#clock.clearTimeout(conversation.timer);
    conversation.timer = this.#clock.setTimeout(() => this.#expire(conversation), this.#opts.conversationTimeoutMs);
  }

  #expire(conversation: Conversation): void {
    if (this.#conversation !== conversation) return;
    const name = conversation.command.name;
    this.#end(conversation, 'expired');
    this.#lastExpired = { userId: conversation.user.id, command: name, atMs: this.#clock.now().getTime() };
    // Browsing just ends quietly; a change that was being confirmed must say it didn't happen.
    if (conversation.command.kind === 'mutable') {
      void this.#say(`⌛ No answer within ${duration(this.#opts.conversationTimeoutMs)}: /${name} cancelled. Nothing changed.`);
    }
  }

  /** A text message from an allowed user: an answer if they're in a conversation, otherwise ignored. */
  async #onText(message: TelegramMessage, user: TelegramUser, text: string, leak: string): Promise<void> {
    const conversation = this.#conversation;
    if (conversation && conversation.user.id === user.id && conversation.step) {
      await this.#answer(conversation, message, text, leak);
      return;
    }
    if (leak) {
      await this.#say(`${leak} Nothing was waiting for it, so nothing was run.`);
      return;
    }
    // A late answer to a question that expired: say so, rather than leave them wondering.
    const expired = this.#lastExpired;
    const nowMs = this.#clock.now().getTime();
    if (expired && expired.userId === user.id && nowMs - expired.atMs < this.#opts.lateAnswerMs && ANSWER_WORDS.has(normalizeAnswer(text))) {
      this.#lastExpired = undefined;
      await this.#say(`⌛ That question had expired, so nothing was done. Send /${expired.command} again if you still want to.`);
    }
    // Anything else is ordinary chat.
  }

  async #answer(conversation: Conversation, message: TelegramMessage, text: string, leak: string): Promise<void> {
    const step = conversation.step;
    if (!step) return;
    this.#clock.clearTimeout(conversation.timer);
    const name = conversation.command.name;
    const word = normalizeAnswer(text);
    if (CANCEL_WORDS.has(word)) {
      this.#end(conversation, 'cancelled');
      await this.#say(this.#cancelledText(conversation));
      return;
    }

    if (step.kind === 'passphrase') {
      // Not an attempt at all: an answer word, or too short to be the passphrase (e.g. a number meant
      // for the previous question). Asked again rather than counted as a wrong passphrase.
      if (!this.#passphrase?.matches(text)) {
        if (ANSWER_WORDS.has(word)) {
          await this.#unexpected(conversation, message, '🔐 That was an answer word, not the passphrase.');
          return;
        }
        if (text.trim().length < MIN_PASSPHRASE_LENGTH) {
          await this.#unexpected(conversation, message, "🔐 That's too short to be the passphrase.");
          return;
        }
      }
      // Any answer from here on may be (close to) the passphrase: delete it before anything else.
      const note = (await this.#deleteMessage(message)) ? '' : ANSWER_NOT_DELETED;
      if (this.#conversation !== conversation) return;
      if (!this.#passphrase?.matches(text)) {
        await this.#wrongPassphrase(conversation, note);
        return;
      }
      this.#failures = [];
      const result = await this.#guard(() => step.run());
      if (this.#conversation !== conversation) return;
      if (result.ok) {
        const reply = typeof result.value === 'string' ? { text: result.value } : result.value;
        if ('error' in reply) log.warn(`Telegram commands: /${name} did not go through: ${reply.error}`);
        this.#end(conversation, 'error' in reply ? 'failed' : 'ok', 'error' in reply ? reply.error : undefined);
        await this.#say(`${reply.text}${note ? `\n\n${note}` : ''}`);
      } else {
        this.#end(conversation, result.outcome, result.error);
        if (result.outcome !== 'stopped') {
          log.warn(`Telegram commands: /${name} failed: ${result.error ?? result.outcome}`);
          await this.#say(`❌ /${name} failed: ${safe(result.error, 300)}. It may or may not have taken effect: check /status.${note ? `\n\n${note}` : ''}`);
        }
      }
      return;
    }

    if (leak) {
      await this.#unexpected(conversation, message, `${leak} Answer this question first; I ask for the passphrase after it.`);
      return;
    }
    if (step.kind === 'input') {
      const result = await this.#guard(() => step.read(text));
      if (this.#conversation !== conversation) return;
      if (!result.ok) {
        this.#end(conversation, result.outcome, result.error);
        if (result.outcome !== 'stopped') await this.#say(`❌ /${name} failed: ${safe(result.error, 300)}. Nothing changed.`);
        return;
      }
      if ('invalid' in result.value) {
        await this.#unexpected(conversation, message, `⚠️ ${safe(result.value.invalid, 300)}`);
        return;
      }
      await this.#advance(conversation, result.value.next, message);
      return;
    }

    // A question with choices.
    const choice = step.choices.find((c) => c.words.includes(word));
    if (!choice) {
      await this.#unexpected(conversation, message);
      return;
    }
    conversation.choice = choice.label;
    const next = await this.#guard(() => choice.next());
    if (this.#conversation !== conversation) return;
    if (!next.ok) {
      this.#end(conversation, next.outcome, next.error);
      if (next.outcome !== 'stopped') await this.#say(`❌ /${name} failed: ${safe(next.error, 300)}. Nothing changed.`);
      return;
    }
    await this.#advance(conversation, next.value, message);
  }

  /** An answer that fits nothing: ask again, or give up after too many. */
  async #unexpected(conversation: Conversation, message: TelegramMessage, why = "🤔 I didn't get that."): Promise<void> {
    const step = conversation.step;
    if (!step) return;
    conversation.invalid++;
    if (conversation.invalid >= this.#opts.maxInvalidAnswers) {
      this.#end(conversation, 'aborted');
      const ending = conversation.command.kind === 'mutable' ? 'cancelled. Nothing changed.' : 'closed.';
      await this.#say(`🤷 Too many unexpected answers: /${conversation.command.name} ${ending}`);
      return;
    }
    const hint = step.kind === 'passphrase' ? 'Send the passphrase, or <b>cancel</b>.' : safe(step.hint);
    await this.#ask(conversation, `${why} ${hint}`, message);
  }

  async #wrongPassphrase(conversation: Conversation, deletedNote: string): Promise<void> {
    const nowMs = this.#clock.now().getTime();
    const user = conversation.user;
    const name = conversation.command.name;
    this.#failures = [...this.#failures.filter((t) => nowMs - t < this.#opts.passphraseFailureWindowMs), nowMs];
    const failures = this.#failures.length;
    log.warn(`Telegram commands: wrong passphrase for /${name} from user ${user.id} (${failures} recent failure(s))`);
    this.#audit.record('command.auth_failed', {
      command: name,
      user: user.id,
      ...(user.username ? { userName: clip(user.username, 64) } : {}),
      failures,
    });
    this.#end(conversation, 'denied');
    let lock = '';
    if (failures >= this.#opts.maxPassphraseFailures) {
      this.#lockedUntil = nowMs + this.#opts.lockoutMs;
      this.#failures = [];
      log.error(`Telegram commands: changes locked for ${duration(this.#opts.lockoutMs)} after ${failures} wrong passphrases`);
      this.#audit.record('command.locked', { until: new Date(this.#lockedUntil).toISOString(), failures, user: user.id });
      lock =
        `\n🔒 Changes are now locked for ${duration(this.#opts.lockoutMs)}. If that wasn't you, someone can post as an ` +
        'allowed user: end their Telegram sessions and change the passphrase.';
    }
    await this.#say(`❌ Wrong passphrase: /${name} was not run.${lock}${deletedNote ? `\n\n${deletedNote}` : ''}`);
  }

  async #cancelCommand(user: TelegramUser): Promise<void> {
    const conversation = this.#conversation;
    if (!conversation) {
      await this.#say('Nothing to cancel.');
      return;
    }
    if (conversation.user.id !== user.id) {
      await this.#say(`Nothing of yours to cancel (${safe(actorOf(conversation.user).label)} is answering /${conversation.command.name}).`);
      return;
    }
    this.#end(conversation, 'cancelled');
    await this.#say(this.#cancelledText(conversation));
  }

  #cancelledText(conversation: Conversation): string {
    return conversation.command.kind === 'mutable'
      ? `✋ /${conversation.command.name} cancelled. Nothing changed.`
      : `👋 /${conversation.command.name} closed.`;
  }

  /** Ends a conversation and records how. */
  #end(conversation: Conversation, outcome: ConversationOutcome, error?: string): void {
    this.#clock.clearTimeout(conversation.timer);
    if (this.#conversation === conversation) this.#conversation = undefined;
    this.#recordConversation(conversation.command, conversation.user, conversation.startedMs, outcome, conversation.choice, error);
  }

  #recordConversation(command: ConversationCommand, user: TelegramUser, startedMs: number, outcome: ConversationOutcome, choice?: string, error?: string): void {
    this.#audit.record('command.handled', {
      command: command.name,
      user: user.id,
      ...(user.username ? { userName: clip(user.username, 64) } : {}),
      outcome,
      ...(choice ? { choice } : {}),
      ms: this.#clock.now().getTime() - startedMs,
      ...(error ? { error } : {}),
    });
  }

  /** Deletes a message that (may) contain the passphrase. Best effort: returns whether it worked. */
  async #deleteMessage(message: TelegramMessage): Promise<boolean> {
    try {
      await this.#deps.api.deleteMessage(message.message_id);
      return true;
    } catch (err) {
      log.warn(`Telegram commands: could not delete a message containing the passphrase: ${errorMessage(err)}`);
      return false;
    }
  }

  /** Sends a conversation message straight away; if that fails, through the queue (which retries). */
  async #say(html: string, opts?: SendOptions): Promise<void> {
    try {
      await this.#deps.api.sendMessage(html, opts);
    } catch (err) {
      log.warn(`Telegram commands: could not send a reply directly (${errorMessage(err)}); queueing it`);
      this.#deps.reply(html);
    }
  }

  #help(): string {
    const line = (c: BotCommand | ConversationCommand) =>
      `/${c.name}: ${safe(c.description)}${'script' in c && c.script ? ` <i>(like npm run ${safe(c.script, 40)})</i>` : ''}`;
    const all = [...this.#conversational.values()];
    const readOnly = [...this.#commands.values(), ...all.filter((c) => c.kind === 'interactive')];
    const mutable = all.filter((c) => c.kind === 'mutable');
    if (mutable.length === 0) {
      return [
        '🌱 <b>Lawn conductor commands</b> (read-only)',
        ...readOnly.map(line),
        '/help: this list',
        ...(all.length > 0 ? ['/cancel: close what is waiting for your answer'] : []),
      ].join('\n');
    }
    return [
      '🌱 <b>Lawn conductor commands</b>',
      ...readOnly.map(line),
      '/help: this list',
      '',
      '<b>Changes</b> (each asks for the passphrase):',
      ...mutable.map(line),
      '/cancel: cancel a pending change',
    ].join('\n');
  }

  /** Logs and audits a rejected command, at most once per sender per interval (and a bounded number overall). */
  #reject(message: TelegramMessage, reason: RejectReason, text: string): void {
    const nowMs = this.#clock.now().getTime();
    if (nowMs - this.#rejectionWindowStart >= this.#opts.rejectionAuditIntervalMs) {
      this.#rejections = new Map();
      this.#rejectionWindowStart = nowMs;
    }
    const from = message.from;
    const key = `${message.chat.id}:${from?.id ?? '-'}:${reason}`;
    if (this.#rejections.has(key) || this.#rejections.size >= this.#opts.maxRejectionAuditsPerInterval) {
      log.debug(`Telegram commands: ignored another command (${reason}) from chat ${message.chat.id}`);
      return;
    }
    this.#rejections.set(key, nowMs);
    // Only the command word is kept: the rest of the text is the sender's and could be anything.
    const parsed = parseCommand(text);
    log.warn(`Telegram commands: rejected a command (${reason}) from user ${from?.id ?? '?'} in chat ${message.chat.id}`);
    this.#audit.record('command.rejected', {
      reason,
      chat: message.chat.id,
      chatType: clip(message.chat.type, 20),
      ...(from ? { user: from.id } : {}),
      ...(from?.username ? { userName: clip(from.username, 64) } : {}),
      ...(parsed ? { command: parsed.name } : {}),
      notify: SUSPICIOUS.has(reason),
    });
  }

  #sleep(ms: number): Promise<void> {
    if (this.#stopped) return Promise.resolve();
    return new Promise((resolve) => {
      const timer = this.#clock.setTimeout(() => {
        this.#wake = undefined;
        resolve();
      }, ms);
      this.#wake = () => {
        this.#clock.clearTimeout(timer);
        this.#wake = undefined;
        resolve();
      };
    });
  }
}

const isConversation = (c: BotCommand | ConversationCommand): c is ConversationCommand =>
  'kind' in c && (c.kind === 'mutable' || c.kind === 'interactive');

const actorOf = (user: TelegramUser): Actor & { label: string } => ({
  id: user.id,
  ...(user.username ? { username: user.username } : {}),
  label: user.username ? `@${user.username}` : `user ${user.id}`,
});
