import { createHash } from 'node:crypto';
import { asc, eq, isNull } from 'drizzle-orm';
import { lastAuditEventOf } from './audit-log.ts';
import type { ConductorDb } from './database.ts';
import { serviceRun, type RunMode } from './schema.ts';

/**
 * One `service_run` row per process start. A run that never recorded its stop crashed, was killed or lost
 * power; the next real (non-dry) start closes it as 'unclean' and reports it. Dry runs (conductor:check)
 * never close other runs: they may be running next to the live service.
 */

export interface UncleanShutdown {
  runId: number;
  /** Type and time of the crashed run's last audit event (its heartbeat time if it recorded none). */
  lastEvent: string;
  lastEventAt: string;
}

export interface BeginRunOptions {
  startedAt: Date;
  mode: RunMode;
  dryRun: boolean;
  /** The effective configuration, kept with the run. */
  config: unknown;
  pid?: number;
}

export const configHash = (config: unknown): string => createHash('sha256').update(JSON.stringify(config)).digest('hex');

/** Records the start of a run; a real run also closes (and reports) runs that never stopped. */
export const beginServiceRun = (db: ConductorDb, o: BeginRunOptions): { runId: number; unclean?: UncleanShutdown } => {
  const unstopped = o.dryRun ? [] : db.select().from(serviceRun).where(isNull(serviceRun.stoppedAt)).orderBy(asc(serviceRun.id)).all();
  const crashed = unstopped.filter((r) => !r.dryRun).at(-1);
  let unclean: UncleanShutdown | undefined;
  if (crashed) {
    // Simulation notes describe the outside world, not what the conductor did last.
    const last = lastAuditEventOf(db, { serviceRunId: crashed.id, excludeTypes: ['simulation.note'] });
    unclean = { runId: crashed.id, lastEvent: last?.type ?? 'service.started', lastEventAt: last?.ts ?? crashed.heartbeatAt.toISOString() };
  }

  const runId = db.transaction((tx) => {
    for (const r of unstopped) {
      tx.update(serviceRun).set({ stoppedAt: r.heartbeatAt, stopReason: 'unclean' }).where(eq(serviceRun.id, r.id)).run();
    }
    const row = tx
      .insert(serviceRun)
      .values({
        startedAt: o.startedAt,
        mode: o.mode,
        dryRun: o.dryRun,
        pid: o.pid ?? null,
        configHash: configHash(o.config),
        config: o.config,
        heartbeatAt: o.startedAt,
      })
      .returning({ id: serviceRun.id })
      .get();
    if (!row) throw new Error('could not record the service run');
    return row.id;
  });
  return unclean ? { runId, unclean } : { runId };
};

/** The run is alive (after every poll); a crashed run is assumed to have died after its last heartbeat. */
export const recordHeartbeat = (db: ConductorDb, runId: number, at: Date): void => {
  db.update(serviceRun).set({ heartbeatAt: at }).where(eq(serviceRun.id, runId)).run();
};

/** A clean stop ('SIGTERM', 'SIGINT', 'once', ...). */
export const endServiceRun = (db: ConductorDb, runId: number, at: Date, reason: string): void => {
  db.update(serviceRun).set({ heartbeatAt: at, stoppedAt: at, stopReason: reason }).where(eq(serviceRun.id, runId)).run();
};
