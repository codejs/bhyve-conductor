import type { AuditEvent, AuditType } from './audit.ts';

/** Event types that show something went wrong, or how it was recovered. */
export const RECOVERY_TYPES: ReadonlySet<AuditType> = new Set<AuditType>([
  'service.unclean_shutdown',
  'poll.failed',
  'connection.lost',
  'connection.restored',
  'socket.disconnected',
  'zone.no_data',
  'zone.data_restored',
  'sequence.resumed',
  'sequence.abandoned',
  'wave.unconfirmed',
  'wave.not_started',
  'wave.send_failed',
  'wave.deferred',
  'wave.retry_scheduled',
  'wave.assumed_delivered',
  'state.save_failed',
  'battery.low',
  'battery.ok',
  'moisture.critical_low',
  'moisture.critical_high',
  'moisture.normal',
  'device.offline',
  'device.online',
  'zone.daily_limit_reached',
  'notification.failed',
]);

export interface AuditFilter {
  since?: Date;
  until?: Date;
  /** Type prefixes, e.g. ["wave", "sequence.abandoned"]. */
  types?: string[];
  device?: string;
  /** "<deviceId>:<station>" */
  zone?: string;
  sequence?: string;
  /** Only failures and recoveries. */
  recovery?: boolean;
}

const DURATION = /^(\d+(?:\.\d+)?)\s*(m|min|h|d|w)$/i;

/** "90m", "24h", "7d", "2w" (before `now`) or an ISO date/time. */
export const parseSince = (text: string, now: Date): Date => {
  const m = DURATION.exec(text.trim());
  if (m) {
    const unitMs = { m: 60_000, min: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000 }[
      (m[2] ?? '').toLowerCase() as 'm' | 'min' | 'h' | 'd' | 'w'
    ];
    return new Date(now.getTime() - Number(m[1]) * unitMs);
  }
  const d = new Date(text);
  if (Number.isNaN(d.getTime())) throw new Error(`Can't read "${text}" as a time; use e.g. 24h, 7d or 2026-07-01T06:00`);
  return d;
};

const stationsOf = (e: AuditEvent): number[] => {
  const list = (e.stations ?? (Array.isArray(e.waves) ? (e.waves as unknown[]).flat() : [])) as { station?: number }[];
  return Array.isArray(list) ? list.map((r) => r.station).filter((s): s is number => typeof s === 'number') : [];
};

const matchesZone = (e: AuditEvent, key: string): boolean => {
  if (e.zone === key) return true;
  if (Array.isArray(e.zones) && (e.zones as { zone?: string }[]).some((z) => z.zone === key)) return true;
  const sep = key.lastIndexOf(':');
  const device = key.slice(0, sep);
  const station = Number(key.slice(sep + 1));
  return e.device === device && stationsOf(e).includes(station);
};

export const filterEvents = (events: readonly AuditEvent[], f: AuditFilter): AuditEvent[] =>
  events.filter((e) => {
    const t = new Date(e.ts).getTime();
    if (f.since && t < f.since.getTime()) return false;
    if (f.until && t > f.until.getTime()) return false;
    if (f.types?.length && !f.types.some((p) => e.type === p || e.type.startsWith(`${p}.`))) return false;
    if (f.recovery && !RECOVERY_TYPES.has(e.type)) return false;
    if (f.device && e.device !== f.device) return false;
    if (f.sequence && e.sequence !== f.sequence) return false;
    if (f.zone && !matchesZone(e, f.zone)) return false;
    return true;
  });

const cycleOf = (e: AuditEvent): string => (typeof e.cycle === 'number' ? ` cycle ${e.cycle}/${String(e.of)}` : '');
const stationsText = (e: AuditEvent): string => {
  const list = e.stations as { station: number; runTime: number }[] | undefined;
  return Array.isArray(list) ? list.map((r) => `st${r.station} ${r.runTime}min`).join(', ') : '';
};

