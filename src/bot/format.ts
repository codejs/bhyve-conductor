import type { BhyveDevice } from '../bhyve/types.ts';
import type { ConductorStatus } from '../conductor/monitor.ts';
import type { MoistureReading } from '../sensors/types.ts';
import { escapeHtml } from '../notify/telegram.ts';

/**
 * Telegram HTML for the bot's replies. Everything that comes from outside (device and sensor names,
 * error messages) is clipped and escaped here: names are chosen in third-party apps, and a stray "<"
 * would make Telegram reject the whole message.
 */

/** Replies are kept under this (Telegram's limit is 4096; the delivery queue batches up to 3500). */
export const MAX_REPLY_CHARS = 3_500;
/** Longest single value (a name, an error) shown in a reply. */
export const MAX_VALUE_CHARS = 200;

/** Shortens to `max` characters (before escaping, so an entity is never cut in half). */
export const clip = (text: string, max = MAX_VALUE_CHARS): string => (text.length <= max ? text : `${text.slice(0, max - 1)}…`);

/** Clipped and HTML-escaped: the only way outside text goes into a reply. */
export const safe = (v: unknown, max = MAX_VALUE_CHARS): string => escapeHtml(clip(v === undefined || v === null ? '?' : String(v), max));

/**
 * Joins lines, dropping whole lines from the end if it gets too long (cutting inside a line could
 * break a tag), and says how many were left out.
 */
export const fitLines = (lines: readonly string[], max = MAX_REPLY_CHARS): string => {
  const all = lines.join('\n');
  if (all.length <= max) return all;
  const out: string[] = [];
  let length = 0;
  for (const [i, line] of lines.entries()) {
    const note = `… ${lines.length - i} more line(s) not shown`;
    // Only take a line if a note (never longer than this one) would still fit after it.
    if (length + line.length + 1 + note.length > max) {
      out.push(note);
      break;
    }
    out.push(line);
    length += line.length + 1;
  }
  return out.join('\n');
};

