import type { ConductorStatus, HeldSequenceAction, PauseResult, ResumeResult, SequenceStatus } from '../conductor/monitor.ts';
import type { RunningWave } from '../conductor/sequencer.ts';
import { ask, confirm, done, passphraseStep, via, type Actor, type MutableCommand, type Step } from './conversation.ts';
import { duration, fitLines, parseDuration, safe, shortTime, where } from './format.ts';

/**
 * /pause and /resume. They only ever pause or resume the conductor's own supplemental watering
 * (Monitor.pause/resume); nothing here talks to B-hyve. Every path that changes something ends in a
 * passphrase step, and `begin` only reads.
 *
 *   /pause [4h]: nothing watering → passphrase → pause (until /resume, or for that long)
 *                watering in progress → "pause anyway?" yes → passphrase → pause
 *                already paused, with a time → "make it end at …" passphrase → new end
 *   /resume: nothing held → passphrase → resume
 *            held watering → continue / discard → passphrase → resume
 *            held watering, all too old to continue → "it will be cancelled; resume?" yes → passphrase → resume
 */

/** What the commands need from the conductor (Monitor implements it). */
export interface ConductorControl {
  status(): ConductorStatus;
  pause(by: string, opts?: { until?: Date }): Promise<PauseResult>;
  resume(by: string, held: HeldSequenceAction): Promise<ResumeResult>;
}

export interface ControlDeps {
  control: ConductorControl;
  timeZone?: string | undefined;
  now?: () => Date;
}

/** How long /pause <time> may be. */
export const PAUSE_LIMITS = { minMs: 5 * 60_000, maxMs: 30 * 86_400_000 };

export const buildControlCommands = ({ control, timeZone, now = () => new Date() }: ControlDeps): MutableCommand[] => {
  const at = (d: Date) => shortTime(d, timeZone);
  const sequenceLine = (q: SequenceStatus, now: Date) => {
    const due = q.dueAt.getTime() > now.getTime() ? `next cycle at ${at(q.dueAt)}` : `next cycle due since ${at(q.dueAt)}`;
    return `• ${where(q.zoneNames, q.deviceId)}: cycle ${q.nextCycle}/${q.cycles}, ${due}`;
  };
  const runningLine = (w: RunningWave) => `• 💧 ${where(w.zoneNames, w.deviceId)}: water on until ${at(w.until)} (cycle ${w.cycle}/${w.of})`;

  const pause: MutableCommand = {
    kind: 'mutable',
    name: 'pause',
    description: 'Pause automatic watering, until /resume or for a while (asks for the passphrase)',
    help: {
      usage: [
        { call: '/pause', does: 'stops supplemental watering until /resume' },
        { call: '/pause 4h', does: 'for 4 hours, then it resumes on its own (90m, 4h, 2d...: up to 30 days)' },
      ],
      details: [
        'While paused, /pause 4h changes when it ends. A pause with no end is reminded of daily.',
        'If watering is in progress, it asks you to confirm first (reply yes), then asks for the passphrase.',
        'Watering in progress is put on hold; water that is already on is not turned off (use the B-hyve app for that).',
        'Sensors are still read and alerts still sent. Your B-hyve schedule is not affected.',
        'It survives restarts.',
      ],
    },
    acceptsArgs: true,
    begin: (actor, args) => {
      let until: Date | undefined;
      if (args.trim() !== '') {
        const ms = parseDuration(args, PAUSE_LIMITS);
        if (typeof ms !== 'number') return done(`⚠️ ${safe(ms.problem)} For example: /pause, or /pause 4h.`);
        until = new Date(now().getTime() + ms);
      }
      const forHow = until ? ` for ${duration(until.getTime() - now().getTime())} (until ${at(until)})` : '';
      const s = control.status();
      if (s.paused) {
        const currently = `⏸️ Already paused since ${at(s.paused.since)} (by ${safe(s.paused.by)}), ${s.paused.until ? `until ${at(s.paused.until)}` : 'until /resume'}.`;
        if (!until) return done(`${currently} Send /resume to resume, or /pause 4h to make it end on its own.`);
        const end = until;
        return passphraseStep({
          intro: `${currently}\nMake it end at ${at(end)} instead?\n`,
          action: 'change when the pause ends',
          run: async () => formatPaused(await control.pause(via(actor), { until: end }), at),
        });
      }
      const pauseNow = (intro?: string): Step =>
        passphraseStep({
          ...(intro ? { intro } : {}),
          action: 'pause',
          run: async () => formatPaused(await control.pause(via(actor), until ? { until } : {}), at),
        });
      if (s.sequences.length === 0 && s.wateringNow.length === 0) {
        return pauseNow(`⏸️ Pause automatic watering${forHow}? Nothing is being watered right now.\n`);
      }
      return confirm({
        text: fitLines([
          '⚠️ <b>Watering in progress</b>',
          ...s.sequences.map((q) => sequenceLine(q, s.at)),
          ...s.wateringNow.map(runningLine),
          '',
          'Pausing holds the remaining cycles until /resume. Water that is already on is <b>not</b> turned off ' +
            '(use the B-hyve app to stop it now).',
          '',
          `Pause anyway${forHow}? Reply <b>yes</b> or <b>cancel</b>.`,
        ]),
        hint: 'Reply yes to pause, or cancel.',
        then: () => pauseNow(),
      });
    },
  };

  const resume: MutableCommand = {
    kind: 'mutable',
    name: 'resume',
    description: 'Resume automatic watering (asks for the passphrase)',
    help: {
      usage: [{ call: '/resume', does: 'turns supplemental watering back on' }],
      details: [
        'If watering is on hold, reply continue (carry on with it) or discard (cancel it); then the passphrase.',
        'Held watering that was due over an hour ago is too old to continue safely: it is cancelled.',
        'Either way the zones are checked against their sensors straight away.',
      ],
    },
    begin: (actor: Actor) => {
      const s = control.status();
      if (!s.paused) return done('▶️ Not paused: automatic watering is on. Nothing to resume.');
      const since = `Paused since ${at(s.paused.since)} by ${safe(s.paused.by)}${s.paused.until ? ` (it ends on its own at ${at(s.paused.until)})` : ''}.`;
      const resumeNow = (held: HeldSequenceAction, intro?: string): Step =>
        passphraseStep({ ...(intro ? { intro } : {}), action: 'resume', run: async () => formatResumed(await control.resume(via(actor), held)) });
      if (s.sequences.length === 0) return resumeNow('discard', `▶️ Resume automatic watering? ${since}\n`);

      const fresh = s.sequences.filter((q) => !q.stale);
      const staleLines = s.sequences
        .filter((q) => q.stale)
        .map((q) => `• ${where(q.zoneNames, q.deviceId)}: cycle ${q.nextCycle}/${q.cycles}, too late to continue; it will be cancelled`);
      if (fresh.length === 0) {
        return confirm({
          text: fitLines([
            since,
            '<b>Watering on hold</b>, paused too long ago to continue safely:',
            ...staleLines,
            'It will be cancelled, and the zones re-checked against their sensors.',
            '',
            'Resume? Reply <b>yes</b> or <b>cancel</b>.',
          ]),
          hint: 'Reply yes to resume, or cancel.',
          label: 'discard',
          then: () => resumeNow('discard'),
        });
      }
      return ask({
        text: fitLines([
          since,
          '<b>Watering on hold</b>:',
          ...fresh.map((q) => sequenceLine(q, s.at)),
          ...staleLines,
          '',
          'Reply:',
          '<b>continue</b>: continue the watering on hold, and resume',
          '<b>discard</b>: cancel the watering on hold, and resume (the zones are re-checked against their sensors)',
          '<b>cancel</b>: stay paused',
        ]),
        hint: 'Reply continue, discard or cancel.',
        choices: [
          { words: ['continue', '1'], label: 'continue', next: () => resumeNow('continue', '▶️ Resume and continue the watering on hold.\n') },
          { words: ['discard', '2'], label: 'discard', next: () => resumeNow('discard', '▶️ Resume and cancel the watering on hold.\n') },
        ],
      });
    },
  };

  return [pause, resume];
};

