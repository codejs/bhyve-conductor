import type { BhyveDevice } from '../bhyve/types.ts';
import type { ConductorStatus, ZoneDetail } from '../conductor/monitor.ts';
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

/** What is being watered: the zone names, or the device id if they aren't known. Escaped. */
export const where = (zoneNames: readonly string[], deviceId: string): string => safe(zoneNames.length > 0 ? zoneNames.join(', ') : deviceId);

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

/** About the service itself, for /health (gathered by index.ts; no paths, just what and how big). */
export interface ServiceInfo {
  version: string;
  node: string;
  uptimeMs: number;
  memoryBytes: number;
  /** The conductor's files: name ("audit trail") and size, or no size if missing. */
  files: readonly { name: string; bytes?: number }[];
  /** Telegram notifications since start. */
  notifications?: { delivered: number; failed: number; waiting: number };
  /** How much longer changes are locked after wrong passphrases (0: not locked). */
  commandsLockedForMs: number;
}

/** "1.2 MB" */
export const size = (bytes: number): string => {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${Math.round((bytes / 1024 / 1024) * 10) / 10} MB`;
};

const DURATION = /^(\d{1,4})(m|min|h|d|w)$/;
const DURATION_UNIT_MS: Record<string, number> = { m: 60_000, min: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000 };

/** Does this look like a duration ("90m", "4h", "7d", "2w"), whatever its length? */
export const isDuration = (text: string): boolean => DURATION.test(text.trim().toLowerCase());

/** "90m", "4h", "7d", "2w" → milliseconds, within [min, max]; or why not. Never repeats the input. */
export const parseDuration = (text: string, limits: { minMs: number; maxMs: number }): number | { problem: string } => {
  const m = DURATION.exec(text.trim().toLowerCase());
  const range = `between ${duration(limits.minMs)} and ${duration(limits.maxMs)}`;
  if (!m) return { problem: `Give a time like 90m, 4h or 2d (${range}).` };
  const ms = Number(m[1]) * (DURATION_UNIT_MS[m[2] ?? ''] ?? 0);
  if (ms < limits.minMs || ms > limits.maxMs) return { problem: `The time must be ${range}.` };
  return ms;
};

/**
 * An open alert in words: "🪫 low battery: sensor Probe A". `names` turns ids and zone keys into names.
 * Keys are those of conductor/alerts.ts.
 */
export const alertLabel = (key: string, state: string, names: ReadonlyMap<string, string> = new Map()): string => {
  const name = (id: string) => safe(names.get(id) ?? id, 60);
  let m: RegExpExecArray | null;
  if ((m = /^battery:sensor:(.+)$/.exec(key))) return `🪫 low battery: sensor ${name(m[1] ?? '')}`;
  if ((m = /^battery:device:(.+)$/.exec(key))) return `🪫 low battery: controller ${name(m[1] ?? '')}`;
  if ((m = /^device:(.+)$/.exec(key))) return `📴 controller ${name(m[1] ?? '')} offline`;
  if ((m = /^daily-limit:(.+)$/.exec(key))) return `⏱️ ${name(m[1] ?? '')} still dry after its daily allowance`;
  if ((m = /^moisture:(.+:\d+):(.+)$/.exec(key))) {
    const what = state === 'high' ? '🌊 waterlogged' : state === 'low' ? '🏜️ critically dry' : `⚠️ ${safe(state, 20)}`;
    return `${what}: ${name(m[1] ?? '')} (sensor ${name(m[2] ?? '')})`;
  }
  return `⚠️ ${safe(key, 120)}: ${safe(state, 40)}`;
};

const pauseLine = (p: NonNullable<ConductorStatus['paused']>, at: (d: Date) => string): string =>
  `⏸️ <b>Paused</b> since ${at(p.since)} by ${safe(p.by)}${p.until ? `, until ${at(p.until)}` : ''}: no supplemental watering ` +
  `(sensors are still read and alerts still sent). /resume to resume${p.until ? ' sooner' : ''}.`;

/** What needs a look, worst first (empty: all good). */
const problemsOf = (s: ConductorStatus, service: ServiceInfo, at: (d: Date) => string): string[] => {
  const problems: string[] = [];
  if (!s.running) problems.push('monitoring is not running');
  for (const o of s.outages) problems.push(`${safe(o.service, 40)} unreachable since ${at(o.since)}`);
  if (s.lastPoll && !s.lastPoll.ok) problems.push('the last poll failed');
  // No poll for two intervals (plus a margin): the loop may be stuck.
  const lastActivity = s.lastPoll?.finishedAt ?? s.startedAt;
  if (s.running && !s.polling && lastActivity && s.at.getTime() - lastActivity.getTime() > (2 * s.pollIntervalMinutes + 5) * 60_000) {
    problems.push(`no poll for ${duration(s.at.getTime() - lastActivity.getTime())}`);
  }
  if (s.alerts.length > 0) problems.push(`${s.alerts.length} open alert(s)`);
  if (service.notifications && service.notifications.failed > 0) problems.push(`${service.notifications.failed} notification(s) could not be sent`);
  if (service.commandsLockedForMs > 0) problems.push(`changes locked for another ${duration(service.commandsLockedForMs)} after wrong passphrases`);
  return problems;
};

/** /health: is everything all right, what the conductor is doing, and how the service itself is. */
export const formatHealth = (s: ConductorStatus, service: ServiceInfo, timeZone?: string): string => {
  const at = (d: Date) => shortTime(d, timeZone);
  const ago = (d: Date) => duration(s.at.getTime() - d.getTime());
  const problems = problemsOf(s, service, at);
  const lines = [
    problems.length === 0 ? '🩺 <b>Health</b>: ✅ all good' : `🩺 <b>Health</b>: ⚠️ ${problems.length} thing(s) to look at`,
    ...problems.map((p) => `• ${p}`),
  ];
  if (s.dryRun) lines.push('🧪 Dry run: no watering commands are sent.');

  lines.push('');
  if (!s.running) lines.push('⏹️ Monitoring is <b>not running</b>');
  else if (s.startedAt) lines.push(`▶️ Running since ${at(s.startedAt)} (${ago(s.startedAt)}), polling every ${s.pollIntervalMinutes} min`);
  if (s.paused) lines.push(pauseLine(s.paused, at));
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

  lines.push('', '<b>Zones</b> (details: /zone <i>number</i>)');
  s.zones.forEach((z, i) => {
    const d = z.decision;
    if (!d) {
      lines.push(`${i + 1}. ${safe(z.name)}: no decision yet`);
      return;
    }
    const icon = d.action === 'water' ? '💦' : (REASON_ICON[d.reason] ?? '•');
    const soil = d.moisturePct !== undefined ? `, soil ${d.moisturePct}%` : '';
    const minutes = d.runMinutes !== undefined ? `, ${d.runMinutes} min` : '';
    lines.push(`${i + 1}. ${icon} ${safe(z.name)}: ${safe(d.reason, 40)}${soil}${minutes} <i>(${ago(d.at)} ago)</i>`);
  });

  if (s.sequences.length > 0) {
    lines.push('', s.paused ? '<b>Watering on hold</b>' : '<b>Watering in progress</b>');
    for (const q of s.sequences) {
      const when = q.dueAt.getTime() > s.at.getTime() ? `due ${at(q.dueAt)}` : s.paused ? `due since ${at(q.dueAt)}` : 'due now';
      const retry = q.attempts > 0 ? `, ${q.attempts} failed attempt(s)` : '';
      const stale = s.paused && q.stale ? ', too late to continue' : '';
      lines.push(`${s.paused ? '⏸️' : '💧'} ${where(q.zoneNames, q.deviceId)}: cycle ${q.nextCycle}/${q.cycles} ${when}${retry}${stale}`);
    }
  }
  if (s.wateringNow.length > 0) {
    lines.push('', '<b>Water on now</b> (/stop turns it off)');
    for (const w of s.wateringNow) {
      lines.push(`💧 ${where(w.zoneNames, w.deviceId)}: cycle ${w.cycle}/${w.of} until ${at(w.until)}`);
    }
  }

  lines.push('', '<b>Connections</b>');
  if (s.outages.length === 0) lines.push('🟢 All services reachable');
  for (const o of s.outages) {
    lines.push(`🔴 ${safe(o.service, 40)} unreachable since ${at(o.since)} (${o.failures} failure(s)): ${safe(o.lastError)}`);
  }

  if (s.alerts.length > 0) {
    const names = new Map(s.zones.map((z) => [z.key, z.name]));
    lines.push('', `<b>Open alerts</b> (${s.alerts.length})`);
    for (const a of s.alerts) lines.push(`${alertLabel(a.key, a.state, names)} since ${at(a.since)}`);
  }

  // A missing file is usually one not written yet (the state file comes with the first watering or pause).
  const files = service.files.map((f) => `${safe(f.name, 30)} ${f.bytes === undefined ? 'none yet' : size(f.bytes)}`).join(' · ');
  lines.push(
    '',
    '<b>Service</b>',
    `${safe(service.version, 30)} · Node ${safe(service.node, 20)} · up ${duration(service.uptimeMs)} · memory ${size(service.memoryBytes)}`,
    `Polls since start: ${s.polls.ok} ok · ${s.polls.failed} failed · ${s.polls.hung} stuck`,
    ...(files ? [`Files: ${files}`] : []),
    ...(service.notifications
      ? [`Notifications: ${service.notifications.delivered} sent · ${service.notifications.failed} failed · ${service.notifications.waiting} waiting`]
      : []),
  );
  return fitLines(lines);
};

const AGGREGATION: Record<string, string> = {
  driest: 'the driest sensor counts',
  average: 'the average counts',
  median: 'the median counts',
};

/** /zone: everything about one zone. */
export const formatZone = (z: ZoneDetail, timeZone?: string): string => {
  const at = (d: Date) => shortTime(d, timeZone);
  const ago = (d: Date) => duration(z.at.getTime() - d.getTime());
  const c = z.zone;
  const minutes = (m: number) => (m >= 90 ? duration(m * 60_000) : `${m} min`);
  const lines = [`🌱 <b>${safe(c.name)}</b> · controller ${safe(c.deviceId, 40)}, station ${c.station}`];
  const d = z.decision;
  if (d) {
    const icon = d.action === 'water' ? '💦' : (REASON_ICON[d.reason] ?? '•');
    lines.push(`${icon} <b>${safe(d.reason, 40)}</b>: ${safe(d.detail, 300)} <i>(${ago(d.at)} ago)</i>`);
  } else {
    lines.push('No decision yet.');
  }
  if (z.paused) lines.push(pauseLine(z.paused, at));

  lines.push('', `<b>Sensors</b> (${AGGREGATION[c.sensorAggregation] ?? safe(c.sensorAggregation, 20)})`);
  for (const s of z.sensors) {
    const label = safe(s.name ?? s.id, 60);
    if (s.moisturePct === undefined) {
      lines.push(`• ${label}: ⚠️ ${safe(s.problem ?? 'no reading', 120)}`);
      continue;
    }
    const parts = [`💧 ${round1(s.moisturePct)}%`];
    if (s.temperatureC !== undefined) parts.push(`🌡️ ${round1(s.temperatureC)}°C`);
    if (s.batteryPct !== undefined) parts.push(`🔋 ${round1(s.batteryPct)}%`);
    if (s.at) parts.push(`${ago(s.at)} old`);
    if (s.problem) parts.push(`⚠️ not used: ${safe(s.problem, 60)}`);
    lines.push(`• ${label}: ${parts.join(' · ')}`);
  }

  lines.push('', '<b>Watering</b>');
  lines.push(`• Last 24 h: ${round1(z.usedLastDayMinutes)} of ${minutes(c.maxMinutesPerDay)} used`);
  lines.push(z.lastRun ? `• Last run: ${at(z.lastRun.at)} (${round1(z.lastRun.minutes)} min)` : '• No supplemental run recently');
  if (z.cooldownUntil) lines.push(`• ⏳ Resting until ${at(z.cooldownUntil)} (cooldown)`);
  if (z.wateringNow) lines.push(`• 💧 Water on until ${at(z.wateringNow.until)} (cycle ${z.wateringNow.cycle}/${z.wateringNow.of}) · /stop turns it off`);
  if (z.sequence) {
    const q = z.sequence;
    const state = z.paused ? 'on hold' : q.dueAt.getTime() > z.at.getTime() ? `due ${at(q.dueAt)}` : 'due now';
    lines.push(`• ${z.paused ? '⏸️' : '🔁'} Next cycle ${q.nextCycle}/${q.cycles} ${state} (on ${where(q.zoneNames, q.deviceId)})`);
  }

  lines.push(
    '',
    '<b>Settings</b> (/config changes them)',
    `Water below ${c.thresholdPct}% · refill to ${c.targetPct}% · runs of ${minutes(c.runMinutes)} · up to ${minutes(c.maxMinutesPerDay)} a day · ` +
      `${minutes(c.cooldownMinutes)} between runs · cycles of up to ${minutes(c.maxCycleMinutes)} with ${minutes(c.soakMinutes)} soak · ` +
      `alerts below ${c.criticalLowPct}% and above ${c.criticalHighPct}% · readings used up to ${minutes(c.maxReadingAgeMinutes)} old`,
  );

  if (z.alerts.length > 0) {
    const names = new Map<string, string>([[c.key, c.name], ...z.sensors.filter((s) => s.name).map((s) => [s.id, s.name ?? s.id] as [string, string])]);
    lines.push('', `<b>Open alerts</b> (${z.alerts.length})`);
    for (const a of z.alerts) lines.push(`${alertLabel(a.key, a.state, names)} since ${at(a.since)}`);
  }
  return fitLines(lines);
};