/** "Jul 1, 14:05" in the given time zone (default: this machine's). */
export const shortTime = (d: Date, timeZone?: string): string =>
  new Intl.DateTimeFormat('en-US', {
    ...(timeZone ? { timeZone } : {}),
    hourCycle: 'h23',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(d);

/** "45 s", "12 min", "3.5 h", "2 days". */
export const duration = (ms: number): string => {
  const s = Math.max(0, ms) / 1000;
  if (s < 90) return `${Math.round(s)} s`;
  const min = s / 60;
  if (min < 90) return `${Math.round(min)} min`;
  const h = min / 60;
  return h < 48 ? `${Math.round(h * 10) / 10} h` : `${Math.round(h / 24)} days`;
};

const round1 = (n: number): number => Math.round(n * 10) / 10;

// ---------- /bhyve_devices ----------

export const formatDevices = (devices: readonly BhyveDevice[]): string => {
  if (devices.length === 0) return '📟 <b>B-hyve devices</b>\nNo devices on this account.';
  const lines = [`📟 <b>B-hyve devices</b> (${devices.length})`];
  for (const d of devices) {
    lines.push('', `<b>${safe(d.name)}</b> [${safe(d.type, 40)}]`);
    const connected = d.is_connected === undefined ? '?' : d.is_connected ? '✅' : '❌ offline';
    const battery = typeof d.battery?.percent === 'number' ? ` · battery ${round1(d.battery.percent)}%` : '';
    lines.push(`id <code>${safe(d.id, 64)}</code> · connected ${connected}${battery}`);
    const status = d.status;
    if (status) {
      const delay = typeof status.rain_delay === 'number' ? status.rain_delay : 0;
      const watering = status.watering_status;
      const now = watering
        ? ` · 💧 watering${typeof watering.current_station === 'number' ? ` station ${watering.current_station}` : ''}`
        : '';
      lines.push(`mode ${safe(status.run_mode ?? '?', 20)} · rain delay ${safe(delay, 10)} h${now}`);
    }
    for (const z of d.zones ?? []) lines.push(`  zone ${safe(z.station, 10)}: ${z.name ? safe(z.name) : '(unnamed)'}`);
  }
  return fitLines(lines);
};

// ---------- /sensors_read ----------

export interface SensorReport {
  readings: readonly MoistureReading[];
  errors: readonly { sensorId: string; error: string }[];
  /** Zone names by sensor id, to say where each sensor is. */
  zonesBySensor: ReadonlyMap<string, readonly string[]>;
  now: Date;
}

export const formatReadings = ({ readings, errors, zonesBySensor, now }: SensorReport): string => {
  const total = readings.length + errors.length;
  if (total === 0) return '🌱 <b>Soil sensors</b>\nNo sensors configured.';
  const lines = [`🌱 <b>Soil sensors</b> (${readings.length} of ${total} read)`];
  const where = (id: string): string => {
    const zones = zonesBySensor.get(id);
    return zones && zones.length > 0 ? ` (${safe(zones.join(', '))})` : '';
  };
  for (const r of readings) {
    const parts = [`💧 ${round1(r.moisturePct)}%`];
    if (r.temperatureC !== undefined) parts.push(`🌡️ ${round1(r.temperatureC)}°C`);
    if (r.batteryPct !== undefined) parts.push(`🔋 ${round1(r.batteryPct)}%`);
    if (!r.online) parts.push('⚠️ offline');
    parts.push(`updated ${duration(now.getTime() - r.at.getTime())} ago`);
    lines.push(`• <b>${safe(r.sensorName)}</b>${where(r.sensorId)}: ${parts.join(' · ')}`);
  }
  for (const e of errors) lines.push(`• ❌ <code>${safe(e.sensorId, 64)}</code>${where(e.sensorId)}: ${safe(e.error)}`);
  return fitLines(lines);
};

// ---------- /status ----------

const REASON_ICON: Record<string, string> = {
  moist: '🟢',
  dry: '🟠',
  'forecast-covered': '🌧️',
  'no-data': '📵',
  cooldown: '🕒',
  'daily-limit': '⏱️',
  'device-not-found': '❓',
  'device-offline': '📴',
  'device-off': '⏹️',
  'rain-delay': '☔',
  'already-watering': '💧',
  soaking: '💧',
  paused: '⏸️',
  'unknown-station': '❓',
};

export const formatStatus = (s: ConductorStatus, timeZone?: string): string => {
  const at = (d: Date) => shortTime(d, timeZone);
  const ago = (d: Date) => duration(s.at.getTime() - d.getTime());
  const lines = [`🌱 <b>Lawn conductor status</b>${s.dryRun ? ' (dry run: no watering commands are sent)' : ''}`];

  if (!s.running) lines.push('⏹️ Monitoring is <b>not running</b>');
  else if (s.startedAt) lines.push(`▶️ Running since ${at(s.startedAt)} (${ago(s.startedAt)}), polling every ${s.pollIntervalMinutes} min`);
  if (s.paused) {
    lines.push(
      `⏸️ <b>Paused</b> since ${at(s.paused.since)} by ${safe(s.paused.by)}: no supplemental watering ` +
        '(sensors are still read and alerts still sent). /resume to resume.',
    );
  }
  if (s.polling) lines.push('🔄 Polling right now');
  if (s.lastPoll) {
    const p = s.lastPoll;
    lines.push(
      p.ok
        ? `✅ Last poll ${at(p.finishedAt)} (${ago(p.finishedAt)} ago)`
        : `❌ Last poll failed ${at(p.finishedAt)} (${ago(p.finishedAt)} ago): ${safe(p.error)}`,
    );
  } else if (s.running && !s.polling) {
    lines.push('No poll has finished yet');
  }
  if (s.nextPollAt) lines.push(`⏭️ Next poll ${at(s.nextPollAt)}`);

  lines.push('', '<b>Zones</b>');
  for (const z of s.zones) {
    const d = z.decision;
    if (!d) {
      lines.push(`• ${safe(z.name)}: no decision yet`);
      continue;
    }
    const icon = d.action === 'water' ? '💦' : (REASON_ICON[d.reason] ?? '•');
    const soil = d.moisturePct !== undefined ? `, soil ${d.moisturePct}%` : '';
    const minutes = d.runMinutes !== undefined ? `, ${d.runMinutes} min` : '';
    lines.push(`${icon} ${safe(z.name)}: ${safe(d.reason, 40)}${soil}${minutes} <i>(${ago(d.at)} ago)</i>`);
  }

  if (s.sequences.length > 0) {
    lines.push('', s.paused ? '<b>Watering on hold</b>' : '<b>Watering in progress</b>');
    for (const q of s.sequences) {
      const who = q.zoneNames.length > 0 ? q.zoneNames.join(', ') : q.deviceId;
      const when = q.dueAt.getTime() > s.at.getTime() ? `due ${at(q.dueAt)}` : s.paused ? `due since ${at(q.dueAt)}` : 'due now';
      const retry = q.attempts > 0 ? `, ${q.attempts} failed attempt(s)` : '';
      const stale = s.paused && q.stale ? ', too late to continue' : '';
      lines.push(`${s.paused ? '⏸️' : '💧'} ${safe(who)}: cycle ${q.nextCycle}/${q.cycles} ${when}${retry}${stale}`);
    }
  }
  if (s.wateringNow.length > 0) {
    lines.push('', '<b>Water on now</b>');
    for (const w of s.wateringNow) {
      const who = w.zoneNames.length > 0 ? w.zoneNames.join(', ') : w.deviceId;
      lines.push(`💧 ${safe(who)}: cycle ${w.cycle}/${w.of} until ${at(w.until)}`);
    }
  }

  lines.push('', '<b>Connections</b>');
  if (s.outages.length === 0) lines.push('🟢 All services reachable');
  for (const o of s.outages) {
    lines.push(`🔴 ${safe(o.service, 40)} unreachable since ${at(o.since)} (${o.failures} failure(s)): ${safe(o.lastError)}`);
  }

  if (s.alerts.length > 0) {
    lines.push('', `<b>Open alerts</b> (${s.alerts.length})`);
    for (const a of s.alerts) lines.push(`⚠️ ${safe(a.key, 120)}: ${safe(a.state, 40)} since ${at(a.since)}`);
  }
  return fitLines(lines);
};
