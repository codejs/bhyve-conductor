import { describe, expect, it, vi } from 'vitest';
import type { AuditEvent, AuditType } from '../../audit/audit.ts';
import { buildAuditCommand, DEFAULT_QUERY, parseAuditQuery, type AuditSnapshot } from '../../bot/audit-command.ts';
import type { InputResult, Step } from '../../bot/conversation.ts';
import { MAX_REPLY_CHARS } from '../../bot/format.ts';

const NOW = new Date('2026-07-03T12:00:00Z');
const MIN = 60_000;
const HOUR = 60 * MIN;
const OWNER = { id: 4242, username: 'owner' };
const wellFormed = (html: string) => expect(html.replace(/<\/?(b|i|code)>/g, '')).not.toMatch(/[<>]/);

const ev = (agoMs: number, type: AuditType, data: Record<string, unknown> = {}): AuditEvent => ({
  ts: new Date(NOW.getTime() - agoMs).toISOString(),
  type,
  ...data,
});

/** A day of events (oldest first, as in the file). */
const DAY: AuditEvent[] = [
  ev(30 * HOUR, 'service.started', { mode: 'continuous', dryRun: false, zones: 2 }), // outside the default 24 h
  ev(20 * HOUR, 'connection.lost', { service: 'tuya', error: 'timed out after 20s' }),
  ev(19 * HOUR, 'connection.restored', { service: 'tuya', downSince: '', outageMinutes: 60, failures: 4, lastError: 'timed out after 20s' }),
  ev(6 * HOUR, 'sequence.started', { sequence: 's1', device: 'dev1', plannedMinutes: 20, waves: [[], []], soakMinutes: 30 }),
  ev(6 * HOUR - MIN, 'wave.sent', { sequence: 's1', device: 'dev1', cycle: 1, of: 2, attempt: 1, stations: [{ station: 1, runTime: 10 }] }),
  ev(5 * HOUR, 'sequence.completed', { sequence: 's1', device: 'dev1', deliveredMinutes: 20, cycles: 2 }),
  ev(2 * HOUR, 'command.handled', { command: 'status', user: 4242, outcome: 'ok', ms: 3 }),
  ev(HOUR, 'conductor.paused', { by: '@owner via Telegram', held: [] }),
  ev(10 * MIN, 'battery.low', { kind: 'sensor', name: 'Probe A', id: 's1', batteryPct: 15, thresholdPct: 20 }),
];

const setup = (events: AuditEvent[] = DAY, snapshot: Partial<AuditSnapshot> = {}, pageSize = 8) => {
  const read = vi.fn(async (): Promise<AuditSnapshot> => ({ events, skipped: 0, truncated: false, ...snapshot }));
  const command = buildAuditCommand({ read, timeZone: 'UTC', now: () => NOW, pageSize });
  return { read, command, begin: (args = '') => Promise.resolve(command.begin(OWNER, args)) };
};

const input = (step: Step) => {
  if (step.kind !== 'input') throw new Error(`expected an input step, got ${step.kind}: ${step.text}`);
  return step;
};
/** Answers the step; returns the next step, or the reason the answer was refused. */
const answer = async (step: Step, text: string): Promise<Step | string> => {
  const result: InputResult = await input(step).read(text);
  return 'next' in result ? result.next : result.invalid;
};
const next = async (step: Step, text: string): Promise<Step> => {
  const result = await answer(step, text);
  if (typeof result === 'string') throw new Error(`refused "${text}": ${result}`);
  return result;
};

