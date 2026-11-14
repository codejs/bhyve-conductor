import { errorMessage, type AuditSink } from '../audit/audit.ts';
import { systemClock, type Clock, type TimerHandle } from '../clock.ts';
import { log } from '../log.ts';
import {
  TelegramConflictError,
  TelegramPermanentError,
  TelegramRateLimitError,
  type GetUpdatesOptions,
  type TelegramMessage,
  type TelegramUpdate,
  type TelegramUser,
} from '../notify/telegram.ts';
import { authorize, type CommandPolicy, type RejectReason } from './auth.ts';
import type { BotCommand } from './commands.ts';
import { clip, duration, safe } from './format.ts';

/**
 * Answers commands sent to the Telegram bot, using long polling (getUpdates): the conductor only makes
 * outgoing requests, so no port is opened and there is no webhook URL to discover or spoof.
 *
 * Every message goes through, in order:
 *   1. only text starting with "/" is looked at; everything else is ignored silently;
 *   2. authorization (auth.ts): the configured chat, an allowed user, no forwards/bots/anonymous senders.
 *      Rejections get no reply (the bot doesn't reveal anything to strangers); they are audited, throttled;
 *   3. freshness: commands older than `maxMessageAgeSeconds` (e.g. queued while the conductor was down,
 *      or replayed after a restart) are dropped;
 *   4. a global rate limit, then a per-command cooldown;
 *   5. the command runs with a timeout, one at a time.
 * Replies only ever go to the configured chat (through the notification queue).
 */

/** The Telegram calls the bot makes (TelegramClient implements it; tests pass a fake). */
export interface BotApi {
  getMe(): Promise<TelegramUser>;
  getUpdates(opts: GetUpdatesOptions): Promise<TelegramUpdate[]>;
  setMyCommands(commands: readonly { command: string; description: string }[], chatId: number): Promise<void>;
}

export interface CommandBotOptions {
  /** Long-poll wait per getUpdates call. */
  pollTimeoutSeconds: number;
  /** Commands older than this are ignored (stale or replayed). */
  maxMessageAgeSeconds: number;
  /** A command that takes longer is reported as timed out. */
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
};

export interface CommandBotDeps {
  api: BotApi;
  policy: CommandPolicy;
  commands: readonly BotCommand[];
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
/** Reasons that mean someone other than the allowed users tried (worth telling the owner). */
const SUSPICIOUS: ReadonlySet<RejectReason> = new Set(['other-chat', 'user-not-allowed', 'anonymous', 'bot-sender', 'no-sender']);

const noAudit: AuditSink = { record: () => {} };

export class CommandBot {
  readonly #deps: CommandBotDeps;
  readonly #opts: CommandBotOptions;
  readonly #clock: Clock;
  readonly #audit: AuditSink;
  readonly #commands: ReadonlyMap<string, BotCommand>;
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

  constructor(deps: CommandBotDeps) {
    this.#deps = deps;
    this.#opts = { ...DEFAULT_BOT_OPTIONS, ...deps.options };
    this.#clock = deps.clock ?? systemClock;
    this.#audit = deps.audit ?? noAudit;
    const map = new Map<string, BotCommand>();
    for (const c of deps.commands) {
      if (HELP_NAMES.has(c.name) || map.has(c.name)) throw new Error(`duplicate bot command /${c.name}`);
      map.set(c.name, c);
    }
    this.#commands = map;
    this.#limiter = new SlidingWindowLimiter(this.#opts.maxCommandsPerWindow, this.#opts.rateWindowMs);
  }

  get running(): boolean {
    return this.#loop !== undefined;
  }

