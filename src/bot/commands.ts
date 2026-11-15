import type { BhyveClient } from '../bhyve/client.ts';
import type { ConductorStatus } from '../conductor/monitor.ts';
import type { MoistureSource } from '../sensors/types.ts';
import type { QueryCommand } from './conversation.ts';
import { formatDevices, formatHealth, formatReadings, type ServiceInfo } from './format.ts';

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
  /** About the service itself (version, memory, files, notifications...), for /health. */
  service: () => ServiceInfo;
  /** For times in replies (default: this machine's). */
  timeZone?: string | undefined;
  now?: () => Date;
}

export const buildCommands = (deps: CommandDeps): QueryCommand[] => {
  const now = deps.now ?? (() => new Date());
  return [
    {
      kind: 'query',
      name: 'health',
      description: 'Is everything all right? Watering, zones, connections, alerts, and the service itself',
      help: {
        usage: [{ call: '/health', does: 'everything at a glance, with what needs a look first' }],
        details: [
          'First: all good, or what needs a look (services down, failed polls, open alerts, lockouts...).',
          'Running or paused (and until when), the last and next poll.',
          "Each zone's latest decision and soil moisture, numbered for /zone.",
          'Watering in progress or on hold, water that is on, connections and open alerts.',
          'The service: version, uptime, memory, polls, file sizes, notifications.',
          'Nothing is fetched from the cloud, so it is always quick.',
        ],
      },
      cooldownSeconds: 0,
      run: async () => formatHealth(deps.status(), deps.service(), deps.timeZone),
    },
    {
      kind: 'query',
      name: 'sensors_read',
      script: 'sensors:read',
      description: 'Read the soil sensors now',
      help: {
        usage: [{ call: '/sensors_read', does: 'reads every soil sensor of the zones now' }],
        details: ['For each sensor: moisture, temperature, battery, whether it is online, how old the reading is, and its zone.', 'Sensors that could not be read are listed with the reason.'],
      },
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
      help: {
        usage: [{ call: '/bhyve_devices', does: 'lists the B-hyve controllers on the account' }],
        details: ['For each: connected or not, battery, mode (auto/off), rain delay, whether it is watering, and its zones.'],
      },
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
