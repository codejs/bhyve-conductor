/**
 * Relations for drizzle's relational queries (`db.query.*`). They don't change the database (foreign keys
 * are declared in schema.ts); they let the app load object graphs in one call, e.g. everything needed
 * to resume sequences:
 *
 *   db.query.wateringSequence.findMany({
 *     where: { status: 'active' },
 *     with: { zones: true, waves: { orderBy: { waveIndex: 'asc' }, with: { stations: { orderBy: { station: 'asc' } } } } },
 *   })
 */
import { defineRelations } from 'drizzle-orm';
import * as schema from './schema.ts';

export const relations = defineRelations(schema, (r) => ({
  serviceRun: {
    sequences: r.many.wateringSequence({ from: r.serviceRun.id, to: r.wateringSequence.serviceRunId }),
  },
  zone: {
    sequenceZones: r.many.sequenceZone({ from: r.zone.zoneKey, to: r.sequenceZone.zoneKey }),
    watering: r.many.zoneWatering({ from: r.zone.zoneKey, to: r.zoneWatering.zoneKey }),
    state: r.one.zoneState({ from: r.zone.zoneKey, to: r.zoneState.zoneKey }),
  },
  wateringSequence: {
    serviceRun: r.one.serviceRun({ from: r.wateringSequence.serviceRunId, to: r.serviceRun.id }),
    zones: r.many.sequenceZone({ from: r.wateringSequence.id, to: r.sequenceZone.sequenceId }),
    waves: r.many.sequenceWave({ from: r.wateringSequence.id, to: r.sequenceWave.sequenceId }),
  },
  sequenceZone: {
    sequence: r.one.wateringSequence({ from: r.sequenceZone.sequenceId, to: r.wateringSequence.id, optional: false }),
    zone: r.one.zone({ from: r.sequenceZone.zoneKey, to: r.zone.zoneKey, optional: false }),
  },
  sequenceWave: {
    sequence: r.one.wateringSequence({ from: r.sequenceWave.sequenceId, to: r.wateringSequence.id, optional: false }),
    stations: r.many.waveStation({
      from: [r.sequenceWave.sequenceId, r.sequenceWave.waveIndex],
      to: [r.waveStation.sequenceId, r.waveStation.waveIndex],
    }),
    watering: r.many.zoneWatering({
      from: [r.sequenceWave.sequenceId, r.sequenceWave.waveIndex],
      to: [r.zoneWatering.sequenceId, r.zoneWatering.waveIndex],
    }),
  },
  waveStation: {
    wave: r.one.sequenceWave({
      from: [r.waveStation.sequenceId, r.waveStation.waveIndex],
      to: [r.sequenceWave.sequenceId, r.sequenceWave.waveIndex],
      optional: false,
    }),
  },
  zoneWatering: {
    zone: r.one.zone({ from: r.zoneWatering.zoneKey, to: r.zone.zoneKey, optional: false }),
    // NULL for imported runs and runs whose sequence was purged.
    wave: r.one.sequenceWave({
      from: [r.zoneWatering.sequenceId, r.zoneWatering.waveIndex],
      to: [r.sequenceWave.sequenceId, r.sequenceWave.waveIndex],
    }),
  },
  zoneState: {
    zone: r.one.zone({ from: r.zoneState.zoneKey, to: r.zone.zoneKey, optional: false }),
  },
}));
