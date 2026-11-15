import type { AuditEvent } from '../audit/audit.ts';
import { describe, filterEvents, RECOVERY_TYPES, summarize, type AuditFilter } from '../audit/report.ts';
import { done, type InputResult, type InteractiveCommand, type Step } from './conversation.ts';
import { duration, fitLines, isDuration, parseDuration, safe } from './format.ts';

/**
 * /audit: the audit trail (like `npm run audit`), made for a phone. Newest first, grouped by day, a page
 * at a time; the reply moves through it ("more", "back", a page number) or changes what's shown (a view
 * such as "problems", or a period such as "7d"). `/audit problems 7d` starts there directly.
 *
 * Read-only. It reads only the end of the audit file (the file grows forever) once per /audit, and pages
 * through that snapshot, so the pages don't shift while new events are written.
 */

export interface AuditSnapshot {
  events: AuditEvent[];
  /** Unreadable lines (e.g. one being written right now). */
  skipped: number;
  /** Only the end of the file was read: older events exist. */
  truncated: boolean;
}

export interface AuditCommandDeps {
  /** Reads (the end of) the audit trail. */
  read: () => Promise<AuditSnapshot>;
  timeZone?: string | undefined;
  now?: () => Date;
  /** Most events per page. Pages are also kept short enough for one message. */
  pageSize?: number;
}

export type AuditView = 'all' | 'problems' | 'watering' | 'commands' | 'summary';

const VIEWS: Record<AuditView, { label: string; filter: Partial<AuditFilter> }> = {
  all: { label: 'everything', filter: {} },
  problems: { label: 'problems and recoveries', filter: { recovery: true } },
  watering: { label: 'watering', filter: { types: ['sequence', 'wave'] } },
  commands: { label: 'commands and changes', filter: { types: ['command', 'conductor', 'config'] } },
  summary: { label: 'summary', filter: {} },
};

const DAY_MS = 86_400_000;
/** The longest period that can be asked for. */
export const MAX_PERIOD_MS = 90 * DAY_MS;
/** Characters of events per page (plus a header and footer), well within one Telegram message. */
const PAGE_CHARS = 2_800;

export interface AuditQuery {
  view: AuditView;
  /** e.g. "24h" */
  period: string;
  periodMs: number;
}

export const DEFAULT_QUERY: AuditQuery = { view: 'all', period: '24h', periodMs: DAY_MS };

/**
 * Reads "problems 7d" (a view and/or a period, in any order) on top of `base`. Returns a problem for
 * anything else. Only short relative periods are accepted (no dates, nothing beyond MAX_PERIOD_MS).
 */
export const parseAuditQuery = (text: string, base: AuditQuery = DEFAULT_QUERY): AuditQuery | { problem: string } => {
  const words = text.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0 || words.length > 2) return { problem: 'Give a view and/or a period, e.g. "problems 7d".' };
  let view: AuditView | undefined;
  let period: { text: string; ms: number } | undefined;
  for (const word of words) {
    if (word in VIEWS) {
      if (view) return { problem: 'Give only one view.' };
      view = word as AuditView;
      continue;
    }
    if (isDuration(word)) {
      if (period) return { problem: 'Give only one period.' };
      const ms = parseDuration(word, { minMs: 60_000, maxMs: MAX_PERIOD_MS });
      if (typeof ms !== 'number') return { problem: 'The period must be between 1 min and 90 days, e.g. 48h or 7d.' };
      period = { text: word.replace(/min$/, 'm'), ms };
      continue;
    }
    // Never repeat what was typed (it could be something that shouldn't be in the chat twice).
    return { problem: 'That is neither a view (all, problems, watering, commands, summary) nor a period like 7d.' };
  }
  return { view: view ?? base.view, period: period?.text ?? base.period, periodMs: period?.ms ?? base.periodMs };
};

const EMOJI: Record<string, string> = {
  service: '🔄',
  poll: '⚠️',
  connection: '🔌',
  socket: '🔌',
  zone: '🌱',
  sequence: '💧',
  wave: '💦',
  state: '💾',
  battery: '🔋',
  moisture: '🌡️',
  device: '📟',
  notification: '📨',
  command: '🤖',
  conductor: '⏯️',
  config: '⚙️',
  simulation: '🎬',
};

const HINT = 'Reply more, back, a page number, a view (problems, watering, commands, summary, all), a period like 7d, or done.';
const PAGING = '➡️ <b>more</b> older · <b>back</b> newer · <b>2</b> a page';
const VIEWS_LINE = 'Views: <b>problems</b> · <b>watering</b> · <b>commands</b> · <b>summary</b> · <b>all</b> · period e.g. <b>7d</b> · <b>done</b>';