describe('parseAuditQuery', () => {
  it.each([
    ['problems', { view: 'problems', period: '24h', periodMs: 24 * HOUR }],
    ['7d', { view: 'all', period: '7d', periodMs: 7 * 24 * HOUR }],
    ['summary 7d', { view: 'summary', period: '7d', periodMs: 7 * 24 * HOUR }],
    ['48h WATERING', { view: 'watering', period: '48h', periodMs: 48 * HOUR }],
    ['  commands  ', { view: 'commands', period: '24h', periodMs: 24 * HOUR }],
    ['90m', { view: 'all', period: '90m', periodMs: 90 * MIN }],
    ['30min', { view: 'all', period: '30m', periodMs: 30 * MIN }],
    ['2w', { view: 'all', period: '2w', periodMs: 14 * 24 * HOUR }],
    ['90d', { view: 'all', period: '90d', periodMs: 90 * 24 * HOUR }],
  ])('%j', (text, expected) => {
    expect(parseAuditQuery(text)).toEqual(expected);
  });

  it('keeps what is not given from the current query', () => {
    expect(parseAuditQuery('7d', { view: 'problems', period: '24h', periodMs: 24 * HOUR })).toEqual({ view: 'problems', period: '7d', periodMs: 7 * 24 * HOUR });
    expect(parseAuditQuery('summary', { view: 'all', period: '7d', periodMs: 7 * 24 * HOUR })).toMatchObject({ view: 'summary', period: '7d' });
  });

  it.each([
    ['', 'Give a view and/or a period'],
    ['problems 7d extra', 'Give a view and/or a period'],
    ['problems watering', 'Give only one view.'],
    ['7d 48h', 'Give only one period.'],
    ['0h', 'between 1 min and 90 days'],
    ['91d', 'between 1 min and 90 days'],
    ['13w', 'between 1 min and 90 days'],
    ['99999d', 'is neither a view'],
    ['7 d', 'is neither a view'],
    ['2026-07-01', 'is neither a view'], // no dates: only short relative periods
    ['-7d', 'is neither a view'],
    ['1.5d', 'is neither a view'],
    ['<b>', 'is neither a view'],
  ])('refuses %j', (text, problem) => {
    const result = parseAuditQuery(text);
    expect(result).toEqual({ problem: expect.stringContaining(problem) });
  });

  it('does not echo a long word back in full', () => {
    const result = parseAuditQuery('x'.repeat(200));
    expect('problem' in result && result.problem.length).toBeLessThan(120);
  });

  it('defaults to everything in the last 24 h', () => {
    expect(DEFAULT_QUERY).toEqual({ view: 'all', period: '24h', periodMs: 24 * HOUR });
  });
});

