import type { ConfigCheck, ConfigEditor, RuleChange, RuleChanges, ZoneSettings } from '../conductor/config-editor.ts';
import { zoneRuleProblem, type EditableZoneRule } from '../conductor/config.ts';
import { ask, done, passphraseStep, via, type Actor, type InputResult, type MutableCommand, type Step } from './conversation.ts';
import { duration, fitLines, safe } from './format.ts';
import { pickZone } from './zones.ts';

/**
 * /config: change a zone's watering settings. Shows them, goes through them one at a time (a new value,
 * "next" to keep it, "back", "done" to skip the rest; "cancel" any time), then shows what would change,
 * including the settings that follow from it, and asks for the passphrase. Nothing is saved before that;
 * then ConfigEditor checks everything again, saves conductor.json and switches the conductor over.
 */

export interface ConfigCommandDeps {
  editor: Pick<ConfigEditor, 'zones' | 'preview' | 'apply'>;
}

interface Field {
  key: EditableZoneRule;
  unit: '%' | 'min';
  what: string;
  /** As the config file accepts it (zoneRuleProblem has the final say). */
  range: string;
  /** Does a higher value mean more water? (undefined: neither) */
  moreWater?: 'up' | 'down';
}

export const FIELDS: readonly Field[] = [
  { key: 'thresholdPct', unit: '%', what: 'Water when the soil is below this.', range: '0 to 100', moreWater: 'up' },
  { key: 'targetPct', unit: '%', what: 'Refill level: watering never goes above it.', range: '0 to 100', moreWater: 'up' },
  { key: 'runMinutes', unit: 'min', what: 'Length of a run (when no forecast is used).', range: 'above 0, up to 240', moreWater: 'up' },
  { key: 'maxMinutesPerDay', unit: 'min', what: 'Most watering in any 24 hours.', range: 'above 0, up to 1440', moreWater: 'up' },
  { key: 'cooldownMinutes', unit: 'min', what: 'Least time between two runs.', range: '0 to 10080', moreWater: 'down' },
  { key: 'maxCycleMinutes', unit: 'min', what: 'Longest single run; longer ones are split into cycles.', range: 'above 0, up to 240' },
  { key: 'soakMinutes', unit: 'min', what: 'Pause between cycles, for the water to soak in.', range: '0 to 240' },
];

const DERIVED_UNITS: Record<string, '%' | 'min'> = { criticalLowPct: '%', criticalHighPct: '%' };

const VALUE = /^(\d{1,5}(?:\.\d)?)\s*(%|m|min|mins|minutes?|h|hours?)?$/;

/** "28", "28%", "12 min", "4h" (= 240 min) → a number, or why not. Never echoes the input back. */
export const parseSetting = (text: string, field: Field): number | { problem: string } => {
  const m = VALUE.exec(text.trim().toLowerCase());
  const expected = `${field.key} must be a number ${field.range}${field.unit === '%' ? ' (%)' : ' (minutes, or hours like 4h)'}, with at most one decimal.`;
  if (!m?.[1]) return { problem: expected };
  const unit = m[2];
  let value = Number(m[1]);
  if (unit === '%' && field.unit !== '%') return { problem: expected };
  if (unit && unit !== '%' && field.unit !== 'min') return { problem: expected };
  if (unit?.startsWith('h')) value = Math.round(value * 60 * 10) / 10;
  const problem = zoneRuleProblem(field.key, value);
  return problem ? { problem: expected } : value;
};

const show = (value: number, unit: '%' | 'min'): string =>
  unit === '%' ? `${value}%` : value >= 90 ? `${value} min (${duration(value * 60_000)})` : `${value} min`;

const unitOf = (key: string): '%' | 'min' => FIELDS.find((f) => f.key === key)?.unit ?? DERIVED_UNITS[key] ?? 'min';

export const formatChange = (c: RuleChange): string =>
  `• ${c.key}: ${show(c.from, unitOf(c.key))} → <b>${show(c.to, unitOf(c.key))}</b>${c.derived ? ' <i>(follows from your changes)</i>' : ''}`;

/** Changes that mean more water, for a warning. */
const moreWater = (changes: readonly RuleChange[]): string[] =>
  changes
    .filter((c) => {
      const f = FIELDS.find((x) => x.key === c.key);
      return (f?.moreWater === 'up' && c.to > c.from) || (f?.moreWater === 'down' && c.to < c.from);
    })
    .map((c) => c.key);

