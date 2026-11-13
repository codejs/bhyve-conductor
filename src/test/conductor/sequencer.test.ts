import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryAuditLog } from '../../audit/audit.ts';
import { ConnectionHealth } from '../../audit/health.ts';
import type { BhyveDevice, StationRun } from '../../bhyve/types.ts';
import type { RecoveryOptions } from '../../conductor/config.ts';
import { WateringHistory } from '../../conductor/history.ts';
import type { DeviceCommand } from '../../conductor/plan.ts';
import { Sequencer } from '../../conductor/sequencer.ts';
import type { PendingSequence } from '../../conductor/state.ts';
import { log } from '../../log.ts';
import { bhyveDevice, NOW, zone } from '../utils/conductor.ts';
import { fakeBhyve } from '../utils/fake-bhyve.ts';

const MIN = 60_000;
const wave = (...runs: [station: number, minutes: number][]): StationRun[] => runs.map(([station, runTime]) => ({ station, runTime }));
const command = (waves: StationRun[][], soakMinutes = 30): DeviceCommand => ({ deviceId: 'dev1', waves, soakMinutes, zones: [] });
/** Two 10-minute cycles of station 1 with a 30-minute soak: cycle 2 is due 40 min after cycle 1. */
const TWO_CYCLES = command([wave([1, 10]), wave([1, 10])]);

const watering = (id = 'dev1'): BhyveDevice => bhyveDevice(id, { status: { run_mode: 'auto', watering_status: { current_station: 1 } } });

const setup = (options: Partial<RecoveryOptions> = {}) => {
  const fake = fakeBhyve([bhyveDevice('dev1')]);
  const history = new WateringHistory();
  const audit = new MemoryAuditLog(() => new Date());
  const health = new ConnectionHealth(audit, () => new Date());
  /** Snapshot of the pending sequences at every save, to check what a crash at that moment would leave. */
  const snapshots: PendingSequence[][] = [];
  let sequencer: Sequencer | undefined;
  const save = vi.fn(async () => {
    snapshots.push(structuredClone(sequencer?.pending() ?? []));
  });
  sequencer = new Sequencer({
    bhyve: fake.control,
    history,
    audit,
    health,
    save,
    options: { confirmTimeoutSeconds: 20, retryWindowMinutes: 30, resumeWindowMinutes: 60, ...options },
    now: () => new Date(),
  });
  const types = () => audit.events.map((e) => e.type);
  return { fake, bhyve: fake.bhyve, history, audit, health, save, snapshots, sequencer, types };
};

