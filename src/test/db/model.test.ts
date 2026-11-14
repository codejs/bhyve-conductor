import { readdir, readFile } from 'node:fs/promises';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AuditEvent } from '../../audit/audit.ts';
import { WateringHistory, type WateringRun } from '../../conductor/history.ts';
import { filterValue, queryAuditEvents } from '../../db/audit-log.ts';
import { openDatabase, type ConductorDb } from '../../db/database.ts';
import type { Prisma } from '../../db/generated/client.ts';
import { ALERT_KINDS, alertKindOf, assertOneOf, assertStationRun, assertTime, InvalidDataError, MAX_RUN_MINUTES, parseZoneKey, WAVE_STATUSES } from '../../db/model.ts';
import { SqliteStore } from '../../db/store.ts';

const T0 = new Date('2026-07-01T11:00:00.000Z');
const T = (min: number): Date => new Date(T0.getTime() + min * 60_000);

describe('the checks that replace CHECK constraints', () => {
  it('assertOneOf accepts listed values and names the field otherwise', () => {
    expect(assertOneOf('sending', WAVE_STATUSES, 'status')).toBe('sending');
    expect(() => assertOneOf('lost', WAVE_STATUSES, 'status')).toThrow(new InvalidDataError('status must be one of pending, sending, delivered, skipped (got "lost")'));
  });

  it.each([
    ['battery:sensor:s1', 'battery'],
    ['moisture:dev1:1:s1', 'moisture'],
    ['device:d', 'device'],
    ['daily-limit:dev1:2', 'daily-limit'],
  ])('alertKindOf(%s) = %s', (key, kind) => expect(alertKindOf(key)).toBe(kind));

  it.each(['mystery:x', 'nocolon', ':x'])('alertKindOf refuses %s', (key) => expect(() => alertKindOf(key)).toThrow(InvalidDataError));

  it('covers every kind AlertTracker produces', () => {
    expect(ALERT_KINDS).toEqual(['battery', 'moisture', 'device', 'daily-limit']);
  });

  it('assertStationRun takes what B-hyve takes', () => {
    expect(() => assertStationRun(1, 0.1)).not.toThrow();
    expect(() => assertStationRun(12, MAX_RUN_MINUTES)).not.toThrow();
    for (const [station, minutes] of [
      [0, 5],
      [1.5, 5],
      [1, 0],
      [1, -1],
      [1, MAX_RUN_MINUTES + 0.1],
      [1, Number.NaN],
    ] as const) {
      expect(() => assertStationRun(station, minutes), `${station} / ${minutes}`).toThrow(InvalidDataError);
    }
  });

  it('assertTime refuses an invalid Date', () => {
    expect(() => assertTime(T0, 'x')).not.toThrow();
    expect(() => assertTime(new Date('yesterday'), 'the start')).toThrow('the start is not a valid time');
  });

  it('parseZoneKey refuses what isn\'t a zone key', () => {
    expect(parseZoneKey('a:b:3')).toEqual({ deviceId: 'a:b', station: 3 });
    expect(() => parseZoneKey('a')).toThrow(InvalidDataError);
  });
});

describe('the watering ledger, as the conductor reads it back', () => {
  let db: ConductorDb;

  beforeEach(async () => {
    db = openDatabase(':memory:');
    await db.prisma.zone.createMany({
      data: [
        { zoneKey: 'timer-1:1', deviceId: 'timer-1', station: 1, name: 'A', firstSeenAt: T0, lastSeenAt: T0 },
        { zoneKey: 'timer-1:2', deviceId: 'timer-1', station: 2, name: 'B', firstSeenAt: T0, lastSeenAt: T0 },
      ],
    });
  });

  afterEach(async () => {
    await db.close();
  });

  it('answers cooldown and daily-cap questions exactly as the runs it was given (incl. the 24 h boundary)', async () => {
    const runs: WateringRun[] = [
      { zoneKey: 'timer-1:1', at: T(0), minutes: 8 },
      { zoneKey: 'timer-1:1', at: T(28), minutes: 8.5 },
      { zoneKey: 'timer-1:1', at: T(28), minutes: 1 }, // same instant: insertion order decides, as in history.ts
      { zoneKey: 'timer-1:1', at: T(24 * 60), minutes: 10 }, // exactly 24 h after the first
      { zoneKey: 'timer-1:1', at: T(24 * 60 + 600), minutes: 12 },
      { zoneKey: 'timer-1:2', at: T(90), minutes: 5 },
      { zoneKey: 'timer-1:2', at: T(-30), minutes: 7 },
    ];
    await db.prisma.zoneWatering.createMany({ data: runs.map((r) => ({ zoneKey: r.zoneKey, startedAt: r.at, minutes: r.minutes })) });
    const expected = new WateringHistory(runs);
    const store = new SqliteStore(db);

    for (const now of [T(-60), T(0), T(27), T(28), T(100), T(24 * 60 - 1), T(24 * 60), T(24 * 60 + 28), T(24 * 60 + 29), T(3 * 24 * 60)]) {
      // What the conductor does at startup: load the window, answer from memory.
      const loaded = new WateringHistory((await store.loadState(now, 0)).history);
      for (const key of ['timer-1:1', 'timer-1:2', 'timer-9:9']) {
        expect(loaded.minutesInLastDay(key, now), `${key} @ ${now.toISOString()}`).toBeCloseTo(expected.minutesInLastDay(key, now), 9);
        if (expected.lastRun(key) && expected.lastRun(key)!.at >= new Date(now.getTime() - 24 * 3600_000)) {
          expect(loaded.lastRun(key), key).toEqual(expected.lastRun(key));
        }
      }
    }
  });
});

describe('the audit trail', () => {
  it('stores every simulated audit event and gives it back unchanged', async () => {
    const simulations = new URL('../../../simulations/', import.meta.url);
    const files = (await readdir(simulations)).filter((f) => f.endsWith('.audit.jsonl')).sort();
    const original: AuditEvent[] = [];
    for (const file of files) {
      const text = await readFile(new URL(file, simulations), 'utf8');
      original.push(...text.split('\n').filter(Boolean).map((line) => JSON.parse(line) as AuditEvent));
    }
    expect(original.length).toBeGreaterThan(200);
    const db = openDatabase(':memory:');

    await db.prisma.auditEvent.createMany({
      data: original.map(({ ts, type, ...data }) => ({
        ts: new Date(ts),
        type,
        data: data as Prisma.InputJsonValue,
        deviceId: filterValue(data.device),
        zoneKey: filterValue(data.zone),
        sequenceId: filterValue(data.sequence),
      })),
    });

    expect(await queryAuditEvents(db)).toEqual(original);
    await db.close();
  });
});
