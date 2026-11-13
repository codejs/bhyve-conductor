import type { AuditEvent, AuditSink, AuditType } from '../audit/audit.ts';
import { systemClock, type Clock, type TimerHandle } from '../clock.ts';
import type { NotificationOptions, Severity } from '../conductor/config.ts';
import { log } from '../log.ts';
import { escapeHtml } from './telegram.ts';

/**
 * Turns audit events into notifications. It is an AuditSink, so it sees exactly what the audit trail
 * records, and the two can never disagree.
 *
 * - Each event type has a severity (info / warning / critical); `minSeverity` filters.
 * - A lost connection is only reported if it's still lost after `connectionGraceMinutes`; a blip that
 *   heals sooner produces no messages at all, and "restored" is only sent if "lost" was.
 * - While Tuya is down, the per-zone "no sensor data" messages are folded into the Tuya one.
 * - Routine plumbing (each send, confirmation, retry) is audit-only; per-cycle messages are optional.
 */

export interface Notification {
  severity: Severity;
  type: AuditType;
  /** Telegram HTML. */
  text: string;
  /** When the event happened. */
  ts: string;
  /** When the notification was sent (later than `ts` for outages that waited out the grace period). */
  sentAt: string;
}

const RANK: Record<Severity, number> = { info: 0, warning: 1, critical: 2 };

const SERVICE: Record<string, { name: string; impact: string; severity: Severity }> = {
  tuya: { name: 'Tuya (soil sensors)', impact: 'No sensor data, so no supplemental watering until it is back.', severity: 'critical' },
  bhyve: { name: 'B-hyve cloud', impact: 'Watering can’t be planned or checked.', severity: 'critical' },
  'bhyve-commands': {
    name: 'B-hyve command connection',
    impact: 'Watering commands can’t be sent; pending cycles are being retried.',
    severity: 'critical',
  },
  weather: { name: 'Weather forecast (Open-Meteo)', impact: 'Using fixed run lengths instead of forecast-based amounts.', severity: 'warning' },
};

const str = (v: unknown): string => escapeHtml(v === undefined || v === null ? '?' : String(v));
const pct = (v: unknown): string => (typeof v === 'number' ? `${Math.round(v * 10) / 10}%` : '?');
const names = (e: AuditEvent): string => {
  const list = Array.isArray(e.zoneNames) ? (e.zoneNames as unknown[]).map(String) : [];
  return list.length > 0 ? escapeHtml(list.join(', ')) : str(e.device);
};
const duration = (minutes: unknown): string => {
  if (typeof minutes !== 'number') return '?';
  if (minutes < 90) return `${Math.round(minutes)} min`;
  const h = minutes / 60;
  return h < 48 ? `${Math.round(h * 10) / 10} h` : `${Math.round(h / 24)} days`;
};

export interface NotifierDeps {
  options: NotificationOptions;
  /** Where composed notifications go (e.g. a DeliveryQueue). */
  deliver: (n: Notification) => void;
  clock?: Clock;
}

export class Notifier implements AuditSink {
  readonly #options: NotificationOptions;
  readonly #deliver: (n: Notification) => void;
  readonly #clock: Clock;
  /** Services known to be down (from the first failure, before the grace period). */
  readonly #down = new Set<string>();
  /** Lost-connection messages waiting out the grace period. */
  readonly #pendingLoss = new Map<string, TimerHandle>();
  /** Services whose loss was actually notified (so "restored" is sent too). */
  readonly #notifiedLoss = new Set<string>();
  /** Zones whose "no data" message was folded into a Tuya outage. */
  readonly #suppressedNoData = new Set<string>();
  /** A crash was just reported; its message already says the conductor is back. */
  #crashReported = false;

  constructor(deps: NotifierDeps) {
    this.#options = deps.options;
    this.#deliver = deps.deliver;
    this.#clock = deps.clock ?? systemClock;
  }

  record(type: AuditType, data: Record<string, unknown> = {}): void {
    try {
      this.#handle({ ts: this.#clock.now().toISOString(), type, ...data });
    } catch (err) {
      log.error(`Could not compose a notification for ${type}`, err);
    }
  }

