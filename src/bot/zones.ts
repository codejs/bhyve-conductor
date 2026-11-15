import { done, type Step } from './conversation.ts';
import { safe } from './format.ts';

/**
 * Choosing a zone, the same way in every command (/zone, /config, /stop): by its number in the list
 * (as /health numbers them) or its name. What was typed is never repeated back.
 */

export interface ZoneRef {
  key: string;
  name: string;
}

/** "2" or "front lawn" → that zone; undefined if it matches none. */
export const findZone = <Z extends ZoneRef>(text: string, zones: readonly Z[]): Z | undefined => {
  const t = text.trim().toLowerCase();
  if (/^\d{1,3}$/.test(t)) return zones[Number(t) - 1];
  return zones.find((z) => z.name.toLowerCase() === t);
};

/** The zones, numbered: "1. Front lawn". */
export const zoneList = (zones: readonly ZoneRef[]): string[] => zones.map((z, i) => `${i + 1}. ${safe(z.name)}`);

export const NOT_A_ZONE = 'That is not one of the zones.';

/** Asks which zone (not when there's only one), then goes on with it. */
export const pickZone = <Z extends ZoneRef>(zones: readonly Z[], q: { title: string; then: (zone: Z) => Step | Promise<Step> }): Step | Promise<Step> => {
  const only = zones[0];
  if (zones.length === 0 || !only) return done('No zones are configured.');
  if (zones.length === 1) return q.then(only);
  return {
    kind: 'input',
    text: [q.title, ...zoneList(zones), '', 'Reply its number, or <b>cancel</b>.'].join('\n'),
    hint: `Reply a number from 1 to ${zones.length}, or cancel.`,
    placeholder: 'zone number',
    read: async (answer) => {
      const zone = findZone(answer, zones);
      return zone ? { next: await q.then(zone) } : { invalid: NOT_A_ZONE };
    },
  };
};
