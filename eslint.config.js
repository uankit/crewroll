const { defineConfig } = require('eslint/config');
const expoConfig = require('eslint-config-expo/flat');

module.exports = defineConfig([
  {
    ignores: [
      '.expo/**',
      'android/**',
      'ios/**',
      'coverage/**',
      'dist/**',
      'node_modules/**',
    ],
  },
  ...expoConfig,
  {
    rules: {
      'no-console': ['warn', { allow: ['warn', 'error'] }],
    },
  },
]);
