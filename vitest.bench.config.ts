import { defineConfig } from 'vitest/config';

// Benchmarks are run on demand with `pnpm run bench`, never as part of
// `pnpm run test`: a timing on a shared machine is evidence, not a gate.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['{apps,workers,scripts}/**/*.bench.ts'],
  },
});
