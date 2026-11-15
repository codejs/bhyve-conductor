import type { BhyveClient } from '../bhyve/client.ts';
import type { ConductorStatus } from '../conductor/monitor.ts';
import type { MoistureSource } from '../sensors/types.ts';
import type { QueryCommand } from './conversation.ts';
import { formatDevices, formatReadings, formatStatus } from './format.ts';

/**
 * The read-only queries the Telegram bot answers: nothing here can start or stop watering or change
 * a controller. That is enforced by the types below (the B-hyve client is narrowed to `getDevices`),
 * not just by convention. /audit (audit-command.ts) is read-only too, over several messages. Commands
 * that change something (/pause, /resume in control.ts; /config in config-command.ts) always go through
 * a conversation ending in the passphrase (conversation.ts, bot.ts); none of them talks to B-hyve.
 */

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

export const buildCommands = (deps: CommandDeps): QueryCommand[] => {
  const now = deps.now ?? (() => new Date());
  return [
    {
      kind: 'query',
      name: 'status',
      description: 'What the conductor is doing: polls, zones, watering, connections, alerts',
      cooldownSeconds: 0,
      run: async () => formatStatus(deps.status(), deps.timeZone),
    },
    {
      kind: 'query',
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
      kind: 'query',
      name: 'bhyve_devices',
      script: 'bhyve:devices',
      description: 'B-hyve controllers: connection, battery, mode, rain delay, zones',
      cooldownSeconds: 30,
      run: async () => formatDevices(await deps.bhyve.getDevices()),
    },
  ];
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
