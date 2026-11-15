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
import {
  actorName,
  ANSWER_WORDS,
  CANCEL_WORDS,
  COMMAND_NAME,
  normalizeAnswer,
  type Actor,
  type BotCommand,
  type ConversationCommand,
  type QueryCommand,
  type Step,
} from './conversation.ts';
import { clip, duration, safe } from './format.ts';
import { classifyAttempt, PassphraseGate, type GateResult } from './gate.ts';
import { BUILT_IN_HELP, HELP_ALIASES, helpFor, helpIndex } from './help.ts';

/**
 * Answers commands sent to the Telegram bot, using long polling (getUpdates): the conductor only makes
 * outgoing requests, so no port is opened and there is no webhook URL to discover or spoof.
 *
 * Every message goes through, in order:
 *   1. authorization (auth.ts): the configured chat, an allowed user, no forwards/bots/anonymous senders.
 *      Rejected commands get no reply (the bot doesn't reveal anything to strangers); they are audited,
 *      throttled. Other messages from strangers are ignored silently;
 *   2. freshness: messages older than `maxMessageAgeSeconds` (e.g. queued while the conductor was down,
 *      or replayed after a restart) are dropped;
 *   3. text that isn't a command is only an answer in a conversation, otherwise ignored;
 *   4. commands: a global rate limit, then a per-command cooldown; each runs with a timeout, one at a time.
 *
 * Conversations (see conversation.ts) are with one person at a time:
 *   - "cancel" (or /cancel) ends one at any step; so does a wrong passphrase;
 *   - an answer that doesn't fit is asked again, up to `maxInvalidAnswers` times; answers are rate-limited;
 *   - no answer within `conversationTimeoutMs` ends it. A change happens only after the passphrase step;
 *   - read-only commands still work meanwhile. The same person starting another conversation replaces
 *     theirs; someone else waits for a change in progress, but read-only browsing gives way to them;
 *   - wrong passphrases lock changes, for longer each time (gate.ts).
 *
 * The passphrase is never compared with anything but an answer to the passphrase question: whether the
 * bot deletes a message must not depend on it, or deleting would tell a guesser when they were right
 * (a guessing oracle with no lockout). Instead, everything that could be the passphrase (classifyAttempt)
 * is deleted wherever the passphrase could turn up by mistake: answers to the passphrase question, right
 * or wrong; an answer to an earlier question of a change; text after a change's command; the next message
 * after a wrong passphrase or after the passphrase question expired (people retype it); an old answer to
 * the passphrase question.
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
  /** At most this many answers (in conversations) per `rateWindowMs`; the rest are ignored. */
  maxAnswersPerWindow: number;
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
  /** ...for this long the first time, twice as long each time after... */
  lockoutMs: number;
  /** ...up to this. */
  maxLockoutMs: number;
  /** After a question expires, a late answer within this long gets told it came too late. */
  lateAnswerMs: number;
}

export const DEFAULT_BOT_OPTIONS: CommandBotOptions = {
  pollTimeoutSeconds: 50,
  maxMessageAgeSeconds: 120,
  commandTimeoutMs: 45_000,
  maxCommandsPerWindow: 10,
  maxAnswersPerWindow: 30,
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
  maxLockoutMs: 24 * 3_600_000,
  lateAnswerMs: 10 * 60_000,
};