/** One-line description of an event (without the timestamp); times inside it are shown in `timeZone`. */
export const describe = (e: AuditEvent, timeZone?: string): string => {
  const at = (v: unknown) => (typeof v === 'string' && !Number.isNaN(Date.parse(v)) ? formatTime(v, timeZone) : String(v));
  const seq = typeof e.sequence === 'string' ? ` [seq ${e.sequence}]` : '';
  const dev = typeof e.device === 'string' ? ` ${e.device}` : '';
  switch (e.type) {
    case 'service.started':
      return `service started (${String(e.mode)}${e.dryRun ? ', dry run' : ''}, ${String(e.zones)} zones)`;
    case 'service.stopped':
      return `service stopped (${String(e.reason)})`;
    case 'service.unclean_shutdown':
      return `previous run ended without a clean shutdown (last event ${String(e.lastEvent)} at ${at(e.lastEventAt)})`;
    case 'poll.failed':
      return `poll failed: ${String(e.error)}`;
    case 'connection.lost':
      return `${String(e.service)} unreachable: ${String(e.error)}`;
    case 'connection.restored':
      return `${String(e.service)} reachable again after ${String(e.outageMinutes)} min (${String(e.failures)} failed attempts; last error: ${String(e.lastError)})`;
    case 'socket.connected':
      return 'B-hyve socket connected';
    case 'socket.disconnected':
      return `B-hyve socket disconnected${e.code === undefined ? '' : ` (code ${String(e.code)})`}`;
    case 'zone.no_data':
      return `zone ${String(e.zone)} (${String(e.name)}) has no usable sensor data, so it won't be watered: ${String(e.detail)}`;
    case 'zone.data_restored':
      return `zone ${String(e.zone)} (${String(e.name)}) has sensor data again after ${String(e.outageMinutes)} min`;
    case 'sequence.started': {
      const zones = Array.isArray(e.zones)
        ? (e.zones as { zone: string; moisturePct?: number; minutes?: number }[])
            .map((z) => `${z.zone} at ${z.moisturePct === undefined ? '?' : Math.round(z.moisturePct * 10) / 10}% → ${String(z.minutes)} min`)
            .join('; ')
        : '';
      const waves = Array.isArray(e.waves) ? (e.waves as unknown[]).length : 0;
      return `watering started${dev}${seq}: ${String(e.plannedMinutes)} min in ${waves} cycle(s), ${String(e.soakMinutes)} min soak${zones ? ` — ${zones}` : ''}`;
    }
    case 'sequence.resumed':
      return `watering resumed after restart${dev}${seq} at cycle ${String(e.nextCycle)}/${String(e.of)} (due ${at(e.dueAt)})`;
    case 'sequence.completed':
      return `watering completed${dev}${seq}: ${String(e.deliveredMinutes)} min in ${String(e.cycles)} cycle(s)`;
    case 'sequence.abandoned':
      return `watering ABANDONED${dev}${seq} after ${String(e.cyclesDelivered)}/${String(e.of)} cycle(s), ${String(e.deliveredMinutes)} of ${String(e.plannedMinutes)} min delivered: ${String(e.reason)}`;
    case 'wave.sent':
      return `sent${dev}${seq}${cycleOf(e)} (attempt ${String(e.attempt)}): ${stationsText(e)}`;
    case 'wave.confirmed':
      return `confirmed${dev}${seq}${cycleOf(e)} via ${String(e.via)}`;
    case 'wave.unconfirmed':
      return `UNCONFIRMED${dev}${seq}${cycleOf(e)}: ${String(e.reason)}`;
    case 'wave.not_started':
      return `did not start${dev}${seq}${cycleOf(e)}: ${String(e.reason)}`;
    case 'wave.send_failed':
      return `send failed${dev}${seq}${cycleOf(e)}: ${String(e.error)}`;
    case 'wave.deferred':
      return `deferred${dev}${seq}${cycleOf(e)}: ${String(e.reason)}`;
    case 'wave.retry_scheduled':
      return `retry${dev}${seq}${cycleOf(e)} #${String(e.attempt)} in ${String(e.inMinutes)} min (${String(e.reason)})`;
    case 'wave.assumed_delivered':
      return `assumed delivered${dev}${seq}${cycleOf(e)} (${String(e.reason)}; sent ${at(e.sentAt)}): ${stationsText(e)}`;
    case 'state.save_failed':
      return `could not save state: ${String(e.error)}`;
    case 'sequence.finished':
      return `water off${dev}${seq}: ${String(e.deliveredMinutes)} min in ${String(e.cycles)} cycle(s)`;
    case 'battery.low':
      return `LOW BATTERY ${String(e.kind)} ${String(e.name)} (${String(e.id)}): ${String(e.batteryPct)}% (≤ ${String(e.thresholdPct)}%)`;
    case 'battery.ok':
      return `battery ok ${String(e.kind)} ${String(e.name)} (${String(e.id)}): ${String(e.batteryPct)}%`;
    case 'moisture.critical_low':
      return `CRITICALLY DRY zone ${String(e.zone)} (${String(e.name)}): ${String(e.sensorName)} at ${String(e.moisturePct)}% (< ${String(e.limitPct)}%)`;
    case 'moisture.critical_high':
      return `WATERLOGGED zone ${String(e.zone)} (${String(e.name)}): ${String(e.sensorName)} at ${String(e.moisturePct)}% (> ${String(e.limitPct)}%)`;
    case 'moisture.normal':
      return `moisture normal again zone ${String(e.zone)} (${String(e.name)}): ${String(e.sensorName)} at ${String(e.moisturePct)}% (was ${String(e.was)} for ${String(e.minutes)} min)`;
    case 'device.offline':
      return `controller OFFLINE ${String(e.device)} (${String(e.name)})`;
    case 'device.online':
      return `controller online again ${String(e.device)} (${String(e.name)}) after ${String(e.offlineMinutes)} min`;
    case 'zone.daily_limit_reached':
      return `zone ${String(e.zone)} (${String(e.name)}) still dry at ${String(e.moisturePct)}% after its full daily allowance (${String(e.maxMinutesPerDay)} min)`;
    case 'zone.decision':
      return `zone ${String(e.zone)} (${String(e.name)}) → ${String(e.reason)}: ${String(e.detail)}`;
    case 'simulation.note':
      return `▶ ${String(e.note)}`;
    case 'notification.failed':
      return `notification NOT delivered after ${String(e.attempts)} attempt(s): ${String(e.error)}`;
    default: {
      const { ts: _ts, type: _type, ...rest } = e;
      return JSON.stringify(rest);
    }
  }
};

