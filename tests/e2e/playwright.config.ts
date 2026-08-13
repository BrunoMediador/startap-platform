import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './specs',
  fullyParallel: false,
  workers: 1,
  timeout: 30_000,
  expect: { timeout: 8_000 },
  retries: 0,
  reporter: [['line']],
  outputDir: '/artifacts/test-results',
  use: {
    baseURL: process.env.E2E_PORTAL_WEB_URL,
    screenshot: 'off',
    trace: 'off',
    video: 'off',
  },
});
