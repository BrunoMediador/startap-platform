import { defineConfig } from '@playwright/test';

const artifactDir = process.env.E2E_ARTIFACT_DIR ?? '/tmp/startap-e2e-artifacts';
const reportPath =
  process.env.E2E_KNOWN_BROKEN_REPORT_PATH ?? `${artifactDir}/known-broken-results.json`;

export default defineConfig({
  testDir: './known-broken',
  fullyParallel: false,
  workers: 1,
  timeout: 30_000,
  retries: 0,
  reporter: [['json', { outputFile: reportPath }]],
  outputDir: `${artifactDir}/known-broken-test-results`,
});
