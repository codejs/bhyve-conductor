import { describe, expect, it, vi } from 'vitest';
import type { InputResult, Step } from '../../bot/conversation.ts';
import { buildZoneCommand } from '../../bot/zone-command.ts';
import type { ZoneDetail } from '../../conductor/monitor.ts';
import { NOW } from '../utils/conductor.ts';

const OWNER = { id: 4242, username: 'owner' };
const ZONES = [
  { key: 'dev1:1', name: 'Front lawn' },
  { key: 'dev1:2', name: 'Back lawn' },
];

const detail = (key: string, name: string): ZoneDetail => ({
  at: NOW,
  zone: {
    key,
    name,
    deviceId: 'dev1',
    station: 1,
    thresholdPct: 30,
    targetPct: 40,
    runMinutes: 10,
    maxMinutesPerDay: 30,
    cooldownMinutes: 240,
    maxCycleMinutes: 20,
    soakMinutes: 30,
    sensorAggregation: 'driest',
    maxReadingAgeMinutes: 180,
    criticalLowPct: 20,
    criticalHighPct: 60,
  },
  sensors: [],
  usedLastDayMinutes: 0,
  alerts: [],
});

const setup = (zones = ZONES) => {
  const zoneStatus = vi.fn((key: string) => {
    const z = zones.find((x) => x.key === key);
    return z ? detail(z.key, z.name) : undefined;
  });
  const command = buildZoneCommand({ view: { zones: () => zones, zoneStatus }, timeZone: 'UTC' });
  return { command, zoneStatus, begin: (args = '') => Promise.resolve(command.begin(OWNER, args)) };
};

const answer = async (step: Step, text: string): Promise<Step | string> => {
  if (step.kind !== 'input') throw new Error(step.kind);
  const r: InputResult = await step.read(text);
  return 'next' in r ? r.next : (r.invalid ?? 'not understood');
};

describe('/zone', () => {
  it('is read-only and takes a zone', () => {
    expect(setup().command).toMatchObject({ kind: 'interactive', name: 'zone', acceptsArgs: true });
  });

  it('asks which zone when there are several, then shows it', async () => {
    const t = setup();
    const step = await t.begin();

    expect(step).toMatchObject({ kind: 'input', text: '🌱 <b>Which zone?</b>\n1. Front lawn\n2. Back lawn\n\nReply its number, or <b>cancel</b>.' });
    const shown = await answer(step, '2');
    expect(shown).toMatchObject({ kind: 'done', text: expect.stringMatching(/^🌱 <b>Back lawn<\/b>/) });
    expect(await answer(step, '7')).toBe('That is not one of the zones.');
    expect(await answer(step, 'nowhere')).toBe('That is not one of the zones.');
  });

  it('shows the only zone straight away', async () => {
    const t = setup([ZONES[0] ?? { key: '', name: '' }]);
    expect(await t.begin()).toMatchObject({ kind: 'done', text: expect.stringMatching(/^🌱 <b>Front lawn<\/b>/) });
  });

  it.each(['2', 'Back lawn', 'BACK LAWN', '  back lawn  '])('shows the zone given with the command: %j', async (args) => {
    const t = setup();
    expect(await t.begin(args)).toMatchObject({ kind: 'done', text: expect.stringMatching(/^🌱 <b>Back lawn<\/b>/) });
    expect(t.zoneStatus).toHaveBeenCalledWith('dev1:2');
  });

  it('lists the zones when the one given is not there, without repeating what was typed', async () => {
    const t = setup();
    const step = await t.begin('secret-passphrase');
    expect(step).toEqual({ kind: 'done', text: '⚠️ That is not one of the zones. The zones are:\n1. Front lawn\n2. Back lawn' });
  });

  it('says so when there are no zones', async () => {
    expect(await setup([]).begin()).toEqual({ kind: 'done', text: 'No zones are configured.' });
  });

  it('copes with a zone that has gone (e.g. between the list and the answer)', async () => {
    const t = setup();
    t.zoneStatus.mockReturnValueOnce(undefined);
    expect(await t.begin('1')).toEqual({ kind: 'done', text: 'That is not one of the zones.' });
  });
});
