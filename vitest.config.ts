import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.{ts,mjs}'],
    coverage: {
      enabled: false,
    },
    mockReset: true,
    restoreMocks: true,
  },
});