describe('/audit', () => {
  it('is a read-only, interactive command that accepts a view and period', () => {
    const { command } = setup();
    expect(command).toMatchObject({ kind: 'interactive', name: 'audit', acceptsArgs: true });
  });

  it('shows the last 24 h, newest first, grouped by day, with how to move on', async () => {
    const t = setup();
    const step = input(await t.begin());

    expect(step.text).toBe(
      [
        '📜 <b>Audit</b> · everything · last 24 h',
        '8 event(s), newest first · page 1/1',
        '',
        '<b>Fri, Jul 3</b>',
        '11:50 🔋 <b>battery low</b>',
        'LOW BATTERY sensor Probe A (s1): 15% (≤ 20%)',
        '11:00 ⏯️ conductor paused',
        'conductor PAUSED by @owner via Telegram',
        '10:00 🤖 command handled',
        'telegram command /status from user 4242: ok in 3 ms',
        '07:00 💧 sequence completed',
        'watering completed dev1 [seq s1]: 20 min in 2 cycle(s)',
        '06:01 💦 wave sent',
        'sent dev1 [seq s1] cycle 1/2 (attempt 1): st1 10min',
        '06:00 💧 sequence started',
        'watering started dev1 [seq s1]: 20 min in 2 cycle(s), 30 min soak',
        '',
        '<b>Thu, Jul 2</b>',
        '17:00 🔌 <b>connection restored</b>',
        'tuya reachable again after 60 min (4 failed attempts; last error: timed out after 20s)',
        '16:00 🔌 <b>connection lost</b>',
        'tuya unreachable: timed out after 20s',
        '',
        "(that's everything for the last 24 h)",
        '',
        'Views: <b>problems</b> · <b>watering</b> · <b>commands</b> · <b>summary</b> · <b>all</b> · period e.g. <b>7d</b> · <b>done</b>',
      ].join('\n'),
    );
    expect(step.hint).toMatch(/^Reply more, back, a page number/);
    expect(t.read).toHaveBeenCalledOnce();
  });

  it('pages through the events: more, back, a page number', async () => {
    const t = setup(DAY, {}, 3);
    const page1 = input(await t.begin());
    expect(page1.text).toContain('8 event(s), newest first · page 1/3');
    expect(page1.text).toContain('➡️ <b>more</b> older · <b>back</b> newer · <b>2</b> a page');
    expect(page1.text).toContain('battery low');
    expect(page1.text).not.toContain('sequence completed');

    const page2 = await next(page1, 'more');
    expect(page2.text).toContain('page 2/3');
    expect(page2.text).toContain('sequence completed');
    expect(page2.text).toContain('<b>Fri, Jul 3</b>'); // every page starts with its day

    const page3 = await next(page2, 'next');
    expect(page3.text).toContain('page 3/3');
    expect(page3.text).toContain("(that's everything for the last 24 h)");
    expect(await answer(page3, 'more')).toBe('That was the oldest page.');

    expect((await next(page3, 'back')).text).toContain('page 2/3');
    expect((await next(page3, 'prev')).text).toContain('page 2/3');
    expect((await next(page3, '1')).text).toContain('page 1/3');
    expect(await answer(page1, 'back')).toBe('That was the newest page.');
    expect(await answer(page1, '4')).toBe('There are 3 pages.');
    expect(await answer(page1, '0')).toBe('There are 3 pages.');
    expect(t.read).toHaveBeenCalledOnce(); // pages come from one snapshot
  });

  it.each([
    ['problems', ['battery low', 'connection restored', 'connection lost'], ['sequence started', 'command handled']],
    ['watering', ['sequence started', 'wave sent', 'sequence completed'], ['battery low', 'connection lost']],
    ['commands', ['command handled', 'conductor paused'], ['sequence started', 'battery low']],
  ])('shows the %s view', async (view, shown, hidden) => {
    const t = setup();
    const step = await next(await t.begin(), view);
    for (const s of shown) expect(step.text).toContain(s);
    for (const h of hidden) expect(step.text).not.toContain(h);
  });

  it('starts from the view and period given with the command', async () => {
    const t = setup();
    const step = input(await t.begin('problems 48h'));
    expect(step.text.split('\n')[0]).toBe('📜 <b>Audit</b> · problems and recoveries · last 2 days');
  });

  it('widens the period on request', async () => {
    const t = setup();
    const step = await next(await t.begin(), '7d');
    expect(step.text).toContain('📜 <b>Audit</b> · everything · last 7 days\n9 event(s), newest first · page 1/2');
    expect((await next(step, 'more')).text).toContain('service started');
  });

  it('goes back to the first page when the view changes', async () => {
    const t = setup(DAY, {}, 2);
    const page2 = await next(input(await t.begin()), 'more');
    const problems = await next(page2, 'problems');
    expect(problems.text).toContain('page 1/2');
  });

  it('shows a summary of outages, watering and crashes', async () => {
    const events = [
      ...DAY,
      ev(4 * HOUR, 'sequence.started', { sequence: 's2', device: 'dev2', plannedMinutes: 30 }),
      ev(3 * HOUR, 'sequence.abandoned', { sequence: 's2', device: 'dev2', deliveredMinutes: 10, plannedMinutes: 30, reason: 'the device was switched off' }),
      ev(2 * HOUR, 'connection.lost', { service: 'bhyve', error: 'HTTP 502' }),
      ev(HOUR, 'service.unclean_shutdown', { lastEvent: 'wave.sent' }),
    ];
    const t = setup(events);
    const step = await next(input(await t.begin()), 'summary');

    expect(step.text).toBe(
      [
        '📊 <b>Audit summary</b> · last 24 h',
        '',
        '<b>Connection outages</b> (2)',
        '🔴 tuya · Thu, Jul 2 16:00 → Thu, Jul 2 17:00 · 60 min, 4 failed attempt(s)',
        '   timed out after 20s',
        '🔴 bhyve · Fri, Jul 3 10:00 → <b>ongoing</b>',
        '   HTTP 502',
        '',
        '<b>Watering</b> (2)',
        '🛑 Fri, Jul 3 08:00 · dev2 · 10/30 min',
        '   the device was switched off',
        '✅ Fri, Jul 3 06:00 · dev1 · 20/20 min',
        '',
        '💥 Unclean shutdowns (crash, kill, power loss): 1',
        '',
        'Views: <b>problems</b> · <b>watering</b> · <b>commands</b> · <b>summary</b> · <b>all</b> · period e.g. <b>7d</b> · <b>done</b>',
      ].join('\n'),
    );
    expect(await answer(step, 'more')).toBe('The summary has only one page.');
    expect(await answer(step, '2')).toBe('There is 1 page.');
    expect((await next(step, 'all')).text).toContain('📜 <b>Audit</b> · everything');
  });

  it('summarises an empty period', async () => {
    const t = setup([]);
    const step = input(await t.begin('summary'));
    expect(step.text).toContain('<b>Connection outages</b> (0)\nnone');
    expect(step.text).toContain('<b>Watering</b> (0)\nnone');
  });

  it('says when nothing was recorded', async () => {
    const t = setup([]);
    const step = input(await t.begin());
    expect(step.text).toContain('📜 <b>Audit</b> · everything · last 24 h\nNothing recorded.');
    expect(step.text).not.toContain('more</b> older');
  });

  it('closes on done', async () => {
    const t = setup();
    expect(await next(input(await t.begin()), 'DONE')).toEqual({ kind: 'done', text: '👋 /audit closed.' });
  });

  it('refuses anything else, saying why', async () => {
    const t = setup();
    const step = input(await t.begin());
    expect(await answer(step, 'yesterday')).toMatch(/^"yesterday" is neither a view/);
    expect(await answer(step, 'problems watering')).toBe('Give only one view.');
  });

  it('answers bad arguments without reading the audit trail', async () => {
    const t = setup();
    const step = await t.begin('last week');
    expect(step).toEqual({
      kind: 'done',
      text: '⚠️ "last" is neither a view (all, problems, watering, commands, summary) nor a period like 7d.\nFor example: /audit, /audit problems, /audit summary 7d.',
    });
    expect(await t.begin('a b c')).toMatchObject({ kind: 'done', text: expect.stringMatching(/^⚠️ Give a view and\/or a period/) });
    expect(t.read).not.toHaveBeenCalled();
  });

  it('says when older events were not read (large file)', async () => {
    const t = setup(DAY.slice(4), { truncated: true });
    expect(input(await t.begin()).text).toContain('⚠️ The audit file is large: only its newest part was read.');
  });

  it('does not mention it when everything asked for was read anyway', async () => {
    const t = setup(DAY, { truncated: true }); // the oldest event read is older than 24 h
    expect(input(await t.begin()).text).not.toContain('The audit file is large');
  });

  it('mentions unreadable lines', async () => {
    const t = setup(DAY, { skipped: 2 });
    expect(input(await t.begin()).text).toContain('(2 unreadable line(s) skipped)');
  });

  it('keeps every page within one message, however long the events', async () => {
    // Long descriptions are clipped, so the number goes first.
    const events = Array.from({ length: 60 }, (_, i) => ev((60 - i) * MIN, 'poll.failed', { error: `#${i} ${'x'.repeat(500)}` }));
    const t = setup(events, {}, 8);
    let step: Step = await t.begin();
    const seen = new Set<string>();
    for (;;) {
      expect(step.text.length).toBeLessThanOrEqual(MAX_REPLY_CHARS);
      for (const m of step.text.matchAll(/^poll failed: #(\d+) x/gm)) seen.add(m[1] ?? '');
      const more = await answer(step, 'more');
      if (typeof more === 'string') break;
      step = more;
    }
    expect(seen.size).toBe(60); // nothing lost between pages
  });

  it('keeps pages within one message even when escaping makes events much longer (e.g. "<" → "&lt;")', async () => {
    // Descriptions are clipped to 300 characters before escaping: 300 "<" become 1200 characters.
    const events = Array.from({ length: 40 }, (_, i) => ev((40 - i) * MIN, 'poll.failed', { error: `#${i} ${'<'.repeat(400)}` }));
    const t = setup(events, {}, 8);
    let step: Step = await t.begin();
    const seen = new Set<string>();
    let pages = 0;
    for (;;) {
      pages++;
      expect(step.text.length).toBeLessThanOrEqual(MAX_REPLY_CHARS);
      expect(step.text).not.toContain('more line(s) not shown'); // nothing cut off the end of a page
      for (const m of step.text.matchAll(/^poll failed: #(\d+) &lt;/gm)) seen.add(m[1] ?? '');
      const more = await answer(step, 'more');
      if (typeof more === 'string') break;
      step = more;
    }
    expect(seen.size).toBe(40);
    expect(pages).toBeGreaterThan(5); // fewer than 8 events fit on a page
  });

  it('escapes whatever is in the audit file (it can hold what strangers sent)', async () => {
    const evil = '<b>x</b> & <script>';
    const events = [
      ev(MIN, 'command.rejected', { reason: 'other-chat', chat: 1, user: 2, userName: evil, command: evil }),
      ev(2 * MIN, 'notification.failed', { error: evil, attempts: 1, message: evil }),
      ev(3 * MIN, '<i>weird</i>' as AuditType, { x: evil }),
      ev(4 * MIN, 'connection.lost', { service: evil, error: evil }),
      { ts: 'not a date', type: 'poll.failed', error: evil } as AuditEvent,
    ];
    const t = setup(events);
    const all = input(await t.begin('7d'));
    wellFormed(all.text);
    wellFormed((await next(all, 'summary')).text);
  });
});
