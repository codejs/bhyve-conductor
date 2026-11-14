import type { AuditEvent } from '../audit/audit.ts';
import type { ConductorConfig } from '../conductor/config.ts';
import type { StoredState } from '../conductor/store.ts';
import { SqliteAuditLog } from './audit-log.ts';
import type { ConductorDb } from './database.ts';
import type { RunMode } from './schema.ts';
import { beginServiceRun, endServiceRun, recordHeartbeat, type UncleanShutdown } from './service-run.ts';
import { SqliteStore } from './store.ts';

/**
 * One run of the conductor against its database: records the run, opens the audit trail and the state
 * store, and loads what the previous run left. Shared by the service (index.ts) and the simulator.
 *
 * Dry runs record their run and audit events, nothing else: they must not change what the real service
 * decides (cooldowns, alerts), and they may run next to it.
 */

export interface SessionOptions {
  config: ConductorConfig;
  mode: RunMode;
  now: () => Date;
  pid?: number;
  /** The last event of an imported JSONL audit trail: if the old version crashed, it is reported like any crash. */
  legacyLastEvent?: AuditEvent;
}

export interface Session {
  runId: number;
  audit: SqliteAuditLog;
  store: SqliteStore;
  state: StoredState;
  /** Set if the previous run ended without a clean stop. */
  unclean?: Omit<UncleanShutdown, 'runId'>;
  /** Call after every poll. */
  heartbeat(): void;
  /** A clean stop. */
  end(reason: string): void;
}

const MINUTE_MS = 60_000;

export const beginSession = (db: ConductorDb, o: SessionOptions): Session => {
  const startedAt = o.now();
  const dryRun = o.config.dryRun;
  const { runId, unclean } = beginServiceRun(db, {
    startedAt,
    mode: o.mode,
    dryRun,
    config: o.config,
    ...(o.pid !== undefined ? { pid: o.pid } : {}),
  });
  const store = new SqliteStore(db, { serviceRunId: runId });
  if (!dryRun) store.syncZones(o.config.zones, startedAt);
  // The same window WateringHistory.prune keeps: the longest cooldown, and at least the 24 h cap.
  const longestCooldown = Math.max(0, ...o.config.zones.map((z) => z.cooldownMinutes));
  const state = store.loadState(startedAt, longestCooldown * MINUTE_MS, { repair: !dryRun });

  const legacy = o.legacyLastEvent;
  const crashed =
    unclean ?? (!dryRun && legacy && legacy.type !== 'service.stopped' ? { lastEvent: legacy.type, lastEventAt: legacy.ts } : undefined);

  return {
    runId,
    audit: new SqliteAuditLog(db, { now: o.now, serviceRunId: runId }),
    store,
    state,
    ...(crashed ? { unclean: { lastEvent: crashed.lastEvent, lastEventAt: crashed.lastEventAt } } : {}),
    heartbeat: () => recordHeartbeat(db, runId, o.now()),
    end: (reason) => endServiceRun(db, runId, o.now(), reason),
  };
};