export interface CommandBotDeps {
  api: BotApi;
  policy: CommandPolicy;
  commands: readonly BotCommand[];
  /** Required if any command is mutable (changes something). */
  passphrase?: string | undefined;
  /** Commands that exist but are switched off here, with why, for /help (e.g. no passphrase set). */
  unavailable?: ReadonlyMap<string, string>;
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

const BUILT_IN = new Set([...HELP_ALIASES, 'cancel']);
/** Reasons that mean someone other than the allowed users tried (worth telling the owner). */
const SUSPICIOUS: ReadonlySet<RejectReason> = new Set(['other-chat', 'user-not-allowed', 'anonymous', 'bot-sender', 'no-sender']);

const noAudit: AuditSink = { record: () => {} };

const CANNOT_DELETE = "(in a group I need the “Delete messages” admin right): please delete it yourself";
/** After deleting (or failing to delete) something that could have been the passphrase. */
const deletedNote = (deleted: boolean): string =>
  deleted ? 'I deleted your message in case it was the passphrase.' : `⚠️ I couldn't delete your message ${CANNOT_DELETE}, in case it was the passphrase.`;

type Outcome = 'ok' | 'failed' | 'timed_out' | 'stopped';
type Guarded<T> = { ok: true; value: T } | { ok: false; outcome: Exclude<Outcome, 'ok'>; error?: string };

/** How a command or conversation ended, for the audit trail. */
type HandledOutcome =
  | Outcome
  | 'nothing-to-do'
  | 'cancelled'
  | 'expired'
  | 'denied'
  | 'aborted'
  | 'superseded'
  | 'locked';

interface Conversation {
  command: ConversationCommand;
  user: TelegramUser;
  startedMs: number;
  /** The step waiting for an answer (unset until the first one is asked). */
  step?: Exclude<Step, { kind: 'done' }>;
  /** Answers that fit nothing, at this step. */
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
  readonly #registry: ReadonlyMap<string, BotCommand>;
  readonly #gate: PassphraseGate | undefined;
  readonly #limiter: SlidingWindowLimiter;
  readonly #answerLimiter: SlidingWindowLimiter;
  readonly #lastRun = new Map<string, number>();
  /** Rejection audit throttle: sender key → last audited; reset every interval. */
  #rejections = new Map<string, number>();
  #rejectionWindowStart = 0;
  /** When "too many commands/answers" was last said, per kind (said once per window). */
  readonly #limitNoticeAt = new Map<'commands' | 'answers', number>();
  #username: string | undefined;
  #offset: number | undefined;
  #loop: Promise<void> | undefined;
  #stopped = true;
  #abort: AbortController | undefined;
  #wake: (() => void) | undefined;
  #stopWaiters: (() => void)[] = [];
  #conversation: Conversation | undefined;
  /** The last conversation that ended, to explain a late answer (and delete a passphrase sent after it). */
  #lastEnded: { userId: number; command: string; atMs: number; atPassphrase: boolean; expired: boolean } | undefined;

  constructor(deps: CommandBotDeps) {
    this.#deps = deps;
    this.#opts = { ...DEFAULT_BOT_OPTIONS, ...deps.options };
    this.#clock = deps.clock ?? systemClock;
    this.#audit = deps.audit ?? noAudit;
    const registry = new Map<string, BotCommand>();
    for (const c of deps.commands) {
      if (BUILT_IN.has(c.name) || registry.has(c.name)) throw new Error(`duplicate bot command /${c.name}`);
      if (!COMMAND_NAME.test(c.name)) throw new Error(`invalid bot command name /${c.name}`);
      registry.set(c.name, c);
    }
    this.#registry = registry;
    const mutable = [...registry.values()].filter((c) => c.kind === 'mutable');
    if (mutable.length > 0 && deps.passphrase === undefined) {
      // Fail closed: a command that changes something must never run without the passphrase check.
      throw new Error(`/${mutable.map((c) => c.name).join(', /')} need a passphrase (TELEGRAM_COMMAND_PASSPHRASE)`);
    }
    this.#gate =
      deps.passphrase === undefined
        ? undefined
        : new PassphraseGate(deps.passphrase, {
            maxFailures: this.#opts.maxPassphraseFailures,
            failureWindowMs: this.#opts.passphraseFailureWindowMs,
            lockoutMs: this.#opts.lockoutMs,
            maxLockoutMs: this.#opts.maxLockoutMs,
          });
    this.#limiter = new SlidingWindowLimiter(this.#opts.maxCommandsPerWindow, this.#opts.rateWindowMs);
    this.#answerLimiter = new SlidingWindowLimiter(this.#opts.maxAnswersPerWindow, this.#opts.rateWindowMs);
  }

  get running(): boolean {
    return this.#loop !== undefined;
  }

  /** The bot's @username, once Telegram has told us. */
  get username(): string | undefined {
    return this.#username;
  }

  /** The command being answered, if any (for tests and status). */
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

