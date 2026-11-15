import type { OutageRow, SequenceRow } from '../audit/report.ts';
import type { AuditEvent, AuditType } from '../audit/types.ts';

/**
 * What the web API (`npm run web`) answers, as plain JSON. No Node imports, so the web app can use the same
 * types. Times are ISO 8601 strings in UTC; simulated times are virtual (the simulated summer day).
 */

export type { AuditEvent, AuditType, OutageRow, SequenceRow };

/** A simulation stored with `npm run simulate -- --store`. */
export interface SimulationDto {
  /** The scenario id (src/sim/scenarios.ts); one stored result per scenario. */
  scenario: string;
  title: string;
  /** When the result was stored (real time). */
  storedAt: string;
  /** When the simulated day started (virtual time) and how many hours it ran. */
  startedAt: string;
  hours: number;
  /** The time zone of the simulated garden, for showing its times. */
  timeZone: string;
  events: number;
  /** Events that show something went wrong or how it was recovered (the `!` of `npm run audit`). */
  recoveryEvents: number;
  notifications: number;
  /** What happens in the scenario and what to look for; null/empty when this version no longer has it. */
  story: string | null;
  lookFor: string[];
}

export interface SimulationListResponse {
  simulations: SimulationDto[];
  /** False when the database predates stored simulations (the conductor upgrades it at its next start). */
  available: boolean;
}

export interface SimulationResponse {
  simulation: SimulationDto;
}

export interface EventsResponse {
  scenario: string;
  timeZone: string;
  /** The matching events, in the order they were recorded: `{ ts, type, ...data }`, as `npm run audit -- --json`. */
  events: AuditEvent[];
  /** All events of the simulation, before filtering. */
  total: number;
}

export interface SummaryResponse {
  scenario: string;
  timeZone: string;
  /** Outages and the fate of each watering sequence, from every event in the time window. */
  summary: { outages: OutageRow[]; sequences: SequenceRow[]; uncleanShutdowns: number };
}

export interface NotificationDto {
  severity: 'info' | 'warning' | 'critical';
  /** The audit event it was about. */
  type: AuditType;
  /** Telegram HTML: show it as text or sanitize it, never insert it as markup. */
  text: string;
  /** When the event happened, and when the message would have been sent. */
  ts: string;
  sentAt: string;
}

export interface NotificationsResponse {
  scenario: string;
  timeZone: string;
  notifications: NotificationDto[];
}

/** Every error: a short message, and for a bad request which parameter and why. */
export interface ErrorResponse {
  error: string;
  issues?: { parameter: string; message: string }[];
}