/** Local "YYYY-MM-DD HH:MM:SS" in the given time zone (default: the system's). */
export const formatTime = (iso: string, timeZone?: string): string => {
  const d = new Date(iso);
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      ...(timeZone ? { timeZone } : {}),
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    })
      .formatToParts(d)
      .map((p) => [p.type, p.value]),
  );
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second}`;
};

export const formatEvent = (e: AuditEvent, timeZone?: string): string =>
  `${formatTime(e.ts, timeZone)}  ${RECOVERY_TYPES.has(e.type) ? '!' : ' '} ${e.type.padEnd(24)} ${describe(e, timeZone)}`;

export interface OutageRow {
  service: string;
  from: string;
  to?: string;
  minutes?: number;
  failures?: number;
  lastError: string;
}

export interface SequenceRow {
  sequence: string;
  device: string;
  started: string;
  status: 'completed' | 'abandoned' | 'in progress' | 'resumed';
  plannedMinutes?: number;
  deliveredMinutes?: number;
  retries: number;
  unconfirmed: number;
  assumed: number;
  /** Picked up again after a restart. */
  resumed: boolean;
  note?: string;
}

/** Outages per service and the fate of every watering sequence, for a quick post-incident review. */
export const summarize = (events: readonly AuditEvent[]): { outages: OutageRow[]; sequences: SequenceRow[]; uncleanShutdowns: number } => {
  const outages: OutageRow[] = [];
  const open = new Map<string, OutageRow>();
  const sequences = new Map<string, SequenceRow>();
  let uncleanShutdowns = 0;

  for (const e of events) {
    const seqId = typeof e.sequence === 'string' ? e.sequence : undefined;
    const row = seqId ? sequences.get(seqId) : undefined;
    switch (e.type) {
      case 'connection.lost': {
        const o: OutageRow = { service: String(e.service), from: e.ts, lastError: String(e.error) };
        open.set(o.service, o);
        outages.push(o);
        break;
      }
      case 'connection.restored': {
        const service = String(e.service);
        const o = open.get(service) ?? { service, from: String(e.downSince), lastError: String(e.lastError) };
        if (!open.has(service)) outages.push(o);
        Object.assign(o, { to: e.ts, minutes: e.outageMinutes as number, failures: e.failures as number, lastError: String(e.lastError) });
        open.delete(service);
        break;
      }
      case 'service.unclean_shutdown':
        uncleanShutdowns++;
        break;
      case 'sequence.started':
        if (seqId) {
          sequences.set(seqId, {
            sequence: seqId,
            device: String(e.device),
            started: e.ts,
            status: 'in progress',
            plannedMinutes: e.plannedMinutes as number,
            retries: 0,
            unconfirmed: 0,
            assumed: 0,
            resumed: false,
          });
        }
        break;
      case 'sequence.resumed':
        if (row) Object.assign(row, { status: 'resumed', resumed: true });
        break;
      case 'sequence.completed':
        if (row) Object.assign(row, { status: 'completed', deliveredMinutes: e.deliveredMinutes as number });
        break;
      case 'sequence.abandoned':
        if (row) {
          Object.assign(row, { status: 'abandoned', deliveredMinutes: e.deliveredMinutes as number, note: String(e.reason) });
        } else if (seqId) {
          // Started before the reviewed period.
          sequences.set(seqId, {
            sequence: seqId,
            device: String(e.device),
            started: '?',
            status: 'abandoned',
            plannedMinutes: e.plannedMinutes as number,
            deliveredMinutes: e.deliveredMinutes as number,
            retries: 0,
            unconfirmed: 0,
            assumed: 0,
            resumed: false,
            note: String(e.reason),
          });
        }
        break;
      case 'wave.retry_scheduled':
        if (row) row.retries++;
        break;
      case 'wave.unconfirmed':
        if (row) row.unconfirmed++;
        break;
      case 'wave.assumed_delivered':
        if (row) row.assumed++;
        break;
      default:
        break;
    }
  }
  return { outages, sequences: [...sequences.values()], uncleanShutdowns };
};

export const formatSummary = (s: ReturnType<typeof summarize>, timeZone?: string): string => {
  const lines: string[] = [];
  const t = (iso?: string) => (iso && iso !== '?' ? formatTime(iso, timeZone) : '?');
  lines.push('Connection outages');
  if (s.outages.length === 0) lines.push('  none');
  for (const o of s.outages) {
    const span = o.to ? `${t(o.from)} → ${t(o.to)}  (${String(o.minutes)} min, ${String(o.failures)} failed attempts)` : `${t(o.from)} → ONGOING`;
    lines.push(`  ${o.service.padEnd(8)} ${span}  last error: ${o.lastError}`);
  }
  lines.push('', 'Watering sequences');
  if (s.sequences.length === 0) lines.push('  none');
  for (const q of s.sequences) {
    const amounts = `${q.deliveredMinutes ?? '?'} of ${q.plannedMinutes ?? '?'} min`;
    const flags = [
      q.resumed ? 'resumed after restart' : '',
      q.retries ? `${q.retries} retries` : '',
      q.unconfirmed ? `${q.unconfirmed} unconfirmed` : '',
      q.assumed ? `${q.assumed} assumed after restart` : '',
    ]
      .filter(Boolean)
      .join(', ');
    lines.push(
      `  ${q.sequence}  ${q.device.padEnd(12)} ${t(q.started)}  ${q.status.toUpperCase().padEnd(11)} ${amounts}` +
        (flags ? `  (${flags})` : '') +
        (q.note ? `  — ${q.note}` : ''),
    );
  }
  if (s.uncleanShutdowns > 0) lines.push('', `Unclean shutdowns (crash/kill/power loss): ${s.uncleanShutdowns}`);
  return lines.join('\n');
};
