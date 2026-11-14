import { defineConfig } from 'prisma/config';

/**
 * Prisma CLI configuration (`npm run db:generate`, and `prisma migrate ...` on a machine that can download
 * Prisma's schema engine). The app itself applies migrations at startup (src/db/migrate.ts) and talks to
 * SQLite through its own node:sqlite driver adapter (src/db/adapter.ts).
 */
export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: { path: 'prisma/migrations' },
  datasource: { url: `file:${process.env.CONDUCTOR_DB ?? '.conductor.db'}` },
});
