import { buildAuditCommand, type AuditSnapshot } from './audit-command.ts';
import { buildCommands, type CommandDeps } from './commands.ts';
import { buildConfigCommand, type ConfigCommandDeps } from './config-command.ts';
import { buildControlCommands, type ConductorControl } from './control.ts';
import type { BotCommand } from './conversation.ts';

/**
 * Every command the bot offers, in one place (used by index.ts and the integration tests):
 *  - always, read-only: /status, /sensors_read, /bhyve_devices, /audit;
 *  - only with `changes` (i.e. a passphrase is set): /pause, /resume, /config.
 */
export interface BotCommandsDeps extends CommandDeps {
  /** Reads (the end of) the audit trail, for /audit. */
  readAudit: () => Promise<AuditSnapshot>;
  /** What the commands that change something work on. Leave out to offer read-only commands only. */
  changes?: {
    control: ConductorControl;
    editor: ConfigCommandDeps['editor'];
  };
}

/** Commands that exist but aren't offered with these deps, with why (for /help). */
export const unavailableCommands = (deps: Pick<BotCommandsDeps, 'changes'>): Map<string, string> =>
  deps.changes
    ? new Map()
    : new Map(['pause', 'resume', 'config'].map((name) => [name, 'changes need a passphrase (TELEGRAM_COMMAND_PASSPHRASE on the conductor).']));

export const buildBotCommands = (deps: BotCommandsDeps): BotCommand[] => {
  const { readAudit, changes, ...query } = deps;
  const timeZone = deps.timeZone;
  return [
    ...buildCommands(query),
    buildAuditCommand({ read: readAudit, timeZone, ...(deps.now ? { now: deps.now } : {}) }),
    ...(changes ? [...buildControlCommands({ control: changes.control, timeZone }), buildConfigCommand({ editor: changes.editor })] : []),
  ];
};