describe('Sequencer', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    vi.setSystemTime(NOW);
    vi.spyOn(log, 'info').mockImplementation(() => {});
    vi.spyOn(log, 'warn').mockImplementation(() => {});
    vi.spyOn(log, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('healthy operation', () => {
    it('sends, confirms by the device event, records, and finishes the sequence', async () => {
      const t = setup();

      await expect(t.sequencer.start(TWO_CYCLES, { zones: [{ zone: 'dev1:1' }] })).resolves.toBe('delivered');
      await vi.advanceTimersByTimeAsync(40 * MIN);

      expect(t.bhyve.startWatering).toHaveBeenCalledTimes(2);
      expect(t.history.runs.map((r) => [r.at.toISOString(), r.minutes])).toEqual([
        ['2026-07-01T12:00:00.000Z', 10],
        ['2026-07-01T12:40:00.000Z', 10],
      ]);
      expect(t.types()).toEqual([
        'sequence.started',
        'wave.sent',
        'wave.confirmed',
        'wave.sent',
        'wave.confirmed',
        'sequence.completed',
      ]);
      expect(t.audit.ofType('wave.confirmed')[0]).toMatchObject({ via: 'event', cycle: 1, of: 2 });
      expect(t.audit.ofType('sequence.started')[0]).toMatchObject({ plannedMinutes: 20, soakMinutes: 30, zones: [{ zone: 'dev1:1' }] });
      expect(t.sequencer.isActive('dev1')).toBe(false);
      expect(t.fake.listenerCount()).toBe(0); // event listeners are cleaned up
    });

    it('reports the water going off once the last cycle has run, with the zone names', async () => {
      const t = setup();
      const cmd: DeviceCommand = { ...command([wave([1, 10]), wave([1, 15])]), zones: [zone({ name: 'Front' })] };

      await t.sequencer.start(cmd);
      await vi.advanceTimersByTimeAsync(40 * MIN); // cycle 2 sent
      expect(t.types()).not.toContain('sequence.finished');
      await vi.advanceTimersByTimeAsync(15 * MIN - 1);
      expect(t.types()).not.toContain('sequence.finished');
      await vi.advanceTimersByTimeAsync(1);

      expect(t.audit.ofType('sequence.finished')).toEqual([
        expect.objectContaining({ zoneNames: ['Front'], cycles: 2, deliveredMinutes: 25, startedAt: NOW.toISOString() }),
      ]);
      expect(t.audit.ofType('sequence.started')[0]?.zoneNames).toEqual(['Front']);
      expect(t.audit.ofType('wave.confirmed')[0]?.zoneNames).toEqual(['Front']);
    });

    it('does not report "water off" after stop()', async () => {
      const t = setup();
      await t.sequencer.start(command([wave([1, 10])]));

      t.sequencer.stop();
      await vi.advanceTimersByTimeAsync(60 * MIN);

      expect(t.types()).not.toContain('sequence.finished');
    });

    it('marks a wave in flight in the saved state before sending it, and clears it after', async () => {
      const t = setup();
      let savedAtSend: PendingSequence[] | undefined;
      t.bhyve.startWatering.mockImplementationOnce(async (deviceId: string) => {
        savedAtSend = t.snapshots.at(-1);
        t.fake.emit({ event: 'watering_in_progress_notification', device_id: deviceId });
      });

      await t.sequencer.start(TWO_CYCLES);

      // A crash during the send would leave this on disk:
      expect(savedAtSend).toEqual([expect.objectContaining({ nextWave: 0, inFlight: { wave: 0, since: NOW } })]);
      // ...and after the outcome is saved, the marker is gone and the next wave is due:
      expect(t.snapshots.at(-1)).toEqual([expect.objectContaining({ nextWave: 1, dueAt: new Date(NOW.getTime() + 40 * MIN) })]);
      expect(t.snapshots.at(-1)?.[0]).not.toHaveProperty('inFlight');
    });

    it('accepts an acknowledgement that arrives within the confirm timeout', async () => {
      const t = setup();
      t.fake.setAcknowledge(false);
      setTimeout(() => t.fake.emit({ event: 'change_mode', device_id: 'dev1' }), 5_000);

      const result = t.sequencer.start(command([wave([1, 10])]));
      await vi.advanceTimersByTimeAsync(5_000);

      await expect(result).resolves.toBe('delivered');
      expect(t.bhyve.getDevice).not.toHaveBeenCalled();
      expect(t.audit.ofType('wave.confirmed')[0]).toMatchObject({ via: 'event' });
    });

    it("ignores another device's events", async () => {
      const t = setup();
      t.fake.setAcknowledge(false);
      t.fake.setDevices(watering());
      setTimeout(() => t.fake.emit({ event: 'watering_in_progress_notification', device_id: 'dev2' }), 1_000);

      const result = t.sequencer.start(command([wave([1, 10])]));
      await vi.advanceTimersByTimeAsync(20_000);

      await expect(result).resolves.toBe('delivered');
      expect(t.audit.ofType('wave.confirmed')[0]).toMatchObject({ via: 'status' }); // not 'event'
    });
  });

  describe('scenario: the command may not have reached the device', () => {
    it('confirms by device status when no event arrives', async () => {
      const t = setup();
      t.fake.setAcknowledge(false);
      t.fake.setDevices(watering());

      const result = t.sequencer.start(command([wave([1, 10])]));
      await vi.advanceTimersByTimeAsync(20_000);

      await expect(result).resolves.toBe('delivered');
      expect(t.audit.ofType('wave.confirmed')[0]).toMatchObject({ via: 'status' });
    });

    it('re-sends only after the device was reported idle twice, then confirms', async () => {
      const t = setup();
      t.fake.setAcknowledge(false); // the command was lost: no event, device idle

      const result = t.sequencer.start(command([wave([1, 10])]));
      await vi.advanceTimersByTimeAsync(40_000); // 20s wait, status, 20s wait, status

      await expect(result).resolves.toBe('retrying');
      expect(t.bhyve.getDevice).toHaveBeenCalledTimes(2);
      expect(t.history.runs).toEqual([]);
      expect(t.audit.ofType('wave.not_started')).toHaveLength(1);
      expect(t.audit.ofType('wave.retry_scheduled')[0]).toMatchObject({ attempt: 2, inMinutes: 1 });

      t.fake.setAcknowledge(true);
      await vi.advanceTimersByTimeAsync(MIN);

      expect(t.bhyve.startWatering).toHaveBeenCalledTimes(2);
      expect(t.history.runs).toHaveLength(1); // delivered exactly once
      expect(t.types().at(-1)).toBe('sequence.completed');
    });

    it('does not re-send when a late event shows the device did start', async () => {
      const t = setup();
      t.fake.setAcknowledge(false);
      setTimeout(() => t.fake.emit({ event: 'watering_in_progress_notification', device_id: 'dev1' }), 30_000);

      const result = t.sequencer.start(command([wave([1, 10])]));
      await vi.advanceTimersByTimeAsync(40_000);

      await expect(result).resolves.toBe('delivered');
      expect(t.bhyve.startWatering).toHaveBeenCalledTimes(1);
    });

    it('never re-sends a short wave that may simply have finished already', async () => {
      const t = setup();
      t.fake.setAcknowledge(false);

      // 1 minute of watering: idle after 40s of checking is not proof it never ran.
      const result = t.sequencer.start(command([wave([1, 1])]));
      await vi.advanceTimersByTimeAsync(40_000);

      await expect(result).resolves.toBe('delivered');
      expect(t.audit.ofType('wave.unconfirmed')).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(60 * MIN);
      expect(t.bhyve.startWatering).toHaveBeenCalledTimes(1);
    });

    it('counts the wave as delivered (never re-sends) when its status cannot be read', async () => {
      const t = setup();
      t.fake.setAcknowledge(false);
      t.bhyve.getDevice.mockRejectedValue(new Error('B-hyve GET /devices/dev1 timed out after 20s'));

      const result = t.sequencer.start(command([wave([1, 10])]));
      await vi.advanceTimersByTimeAsync(20_000);

      await expect(result).resolves.toBe('delivered');
      expect(t.history.runs).toHaveLength(1);
      expect(t.audit.ofType('wave.unconfirmed')[0]?.reason).toContain('counted as delivered so it is never sent twice');
      expect(t.audit.ofType('connection.lost')[0]).toMatchObject({ service: 'bhyve', error: expect.stringContaining('timed out') });
      await vi.advanceTimersByTimeAsync(60 * MIN);
      expect(t.bhyve.startWatering).toHaveBeenCalledTimes(1);
    });
  });

  describe('scenario: B-hyve unreachable when a wave is due', () => {
    it('retries with back-off and continues once the connection is back', async () => {
      const t = setup();
      t.bhyve.startWatering.mockRejectedValueOnce(new Error('B-hyve socket did not open within 15s'));
      t.bhyve.startWatering.mockRejectedValueOnce(new Error('B-hyve socket did not open within 15s'));

      await expect(t.sequencer.start(TWO_CYCLES)).resolves.toBe('retrying');
      await vi.advanceTimersByTimeAsync(1 * MIN); // retry #2 fails
      await vi.advanceTimersByTimeAsync(2 * MIN); // retry #3 succeeds

      expect(t.bhyve.startWatering).toHaveBeenCalledTimes(3);
      expect(t.audit.ofType('wave.retry_scheduled').map((e) => e.inMinutes)).toEqual([1, 2]);
      // One outage of the command socket, not one per failure, and not confused with the REST API
      // (which kept answering the pre-send status checks).
      expect(t.audit.ofType('connection.lost')).toEqual([expect.objectContaining({ service: 'bhyve-commands' })]);
      expect(t.audit.ofType('connection.restored')).toEqual([
        expect.objectContaining({ service: 'bhyve-commands', failures: 2, outageMinutes: 3 }),
      ]);
      expect(t.history.runs.map((r) => r.at)).toEqual([new Date(NOW.getTime() + 3 * MIN)]);

      // Cycle 2 is timed from when cycle 1 actually ran.
      await vi.advanceTimersByTimeAsync(40 * MIN - 1);
      expect(t.bhyve.startWatering).toHaveBeenCalledTimes(3);
      await vi.advanceTimersByTimeAsync(1);
      expect(t.bhyve.startWatering).toHaveBeenCalledTimes(4);
      expect(t.types().at(-1)).toBe('sequence.completed');
    });

    it('starts the back-off afresh for each cycle', async () => {
      const t = setup();
      t.bhyve.startWatering.mockRejectedValueOnce(new Error('socket down')).mockRejectedValueOnce(new Error('socket down'));

      await t.sequencer.start(TWO_CYCLES); // cycle 1: fails, fails, then succeeds at +3 min
      await vi.advanceTimersByTimeAsync(3 * MIN);
      t.bhyve.startWatering.mockRejectedValueOnce(new Error('socket down'));
      await vi.advanceTimersByTimeAsync(40 * MIN); // cycle 2: fails once

      const retries = t.audit.ofType('wave.retry_scheduled');
      expect(retries.map((e) => [e.cycle, e.attempt, e.inMinutes])).toEqual([
        [1, 2, 1],
        [1, 3, 2],
        [2, 2, 1], // not attempt 4 with a 5-minute wait
      ]);
    });

    it('backs off 1, 2, 5, 10, 10 min and gives up at the end of the retry window', async () => {
      const t = setup({ retryWindowMinutes: 30 });
      t.bhyve.startWatering.mockRejectedValue(new Error('socket down'));

      await t.sequencer.start(TWO_CYCLES);
      await vi.advanceTimersByTimeAsync(60 * MIN);

      // Attempts at 0, 1, 3, 8, 18, 28 min, and a last one at 30 (the window's end).
      expect(t.audit.ofType('wave.retry_scheduled').map((e) => e.inMinutes)).toEqual([1, 2, 5, 10, 10, 2]);
      expect(t.bhyve.startWatering).toHaveBeenCalledTimes(7);
      expect(t.audit.ofType('sequence.abandoned')[0]).toMatchObject({
        cyclesDelivered: 0,
        of: 2,
        deliveredMinutes: 0,
        plannedMinutes: 20,
        reason: expect.stringContaining('gave up on cycle 1/2 after 7 attempt(s) over 30 min: socket down'),
      });
      expect(t.sequencer.isActive('dev1')).toBe(false);
      expect(t.snapshots.at(-1)).toEqual([]); // nothing left to resume
      expect(t.history.runs).toEqual([]);
    });

    it('abandons only the rest of a sequence, keeping what was delivered', async () => {
      const t = setup({ retryWindowMinutes: 5 });
      await t.sequencer.start(TWO_CYCLES);
      t.bhyve.startWatering.mockRejectedValue(new Error('socket down'));

      await vi.advanceTimersByTimeAsync(40 * MIN + 5 * MIN);

      expect(t.audit.ofType('sequence.abandoned')[0]).toMatchObject({ cyclesDelivered: 1, deliveredMinutes: 10, plannedMinutes: 20 });
      expect(t.history.runs).toHaveLength(1);
    });
  });

  describe('scenario: things change during the soak', () => {
    it.each([
      ['switched off', bhyveDevice('dev1', { status: { run_mode: 'off' } }), 'the device was switched off'],
      ['rain delay set', bhyveDevice('dev1', { status: { run_mode: 'auto', rain_delay: 48 } }), 'a 48h rain delay was set'],
    ])('abandons the rest when the owner intervened (%s), without sending', async (_, device, reason) => {
      const t = setup();
      await t.sequencer.start(TWO_CYCLES);
      t.fake.setDevices(device);

      await vi.advanceTimersByTimeAsync(40 * MIN);

      expect(t.bhyve.startWatering).toHaveBeenCalledTimes(1);
      expect(t.audit.ofType('sequence.abandoned')[0]).toMatchObject({ reason, cyclesDelivered: 1 });
      expect(t.snapshots.at(-1)).toEqual([]);
    });

    it.each([
      ['offline', bhyveDevice('dev1', { is_connected: false }), 'the device is offline'],
      ['busy with another program', watering(), 'the device is busy watering'],
    ])('waits while the device is %s, then continues', async (_, device, reason) => {
      const t = setup();
      await t.sequencer.start(TWO_CYCLES);
      t.fake.setDevices(device);

      await vi.advanceTimersByTimeAsync(40 * MIN);
      expect(t.audit.ofType('wave.deferred')[0]).toMatchObject({ reason, cycle: 2 });
      expect(t.bhyve.startWatering).toHaveBeenCalledTimes(1);

      t.fake.setDevices(bhyveDevice('dev1'));
      await vi.advanceTimersByTimeAsync(MIN);
      expect(t.bhyve.startWatering).toHaveBeenCalledTimes(2);
      expect(t.types().at(-1)).toBe('sequence.completed');
    });

    it('does not send blind when the device status cannot be read (it may have been switched off)', async () => {
      const t = setup();
      await t.sequencer.start(TWO_CYCLES);
      t.bhyve.getDevice.mockRejectedValueOnce(new Error('B-hyve GET /devices/dev1 failed: HTTP 503'));

      await vi.advanceTimersByTimeAsync(40 * MIN);

      expect(t.bhyve.startWatering).toHaveBeenCalledTimes(1);
      expect(t.audit.ofType('wave.deferred')[0]?.reason).toContain('could not read the device status');
      await vi.advanceTimersByTimeAsync(MIN);
      expect(t.bhyve.startWatering).toHaveBeenCalledTimes(2);
    });
  });

  describe('scenario: restart in the middle of a sequence', () => {
    const saved = (overrides: Partial<PendingSequence> = {}): PendingSequence => ({
      id: 'abc',
      deviceId: 'dev1',
      waves: [wave([1, 10]), wave([1, 10]), wave([1, 10])],
      soakMinutes: 30,
      createdAt: new Date(NOW.getTime() - 40 * MIN),
      nextWave: 1,
      dueAt: new Date(NOW.getTime() + 5 * MIN),
      attempts: 0,
      ...overrides,
    });

    it('resumes at the saved cycle when it comes due', async () => {
      const t = setup();

      await t.sequencer.resume([saved()]);
      expect(t.audit.ofType('sequence.resumed')[0]).toMatchObject({ sequence: 'abc', nextCycle: 2, of: 3 });
      expect(t.sequencer.isActive('dev1')).toBe(true);

      await vi.advanceTimersByTimeAsync(5 * MIN);
      expect(t.bhyve.startWatering).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(40 * MIN);
      expect(t.bhyve.startWatering).toHaveBeenCalledTimes(2);
      expect(t.audit.ofType('sequence.completed')).toHaveLength(1);
    });

    it('sends an overdue cycle right away if still within the resume window', async () => {
      const t = setup({ resumeWindowMinutes: 60 });

      await t.sequencer.resume([saved({ dueAt: new Date(NOW.getTime() - 20 * MIN) })]);
      await vi.advanceTimersByTimeAsync(0);

      expect(t.bhyve.startWatering).toHaveBeenCalledTimes(1);
    });

    it('abandons a sequence that is too stale to resume', async () => {
      const t = setup({ resumeWindowMinutes: 60 });

      await t.sequencer.resume([saved({ dueAt: new Date(NOW.getTime() - 90 * MIN) })]);
      await vi.advanceTimersByTimeAsync(60 * MIN);

      expect(t.bhyve.startWatering).not.toHaveBeenCalled();
      expect(t.audit.ofType('sequence.abandoned')[0]?.reason).toBe('too late to resume after a restart: cycle 2 was due 90 min ago');
      expect(t.snapshots.at(-1)).toEqual([]);
    });

    it('counts a wave found in flight as delivered and moves on (never sends it twice)', async () => {
      const t = setup();
      const sentAt = new Date(NOW.getTime() - 2 * MIN);

      await t.sequencer.resume([saved({ inFlight: { wave: 1, since: sentAt }, dueAt: new Date(NOW.getTime() - 2 * MIN) })]);

      expect(t.audit.ofType('wave.assumed_delivered')[0]).toMatchObject({ cycle: 2, reason: 'found in flight after a restart' });
      expect(t.history.runs).toEqual([{ zoneKey: 'dev1:1', at: sentAt, minutes: 10 }]);
      // Cycle 3 is due 40 min after the in-flight cycle was sent.
      await vi.advanceTimersByTimeAsync(38 * MIN - 1);
      expect(t.bhyve.startWatering).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(t.bhyve.startWatering).toHaveBeenCalledOnce();
      expect(t.bhyve.startWatering).toHaveBeenCalledWith('dev1', wave([1, 10]));
    });

    it('completes a sequence whose last wave was in flight', async () => {
      const t = setup();

      await t.sequencer.resume([saved({ nextWave: 2, inFlight: { wave: 2, since: NOW } })]);

      expect(t.types()).toEqual(['wave.assumed_delivered', 'sequence.completed']);
      expect(t.sequencer.isActive('dev1')).toBe(false);
      expect(t.snapshots.at(-1)).toEqual([]);
    });

    it('keeps the retry count and original due time across the restart', async () => {
      const t = setup({ retryWindowMinutes: 30 });
      t.bhyve.startWatering.mockRejectedValue(new Error('socket down'));

      // Due 25 min ago, 4 attempts already: only 5 min of the retry window left.
      await t.sequencer.resume([saved({ dueAt: new Date(NOW.getTime() - 25 * MIN), attempts: 4 })]);
      await vi.advanceTimersByTimeAsync(10 * MIN);

      expect(t.audit.ofType('sequence.abandoned')[0]?.reason).toContain('after 6 attempt(s) over 30 min');
    });
  });

  it('never runs two sequences on one device (e.g. a late poll after the watchdog gave up on it)', async () => {
    const t = setup();
    await t.sequencer.start(TWO_CYCLES);

    await expect(t.sequencer.start(TWO_CYCLES)).resolves.toBe('abandoned');

    expect(t.bhyve.startWatering).toHaveBeenCalledOnce();
    expect(t.audit.ofType('sequence.started')).toHaveLength(1);
  });

  describe('stopping', () => {
    it('stop() clears timers but keeps sequences for the next start, and releases drain()', async () => {
      const t = setup();
      await t.sequencer.start(TWO_CYCLES);
      const drained = t.sequencer.drain();

      t.sequencer.stop();
      await vi.advanceTimersByTimeAsync(60 * MIN);

      await expect(drained).resolves.toBeUndefined();
      expect(t.bhyve.startWatering).toHaveBeenCalledTimes(1);
      expect(t.sequencer.pending()).toEqual([expect.objectContaining({ nextWave: 1 })]);
    });
  });
});