export const formatPaused = (r: PauseResult, at: (d: Date) => string): string => {
  const end = r.paused.until;
  if (r.updated && end) {
    return `⏸️ The pause now ends at ${at(end)}; then automatic watering resumes on its own (watering on hold is cancelled, and the zones re-checked).`;
  }
  if (!r.changed) return `⏸️ Already paused since ${at(r.paused.since)} (by ${safe(r.paused.by)}).`;
  const lines = [
    end
      ? `⏸️ <b>Paused</b> by ${safe(r.paused.by)} until ${at(end)}. No supplemental watering until then (or /resume).`
      : `⏸️ <b>Paused</b> by ${safe(r.paused.by)}. No supplemental watering until /resume.`,
    'Sensors are still read and alerts still sent; your B-hyve schedule runs as usual.',
    ...(end ? ['When the pause ends, watering on hold is cancelled and the zones are re-checked.'] : []),
  ];
  if (r.held.length > 0) {
    lines.push('', '<b>On hold</b> (/resume can continue or cancel it):');
    for (const q of r.held) lines.push(`• ${where(q.zoneNames, q.deviceId)}: cycle ${q.nextCycle}/${q.cycles}`);
  }
  if (r.wateringNow.length > 0) {
    lines.push('', '💧 <b>Still on</b> (not turned off; use the B-hyve app to stop it now):');
    for (const w of r.wateringNow) lines.push(`• ${where(w.zoneNames, w.deviceId)} until ${at(w.until)}`);
  }
  if (r.sendInProgress) lines.push('', '⚠️ A cycle was being sent at that moment and may still start. /status shows what is running.');
  return fitLines(lines);
};

export const formatResumed = (r: ResumeResult): string => {
  if (!r.changed) return '▶️ Not paused anymore: nothing to do.';
  const lines = [`▶️ <b>Resumed</b> after ${duration(r.pausedMinutes * 60_000)}. Automatic watering is on; the zones are being checked now.`];
  if (r.continued.length > 0) {
    lines.push('', '<b>Continued</b>:');
    for (const q of r.continued) lines.push(`• ${where(q.zoneNames, q.deviceId)}: cycle ${q.nextCycle}/${q.cycles}`);
  }
  if (r.discarded.length > 0) {
    lines.push('', '<b>Cancelled</b>:');
    for (const d of r.discarded) lines.push(`• ${where(d.sequence.zoneNames, d.sequence.deviceId)}: ${safe(d.reason)}`);
  }
  return fitLines(lines);
};