  /** The bot's @username, once Telegram has told us. */
  get username(): string | undefined {
    return this.#username;
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

  /** Stops polling, abandoning a long poll or a running command. */
  async stop(): Promise<void> {
    this.#stopped = true;
    this.#abort?.abort();
    this.#wake?.();
    for (const resolve of this.#stopWaiters.splice(0)) resolve();
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
    try {
      await this.#deps.api.setMyCommands(
        [{ command: 'help', description: 'List the commands' }, ...[...this.#commands.values()].map((c) => ({ command: c.name, description: c.description }))],
        this.#deps.policy.chatId,
      );
    } catch (err) {
      // Only the menu in the Telegram app; typed commands work regardless.
      log.warn(`Telegram commands: could not set the command menu: ${errorMessage(err)}`);
    }
  }

  async #handle(update: TelegramUpdate): Promise<void> {
    const message = update.message;
    const text = message?.text;
    if (!message || text === undefined || !text.startsWith('/')) return;

    const verdict = authorize(message, this.#deps.policy);
    if (!verdict.ok) {
      this.#reject(message, verdict.reason, text);
      return;
    }
    const user = verdict.user;
    const nowMs = this.#clock.now().getTime();
    const ageSeconds = nowMs / 1000 - message.date;
    if (ageSeconds > this.#opts.maxMessageAgeSeconds) {
      log.info(`Telegram commands: ignoring "${clip(text, 40)}" from user ${user.id}, sent ${duration(ageSeconds * 1000)} ago (too old)`);
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

    if (!parsed || (!this.#commands.has(parsed.name) && !HELP_NAMES.has(parsed.name))) {
      this.#deps.reply(`🤷 Unknown command${parsed ? ` /${safe(parsed.name, 32)}` : ''}. Send /help for the list.`);
      return;
    }
    if (HELP_NAMES.has(parsed.name)) {
      this.#deps.reply(this.#help());
      return;
    }
    const command = this.#commands.get(parsed.name);
    if (!command) return;
    if (parsed.args !== '') {
      this.#deps.reply(`⚠️ /${command.name} takes no arguments.`);
      return;
    }
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

  async #execute(command: BotCommand, user: TelegramUser): Promise<void> {
    const started = this.#clock.now().getTime();
    log.info(`Telegram commands: /${command.name} from user ${user.id}`);
    let outcome: 'ok' | 'failed' | 'timed_out' | 'stopped';
    let error: string | undefined;
    let timer: TimerHandle | undefined;
    // The outcome is always a value: a command that fails after it has timed out must not become an
    // unhandled rejection (that would crash the whole conductor). A synchronous throw is caught too.
    const run = Promise.resolve()
      .then(() => command.run())
      .then(
        (html) => ({ html }),
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
      if ('html' in result) {
        outcome = 'ok';
        this.#deps.reply(result.html);
      } else if ('err' in result) {
        outcome = 'failed';
        error = clip(errorMessage(result.err), 300);
        log.warn(`Telegram commands: /${command.name} failed: ${error}`);
        this.#deps.reply(`❌ /${command.name} failed: ${safe(error, 300)}`);
      } else if ('timedOut' in result) {
        outcome = 'timed_out';
        error = `no answer within ${duration(this.#opts.commandTimeoutMs)}`;
        this.#deps.reply(`⌛ /${command.name} timed out (${error}). Try again later.`);
      } else {
        outcome = 'stopped';
      }
    } finally {
      this.#clock.clearTimeout(timer);
      this.#stopWaiters = [];
    }
    this.#audit.record('command.handled', {
      command: command.name,
      user: user.id,
      ...(user.username ? { userName: clip(user.username, 64) } : {}),
      outcome,
      ms: this.#clock.now().getTime() - started,
      ...(error ? { error } : {}),
    });
  }

  #help(): string {
    const lines = ['🌱 <b>Lawn conductor commands</b> (read-only)'];
    for (const c of this.#commands.values()) {
      lines.push(`/${c.name}: ${safe(c.description)}${c.script ? ` <i>(like npm run ${safe(c.script, 40)})</i>` : ''}`);
    }
    lines.push('/help: this list');
    return lines.join('\n');
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