export const buildAuditCommand = (deps: AuditCommandDeps): InteractiveCommand => {
  const now = deps.now ?? (() => new Date());
  const pageSize = deps.pageSize ?? 8;
  const tz = deps.timeZone;
  const dayFmt = new Intl.DateTimeFormat('en-US', { ...(tz ? { timeZone: tz } : {}), weekday: 'short', month: 'short', day: 'numeric' });
  const timeFmt = new Intl.DateTimeFormat('en-US', { ...(tz ? { timeZone: tz } : {}), hourCycle: 'h23', hour: '2-digit', minute: '2-digit' });

  /** One event: "14:05 💧 watering started" and what happened, on the next line. */
  const render = (e: AuditEvent): string => {
    const t = new Date(e.ts);
    const time = Number.isNaN(t.getTime()) ? '?' : timeFmt.format(t);
    const emoji = EMOJI[e.type.split('.')[0] ?? ''] ?? '•';
    const label = safe(e.type.replace(/[._]/g, ' '), 40);
    const title = RECOVERY_TYPES.has(e.type) ? `<b>${label}</b>` : label;
    return `${time} ${emoji} ${title}\n${safe(describe(e, tz), 300)}`;
  };
  const dayOf = (e: AuditEvent): string => {
    const t = new Date(e.ts);
    return Number.isNaN(t.getTime()) ? '?' : dayFmt.format(t);
  };

  /** Splits events (newest first) into pages by count and length. */
  const paginate = (events: readonly AuditEvent[], rendered: (e: AuditEvent) => string): AuditEvent[][] => {
    const pages: AuditEvent[][] = [];
    let page: AuditEvent[] = [];
    let chars = 0;
    for (const e of events) {
      const size = rendered(e).length + 20;
      if (page.length > 0 && (page.length >= pageSize || chars + size > PAGE_CHARS)) {
        pages.push(page);
        page = [];
        chars = 0;
      }
      page.push(e);
      chars += size;
    }
    if (page.length > 0) pages.push(page);
    return pages;
  };

  return {
    kind: 'interactive',
    name: 'audit',
    description: 'What happened: the audit trail, a page at a time (e.g. /audit problems 7d)',
    help: {
      usage: [
        { call: '/audit', does: 'everything from the last 24 h, newest first' },
        { call: '/audit problems', does: 'only failures and recoveries' },
        { call: '/audit watering 7d', does: 'watering of the last 7 days' },
        { call: '/audit summary 7d', does: 'outages, each watering and its outcome, crashes' },
      ],
      details: [
        'Views: all, problems, watering, commands, summary. Periods: e.g. 90m, 48h, 7d, 2w (up to 90 days).',
        'Then reply more (older), back (newer), a page number, another view or period, or done.',
      ],
    },
    acceptsArgs: true,
    begin: async (_actor, args) => {
      const query = args.trim() === '' ? DEFAULT_QUERY : parseAuditQuery(args);
      if ('problem' in query) return done(`⚠️ ${safe(query.problem)}\nFor example: /audit, /audit problems, /audit summary 7d.`);
      const snapshot = await deps.read();
      const at = now();
      // Each answer shows a page of one of a few queries: work each query out once, not on every page.
      const rendered = new WeakMap<AuditEvent, string>();
      const renderOnce = (e: AuditEvent): string => {
        let html = rendered.get(e);
        if (html === undefined) rendered.set(e, (html = render(e)));
        return html;
      };
      const cache = new Map<string, { selected: AuditEvent[]; pages: AuditEvent[][] }>();
      const select = (q: AuditQuery, since: Date) => {
        const key = `${q.view}:${q.periodMs}`;
        let hit = cache.get(key);
        if (!hit) {
          const selected = filterEvents(snapshot.events, { since, ...VIEWS[q.view].filter });
          hit = { selected, pages: q.view === 'summary' ? [] : paginate([...selected].reverse(), renderOnce) };
          cache.set(key, hit);
        }
        return hit;
      };

      const show = (q: AuditQuery, pageIndex = 0): Step => {
        const since = new Date(at.getTime() - q.periodMs);
        const { selected, pages: all } = select(q, since);
        const notes: string[] = [];
        const earliest = snapshot.events[0];
        if (snapshot.truncated && earliest && new Date(earliest.ts).getTime() > since.getTime()) {
          notes.push('⚠️ The audit file is large: only its newest part was read. `npm run audit` on the machine shows everything.');
        }
        if (snapshot.skipped > 0) notes.push(`(${snapshot.skipped} unreadable line(s) skipped)`);
        const period = `last ${duration(q.periodMs)}`;

        let body: string;
        let pages = 1;
        if (q.view === 'summary') {
          body = summaryText(summarize(selected), period, (iso) => {
            const d = new Date(iso);
            return Number.isNaN(d.getTime()) ? '?' : `${dayFmt.format(d)} ${timeFmt.format(d)}`;
          });
        } else if (selected.length === 0) {
          body = `📜 <b>Audit</b> · ${VIEWS[q.view].label} · ${period}\nNothing recorded.`;
        } else {
          pages = all.length;
          const index = Math.min(pageIndex, pages - 1);
          const lines = [
            `📜 <b>Audit</b> · ${VIEWS[q.view].label} · ${period}`,
            `${selected.length} event(s), newest first · page ${index + 1}/${pages}`,
          ];
          let day = '';
          for (const e of all[index] ?? []) {
            const d = dayOf(e);
            if (d !== day) {
              lines.push('', `<b>${safe(d)}</b>`);
              day = d;
            }
            lines.push(renderOnce(e));
          }
          if (index === pages - 1) lines.push('', `(that's everything for the ${period})`);
          body = lines.join('\n');
        }
        const text = [body, ...(notes.length > 0 ? ['', ...notes] : []), '', ...(pages > 1 ? [PAGING] : []), VIEWS_LINE].join('\n');

        const read = (answer: string): InputResult => {
          const word = answer.trim().toLowerCase();
          if (word === 'done') return { next: done('👋 /audit closed.') };
          if (word === 'more' || word === 'next') {
            if (q.view === 'summary') return { invalid: 'The summary has only one page.' };
            if (pageIndex + 1 >= pages) return { invalid: 'That was the oldest page.' };
            return { next: show(q, pageIndex + 1) };
          }
          if (word === 'back' || word === 'prev') {
            if (pageIndex === 0) return { invalid: 'That was the newest page.' };
            return { next: show(q, pageIndex - 1) };
          }
          if (/^\d{1,4}$/.test(word)) {
            const n = Number(word);
            if (q.view === 'summary' || n < 1 || n > pages) return { invalid: `There ${pages === 1 ? 'is 1 page' : `are ${pages} pages`}.` };
            return { next: show(q, n - 1) };
          }
          const next = parseAuditQuery(answer, q);
          if ('problem' in next) return { invalid: next.problem };
          return { next: show(next) };
        };
        return { kind: 'input', text: fitLines(text.split('\n')), hint: HINT, placeholder: 'more, back, done…', read };
      };
      return show(query);
    },
  };
};