  // ---------- polling ----------

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
    const commands = [...this.#registry.values()];
    const menu = [
      { command: 'help', description: BUILT_IN_HELP.help.description },
      ...commands.map((c) => ({ command: c.name, description: c.description })),
      ...(commands.some((c) => c.kind !== 'query') ? [{ command: 'cancel', description: BUILT_IN_HELP.cancel.description }] : []),
    ];
    try {
      await this.#deps.api.setMyCommands(menu, this.#deps.policy.chatId);
    } catch (err) {
      // Only the menu in the Telegram app; typed commands work regardless.
      log.warn(`Telegram commands: could not set the command menu: ${errorMessage(err)}`);
    }
  }

  // ---------- every message ----------

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
    if (ageSeconds > this.#opts.maxMessageAgeSeconds) await this.#onStale(message, user, text, isCommand, ageSeconds);
    else if (isCommand) await this.#onCommand(message, user, text, nowMs);
    else await this.#onText(message, user, text, nowMs);
  }

  /** An old message (sent while the conductor was down, or replayed): never acted on. */
  async #onStale(message: TelegramMessage, user: TelegramUser, text: string, isCommand: boolean, ageSeconds: number): Promise<void> {
    // Never log the text: it could be the passphrase.
    log.info(`Telegram commands: ignoring a ${isCommand ? 'command' : 'message'} from user ${user.id}, sent ${duration(ageSeconds * 1000)} ago (too old)`);
    const conversation = this.#conversation;
    const atPassphrase = !isCommand && conversation?.user.id === user.id && conversation.step?.kind === 'passphrase';
    if (atPassphrase && classifyAttempt(text) === 'attempt') {
      await this.#say(`🔐 Your message was too old to act on; nothing was run. ${deletedNote(await this.#deleteMessage(message))}`);
    }
  }

