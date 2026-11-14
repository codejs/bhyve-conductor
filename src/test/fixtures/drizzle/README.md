# The drizzle-based version's database, for the conversion tests

The version before the Prisma one kept its data with drizzle-orm. These files let
`src/test/db/drizzle-transfer.test.ts` check that a database it left behind converts without losing a row.

- `conductor-drizzle-era.db`: a database written by that version's own code (its store, sessions and audit
  log), by `make-fixture.ts.txt` run against that version (the drizzle code is no longer in this repository,
  so the script is kept as text). It has a completed, an abandoned and a crashed-mid-send sequence, ledger
  rows (one without provenance), alerts, zone spells, sensor readings, audit events with a deleted range
  (the id counter is above the highest id), and a run that never stopped (a crash).
- `*.sql`: that version's three migrations (drizzle-kit's output, split on `--> statement-breakpoint`), and
  the views and triggers its app created at startup. `src/test/utils/drizzle-db.ts` rebuilds a database at
  any of the three migration levels from them.

Don't edit them: they stand for databases that exist out there.