/** The summary (outages, watering sequences, crashes) for a phone. */
const summaryText = (s: ReturnType<typeof summarize>, period: string, when: (iso: string) => string): string => {
  const lines = [`📊 <b>Audit summary</b> · ${period}`, '', `<b>Connection outages</b> (${s.outages.length})`];
  if (s.outages.length === 0) lines.push('none');
  for (const o of s.outages) {
    const span = o.to ? `${when(o.from)} → ${when(o.to)} · ${String(o.minutes)} min, ${String(o.failures)} failed attempt(s)` : `${when(o.from)} → <b>ongoing</b>`;
    lines.push(`🔴 ${safe(o.service, 40)} · ${span}`, `   ${safe(o.lastError, 150)}`);
  }
  lines.push('', `<b>Watering</b> (${s.sequences.length})`);
  if (s.sequences.length === 0) lines.push('none');
  const icon: Record<string, string> = { completed: '✅', abandoned: '🛑', 'in progress': '💧', resumed: '🔁' };
  // Newest first: the most relevant on top if the list is cut short.
  for (const q of [...s.sequences].reverse()) {
    const flags = [
      q.resumed ? 'resumed after restart' : '',
      q.retries ? `${q.retries} retries` : '',
      q.unconfirmed ? `${q.unconfirmed} unconfirmed` : '',
      q.assumed ? `${q.assumed} assumed` : '',
    ].filter(Boolean);
    lines.push(
      `${icon[q.status] ?? '•'} ${q.started === '?' ? '?' : when(q.started)} · ${safe(q.device, 40)} · ${q.deliveredMinutes ?? '?'}/${q.plannedMinutes ?? '?'} min` +
        (flags.length > 0 ? ` · ${flags.join(', ')}` : '') +
        (q.note ? `\n   ${safe(q.note, 150)}` : ''),
    );
  }
  if (s.uncleanShutdowns > 0) lines.push('', `💥 Unclean shutdowns (crash, kill, power loss): ${s.uncleanShutdowns}`);
  return fitLines(lines, 3_000);
};
