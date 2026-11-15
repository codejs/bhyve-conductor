import { vi } from 'vitest';
import type { ServiceInfo } from '../../bot/format.ts';
import type { BotCommandsDeps } from '../../bot/registry.ts';
import type { ConductorStatus } from '../../conductor/monitor.ts';
import { NOW } from './conductor.ts';

/** A conductor status: running, idle, nothing to report (override what a test needs). */
export const conductorStatus = (overrides: Partial<ConductorStatus> = {}): ConductorStatus => ({
  at: NOW,
  running: true,
  dryRun: false,
  pollIntervalMinutes: 15,
  polling: false,
  zones: [],
  sequences: [],
  wateringNow: [],
  outages: [],
  alerts: [],
  polls: { ok: 0, failed: 0, hung: 0 },
  ...overrides,
});

/** The service, healthy. */
export const serviceInfo = (overrides: Partial<ServiceInfo> = {}): ServiceInfo => ({
  version: 'v1.0.0',
  node: 'v22.21.0',
  uptimeMs: 3 * 3_600_000,
  memoryBytes: 80 * 1024 * 1024,
  files: [
    { name: 'audit trail', bytes: 1_234_567 },
    { name: 'state', bytes: 2_048 },
    { name: 'settings', bytes: 900 },
  ],
  notifications: { delivered: 12, failed: 0, waiting: 0 },
  commandsLockedForMs: 0,
  ...overrides,
});

/** Everything buildBotCommands needs, as fakes (with or without the commands that change something). */
export const fakeBotDeps = (opts: { changes?: boolean } = {}): BotCommandsDeps => ({
  bhyve: { getDevices: vi.fn(async () => []) },
  sensors: { id: 'x', read: vi.fn(async () => []) },
  zonesBySensor: new Map(),
  status: vi.fn(() => conductorStatus()),
  service: vi.fn(() => serviceInfo()),
  timeZone: 'UTC',
  now: () => NOW,
  readAudit: vi.fn(async () => ({ events: [], skipped: 0, truncated: false })),
  zoneView: { zones: vi.fn(() => []), zoneStatus: vi.fn(() => undefined) },
  waterStop: { zones: vi.fn(() => []), status: vi.fn(() => conductorStatus()), devices: vi.fn(async () => []), stopWatering: vi.fn(async () => []) },
  ...(opts.changes
    ? { changes: { control: { status: vi.fn(() => conductorStatus()), pause: vi.fn(), resume: vi.fn() }, editor: { zones: () => [], preview: vi.fn(), apply: vi.fn() } } }
    : {}),
});
