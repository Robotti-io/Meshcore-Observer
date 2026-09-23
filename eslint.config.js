import js from '@eslint/js';

const nodeGlobals = {
  process: 'readonly',
  console: 'readonly',
  Buffer: 'readonly',
  URL: 'readonly',
  URLSearchParams: 'readonly',
  setTimeout: 'readonly',
  clearTimeout: 'readonly',
  setInterval: 'readonly',
  clearInterval: 'readonly',
  setImmediate: 'readonly',
  fetch: 'readonly',
  AbortController: 'readonly',
  TextDecoder: 'readonly'
};

// Served to a browser (see src/web/metrics-server.js's STATIC_ASSETS), not
// run under Node - real DOM/browser globals, not nodeGlobals, and Chart is
// a third-party global loaded from a CDN <script> tag (see
// dashboard-page.js), not an import.
const browserGlobals = {
  window: 'readonly',
  document: 'readonly',
  getComputedStyle: 'readonly',
  EventSource: 'readonly',
  Chart: 'readonly',
  console: 'readonly',
  fetch: 'readonly'
};

export default [
  { ignores: ['coverage/**'] },
  js.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: nodeGlobals
    },
    rules: {
      'no-unused-vars': ['error', { argsIgnorePattern: '^_' }]
    }
  },
  {
    files: ['src/web/client/**/*.js'],
    languageOptions: {
      globals: browserGlobals
    }
  }
];
