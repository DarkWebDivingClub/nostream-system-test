import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: '.',
  testMatch: ['tests/**/*.e2e.spec.ts'],
  timeout: 25 * 60 * 1000,
  expect: {
    timeout: 60_000
  },
  use: {
    headless: true,
    viewport: { width: 1366, height: 900 }
  }
});
