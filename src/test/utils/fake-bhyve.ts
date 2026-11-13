import { vi } from 'vitest';
import type { BhyveDevice, BhyveEvent, BhyveProgram, StationRun } from '../../bhyve/types.ts';
import type { BhyveControl } from '../../conductor/monitor.ts';

/**
 * A B-hyve account in memory. By default `startWatering` behaves like a healthy device: it emits the
 * acknowledgement event a real controller sends when it starts a manual run.
 */
export const fakeBhyve = (initial: BhyveDevice[]) => {
  let devices = initial;
  let acknowledge = true;
  const listeners = new Set<(e: BhyveEvent) => void>();
  const emit = (e: BhyveEvent) => {
    for (const l of listeners) l(e);
  };

  const bhyve = {
    getDevices: vi.fn(async () => devices),
    getDevice: vi.fn(async (id: string) => {
      const d = devices.find((x) => x.id === id);
      if (!d) throw new Error(`B-hyve GET /devices/${id} failed: HTTP 404`);
      return d;
    }),
    getPrograms: vi.fn(async (): Promise<BhyveProgram[]> => []),
    startWatering: vi.fn(async (deviceId: string, _runs: StationRun[]) => {
      if (acknowledge) emit({ event: 'watering_in_progress_notification', device_id: deviceId });
    }),
    onEvent: vi.fn((listener: (e: BhyveEvent) => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    }),
  };

  return {
    bhyve,
    control: bhyve as unknown as BhyveControl,
    emit,
    setDevices: (...ds: BhyveDevice[]) => {
      devices = ds;
    },
    /** Simulate a device/cloud that no longer sends acknowledgement events. */
    setAcknowledge: (on: boolean) => {
      acknowledge = on;
    },
    listenerCount: () => listeners.size,
  };
};
