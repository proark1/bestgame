import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    // Zero retries — flaky sim tests are never acceptable.
    retry: 0,
  },
});