  async #onCommand(message: TelegramMessage, user: TelegramUser, text: string, nowMs: number): Promise<void> {
    const parsed = parseCommand(text);
    // Addressed to another bot in the group: not ours to answer.
    if (parsed?.target !== undefined && parsed.target.toLowerCase() !== this.#username?.toLowerCase()) return;
    if (!this.#withinLimit(this.#limiter, 'commands', nowMs, user)) return;

    const command = parsed ? this.#registry.get(parsed.name) : undefined;
    if (!parsed || (!command && !BUILT_IN.has(parsed.name))) {
      this.#deps.reply(`🤷 Unknown command${parsed ? ` /${safe(parsed.name, 32)}` : ''}. Send /help for the list.`);
      return;
    }
    if (HELP_ALIASES.has(parsed.name)) {
      // "/help audit" explains one command. ("/start <anything>" is Telegram's deep link: just the list.)
      const commands = [...this.#registry.values()];
      this.#deps.reply(
        parsed.name === 'help' && parsed.args !== ''
          ? helpFor(parsed.args, commands, { ...(this.#deps.unavailable ? { unavailable: this.#deps.unavailable } : {}), answerTimeoutMs: this.#opts.conversationTimeoutMs })
          : helpIndex(commands),
      );
      return;
    }
    if (parsed.args !== '' && !(command && command.kind !== 'query' && command.acceptsArgs)) {
      // Text after a change's command could be the passphrase, sent along with it by mistake.
      const note =
        command?.kind === 'mutable' && classifyAttempt(parsed.args) === 'attempt'
          ? ` Send it alone; I ask for the passphrase when it's needed. ${deletedNote(await this.#deleteMessage(message))}`
          : '';
      this.#deps.reply(`⚠️ /${parsed.name} takes no arguments.${note}`);
      return;
    }
    if (!command) {
      await this.#cancelCommand(user); // the only other built-in
      return;
    }
    if (command.kind === 'query') {
      await this.#query(command, user, nowMs);
      return;
    }
    await this.#startConversation(command, message, user, parsed.args);
  }

  /** Text that isn't a command: an answer if the sender is in a conversation; otherwise mostly ignored. */
  async #onText(message: TelegramMessage, user: TelegramUser, text: string, nowMs: number): Promise<void> {
    const conversation = this.#conversation;
    if (conversation?.step && conversation.user.id === user.id) {
      if (this.#withinLimit(this.#answerLimiter, 'answers', nowMs, user)) await this.#answer(conversation, message, text);
      return;
    }
    // Just after a conversation: a late answer (say it came too late), or the passphrase typed again after
    // the passphrase question ended (delete it, whatever it is: it is never compared).
    const ended = this.#lastEnded;
    if (!ended || ended.userId !== user.id || nowMs - ended.atMs >= this.#opts.lateAnswerMs) return;
    const kind = classifyAttempt(text);
    const retypedPassphrase = kind === 'attempt' && ended.atPassphrase;
    const lateAnswer = kind === 'answer-word' && ended.expired;
    if (!retypedPassphrase && !lateAnswer) return; // ordinary chat
    this.#lastEnded = undefined;
    const cleanup = retypedPassphrase ? ` ${deletedNote(await this.#deleteMessage(message))}` : '';
    await this.#say(
      ended.expired
        ? `⌛ That question had expired, so nothing was done.${cleanup} Send /${ended.command} again if you still want to.`
        : `Nothing was waiting for an answer, so nothing was run.${cleanup}`,
    );
  }

  /** Commands and answers are rate-limited; over the limit, say so once per window and ignore the rest. */
  #withinLimit(limiter: SlidingWindowLimiter, what: 'commands' | 'answers', nowMs: number, user: TelegramUser): boolean {
    if (limiter.tryTake(nowMs)) return true;
    const last = this.#limitNoticeAt.get(what);
    if (last === undefined || nowMs - last >= this.#opts.rateWindowMs) {
      this.#limitNoticeAt.set(what, nowMs);
      this.#deps.reply(`🐢 Too many ${what}; ignoring them for up to ${duration(this.#opts.rateWindowMs)}.`);
    }
    log.warn(`Telegram commands: rate limit reached; ignoring ${what === 'commands' ? 'a command' : 'an answer'} from user ${user.id}`);
    return false;
  }

  // ---------- read-only queries ----------

  async #query(command: QueryCommand, user: TelegramUser, nowMs: number): Promise<void> {
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
    log.info(`Telegram commands: /${command.name} from user ${user.id}`);
    const result = await this.#guard(() => command.run());
    if (result.ok) {
      this.#deps.reply(result.value);
    } else if (result.outcome === 'failed') {
      log.warn(`Telegram commands: /${command.name} failed: ${result.error}`);
      this.#deps.reply(`❌ /${command.name} failed: ${safe(result.error, 300)}`);
    } else if (result.outcome === 'timed_out') {
      this.#deps.reply(`⌛ /${command.name} timed out (${result.error}). Try again later.`);
    }
    this.#recordHandled(command.name, user, nowMs, result.ok ? 'ok' : result.outcome, { error: result.ok ? undefined : result.error });
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

  // ---------- conversations ----------

  async #startConversation(command: ConversationCommand, message: TelegramMessage, user: TelegramUser, args: string): Promise<void> {
    const nowMs = this.#clock.now().getTime();
    log.info(`Telegram commands: /${command.name} from user ${user.id}`);
    const locked = command.kind === 'mutable' ? (this.#gate?.lockedForMs(nowMs) ?? 0) : 0;
    if (locked > 0) {
      await this.#say(`🔒 Changes are locked for another ${duration(locked)} after too many wrong passphrases. /${command.name} was not run.`);
      this.#recordHandled(command.name, user, nowMs, 'locked');
      return;
    }
    const current = this.#conversation;
    if (current) {
      const other = current.user.id !== user.id;
      if (other && current.command.kind === 'mutable') {
        // Someone else's change in progress is never interfered with.
        await this.#say(`⏳ ${safe(actorName(current.user))} is answering /${current.command.name}. Try again when that's done.`);
        return;
      }
      this.#end(current, 'superseded');
      // Read-only browsing gives way (it must never hold up e.g. a /pause).
      if (other) await this.#say(`👋 ${safe(actorName(current.user))}'s /${current.command.name} was closed for /${command.name}.`);
      else if (current.command.kind === 'mutable') await this.#say(`✋ The pending /${current.command.name} was cancelled.`);
    }

    const conversation: Conversation = { command, user, startedMs: nowMs, invalid: 0 };
    this.#conversation = conversation;
    const actor: Actor = { id: user.id, ...(user.username ? { username: user.username } : {}) };
    const step = await this.#step(conversation, () => command.begin(actor, args));
    if (step) await this.#advance(conversation, step, message);
  }

  /**
   * Runs a conversation's command code (begin, read). Returns its result; or, if it failed, timed out or
   * the bot stopped (or the conversation ended meanwhile), ends the conversation, says so, and returns
   * undefined.
   */
  async #step<T>(conversation: Conversation, fn: () => T | Promise<T>): Promise<T | undefined> {
    const result = await this.#guard(fn);
    if (this.#conversation !== conversation) return undefined;
    if (result.ok) return result.value;
    this.#end(conversation, result.outcome, result.error);
    if (result.outcome !== 'stopped') await this.#say(`❌ /${conversation.command.name} failed: ${safe(result.error, 300)}. Nothing changed.`);
    return undefined;
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
    const placeholder = step?.kind === 'passphrase' ? 'passphrase or cancel' : (step?.placeholder ?? 'your answer');
    await this.#say(html, { replyToMessageId: replyTo.message_id, forceReply: true, placeholder });
    if (this.#conversation !== conversation) return;
    this.#clock.clearTimeout(conversation.timer);
    conversation.timer = this.#clock.setTimeout(() => this.#expire(conversation), this.#opts.conversationTimeoutMs);
  }

  #expire(conversation: Conversation): void {
    if (this.#conversation !== conversation) return;
    const name = conversation.command.name;
    this.#end(conversation, 'expired');
    // Browsing just ends quietly; a change that was being confirmed must say it didn't happen.
    if (conversation.command.kind === 'mutable') {
      void this.#say(`⌛ No answer within ${duration(this.#opts.conversationTimeoutMs)}: /${name} cancelled. Nothing changed.`);
    }
  }

  async #answer(conversation: Conversation, message: TelegramMessage, text: string): Promise<void> {
    const step = conversation.step;
    if (!step) return;
    this.#clock.clearTimeout(conversation.timer);
    if (CANCEL_WORDS.has(normalizeAnswer(text))) {
      this.#end(conversation, 'cancelled');
      await this.#say(this.#cancelledText(conversation));
      return;
    }
    if (step.kind === 'passphrase') {
      await this.#passphraseAnswer(conversation, step, message, text);
      return;
    }
    const result = await this.#step(conversation, () => step.read(text));
    if (!result) return;
    if ('next' in result) {
      if (result.choice) conversation.choice = result.choice;
      await this.#advance(conversation, result.next, message);
      return;
    }
    const why = result.invalid ? `⚠️ ${safe(result.invalid, 300)}` : undefined;
    // In a change, an answer that fits nothing may be the passphrase, sent too early: remove it.
    if (conversation.command.kind === 'mutable' && classifyAttempt(text) === 'attempt') {
      const deleted = await this.#deleteMessage(message);
      if (this.#conversation !== conversation) return;
      await this.#unexpected(conversation, message, `${why ? `${why} ` : ''}🔐 ${deletedNote(deleted)} Answer this question first; the passphrase comes last.`);
      return;
    }
    await this.#unexpected(conversation, message, why);
  }

  async #passphraseAnswer(conversation: Conversation, step: Extract<Step, { kind: 'passphrase' }>, message: TelegramMessage, text: string): Promise<void> {
    // Not an attempt at all (judged without looking at the passphrase): asked again, not counted.
    const kind = classifyAttempt(text);
    if (kind !== 'attempt') {
      await this.#unexpected(conversation, message, kind === 'answer-word' ? '🔐 That was an answer word, not the passphrase.' : "🔐 That's too short to be the passphrase.");
      return;
    }
    // Every attempt is deleted, right or wrong.
    const deleted = await this.#deleteMessage(message);
    if (this.#conversation !== conversation) return;
    const note = deleted ? '' : `\n\n⚠️ I couldn't delete your passphrase message ${CANNOT_DELETE}.`;
    const check: GateResult = this.#gate ? this.#gate.check(text, this.#clock.now().getTime()) : { ok: false, failures: 0 };
    if (!check.ok) {
      await this.#wrongPassphrase(conversation, check, note);
      return;
    }
    const result = await this.#guard(() => step.run());
    if (this.#conversation !== conversation) return;
    const name = conversation.command.name;
    if (!result.ok) {
      this.#end(conversation, result.outcome, result.error);
      if (result.outcome !== 'stopped') {
        log.warn(`Telegram commands: /${name} failed: ${result.error ?? result.outcome}`);
        await this.#say(`❌ /${name} failed: ${safe(result.error, 300)}. It may or may not have taken effect: check /status.${note}`);
      }
      return;
    }
    const reply = typeof result.value === 'string' ? { text: result.value } : result.value;
    if ('error' in reply) log.warn(`Telegram commands: /${name} did not go through: ${reply.error}`);
    this.#end(conversation, 'error' in reply ? 'failed' : 'ok', 'error' in reply ? reply.error : undefined);
    await this.#say(`${reply.text}${note}`);
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

  async #wrongPassphrase(conversation: Conversation, check: Extract<GateResult, { ok: false }>, note: string): Promise<void> {
    const user = conversation.user;
    const name = conversation.command.name;
    this.#end(conversation, check.alreadyLocked ? 'locked' : 'denied');
    if (check.alreadyLocked) {
      await this.#say(`🔒 Changes are locked for another ${duration(check.lockedForMs ?? 0)}. /${name} was not run.${note}`);
      return;
    }
    log.warn(`Telegram commands: wrong passphrase for /${name} from user ${user.id} (${check.failures} recent failure(s))`);
    this.#audit.record('command.auth_failed', {
      command: name,
      user: user.id,
      ...(user.username ? { userName: clip(user.username, 64) } : {}),
      failures: check.failures,
    });
    let lock = '';
    if (check.lockedForMs !== undefined) {
      const until = new Date(this.#clock.now().getTime() + check.lockedForMs);
      log.error(`Telegram commands: changes locked for ${duration(check.lockedForMs)} after ${check.failures} wrong passphrases`);
      this.#audit.record('command.locked', { until: until.toISOString(), failures: check.failures, user: user.id });
      lock =
        `\n🔒 Changes are now locked for ${duration(check.lockedForMs)}. If that wasn't you, someone can post as an ` +
        'allowed user: end their Telegram sessions and change the passphrase.';
    }
    await this.#say(`❌ Wrong passphrase: /${name} was not run.${lock}${note}`);
  }

  async #cancelCommand(user: TelegramUser): Promise<void> {
    const conversation = this.#conversation;
    if (!conversation) {
      await this.#say('Nothing to cancel.');
      return;
    }
    if (conversation.user.id !== user.id) {
      await this.#say(`Nothing of yours to cancel (${safe(actorName(conversation.user))} is answering /${conversation.command.name}).`);
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
  #end(conversation: Conversation, outcome: HandledOutcome, error?: string): void {
    this.#clock.clearTimeout(conversation.timer);
    if (this.#conversation === conversation) this.#conversation = undefined;
    this.#lastEnded = {
      userId: conversation.user.id,
      command: conversation.command.name,
      atMs: this.#clock.now().getTime(),
      // People retype the passphrase after a wrong one, or after the question expired (not after it worked).
      atPassphrase: conversation.step?.kind === 'passphrase' && (outcome === 'denied' || outcome === 'expired'),
      expired: outcome === 'expired',
    };
    this.#recordHandled(conversation.command.name, conversation.user, conversation.startedMs, outcome, { choice: conversation.choice, error });
  }

  /** The audit record of every command (never its text, which could hold anything). */
  #recordHandled(command: string, user: TelegramUser, startedMs: number, outcome: HandledOutcome, extra: { choice?: string | undefined; error?: string | undefined } = {}): void {
    this.#audit.record('command.handled', {
      command,
      user: user.id,
      ...(user.username ? { userName: clip(user.username, 64) } : {}),
      outcome,
      ...(extra.choice ? { choice: extra.choice } : {}),
      ms: this.#clock.now().getTime() - startedMs,
      ...(extra.error ? { error: extra.error } : {}),
    });
  }

  // ---------- sending ----------

  /** Deletes a message that could hold the passphrase. Best effort: returns whether it worked. */
  async #deleteMessage(message: TelegramMessage): Promise<boolean> {
    try {
      await this.#deps.api.deleteMessage(message.message_id);
      return true;
    } catch (err) {
      log.warn(`Telegram commands: could not delete a message: ${errorMessage(err)}`);
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
