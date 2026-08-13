import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFile, rename, rm } from 'node:fs/promises';
import process from 'node:process';
import { validateKnownBrokenRun } from './known-broken-contract.mjs';

const artifactDir = process.env.E2E_ARTIFACT_DIR ?? '/tmp/startap-e2e-artifacts';
const reportPath = `${artifactDir}/known-broken-results.json`;
const invocationReportPath = `${artifactDir}/known-broken-results-${randomUUID()}.json`;
const manifest = JSON.parse(await readFile('known-broken.json', 'utf8'));

await rm(reportPath, { force: true });
await rm(invocationReportPath, { force: true });
const result = spawnSync('npx', ['playwright', 'test', '--config', 'known-broken.config.ts'], {
  cwd: process.cwd(),
  encoding: 'utf8',
  env: { ...process.env, E2E_KNOWN_BROKEN_REPORT_PATH: invocationReportPath },
  stdio: ['ignore', 'pipe', 'pipe'],
});

let report;
let reportCurrent = false;
let reportError;
try {
  report = JSON.parse(await readFile(invocationReportPath, 'utf8'));
  await rename(invocationReportPath, reportPath);
  reportCurrent = true;
} catch (error) {
  reportError = error;
  await rm(invocationReportPath, { force: true });
}

const errors = validateKnownBrokenRun({ manifest, report, processResult: result, reportCurrent });
if (reportError !== undefined) {
  errors.push(`report da invocação indisponível: ${reportError.code ?? 'erro desconhecido'}`);
}

if (errors.length > 0) {
  process.stderr.write(`known-broken divergiu:\n- ${errors.join('\n- ')}\n`);
  process.stderr.write(String(result.stderr ?? '').slice(0, 4_000));
  process.exitCode = 1;
} else {
  process.stdout.write(
    `known-broken validado por Jira, título, causa e assertion: ${manifest.expectedFailures} falhas conhecidas. Relatório: ${reportPath}\n`,
  );
}
