import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/coverage/**',
      '**/.wrangler/**',
      // Native helper environments and vendored models are not repo source.
      'tools/duet-helper/.venv/**',
      'tools/duet-helper/.vendor/**',
      'tools/duet-helper/.cache/**',
    ],
  },
  js.configs.recommended,
  tseslint.configs.recommended,
  {
    files: ['**/*.{js,mjs,ts,tsx}'],
    rules: {
      eqeqeq: ['error', 'always'],
      'no-var': 'error',
      'prefer-const': 'error',
    },
  },
  {
    files: ['apps/web/**/*.{ts,tsx}'],
    languageOptions: {
      globals: globals.browser,
    },
  },
  {
    // The extension runs in four scopes: a page, a service worker, a dedicated
    // worker and two audio worklets. The worklet globals are declared for
    // TypeScript in src/worklets/audio-worklet.d.ts.
    files: ['apps/extension/**/*.ts'],
    languageOptions: {
      globals: {
        ...globals.browser,
        ...globals.worker,
        chrome: 'readonly',
        AudioWorkletProcessor: 'readonly',
        registerProcessor: 'readonly',
        currentFrame: 'readonly',
        currentTime: 'readonly',
        sampleRate: 'readonly',
      },
    },
  },
  {
    files: ['scripts/**/*.mjs', '**/*.config.{js,ts}', '**/*.test.{ts,tsx,mjs}'],
    languageOptions: {
      globals: globals.nodeBuiltin,
    },
  },
);
