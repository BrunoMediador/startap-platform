import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import process from 'node:process';

const artifactDir = process.env.E2E_ARTIFACT_DIR ?? '/tmp/startap-e2e-artifacts';
const reportPath = `${artifactDir}/known-broken-results.json`;
const manifest = JSON.parse(await readFile('known-broken.json', 'utf8'));
const result = spawnSync('npx', ['playwright', 'test', '--config', 'known-broken.config.ts'], {
  cwd: process.cwd(),
  encoding: 'utf8',
  stdio: ['ignore', 'pipe', 'pipe'],
});
const report = JSON.parse(await readFile(reportPath, 'utf8'));

function collectSpecs(suites) {
  const specs = [];
  for (const suite of Array.isArray(suites) ? suites : []) {
    specs.push(...(Array.isArray(suite.specs) ? suite.specs : []));
    specs.push(...collectSpecs(suite.suites));
  }
  return specs;
}

const specs = collectSpecs(report.suites);
const manifestItems = Array.isArray(manifest.items) ? manifest.items : [];
const errors = [];
if (manifest.expectedFailures !== manifestItems.length) {
  errors.push('manifest expectedFailures diverge do número de items');
}
if (specs.length !== manifestItems.length) {
  errors.push(`report trouxe ${specs.length} specs; manifest exige ${manifestItems.length}`);
}

for (const item of manifestItems) {
  const matches = specs.filter((spec) => spec.title === item.test);
  if (matches.length !== 1) {
    errors.push(`${item.jira}: título ausente/duplicado no report`);
    continue;
  }
  const spec = matches[0];
  if (!String(spec.title).startsWith(`${item.jira} `)) {
    errors.push(`${item.jira}: título não começa com o Jira esperado`);
  }
  const tests = Array.isArray(spec.tests) ? spec.tests : [];
  if (tests.length !== 1 || tests[0]?.status !== 'unexpected') {
    errors.push(`${item.jira}: resultado não é uma única falha unexpected`);
    continue;
  }
  const annotations = Array.isArray(tests[0].annotations) ? tests[0].annotations : [];
  if (
    !annotations.some(
      (annotation) =>
        annotation.type === 'known-broken-cause' && annotation.description === item.causeId,
    )
  ) {
    errors.push(`${item.jira}: causeId do report não corresponde ao manifest`);
  }
  const results = Array.isArray(tests[0].results) ? tests[0].results : [];
  const messages = results
    .flatMap((testResult) => [testResult.error, ...(testResult.errors ?? [])])
    .map((error) => String(error?.message ?? ''))
    .join('\n');
  for (const fragment of item.expectedErrorFragments ?? []) {
    if (!messages.includes(fragment)) {
      errors.push(`${item.jira}: assertion falhou por causa diferente; ausente: ${fragment}`);
    }
  }
}

const unexpected = Number(report?.stats?.unexpected ?? -1);
if (unexpected !== manifest.expectedFailures) {
  errors.push(`stats.unexpected=${unexpected}; manifest=${manifest.expectedFailures}`);
}
if (result.status === 0) errors.push('Playwright retornou verde para suíte expected-red');

if (errors.length > 0) {
  process.stderr.write(`known-broken divergiu:\n- ${errors.join('\n- ')}\n`);
  process.stderr.write(String(result.stderr ?? '').slice(0, 4_000));
  process.exitCode = 1;
} else {
  process.stdout.write(
    `known-broken validado por Jira, título, causa e assertion: ${manifest.expectedFailures} falhas conhecidas. Relatório: ${reportPath}\n`,
  );
}
