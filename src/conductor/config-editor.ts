import { readFile, stat } from 'node:fs/promises';
import { errorMessage, type AuditSink } from '../audit/audit.ts';
import { writeFileAtomic } from '../files.ts';
import { log } from '../log.ts';
import {
  EDITABLE_ZONE_RULES,
  validateConductorConfig,
  zoneKey,
  zoneRuleProblem,
  type ConductorConfig,
  type EditableZoneRule,
  type ZoneConfig,
} from './config.ts';

/**
 * Changes a zone's watering settings while the conductor runs (e.g. /config in Telegram). Only the
 * settings in EDITABLE_ZONE_RULES can be changed, and only as a whole checked change:
 *
 *   1. conductor.json is read afresh, and the zone's settings there must still be the ones in use: if the
 *      file was edited by hand since the conductor started, nothing is changed (restart it first), so
 *      an edit nobody reviewed is never picked up half-way;
 *   2. the new values go into that zone's entry (as overrides; `defaults` and other zones are untouched)
 *      and the whole file is validated exactly as at startup, including the rules between settings
 *      (target above threshold...) and the values that follow from others (e.g. criticalLowPct);
 *   3. the previous file is kept as conductor.json.bak, the new one is written to a temporary file with
 *      the same permissions and renamed over the old one, so a crash never leaves half a file (see
 *      writeFileAtomic: nothing planted in the folder is followed); if the file changed meanwhile, it is
 *      left alone;
 *   4. only then does the running conductor switch to the new settings (at its next poll). Watering
 *      already under way keeps the plan it started with.
 */

/** Settings shown with a change because they follow from the editable ones when not set explicitly. */
export const DERIVED_ZONE_RULES = ['criticalLowPct', 'criticalHighPct'] as const;
type ShownRule = EditableZoneRule | (typeof DERIVED_ZONE_RULES)[number];

export type RuleChanges = Partial<Record<EditableZoneRule, number>>;

export interface RuleChange {
  key: ShownRule;
  from: number;
  to: number;
  /** Not entered by the user: it follows from another setting (e.g. targetPct from thresholdPct). */
  derived: boolean;
}

export interface ZoneSettings {
  key: string;
  name: string;
  values: Record<EditableZoneRule, number>;
}

export type ConfigCheck =
  | { ok: true; zone: { key: string; name: string }; changes: RuleChange[] }
  | {
      ok: false;
      /**
       * `invalid`: the new values don't fit (shown to the user, who can fix them);
       * `conflict`: the file was edited since the conductor started; `unavailable`: it can't be read or written.
       */
      reason: 'invalid' | 'conflict' | 'unavailable';
      problems: string[];
    };

export interface ConfigEditorDeps {
  /** conductor.json (CONDUCTOR_CONFIG). */
  path: string;
  /** The config the conductor is running with; changed zones are swapped into it. */
  config: ConductorConfig;
  audit?: AuditSink;
}

export class ConfigEditor {
  readonly #deps: ConfigEditorDeps;
  /** Changes are made one at a time. */
  #queue: Promise<unknown> = Promise.resolve();

  constructor(deps: ConfigEditorDeps) {
    this.#deps = deps;
  }

  /** The zones and their editable settings, as in use right now. */
  zones(): ZoneSettings[] {
    return this.#deps.config.zones.map((z) => ({ key: z.key, name: z.name, values: pick(z) }));
  }

  /** What the changes would do, without changing anything. */
  async preview(key: string, changes: RuleChanges): Promise<ConfigCheck> {
    const result = await this.#prepare(key, changes);
    return result.ok ? { ok: true, zone: result.zone, changes: result.changes } : result;
  }

  /** Checks the changes again against the file as it is now, saves them, and switches the conductor to them. */
  apply(key: string, changes: RuleChanges, by: string): Promise<ConfigCheck> {
    const run = this.#queue.then(() => this.#apply(key, changes, by));
    this.#queue = run.catch(() => undefined);
    return run;
  }

