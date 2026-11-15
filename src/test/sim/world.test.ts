import { describe, expect, it } from 'vitest';
import { VirtualClock } from '../../clock.ts';
import { SimWorld } from '../../sim/world.ts';

const START = new Date('2026-07-01T06:00:00Z');
const MIN = 60_000;

describe('SimWorld B-hyve stop', () => {
  const world = () => {
    const clock = new VirtualClock(START);
    const w = new SimWorld(clock, { dryingPctPerHour: 0, wateringPctPerMinute: 1 });
    w.addDevice({ id: 'dev1', name: 'Front timer', stations: [1, 2] });
    w.addSensor({ id: 's1', name: 'Probe', zone: 'dev1:1', moisture: 20 });
    w.addSensor({ id: 's2', name: 'Probe 2', zone: 'dev1:2', moisture: 20 });
    return { clock, w };
  };

  it('turns the water off now: what runs ends, what was still to come does not happen', async () => {
    const { clock, w } = world();
    await w.bhyve.startWatering('dev1', [
      { station: 1, runTime: 10 },
      { station: 2, runTime: 10 },
    ]);
    await clock.advanceBy(4 * MIN);

    await w.bhyve.stopWatering('dev1');
    await clock.advanceBy(30 * MIN);
    w.update();

    expect(w.isWatering('dev1')).toBe(false);
    expect(w.sensor('s1').moisture).toBeCloseTo(24); // 4 of its 10 minutes
    expect(w.sensor('s2').moisture).toBeCloseTo(20); // never started
  });

  it('cannot be sent while the command socket is down', async () => {
    const { w } = world();
    w.services.bhyveSocket = 'down';
    await expect(w.bhyve.stopWatering('dev1')).rejects.toThrow('B-hyve socket did not open within 15s');
  });
});
