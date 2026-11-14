import { existsSync } from 'node:fs';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConductorConfig } from '../../conductor/config.ts';
import { WateringHistory } from '../../conductor/history.ts';
import { queryAuditEvents } from '../../db/audit-log.ts';
import { openDatabase, type ConductorDb } from '../../db/database.ts';
import { importLegacyFiles, type LegacyFiles } from '../../db/legacy-import.ts';
import { beginSession } from '../../db/session.ts';
import { SqliteStore } from '../../db/store.ts';
import { log } from '../../log.ts';
import { zone } from '../utils/conductor.ts';

const NOW = new Date('2026-07-01T12:00:00.000Z');
const ago = (min: number): Date => new Date(NOW.getTime() - min * 60_000);
const zones = [zone({ name: 'Front', thresholdPct: 30, targetPct: 40 }), zone({ station: 2, name: 'Back' })];
const config: ConductorConfig = {
  pollIntervalMinutes: 15,
  dryRun: false,
  forecastHours: 72,
  recovery: { confirmTimeoutSeconds: 20, retryWindowMinutes: 30, resumeWindowMinutes: 60 },
  alerts: { lowBatteryPct: 20, deviceCheckMinutes: 60 },
  notifications: { minSeverity: 'info', cycles: false, connectionGraceMinutes: 5 },
  zones,
};

/** What the last version before the database left behind: it crashed during cycle 2 of 3 on dev1. */
const stateFile = {
  runs: [
    { zoneKey: 'dev1:1', at: ago(90).toISOString(), minutes: 8 }, // cycle 1 of the sequence below
    { zoneKey: 'dev1:2', at: ago(600).toISOString(), minutes: 12 },
    { zoneKey: 'not-a-zone', at: ago(5).toISOString(), minutes: 1 },
  ],
  sequences: [
    {
      id: '3d7cc742',
      deviceId: 'dev1',
      waves: [[{ station: 1, runTime: 8 }], [{ station: 1, runTime: 8 }], [{ station: 1, runTime: 8 }]],
      soakMinutes: 20,
      zoneNames: ['Front'],
      createdAt: ago(90).toISOString(),
      nextWave: 1,
      dueAt: ago(62).toISOString(),
      attempts: 1,
      inFlight: { wave: 1, since: ago(60).toISOString() },
    },
    // A second one on the same device: the old Sequencer only ever resumed the first.
    { id: 'dup', deviceId: 'dev1', waves: [[{ station: 2, runTime: 5 }]], soakMinutes: 0, createdAt: ago(30).toISOString(), nextWave: 0, dueAt: ago(30).toISOString(), attempts: 0 },
  ],
  alerts: {
    'battery:sensor:s1': { state: 'low', since: ago(300).toISOString() },
    'mystery:x': { state: 'low', since: ago(5).toISOString() },
  },
};
const auditLines = [
  { ts: ago(120).toISOString(), type: 'service.started', mode: 'continuous', dryRun: false, zones: 2 },
  { ts: ago(90).toISOString(), type: 'sequence.started', sequence: '3d7cc742', device: 'dev1' },
  { ts: ago(60).toISOString(), type: 'wave.sent', sequence: '3d7cc742', device: 'dev1', cycle: 2, of: 3 },
];