  async #apply(key: string, changes: RuleChanges, by: string): Promise<ConfigCheck> {
    const prepared = await this.#prepare(key, changes);
    if (!prepared.ok) return prepared;
    if (prepared.changes.length === 0) return { ok: true, zone: prepared.zone, changes: [] };
    const { path, config, audit } = this.#deps;
    try {
      const mode = (await stat(path)).mode & 0o777;
      await writeFileAtomic(`${path}.bak`, prepared.original, { mode });
      await writeFileAtomic(path, `${JSON.stringify(prepared.raw, null, 2)}\n`, {
        mode,
        // Someone may have edited the file while this change was being prepared: don't overwrite that.
        beforeReplace: async () => {
          if ((await readFile(path, 'utf8')) !== prepared.original) throw new FileChangedError();
        },
      });
    } catch (err) {
      if (err instanceof FileChangedError) {
        return { ok: false, reason: 'conflict', problems: [`${path} was changed while saving; nothing was changed, try again`] };
      }
      log.error(`Could not save ${path}`, err);
      return { ok: false, reason: 'unavailable', problems: [`could not save ${path}: ${errorMessage(err)}`] };
    }
    // Swap in a whole new zone object: a poll under way keeps using the old one consistently.
    const index = config.zones.findIndex((z) => z.key === key);
    if (index >= 0) config.zones[index] = prepared.zoneAfter;
    log.info(`Settings of ${prepared.zone.name} [${key}] changed by ${by}: ${prepared.changes.map((c) => `${c.key} ${c.from} → ${c.to}`).join(', ')}`);
    audit?.record('config.changed', {
      by,
      zone: key,
      name: prepared.zone.name,
      changes: prepared.changes.map((c) => ({ key: c.key, from: c.from, to: c.to, ...(c.derived ? { derived: true } : {}) })),
    });
    return { ok: true, zone: prepared.zone, changes: prepared.changes };
  }

  async #prepare(
    key: string,
    changes: RuleChanges,
  ): Promise<
    | { ok: true; zone: { key: string; name: string }; changes: RuleChange[]; raw: unknown; original: string; zoneAfter: ZoneConfig }
    | Extract<ConfigCheck, { ok: false }>
  > {
    const { path, config } = this.#deps;
    const live = config.zones.find((z) => z.key === key);
    if (!live) return { ok: false, reason: 'unavailable', problems: [`zone ${key} is not configured`] };

    // Only the editable settings, each valid on its own, get anywhere near the file.
    const entries: [EditableZoneRule, number][] = [];
    for (const [k, v] of Object.entries(changes)) {
      if (!(EDITABLE_ZONE_RULES as readonly string[]).includes(k)) return { ok: false, reason: 'invalid', problems: [`${k} can't be changed here`] };
      const rule = k as EditableZoneRule;
      if (typeof v !== 'number' || !Number.isFinite(v)) return { ok: false, reason: 'invalid', problems: [`${rule} must be a number`] };
      const problem = zoneRuleProblem(rule, v);
      if (problem) return { ok: false, reason: 'invalid', problems: [`${rule}: ${problem}`] };
      entries.push([rule, v]);
    }

    let original: string;
    let raw: unknown;
    try {
      original = await readFile(path, 'utf8');
      raw = JSON.parse(original);
    } catch (err) {
      return { ok: false, reason: 'unavailable', problems: [`could not read ${path}: ${errorMessage(err)}`] };
    }
    const before = validateConductorConfig(raw);
    if (!before.ok) {
      return { ok: false, reason: 'conflict', problems: [`${path} is no longer valid (edited by hand?): ${before.issues.map(issueText).join('; ')}`] };
    }
    const zoneBefore = before.config.zones.find((z) => z.key === key);
    if (!zoneBefore || !sameRules(zoneBefore, live)) {
      return {
        ok: false,
        reason: 'conflict',
        problems: [`${path} has changed since the conductor started (${live.name}'s settings there differ from the ones in use); restart the conductor to load it first`],
      };
    }

    // The zone's entry in the file, found by device and station (keys are unique).
    const zones = (raw as { zones: Record<string, unknown>[] }).zones;
    const entry = zones.find((z) => zoneKey(z as { deviceId: string; station: number }) === key);
    if (!entry) return { ok: false, reason: 'unavailable', problems: [`zone ${key} is not in ${path}`] };
    for (const [rule, value] of entries) entry[rule] = value;

    const after = validateConductorConfig(raw);
    if (!after.ok) return { ok: false, reason: 'invalid', problems: after.issues.map(issueText) };
    const zoneAfter = after.config.zones.find((z) => z.key === key);
    if (!zoneAfter) return { ok: false, reason: 'unavailable', problems: [`zone ${key} disappeared`] };

    const entered = new Set(entries.map(([rule]) => rule));
    const shown: ShownRule[] = [...EDITABLE_ZONE_RULES, ...DERIVED_ZONE_RULES];
    const list: RuleChange[] = shown
      .filter((k) => zoneBefore[k] !== zoneAfter[k])
      .map((k) => ({ key: k, from: zoneBefore[k], to: zoneAfter[k], derived: !entered.has(k as EditableZoneRule) }));
    return { ok: true, zone: { key, name: live.name }, changes: list, raw, original, zoneAfter };
  }
}

class FileChangedError extends Error {}

const pick = (z: ZoneConfig): Record<EditableZoneRule, number> =>
  Object.fromEntries(EDITABLE_ZONE_RULES.map((k) => [k, z[k]])) as Record<EditableZoneRule, number>;

/** Are the settings /config shows or affects the same? */
const sameRules = (a: ZoneConfig, b: ZoneConfig): boolean =>
  [...EDITABLE_ZONE_RULES, ...DERIVED_ZONE_RULES].every((k) => a[k] === b[k]);

/** "zones.1.targetPct: targetPct (40) must be above thresholdPct (45)" → just the message when it names the setting. */
const issueText = (i: { path: string; message: string }): string => {
  const field = i.path.split('.').at(-1) ?? '';
  return i.message.includes(field) ? i.message : `${field || i.path}: ${i.message}`;
};
