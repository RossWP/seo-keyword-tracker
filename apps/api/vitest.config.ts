import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globalSetup: ['./src/test/global-setup.ts'],
    // Database tests share one test database, so files run one after another.
    fileParallelism: false,
  },
});
