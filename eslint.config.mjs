import globals from 'globals';

const rules = { 'no-unused-vars': ['error', { argsIgnorePattern: '^_' }] };

export default [
  {
    files: ['extension/**/*.js'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'script',
      globals: { ...globals.browser, chrome: 'readonly', module: 'writable', buildReport: 'readonly' },
    },
    rules,
  },
  {
    files: ['test/**/*.js'],
    languageOptions: { ecmaVersion: 2023, sourceType: 'commonjs', globals: globals.node },
    rules,
  },
];
