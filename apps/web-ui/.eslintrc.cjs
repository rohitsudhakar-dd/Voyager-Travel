/** eslint 8 flat-config is opt-in; the repo's other Node packages use .eslintrc. */
module.exports = {
  root: true,
  env: { browser: true, es2022: true, node: true },
  parser: '@typescript-eslint/parser',
  parserOptions: { ecmaVersion: 2022, sourceType: 'module', ecmaFeatures: { jsx: true } },
  plugins: ['@typescript-eslint', 'react-hooks', 'react-refresh'],
  extends: [
    'eslint:recommended',
    'plugin:@typescript-eslint/recommended',
    'plugin:react-hooks/recommended',
  ],
  settings: { react: { version: '18.3' } },
  ignorePatterns: [
    'dist',
    'coverage',
    'playwright-report',
    'test-results',
    'public/mockServiceWorker.js',
  ],
  rules: {
    'no-console': 'error',
    // Providers are colocated with their hooks and step lists with their steppers,
    // which costs HMR granularity in a handful of files and is worth it for locality.
    'react-refresh/only-export-components': 'off',
    '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
    '@typescript-eslint/no-non-null-assertion': 'off',
    '@typescript-eslint/consistent-type-imports': ['error', { fixStyle: 'inline-type-imports' }],
  },
  overrides: [
    {
      files: ['*.config.ts', 'scripts/**/*.mjs', 'e2e/**/*.ts'],
      rules: { 'no-console': 'off' },
    },
  ],
};
