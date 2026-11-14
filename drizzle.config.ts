import { defineConfig } from 'drizzle-kit';

/**
 * drizzle-kit: `npm run db:generate` writes a migration to drizzle/ from src/db/schema.ts;
 * `npm run db:check` validates the migrations folder. The app applies migrations itself at startup
 * (src/db/database.ts), so no credentials are needed here.
 */
export default defineConfig({
  dialect: 'sqlite',
  schema: './src/db/schema.ts',
  out: './drizzle',
});