export const buildConfigCommand = ({ editor }: ConfigCommandDeps): MutableCommand => ({
  kind: 'mutable',
  name: 'config',
  description: "Change a zone's watering settings (asks for the passphrase)",
  help: {
    usage: [{ call: '/config', does: "changes a zone's watering settings, one at a time" }],
    details: [
      `Settings: ${FIELDS.map((f) => f.key).join(', ')}.`,
      'With several zones it first asks which one (reply its number).',
      'For each setting reply a new value (e.g. 28, 12 min, 4h), next to keep it, back, or done to skip the rest.',
      'Then it shows every change, including settings that follow from them, and asks for the passphrase.',
      'Saved to conductor.json (the old one is kept as conductor.json.bak); used from the next poll.',
    ],
  },
  begin: (actor) => pickZone(editor.zones(), { title: '⚙️ <b>Which zone?</b>', then: (zone) => walk(editor, actor, zone) }),
});

/** Goes through the settings of one zone, then to the summary. */
const walk = (editor: ConfigCommandDeps['editor'], actor: Actor, zone: ZoneSettings): Step => {
  /** New values entered so far (only those that differ from the ones in use). */
  const pending: RuleChanges = {};
  const valueOf = (key: EditableZoneRule): number => pending[key] ?? zone.values[key];

  const current = [
    `⚙️ <b>${safe(zone.name)}</b>: settings in use`,
    ...FIELDS.map((f) => `• ${f.key}: ${show(zone.values[f.key], f.unit)}`),
    '',
    'For each one, reply a new value, <b>next</b> to keep it, <b>back</b>, <b>done</b> to finish, or <b>cancel</b>.',
  ].join('\n') + '\n\n';

  /** The setting at `i`, or the summary after the last one. */
  const goTo = (i: number): InputResult | Promise<InputResult> => (i < FIELDS.length ? { next: field(i) } : summary().then((next) => ({ next })));

  const field = (i: number, intro = ''): Step => {
    const f = FIELDS[i] ?? FIELDS[0];
    if (!f) return done('Nothing to change.');
    const changed = pending[f.key] !== undefined ? ` (was ${show(zone.values[f.key], f.unit)})` : '';
    return {
      kind: 'input',
      text:
        `${intro}${i + 1}/${FIELDS.length} <b>${f.key}</b>: ${f.what}\n` +
        `Now <b>${show(valueOf(f.key), f.unit)}</b>${changed}. Allowed: ${f.range}${f.unit === '%' ? '' : ' min'}.`,
      hint: 'Reply a new value, next, back, done or cancel.',
      placeholder: `new ${f.key}, next or done`,
      read: (answer): InputResult | Promise<InputResult> => {
        const word = answer.trim().toLowerCase();
        if (word === 'next') return goTo(i + 1);
        if (word === 'done') return goTo(FIELDS.length);
        if (word === 'back') return i > 0 ? { next: field(i - 1) } : { invalid: 'This is the first setting.' };
        const value = parseSetting(answer, f);
        if (typeof value !== 'number') return { invalid: value.problem };
        if (value === zone.values[f.key]) delete pending[f.key];
        else pending[f.key] = value;
        return goTo(i + 1);
      },
    };
  };

  const summary = async (): Promise<Step> => {
    const check: ConfigCheck = await editor.preview(zone.key, { ...pending });
    if (!check.ok && check.reason === 'invalid') {
      return ask({
        text: fitLines([
          "⚠️ <b>These values don't fit together:</b>",
          ...check.problems.map((p) => `• ${safe(p)}`),
          '',
          'Reply <b>edit</b> to go through the settings again (your new values are kept), or <b>cancel</b>.',
        ]),
        hint: 'Reply edit or cancel.',
        choices: [{ words: ['edit'], label: 'edit', next: () => field(0) }],
      });
    }
    if (!check.ok) return done(fitLines(["⚠️ The settings can't be changed right now:", ...check.problems.map((p) => `• ${safe(p)}`), 'Nothing changed.']));
    if (check.changes.length === 0) return done(`⚙️ No changes for ${safe(zone.name)}: nothing was saved.`);
    const more = moreWater(check.changes);
    const changes = { ...pending };
    return passphraseStep({
      intro: `${fitLines([
        `⚙️ <b>${safe(zone.name)}</b>: changes to save`,
        ...check.changes.map(formatChange),
        ...(more.length > 0 ? ['', `💧 <b>More watering</b>: ${more.join(', ')}.`] : []),
        '',
        'They are saved to conductor.json and used from the next poll. Watering already under way keeps its plan.',
      ])}\n\n`,
      action: 'save',
      run: async () => {
        const result = await editor.apply(zone.key, changes, via(actor));
        if (!result.ok) {
          const problems = result.problems.join('; ');
          return { text: fitLines(['❌ <b>Not saved</b>:', ...result.problems.map((p) => `• ${safe(p)}`), 'Nothing changed.']), error: problems.slice(0, 300) };
        }
        if (result.changes.length === 0) return `⚙️ No changes for ${safe(zone.name)}: nothing was saved.`;
        return fitLines([`✅ <b>Saved</b> for ${safe(zone.name)}:`, ...result.changes.map(formatChange), '', 'Used from the next poll.']);
      },
    });
  };

  return field(0, current);
};
