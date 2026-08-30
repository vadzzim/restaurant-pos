import eslint from '@eslint/js';
import vue from 'eslint-plugin-vue';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/node_modules/**',
      '**/coverage/**',
      '**/playwright-report/**',
      '.verify-output/**',
    ],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  ...vue.configs['flat/recommended'],
  {
    files: ['**/*.vue'],
    languageOptions: {
      parserOptions: {
        parser: tseslint.parser,
      },
    },
  },
  {
    files: ['apps/{api,worker}/**/*.ts', 'packages/**/*.ts', '*.config.js', '**/scripts/**/*.mjs'],
    languageOptions: {
      globals: globals.node,
    },
  },
  {
    files: ['apps/web/**/*.{ts,vue}'],
    languageOptions: {
      globals: globals.browser,
    },
  },
  {
    // The service worker runs in a worker scope, not a document: no `window`, no `document`, but
    // `self`, `caches` and `clients`. Its Vite plugin, on the other hand, runs in Node.
    files: ['apps/web/src/sw/**/*.ts'],
    languageOptions: {
      globals: globals.serviceworker,
    },
  },
  {
    files: ['apps/web/vite/**/*.ts'],
    languageOptions: {
      globals: globals.node,
    },
  },
  {
    // The E2E harness runs in Node, outside every app: `@pos/config` validates the *application's*
    // environment and is bundled into the API, the worker and the browser, so it is the wrong door
    // for two variables that belong to the test runner. The `process.env` reads are in the config
    // file only — the spec takes its base URL from Playwright's fixtures.
    files: ['playwright.config.ts', 'e2e/**/*.ts'],
    languageOptions: {
      globals: globals.node,
    },
  },
  {
    files: ['**/*.{ts,vue}'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      'no-restricted-syntax': [
        'error',
        {
          selector: "MemberExpression[object.name='process'][property.name='env']",
          message: 'Read environment variables through @pos/config.',
        },
      ],
      // Prettier owns template formatting; these three rules disagree with it.
      'vue/max-attributes-per-line': 'off',
      'vue/html-self-closing': 'off',
      'vue/singleline-html-element-content-newline': 'off',
    },
  },
  {
    files: ['packages/config/src/index.ts'],
    rules: {
      'no-restricted-syntax': 'off',
    },
  },
);
