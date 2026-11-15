import { COMMAND_NAME, type BotCommand, type CommandHelp } from './conversation.ts';
import { duration, fitLines, safe } from './format.ts';

export interface HelpOptions {
  /** Commands that exist but are switched off here, with why (e.g. no passphrase set). */
  unavailable?: ReadonlyMap<string, string>;
  /** How long a question waits for an answer (the bot's conversationTimeoutMs). */
  answerTimeoutMs?: number;
}

/**
 * /help: the list of commands, or how to use one (`/help audit`). Each command describes itself
 * (CommandHelp); what follows from its kind (read-only or not, the passphrase, cooldowns) is added here,
 * so it can't drift from what the bot actually does.
 */

/** Names that are always there (handled by the bot itself), and their help. */
export const BUILT_IN_HELP: Readonly<Record<'help' | 'cancel', { description: string; help: CommandHelp }>> = {
  help: {
    description: 'List the commands, or show how to use one',
    help: {
      usage: [
        { call: '/help', does: 'lists the commands' },
        { call: '/help <command>', does: 'how to use that command, e.g. /help audit' },
      ],
    },
  },
  cancel: {
    description: 'Cancel a pending change (or close /audit)',
    help: {
      usage: [{ call: '/cancel', does: 'cancels the change waiting for your answer, or closes /audit' }],
      details: ['Nothing is changed. Replying "cancel" to a question does the same.'],
    },
  },
};

/** /start is what Telegram sends when someone first opens the bot: it shows the list. */
export const HELP_ALIASES: ReadonlySet<string> = new Set(['help', 'start']);

/** The list of commands: read-only ones first, then the ones that change something. */
export const helpIndex = (commands: readonly BotCommand[]): string => {
  const line = (c: BotCommand) => `/${c.name}: ${safe(c.description)}${c.kind === 'query' && c.script ? ` <i>(like npm run ${safe(c.script, 40)})</i>` : ''}`;
  const readOnly = commands.filter((c) => c.kind === 'query' || c.kind === 'interactive');
  const safety = commands.filter((c) => c.kind === 'safety');
  const mutable = commands.filter((c) => c.kind === 'mutable');
  const safetyLines = safety.length > 0 ? ['', '<b>Safety</b> (asks you to confirm, no passphrase):', ...safety.map(line)] : [];
  const conversations = commands.some((c) => c.kind !== 'query');
  const footer = ['', 'Send <b>/help</b> <i>command</i> to see how to use one, e.g. /help audit.'];
  if (mutable.length === 0) {
    return [
      '🌱 <b>Lawn conductor commands</b> (read-only)',
      ...readOnly.map(line),
      '/help: this list, or how to use a command',
      ...(conversations ? ['/cancel: close what is waiting for your answer'] : []),
      ...safetyLines,
      ...footer,
    ].join('\n');
  }
  return [
    '🌱 <b>Lawn conductor commands</b>',
    ...readOnly.map(line),
    '/help: this list, or how to use a command',
    ...safetyLines,
    '',
    '<b>Changes</b> (each asks for the passphrase):',
    ...mutable.map(line),
    '/cancel: cancel a pending change',
    ...footer,
  ].join('\n');
};

/**
 * How to use one command. `arg` is what followed /help ("audit", "/Audit", "audit@MyBot").
 * `unavailable` names commands that exist but are switched off here, with why.
 * What was typed is never repeated back (it could be anything, even the passphrase).
 */
export const helpFor = (arg: string, commands: readonly BotCommand[], opts: HelpOptions = {}): string => {
  const words = arg.trim().split(/\s+/).filter(Boolean);
  if (words.length !== 1) return '⚠️ Send /help for the list, or /help <i>command</i> for one of them, e.g. /help audit.';
  const name = (words[0] ?? '').replace(/^\//, '').replace(/@\w*$/, '').toLowerCase();
  if (!COMMAND_NAME.test(name)) return "🤷 There's no command by that name. Send /help for the list.";
  if (HELP_ALIASES.has(name)) return render('help', BUILT_IN_HELP.help.description, BUILT_IN_HELP.help.help, []);
  if (name === 'cancel') return render('cancel', BUILT_IN_HELP.cancel.description, BUILT_IN_HELP.cancel.help, []);

  const command = commands.find((c) => c.name === name);
  if (!command) {
    const why = opts.unavailable?.get(name);
    // Only a known name is shown back (it's ours, not what was typed).
    return why ? unavailableText(name, why) : "🤷 There's no command by that name. Send /help for the list.";
  }
  return render(command.name, command.description, command.help, notesFor(command, duration(opts.answerTimeoutMs ?? 120_000)));
};

/** A command that exists but is off here (no passphrase set), or was replaced: why. */
export const unavailableText = (name: string, why: string): string => `⛔ /${safe(name, 32)} is off here: ${safe(why)}`;

/** What follows from the command's kind and settings. */
const notesFor = (c: BotCommand, wait: string): string[] => {
  const notes: string[] = [];
  if (c.kind === 'mutable') {
    notes.push('🔐 Changes something: it asks for the passphrase last, and nothing changes before that. Reply <b>cancel</b> (or /cancel) at any step.');
    notes.push(`⌛ Each question waits ${wait} for your answer.`);
  } else if (c.kind === 'safety') {
    notes.push('🛑 Safety: it only ever turns water off. It asks you to confirm (no passphrase), and works even while changes are locked.');
    notes.push(`⌛ The question waits ${wait} for your answer.`);
  } else {
    notes.push('🔍 Read-only.');
  }
  if (c.kind === 'interactive') notes.push(`Reply <b>done</b> (or /cancel) to close it; it also closes after ${wait} without an answer.`);
  if (c.kind === 'query') {
    if (c.cooldownSeconds > 0) notes.push(`⏳ Runs at most once every ${c.cooldownSeconds} s (it asks a cloud service).`);
    if (c.script) notes.push(`💻 On the machine: <code>npm run ${safe(c.script, 40)}</code>`);
  }
  return notes;
};

const render = (name: string, description: string, help: CommandHelp | undefined, notes: readonly string[]): string => {
  const usage = help?.usage ?? [{ call: `/${name}`, does: description }];
  return fitLines([
    `❓ <b>/${name}</b>: ${safe(description)}`,
    '',
    '<b>Usage</b>',
    ...usage.map((u) => `<code>${safe(u.call, 60)}</code>: ${safe(u.does)}`),
    ...(help?.details?.length ? ['', ...help.details.map((d) => `• ${safe(d)}`)] : []),
    ...(notes.length > 0 ? ['', ...notes] : []),
  ]);
};
