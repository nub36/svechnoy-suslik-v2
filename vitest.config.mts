import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    globals: false,
    testTimeout: 60_000,
    hookTimeout: 120_000,
    // DB tests share one embedded Postgres -> keep everything in one process.
    pool: 'forks',
    maxForks: 1,
    minForks: 1,
    fileParallelism: false,
    reporters: ['default'],
  },
});
