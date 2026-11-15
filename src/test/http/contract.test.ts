import { readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * The web app shares the API's types (http/contract.ts) and the code that describes events
 * (audit/report.ts). In a browser there is no Node: those files, and every file they import — type-only
 * imports too, as they bring the file into the web app's type check — must not import Node modules or
 * packages, or use Node's globals.
 */

const SRC = fileURLToPath(new URL('../../', import.meta.url));
const SHARED_ENTRY_POINTS = ['http/contract.ts', 'audit/report.ts', 'audit/types.ts'];

/** Module specifiers of every import/export ... from, side-effect import and dynamic import(). */
const specifiersOf = (code: string): string[] => [
  ...[...code.matchAll(/^\s*(?:import|export)\s[^'";]*?\bfrom\s*(['"])(.+?)\1/gm)].map((m) => m[2] ?? ''),
  ...[...code.matchAll(/^\s*import\s*(['"])(.+?)\1/gm)].map((m) => m[2] ?? ''),
  ...[...code.matchAll(/\bimport\(\s*(['"])(.+?)\1\s*\)/g)].map((m) => m[2] ?? ''),
];

/** The files reachable from the entry points through relative imports. */
const closure = (entries: readonly string[]): Map<string, string[]> => {
  const seen = new Map<string, string[]>();
  const queue = entries.map((e) => join(SRC, e));
  for (let file = queue.shift(); file !== undefined; file = queue.shift()) {
    if (seen.has(file)) continue;
    const specifiers = specifiersOf(readFileSync(file, 'utf8'));
    seen.set(file, specifiers);
    for (const s of specifiers) if (s.startsWith('.')) queue.push(resolve(dirname(file), s));
  }
  return seen;
};

describe('modules shared with the web app', () => {
  const files = closure(SHARED_ENTRY_POINTS);

  it('are exactly these (a new import here must be browser-safe too)', () => {
    expect([...files.keys()].map((f) => relative(SRC, f)).sort()).toEqual(['audit/report.ts', 'audit/types.ts', 'http/contract.ts']);
  });

  it('import neither Node modules nor packages', () => {
    for (const [file, specifiers] of files) {
      const external = specifiers.filter((s) => !s.startsWith('.'));
      expect({ file: relative(SRC, file), external }).toEqual({ file: relative(SRC, file), external: [] });
    }
  });

  it('use no Node globals', () => {
    for (const file of files.keys()) {
      const code = readFileSync(file, 'utf8');
      expect({ file: relative(SRC, file), globals: code.match(/\b(process|Buffer|require|__dirname|__filename|NodeJS)\b/g) ?? [] }).toEqual({
        file: relative(SRC, file),
        globals: [],
      });
    }
  });

  it('the import scanner sees every kind of import (so the checks above are not vacuous)', () => {
    const code = [
      "import { a } from './a.ts';",
      "import type { B } from '../b.ts';",
      'import {\n  c,\n  d,\n} from "./double-quoted.ts";',
      "import {\n  e,\n  f,\n} from './multi-line.ts';",
      "export { g } from './re-export.ts';",
      "export type { H } from 'node:fs';",
      "import 'side-effect';",
      'import "node:os";',
      "const m = await import('node:path');",
      'const n = await import("node:net");',
    ].join('\n');
    expect(specifiersOf(code).sort()).toEqual(
      ['../b.ts', './a.ts', './double-quoted.ts', './multi-line.ts', './re-export.ts', 'node:fs', 'node:net', 'node:os', 'node:path', 'side-effect'].sort(),
    );
  });
});
