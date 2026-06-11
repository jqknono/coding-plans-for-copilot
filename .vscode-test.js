const { defineConfig } = require('@vscode/test-cli');

module.exports = defineConfig([
  {
    label: 'desktop',
    platform: 'desktop',
    files: 'out/test/suite/**/*.test.js',
    version: 'stable',
    extensionDevelopmentPath: __dirname,
    launchArgs: ['--disable-extensions'],
    mocha: {
      ui: 'tdd',
      timeout: 20000,
      color: true,
    },
  },
]);
