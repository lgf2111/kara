import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['{apps,workers,scripts}/**/*.test.{ts,tsx,mjs}'],
  },
});
