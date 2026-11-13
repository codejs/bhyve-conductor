import type { GeocodeResult } from './open-meteo.ts';
import type { GeoPoint } from './types.ts';

/**
 * LOCATION accepts, most precise first:
 *   "30.2672,-97.7431"   latitude,longitude (recommended: no lookup, no ambiguity)
 *   "78701"              US ZIP code (ZIP+4 is accepted; the +4 is ignored)
 *   "Austin, TX"         city and state (two-letter code or full name)
 *   "Austin"             place name (first US match; check the log to be sure it's the right one)
 */
export type LocationSpec =
  | { kind: 'coordinates'; point: GeoPoint }
  | { kind: 'zip'; zip: string }
  | { kind: 'place'; name: string; state?: string };

const STATES: Record<string, string> = {
  AL: 'Alabama', AK: 'Alaska', AZ: 'Arizona', AR: 'Arkansas', CA: 'California', CO: 'Colorado',
  CT: 'Connecticut', DE: 'Delaware', DC: 'District of Columbia', FL: 'Florida', GA: 'Georgia',
  HI: 'Hawaii', ID: 'Idaho', IL: 'Illinois', IN: 'Indiana', IA: 'Iowa', KS: 'Kansas', KY: 'Kentucky',
  LA: 'Louisiana', ME: 'Maine', MD: 'Maryland', MA: 'Massachusetts', MI: 'Michigan', MN: 'Minnesota',
  MS: 'Mississippi', MO: 'Missouri', MT: 'Montana', NE: 'Nebraska', NV: 'Nevada', NH: 'New Hampshire',
  NJ: 'New Jersey', NM: 'New Mexico', NY: 'New York', NC: 'North Carolina', ND: 'North Dakota',
  OH: 'Ohio', OK: 'Oklahoma', OR: 'Oregon', PA: 'Pennsylvania', RI: 'Rhode Island', SC: 'South Carolina',
  SD: 'South Dakota', TN: 'Tennessee', TX: 'Texas', UT: 'Utah', VT: 'Vermont', VA: 'Virginia',
  WA: 'Washington', WV: 'West Virginia', WI: 'Wisconsin', WY: 'Wyoming', PR: 'Puerto Rico',
};

const COORDS = /^\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*$/;
const ZIP = /^\s*(\d{5})(?:-\d{4})?\s*$/;

export const parseLocation = (raw: string): LocationSpec => {
  const text = raw.trim();
  if (!text) throw new Error('LOCATION is empty');

  const coords = COORDS.exec(text);
  if (coords) {
    const latitude = Number(coords[1]);
    const longitude = Number(coords[2]);
    if (Math.abs(latitude) > 90 || Math.abs(longitude) > 180) {
      throw new Error(`LOCATION "${raw}" is not a valid latitude,longitude`);
    }
    return { kind: 'coordinates', point: { latitude, longitude } };
  }

  const zip = ZIP.exec(text);
  if (zip?.[1]) return { kind: 'zip', zip: zip[1] };

  const comma = text.lastIndexOf(',');
  if (comma > 0) {
    const name = text.slice(0, comma).trim();
    const stateText = text.slice(comma + 1).trim();
    const state = STATES[stateText.toUpperCase()] ?? Object.values(STATES).find((s) => s.toLowerCase() === stateText.toLowerCase());
    if (!state) throw new Error(`LOCATION "${raw}": unknown US state "${stateText}"`);
    if (name.length < 2) throw new Error(`LOCATION "${raw}": place name is too short`);
    return { kind: 'place', name, state };
  }

  if (text.length < 2) throw new Error(`LOCATION "${raw}": place name is too short`);
  return { kind: 'place', name: text };
};

export type Geocoder = (query: string) => Promise<GeocodeResult[]>;

/** Turns a LOCATION spec into coordinates, looking up ZIPs and place names with `geocode`. */
export const resolveLocation = async (spec: LocationSpec, geocode: Geocoder): Promise<GeoPoint> => {
  if (spec.kind === 'coordinates') return spec.point;

  const query = spec.kind === 'zip' ? spec.zip : spec.name;
  let results = await geocode(query);
  if (spec.kind === 'place' && spec.state) {
    const state = spec.state;
    results = results.filter((r) => r.admin1?.toLowerCase() === state.toLowerCase());
  }
  const best = results[0];
  if (!best) {
    const what = spec.kind === 'zip' ? `ZIP ${spec.zip}` : `"${spec.name}${spec.state ? `, ${spec.state}` : ''}"`;
    throw new Error(`Could not find ${what} in the US; set LOCATION to "latitude,longitude" instead`);
  }
  return {
    latitude: best.latitude,
    longitude: best.longitude,
    name: [best.name, best.admin1].filter(Boolean).join(', '),
  };
};
