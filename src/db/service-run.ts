import { createHash } from 'node:crypto';
import { lastAuditEventOf } from './audit-log.ts';
import type { ConductorDb } from './database.ts';
import type { Prisma } from './generated/client.ts';
import type { RunMode } from './model.ts';

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
export const beginServiceRun = async (db: ConductorDb, o: BeginRunOptions): Promise<{ runId: number; unclean?: UncleanShutdown }> => {
  const { prisma } = db;
  const unstopped = o.dryRun ? [] : await prisma.serviceRun.findMany({ where: { stoppedAt: null }, orderBy: { id: 'asc' } });
  const crashed = unstopped.filter((r) => !r.dryRun).at(-1);
  let unclean: UncleanShutdown | undefined;
  if (crashed) {
    // Simulation notes describe the outside world, not what the conductor did last.
    const last = await lastAuditEventOf(db, { serviceRunId: crashed.id, excludeTypes: ['simulation.note'] });
    unclean = { runId: crashed.id, lastEvent: last?.type ?? 'service.started', lastEventAt: last?.ts ?? crashed.heartbeatAt.toISOString() };
  }

  const [created] = await prisma.$transaction([
    prisma.serviceRun.create({
      data: {
        startedAt: o.startedAt,
        mode: o.mode,
        dryRun: o.dryRun,
        pid: o.pid ?? null,
        configHash: configHash(o.config),
        config: JSON.parse(JSON.stringify(o.config)) as Prisma.InputJsonValue,
        heartbeatAt: o.startedAt,
      },
      select: { id: true },
    }),
    // Each died after its last heartbeat.
    ...unstopped.map((r) => prisma.serviceRun.update({ where: { id: r.id }, data: { stoppedAt: r.heartbeatAt, stopReason: 'unclean' }, select: { id: true } })),
  ]);
  if (!created) throw new Error('could not record the service run');
  return unclean ? { runId: created.id, unclean } : { runId: created.id };
};

/** The run is alive (after every poll); a crashed run is assumed to have died after its last heartbeat. */
export const recordHeartbeat = async (db: ConductorDb, runId: number, at: Date): Promise<void> => {
  await db.prisma.serviceRun.update({ where: { id: runId }, data: { heartbeatAt: at }, select: { id: true } });
};

/** A clean stop ('SIGTERM', 'SIGINT', 'once', ...). */
export const endServiceRun = async (db: ConductorDb, runId: number, at: Date, reason: string): Promise<void> => {
  await db.prisma.serviceRun.update({ where: { id: runId }, data: { heartbeatAt: at, stoppedAt: at, stopReason: reason }, select: { id: true } });
};
