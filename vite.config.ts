import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';
import { previewHeaders } from './deploy/headers.ts';

export default defineConfig({
  // `vite preview` sends the production security headers from public/_headers (D-025).
  plugins: [react(), previewHeaders('public/_headers')],
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