  /** Cancels pending grace timers. */
  stop(): void {
    for (const timer of this.#pendingLoss.values()) this.#clock.clearTimeout(timer);
    this.#pendingLoss.clear();
  }

  #handle(e: AuditEvent): void {
    const service = typeof e.service === 'string' ? e.service : '';
    switch (e.type) {
      case 'connection.lost': {
        this.#down.add(service);
        const graceMs = this.#options.connectionGraceMinutes * 60_000;
        if (graceMs <= 0) {
          this.#sendLoss(e);
          return;
        }
        this.#pendingLoss.set(
          service,
          this.#clock.setTimeout(() => {
            this.#pendingLoss.delete(service);
            this.#sendLoss(e);
          }, graceMs),
        );
        return;
      }
      case 'connection.restored': {
        this.#down.delete(service);
        const pending = this.#pendingLoss.get(service);
        if (pending !== undefined) {
          // Healed within the grace period: nobody needs to hear about it.
          this.#clock.clearTimeout(pending);
          this.#pendingLoss.delete(service);
          return;
        }
        if (!this.#notifiedLoss.delete(service)) return;
        break;
      }
      case 'service.unclean_shutdown':
        this.#crashReported = true;
        break;
      case 'service.started':
        if (this.#crashReported) {
          this.#crashReported = false;
          return;
        }
        break;
      case 'zone.no_data':
        if (this.#down.has('tuya')) {
          this.#suppressedNoData.add(String(e.zone));
          return;
        }
        break;
      case 'zone.data_restored':
        if (this.#suppressedNoData.delete(String(e.zone))) return;
        break;
      default:
        break;
    }
    this.#emit(e);
  }

  #sendLoss(e: AuditEvent): void {
    if (this.#emit(e)) this.#notifiedLoss.add(String(e.service));
  }

  /** Composes and delivers; returns whether it was sent (not filtered out). */
  #emit(e: AuditEvent): boolean {
    const composed = this.compose(e);
    if (!composed || RANK[composed.severity] < RANK[this.#options.minSeverity]) return false;
    this.#deliver({ ...composed, type: e.type, ts: e.ts, sentAt: this.#clock.now().toISOString() });
    return true;
  }

  /** The message for an event, or undefined if it isn't worth one. Public for the simulator and tests. */
  compose(e: AuditEvent): { severity: Severity; text: string } | undefined {
    const at = (iso: unknown) => (typeof iso === 'string' ? this.#time(iso) : '?');
    switch (e.type) {
      // ----- watering -----
      case 'sequence.started': {
        const zones = Array.isArray(e.zones) ? (e.zones as { name?: string; moisturePct?: number; minutes?: number }[]) : [];
        const waves = Array.isArray(e.waves) ? e.waves.length : 1;
        const plan = waves > 1 ? `${str(e.plannedMinutes)} min in ${waves} cycles (${str(e.soakMinutes)} min soak)` : `${str(e.plannedMinutes)} min`;
        const lines = zones.map((z) => `• ${str(z.name)}: soil ${pct(z.moisturePct)} → ${str(z.minutes)} min`);
        return { severity: 'info', text: [`💧 <b>Watering started</b>: ${names(e)}`, plan, ...lines].join('\n') };
      }
      case 'sequence.finished':
        return {
          severity: 'info',
          text: `✅ <b>Watering finished</b>: ${names(e)}\n${str(e.deliveredMinutes)} min${
            typeof e.cycles === 'number' && e.cycles > 1 ? ` in ${e.cycles} cycles` : ''
          }, started ${at(e.startedAt)}`,
        };
      case 'sequence.abandoned': {
        const reason = String(e.reason ?? '');
        const connectivity = /^gave up|^too late to resume/.test(reason);
        return {
          severity: connectivity ? 'critical' : 'warning',
          text:
            `${connectivity ? '🛑' : '⚠️'} <b>Watering stopped early</b>: ${names(e)}\n` +
            `${str(e.deliveredMinutes)} of ${str(e.plannedMinutes)} min delivered (${str(e.cyclesDelivered)}/${str(e.of)} cycles)\n` +
            `Reason: ${escapeHtml(reason)}` +
            (connectivity ? '\nThe zone will be re-evaluated from its sensors after the cooldown.' : ''),
        };
      }
      case 'sequence.resumed':
        return { severity: 'info', text: `🔁 <b>Watering resumed</b> after a restart: ${names(e)}, cycle ${str(e.nextCycle)}/${str(e.of)}` };
      case 'wave.confirmed':
        if (!this.#options.cycles || typeof e.of !== 'number' || e.of < 2) return undefined;
        return { severity: 'info', text: `💧 Cycle ${str(e.cycle)}/${str(e.of)} started: ${names(e)}` };
      case 'wave.unconfirmed':
        return {
          severity: 'warning',
          text: `❓ <b>Couldn’t confirm</b> cycle ${str(e.cycle)}/${str(e.of)} started: ${names(e)}\nCounted as delivered (never re-sent). Check the lawn if unsure.`,
        };
      case 'wave.assumed_delivered':
        return {
          severity: 'warning',
          text: `❓ Cycle ${str(e.cycle)}/${str(e.of)} for ${names(e)} was being sent when the conductor stopped; counted as delivered.`,
        };

      // ----- moisture -----
      case 'moisture.critical_low':
        return {
          severity: 'critical',
          text: `🏜️ <b>Critically dry</b>: ${str(e.name)}\n${str(e.sensorName)} reads ${pct(e.moisturePct)} (alert below ${pct(e.limitPct)})`,
        };
      case 'moisture.critical_high':
        return {
          severity: 'critical',
          text:
            `🌊 <b>Waterlogged</b>: ${str(e.name)}\n${str(e.sensorName)} reads ${pct(e.moisturePct)} (alert above ${pct(e.limitPct)})\n` +
            'Possible leak, stuck valve, overwatering or heavy rain.',
        };
      case 'moisture.normal':
        return { severity: 'info', text: `👍 Moisture back to normal: ${str(e.name)}, ${str(e.sensorName)} at ${pct(e.moisturePct)}` };
      case 'zone.daily_limit_reached':
        return {
          severity: 'warning',
          text:
            `⏱️ <b>${str(e.name)} is still dry</b> after its full daily allowance (${str(e.maxMinutesPerDay)} min): ${pct(e.moisturePct)}, threshold ${pct(e.thresholdPct)}\n` +
            'Check for a broken valve, clogged nozzle or misplaced sensor, or raise maxMinutesPerDay.',
        };

      // ----- sensors & devices -----
      case 'zone.no_data':
        return { severity: 'warning', text: `📵 <b>No sensor data</b> for ${str(e.name)}: not watered until readings return\n${str(e.detail)}` };
      case 'zone.data_restored':
        return { severity: 'info', text: `📶 Sensor data back for ${str(e.name)} after ${duration(e.outageMinutes)}` };
      case 'battery.low':
        return {
          severity: 'warning',
          text: `🪫 <b>Low battery</b>: ${str(e.name)} (${e.kind === 'timer' ? 'B-hyve timer' : 'soil sensor'}) at ${pct(e.batteryPct)}. Replace it soon.`,
        };
      case 'battery.ok':
        return { severity: 'info', text: `🔋 Battery OK: ${str(e.name)} at ${pct(e.batteryPct)}` };
      case 'device.offline':
        return { severity: 'critical', text: `📴 <b>${str(e.name)} is offline</b>: B-hyve can’t reach it, so no watering is possible.` };
      case 'device.online':
        return { severity: 'info', text: `📶 ${str(e.name)} is back online after ${duration(e.offlineMinutes)}` };

      // ----- connections -----
      case 'connection.lost': {
        const s = SERVICE[String(e.service)] ?? { name: String(e.service), impact: '', severity: 'warning' as Severity };
        return {
          severity: s.severity,
          text: `🔴 <b>${escapeHtml(s.name)} unreachable</b> since ${at(e.ts)}\n${escapeHtml(s.impact)}\nError: ${str(e.error)}`,
        };
      }
      case 'connection.restored': {
        const s = SERVICE[String(e.service)];
        return {
          severity: 'info',
          text: `🟢 <b>${escapeHtml(s?.name ?? String(e.service))} reachable again</b> after ${duration(e.outageMinutes)} (${str(e.failures)} failed attempts)`,
        };
      }

      // ----- the conductor itself -----
      case 'service.started':
        return e.dryRun ? undefined : { severity: 'info', text: `▶️ Lawn conductor started, watching ${str(e.zones)} zone(s)` };
      case 'service.stopped':
        return e.reason === 'once' ? undefined : { severity: 'info', text: `⏹️ Lawn conductor stopped (${str(e.reason)})` };
      case 'service.unclean_shutdown':
        return {
          severity: 'critical',
          text: `💥 <b>Lawn conductor restarted after a crash or power loss</b>\nLast activity: ${str(e.lastEvent)} at ${at(e.lastEventAt)}. Unfinished watering is resumed if still due.`,
        };
      case 'poll.failed':
        // Ordinary failures show up as connection.lost; only the watchdog (an unexpected hang) gets a message.
        return typeof e.error === 'string' && e.error.includes('did not finish')
          ? { severity: 'critical', text: `⏳ <b>Monitoring got stuck</b> and was restarted: ${str(e.error)}` }
          : undefined;
      case 'state.save_failed':
        return { severity: 'critical', text: `💾 <b>Can’t save state</b>: ${str(e.error)}\nCooldowns and pending cycles won’t survive a restart.` };
      default:
        return undefined;
    }
  }

  #time(iso: string): string {
    const d = new Date(iso);
    const tz = this.#options.timeZone;
    const fmt = new Intl.DateTimeFormat('en-US', {
      ...(tz ? { timeZone: tz } : {}),
      hourCycle: 'h23',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
    return fmt.format(d);
  }
}
