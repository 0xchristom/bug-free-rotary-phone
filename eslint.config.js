import js from '@eslint/js';
import reactHooks from 'eslint-plugin-react-hooks';
import reactRefresh from 'eslint-plugin-react-refresh';
import globals from 'globals';
import tseslint from 'typescript-eslint';
import { defineConfig } from 'eslint/config';

// SPEC 6.1: private keys and the mnemonic may live in plaintext only in Web Worker memory.
const STORAGE_MESSAGE =
  'Zakazane (SPEC 6.1): klucze i sekrety nie mogą trafiać do localStorage, sessionStorage ani IndexedDB.';
const FORBIDDEN_STORAGE = ['localStorage', 'sessionStorage', 'indexedDB'];
const GLOBAL_OBJECTS = ['window', 'globalThis', 'self'];

const storageGlobals = FORBIDDEN_STORAGE.map((name) => ({ name, message: STORAGE_MESSAGE }));
const storageProperties = GLOBAL_OBJECTS.flatMap((object) =>
  FORBIDDEN_STORAGE.map((property) => ({ object, property, message: STORAGE_MESSAGE })),
);

// SPEC 4: core, executor and jupiter must be testable in Node without a browser;
// the vault worker has no DOM either (BUNNDLY-7).
const DOM_MESSAGE = 'Zakazane (SPEC 4): ten moduł musi działać w Node, bez DOM.';
const domGlobals = ['window', 'document'].map((name) => ({ name, message: DOM_MESSAGE }));
const domProperties = ['globalThis', 'self'].flatMap((object) =>
  ['window', 'document'].map((property) => ({ object, property, message: DOM_MESSAGE })),
);

export default defineConfig(
  { ignores: ['dist', 'coverage'] },
  {
    files: ['**/*.{ts,tsx}'],
    extends: [js.configs.recommended, ...tseslint.configs.strictTypeChecked],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  {
    files: ['src/**/*.{ts,tsx}'],
    extends: [reactHooks.configs.flat['recommended-latest'], reactRefresh.configs.vite],
    languageOptions: {
      globals: globals.browser,
    },
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      'no-console': 'error',
      'no-eval': 'error',
      'no-implied-eval': 'error',
      '@typescript-eslint/no-implied-eval': 'error',
      'no-new-func': 'error',
      'no-restricted-globals': ['error', ...storageGlobals],
      'no-restricted-properties': ['error', ...storageProperties],
    },
  },
  {
    // Rule options are replaced, not merged, so storage restrictions are repeated here.
    files: ['src/{core,executor,jupiter,worker}/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-globals': ['error', ...storageGlobals, ...domGlobals],
      'no-restricted-properties': ['error', ...storageProperties, ...domProperties],
    },
  },
  {
    files: ['tests/**/*.ts', 'vite.config.ts'],
    languageOptions: {
      globals: globals.node,
    },
  },
  {
    files: ['**/*.js'],
    extends: [js.configs.recommended],
    languageOptions: {
      globals: globals.node,
    },
  },
);