describe('importLegacyFiles', () => {
  let dir: string;
  let files: LegacyFiles;
  let db: ConductorDb;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'conductor-legacy-'));
    files = { statePath: join(dir, '.conductor-state.json'), auditPath: join(dir, '.conductor-audit.jsonl') };
    db = openDatabase(join(dir, 'conductor.db'));
    vi.spyOn(log, 'info').mockImplementation(() => {});
    vi.spyOn(log, 'warn').mockImplementation(() => {});
  });

  afterEach(async () => {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  });

  const writeLegacy = async (state: unknown = stateFile, audit: unknown[] | undefined = auditLines) => {
    await writeFile(files.statePath, JSON.stringify(state));
    if (audit) await writeFile(files.auditPath, `${audit.map((l) => JSON.stringify(l)).join('\n')}\n{"ts":"2026-07-01T11:5`); // torn last line
  };

  it('imports runs, the unfinished sequence, alerts and the audit trail, then renames the files', async () => {
    await writeLegacy();

    const result = await importLegacyFiles(db, files, zones, NOW);

    expect(result).toEqual({
      runs: 2,
      sequences: 1,
      alerts: 1,
      auditEvents: 3,
      skipped: 4, // the bad zone key, the duplicate sequence, the unknown alert, the torn audit line
      lastAuditEvent: auditLines[2],
      renamed: [`${files.statePath}.imported`, `${files.auditPath}.imported`],
    });
    expect((await readdir(dir)).sort()).toEqual(['.conductor-audit.jsonl.imported', '.conductor-state.json.imported', 'conductor.db', 'conductor.db-shm', 'conductor.db-wal']);
    expect(await queryAuditEvents(db)).toEqual(auditLines);
    expect(JSON.parse(await readFile(`${files.statePath}.imported`, 'utf8'))).toEqual(stateFile); // kept as it was
  });

  it('hands the next start exactly what the old version would have resumed', async () => {
    await writeLegacy();
    await importLegacyFiles(db, files, zones, NOW);

    const state = await new SqliteStore(db).loadState(NOW, 0);

    expect(state.sequences).toEqual([
      {
        id: '3d7cc742',
        deviceId: 'dev1',
        waves: stateFile.sequences[0]?.waves,
        soakMinutes: 20,
        zoneNames: ['Front'],
        createdAt: ago(90),
        nextWave: 1,
        dueAt: ago(62),
        attempts: 1,
        inFlight: { wave: 1, since: ago(60) },
      },
    ]);
    expect(state.alerts).toEqual({ 'battery:sensor:s1': stateFile.alerts['battery:sensor:s1'] });
  });

  it('counts the watering once: cooldowns and the daily cap see the same minutes as before', async () => {
    await writeLegacy();
    const before = new WateringHistory(stateFile.runs.slice(0, 2).map((r) => ({ ...r, at: new Date(r.at) })));
    await importLegacyFiles(db, files, zones, NOW);

    const after = new WateringHistory((await new SqliteStore(db).loadState(NOW, 0)).history);

    for (const key of ['dev1:1', 'dev1:2']) {
      expect(after.minutesInLastDay(key, NOW)).toBe(before.minutesInLastDay(key, NOW));
      expect(after.lastRun(key)).toEqual(before.lastRun(key));
    }
    // The delivered first cycle is marked delivered (its time estimated), without a second ledger row.
    expect(await db.prisma.sequenceWave.findMany({ orderBy: { waveIndex: 'asc' }, select: { status: true, delivery: true, sentAt: true } })).toEqual([
      { status: 'delivered', delivery: 'assumed', sentAt: ago(90) },
      { status: 'sending', delivery: null, sentAt: ago(60) },
      { status: 'pending', delivery: null, sentAt: null },
    ]);
    expect(await db.prisma.zoneWatering.count()).toBe(2);
  });

  it('explains each imported sequence with the configured zones', async () => {
    await writeLegacy();
    await importLegacyFiles(db, files, zones, NOW);

    expect(await db.prisma.sequenceZone.findMany()).toEqual([
      expect.objectContaining({ sequenceId: '3d7cc742', zoneKey: 'dev1:1', zoneName: 'Front', thresholdPct: 30, targetPct: 40, requestedMinutes: 24, detail: `imported from ${files.statePath}` }),
    ]);
  });

  it('leads to a crash report at the next start when the old version did not stop cleanly', async () => {
    await writeLegacy();
    const result = await importLegacyFiles(db, files, zones, NOW);

    const session = await beginSession(db, {
      config,
      mode: 'continuous',
      now: () => NOW,
      ...(result?.lastAuditEvent ? { legacyLastEvent: result.lastAuditEvent } : {}),
    });

    expect(session.unclean).toEqual({ lastEvent: 'wave.sent', lastEventAt: ago(60).toISOString() });
  });

  it('imports just the audit trail when there is no state file, and the other way round', async () => {
    await writeFile(files.auditPath, `${JSON.stringify(auditLines[0])}\n`);
    expect(await importLegacyFiles(db, files, zones, NOW)).toMatchObject({ runs: 0, sequences: 0, auditEvents: 1, renamed: [`${files.auditPath}.imported`] });

    const other = openDatabase(':memory:');
    await writeFile(files.statePath, JSON.stringify({ runs: stateFile.runs.slice(0, 1) }));
    expect(await importLegacyFiles(other, files, zones, NOW)).toMatchObject({ runs: 1, auditEvents: 0, renamed: [`${files.statePath}.imported`] });
    await other.close();
  });

  it('does nothing without files, or for a database already in use (the files stay where they are)', async () => {
    expect(await importLegacyFiles(db, files, zones, NOW)).toBeUndefined();

    await beginSession(db, { config, mode: 'continuous', now: () => NOW });
    await writeLegacy();

    expect(await importLegacyFiles(db, files, zones, NOW)).toBeUndefined();
    expect(existsSync(files.statePath)).toBe(true);
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('not imported: the database is already in use'));
  });

  it('imports only once', async () => {
    await writeLegacy();
    await importLegacyFiles(db, files, zones, NOW);
    await writeLegacy(); // e.g. restored from a backup by mistake

    expect(await importLegacyFiles(db, files, zones, NOW)).toBeUndefined();
  });

  it('does not overwrite an earlier *.imported file', async () => {
    await writeFile(`${files.statePath}.imported`, 'an earlier import');
    await writeLegacy(undefined, undefined);

    const result = await importLegacyFiles(db, files, zones, NOW);

    expect(result?.renamed[0]).toMatch(/\.conductor-state\.json\.imported-\d+$/);
    expect(await readFile(`${files.statePath}.imported`, 'utf8')).toBe('an earlier import');
  });
});
