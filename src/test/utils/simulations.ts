import { cp, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { vi } from 'vitest';
import { openDatabase } from '../../db/database.ts';
import { MIGRATIONS_FOLDER, readMigrations } from '../../db/migrate.ts';
import { log } from '../../log.ts';
import { runScenario, type SimResult } from '../../sim/runner.ts';
import { scenarioById } from '../../sim/scenarios.ts';

/** Real simulation results (the conductor's own code in virtual time), for tests that read stored ones. */

/** Runs the scenarios once, quietly. */
export const runScenarios = async (ids: readonly string[]): Promise<Map<string, SimResult>> => {
  const spies = (['debug', 'info', 'warn', 'error'] as const).map((level) => vi.spyOn(log, level).mockImplementation(() => {}));
  try {
    const results = new Map<string, SimResult>();
    for (const id of ids) {
      const scenario = scenarioById(id);
      if (!scenario) throw new Error(`no scenario ${id}`);
      results.set(id, await runScenario(scenario));
    }
    return results;
  } finally {
    for (const spy of spies) spy.mockRestore();
  }
};

/** A result by scenario id, or a clear failure. */
export const pick = (results: ReadonlyMap<string, SimResult>, id: string): SimResult => {
  const r = results.get(id);
  if (!r) throw new Error(`scenario ${id} did not run`);
  return r;
};

/** The same result under another scenario id, e.g. one this version no longer defines. */
export const renamed = (result: SimResult, id: string, title = `${result.scenario.title} (renamed)`): SimResult => ({
  ...result,
  scenario: { ...result.scenario, id, title },
});

/** A database file at the first migration only: from before stored simulations. */
export const databaseBeforeSimulations = async (dir: string): Promise<string> => {
  const first = readMigrations()[0];
  if (!first) throw new Error('no migrations');
  const initOnly = join(dir, 'migrations-init-only');
  await mkdir(join(initOnly, first.name), { recursive: true });
  await cp(join(MIGRATIONS_FOLDER, first.name), join(initOnly, first.name), { recursive: true });
  const path = join(dir, 'before-simulations.db');
  const db = openDatabase(path, { migrationsFolder: initOnly });
  await db.close();
  return path;
};
