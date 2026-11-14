import type { BhyveClient } from '../bhyve/client.ts';
import type { ConductorStatus } from '../conductor/monitor.ts';
import type { MoistureSource } from '../sensors/types.ts';
import { formatDevices, formatReadings, formatStatus } from './format.ts';

/**
 * The read-only commands the Telegram bot answers: nothing here can start or stop watering or change
 * a controller. That is enforced by the types below (the B-hyve client is narrowed to `getDevices`),
 * not just by convention. Commands that change something (/pause, /resume) live in control.ts and
 * always go through a conversation ending in the passphrase (conversation.ts, bot.ts); they still
 * never talk to B-hyve directly.
 */

export interface BotCommand {
  /** Telegram command name: lowercase letters, digits and underscores, at most 32. */
  name: string;
  /** Shown in /help and in the Telegram command menu. */
  description: string;
  /** The npm script it mirrors, if any. */
  script?: string;
  /** Minimum time between two runs; it protects API quotas and the B-hyve account the conductor relies on. */
  cooldownSeconds: number;
  /** Produces the reply (Telegram HTML). May throw; the bot reports the error. */
  run(): Promise<string>;
}

export interface CommandDeps {
  /** Read-only on purpose: only device listing is reachable from a chat. */
  bhyve: Pick<BhyveClient, 'getDevices'>;
  /** The conductor's sensors. Give the bot its own source instance so its reads can't mix with the monitor's. */
  sensors: MoistureSource;
  /** Zone names per sensor id, to label readings. */
  zonesBySensor: ReadonlyMap<string, readonly string[]>;
  /** The conductor's state, without network calls (Monitor.status). */
  status: () => ConductorStatus;
  /** For times in replies (default: this machine's). */
  timeZone?: string | undefined;
  now?: () => Date;
}

export const COMMAND_NAME = /^[a-z0-9_]{1,32}$/;

export const buildCommands = (deps: CommandDeps): BotCommand[] => {
  const now = deps.now ?? (() => new Date());
  const commands: BotCommand[] = [
    {
      name: 'status',
      description: 'What the conductor is doing: polls, zones, watering, connections, alerts',
      cooldownSeconds: 0,
      run: async () => formatStatus(deps.status(), deps.timeZone),
    },
    {
      name: 'sensors_read',
      script: 'sensors:read',
      description: 'Read the soil sensors now',
      cooldownSeconds: 30,
      run: async () => {
        const readings = await deps.sensors.read();
        return formatReadings({ readings, errors: deps.sensors.lastErrors ?? [], zonesBySensor: deps.zonesBySensor, now: now() });
      },
    },
    {
      name: 'bhyve_devices',
      script: 'bhyve:devices',
      description: 'B-hyve controllers: connection, battery, mode, rain delay, zones',
      cooldownSeconds: 30,
      run: async () => formatDevices(await deps.bhyve.getDevices()),
    },
  ];
  for (const c of commands) if (!COMMAND_NAME.test(c.name)) throw new Error(`invalid command name ${c.name}`);
  return commands;
};

/** Sensor id → names of the zones it's in. */
export const zonesBySensor = (zones: readonly { name: string; sensorIds: readonly string[] }[]): Map<string, string[]> => {
  const map = new Map<string, string[]>();
  for (const z of zones) {
    for (const id of z.sensorIds) {
      const list = map.get(id) ?? [];
      if (!list.includes(z.name)) list.push(z.name);
      map.set(id, list);
    }
  }
  return map;
};
