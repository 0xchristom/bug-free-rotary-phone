import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [react()],
  test: {
    // core, executor and jupiter must run in Node without a browser (SPEC 4). UI tests opt
    // into jsdom per file with `// @vitest-environment jsdom`.
    environment: 'node',
    include: ['tests/**/*.test.{ts,tsx}'],
    // Mocks only: fetch and WebSocket throw in every test.
    setupFiles: ['tests/helpers/no-network.ts'],
    unstubGlobals: true,
  },
});
