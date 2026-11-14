import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/test/**/*.test.ts'],
    environment: 'node',
    env: { LOG_LEVEL: 'error' }, // keep test output quiet
    restoreMocks: true,
    unstubEnvs: true,
    unstubGlobals: true,
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      // The Prisma client is generated (npm run db:generate), not written here.
      exclude: ['src/test/**', 'src/scripts/**', 'src/**/types.ts', 'src/db/generated/**'],
    },
  },
});
