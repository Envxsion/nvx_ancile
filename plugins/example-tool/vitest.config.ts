import { defineConfig } from 'vitest/config';

// The tests run the built server, as NVX Ancile would: build it first.
export default defineConfig({
  test: { globalSetup: ['./test/build.ts'], testTimeout: 20_000 },
});
