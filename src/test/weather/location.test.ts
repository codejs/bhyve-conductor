import { describe, expect, it, vi } from 'vitest';
import type { GeocodeResult } from '../../weather/open-meteo.ts';
import { parseLocation, resolveLocation } from '../../weather/location.ts';

describe('parseLocation', () => {
  it.each([
    ['30.2672,-97.7431', { kind: 'coordinates', point: { latitude: 30.2672, longitude: -97.7431 } }],
    [' 40 , -74 ', { kind: 'coordinates', point: { latitude: 40, longitude: -74 } }],
    ['78701', { kind: 'zip', zip: '78701' }],
    ['78701-1234', { kind: 'zip', zip: '78701' }],
    ['Austin, TX', { kind: 'place', name: 'Austin', state: 'Texas' }],
    ['austin, tx', { kind: 'place', name: 'austin', state: 'Texas' }],
    ['Portland, oregon', { kind: 'place', name: 'Portland', state: 'Oregon' }],
    ['Washington, DC', { kind: 'place', name: 'Washington', state: 'District of Columbia' }],
    ['Boise', { kind: 'place', name: 'Boise' }],
  ])('parses %j', (raw, expected) => {
    expect(parseLocation(raw)).toEqual(expected);
  });

  it.each([
    ['', 'LOCATION is empty'],
    ['91,0', 'not a valid latitude,longitude'],
    ['0,181', 'not a valid latitude,longitude'],
    ['Springfield, ZZ', 'unknown US state "ZZ"'],
    ['X, TX', 'place name is too short'],
    ['X', 'place name is too short'],
  ])('rejects %j', (raw, message) => {
    expect(() => parseLocation(raw)).toThrow(message);
  });
});

describe('resolveLocation', () => {
  const geocoder = (results: GeocodeResult[]) => vi.fn(async (_q: string) => results);
  const AUSTIN_TX: GeocodeResult = { name: 'Austin', latitude: 30.27, longitude: -97.74, admin1: 'Texas', countryCode: 'US' };
  const AUSTIN_MN: GeocodeResult = { name: 'Austin', latitude: 43.67, longitude: -92.97, admin1: 'Minnesota', countryCode: 'US' };

  it('uses coordinates as given, without a lookup', async () => {
    const geocode = geocoder([]);

    await expect(resolveLocation(parseLocation('30.1,-97.2'), geocode)).resolves.toEqual({ latitude: 30.1, longitude: -97.2 });
    expect(geocode).not.toHaveBeenCalled();
  });

  it('looks up a ZIP code', async () => {
    const geocode = geocoder([{ ...AUSTIN_TX, name: '78701' }]);

    const point = await resolveLocation(parseLocation('78701'), geocode);

    expect(geocode).toHaveBeenCalledWith('78701');
    expect(point).toEqual({ latitude: 30.27, longitude: -97.74, name: '78701, Texas' });
  });

  it('picks the place in the requested state', async () => {
    const point = await resolveLocation(parseLocation('Austin, MN'), geocoder([AUSTIN_TX, AUSTIN_MN]));

    expect(point).toEqual({ latitude: 43.67, longitude: -92.97, name: 'Austin, Minnesota' });
  });

  it('takes the first match for a bare place name', async () => {
    await expect(resolveLocation(parseLocation('Austin'), geocoder([AUSTIN_TX, AUSTIN_MN]))).resolves.toMatchObject({
      name: 'Austin, Texas',
    });
  });

  it.each([
    ['Austin, WA', [AUSTIN_TX], 'Could not find "Austin, Washington" in the US'],
    ['00000', [], 'Could not find ZIP 00000 in the US'],
    ['Atlantis', [], 'Could not find "Atlantis" in the US'],
  ])('explains when %j is not found', async (raw, results, message) => {
    await expect(resolveLocation(parseLocation(raw), geocoder(results))).rejects.toThrow(message);
  });
});
