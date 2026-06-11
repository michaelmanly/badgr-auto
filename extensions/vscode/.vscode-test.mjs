import { defineConfig } from '@vscode/test-cli';

export default defineConfig({
  files: 'test/suite/**/*.test.js',
  workspaceFolder: '.',
  mocha: {
    timeout: 20000,
    ui: 'tdd',
  },
});
