import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    setupFiles: ['./tests/setup.ts'],
    // Integration tests each create and drop their own database. Running them
    // in a single fork keeps the connection count predictable and makes
    // failures reproducible.
    pool: 'forks',
    maxForks: 1,
    minForks: 1,
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
