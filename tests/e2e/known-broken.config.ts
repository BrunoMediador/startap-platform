import { defineConfig } from '@playwright/test';

const artifactDir = process.env.E2E_ARTIFACT_DIR ?? '/tmp/startap-e2e-artifacts';

export default defineConfig({
  testDir: './known-broken',
  fullyParallel: false,
  workers: 1,
  timeout: 30_000,
  retries: 0,
  reporter: [['json', { outputFile: `${artifactDir}/known-broken-results.json` }]],
  outputDir: `${artifactDir}/known-broken-test-results`,
});
