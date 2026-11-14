-- The views move from migrations to the app (src/db/repeatable.ts), which re-creates them at every start
-- after migrations have run. drizzle-kit wrote `CREATE VIEW ... AS null` here for views declared with
-- .existing() (a drizzle-kit bug); only the drops are kept. IF EXISTS: the app drops its views before
-- running pending migrations.
DROP VIEW IF EXISTS `pending_sequence`;
--> statement-breakpoint
DROP VIEW IF EXISTS `sequence_result`;
