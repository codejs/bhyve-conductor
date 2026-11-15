import type { ZoneDetail } from '../conductor/monitor.ts';
import { done, type InteractiveCommand, type Step } from './conversation.ts';
import { formatZone } from './format.ts';
import { findZone, NOT_A_ZONE, pickZone, zoneList, type ZoneRef } from './zones.ts';

/**
 * /zone [number or name]: everything about one zone, to answer "why did (or didn't) it water?": the
 * decision and why, each sensor, watering today against the daily cap, the cooldown, watering in progress
 * or on hold, the settings and open alerts. Read-only, no cloud calls.
 */

export interface ZoneView {
  zones(): ZoneRef[];
  zoneStatus(key: string): ZoneDetail | undefined;
}

export const buildZoneCommand = (deps: { view: ZoneView; timeZone?: string | undefined }): InteractiveCommand => {
  const show = (zone: ZoneRef): Step => {
    const detail = deps.view.zoneStatus(zone.key);
    return done(detail ? formatZone(detail, deps.timeZone) : NOT_A_ZONE);
  };
  return {
    kind: 'interactive',
    name: 'zone',
    description: 'Everything about one zone: why it did or didn\'t water, sensors, limits, settings',
    help: {
      usage: [
        { call: '/zone', does: 'asks which zone (if there are several), then shows it' },
        { call: '/zone 2', does: 'zone 2 (as numbered in /health)' },
        { call: '/zone Front lawn', does: 'the zone with that name' },
      ],
      details: [
        'The latest decision and why, each sensor (moisture, temperature, battery, age).',
        'Watering in the last 24 h against the daily cap, the last run, the cooldown.',
        'Watering in progress or on hold, the settings, and open alerts for the zone.',
      ],
    },
    acceptsArgs: true,
    begin: (_actor, args) => {
      const zones = deps.view.zones();
      if (args.trim() === '') return pickZone(zones, { title: '🌱 <b>Which zone?</b>', then: show });
      const zone = findZone(args, zones);
      return zone ? show(zone) : done([`⚠️ ${NOT_A_ZONE} The zones are:`, ...zoneList(zones)].join('\n'));
    },
  };
};
