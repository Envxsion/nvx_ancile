import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [react()],
  // Tests run as the free build: no Pro screens (see vite.config.ts).
  define: { __ANCILE_PRO_UI__: 'false' },
  test: {
    environment: 'jsdom',
    include: ['test/**/*.test.{ts,tsx}'],
    setupFiles: ['test/setup.ts'],
    css: false,
  },
});
