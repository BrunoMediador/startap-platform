import { stripVTControlCharacters } from 'node:util';

function collectSpecs(suites) {
  const specs = [];
  for (const suite of Array.isArray(suites) ? suites : []) {
    specs.push(...(Array.isArray(suite.specs) ? suite.specs : []));
    specs.push(...collectSpecs(suite.suites));
  }
  return specs;
}

export function validateKnownBrokenRun({ manifest, report, processResult, reportCurrent }) {
  const specs = collectSpecs(report?.suites);
  const manifestItems = Array.isArray(manifest?.items) ? manifest.items : [];
  const errors = [];

  if (processResult?.error !== undefined) {
    errors.push(`Playwright não iniciou: ${processResult.error?.code ?? 'erro desconhecido'}`);
  }
  if (processResult?.signal !== null) {
    errors.push(`Playwright terminou por sinal: ${processResult?.signal ?? 'desconhecido'}`);
  }
  if (processResult?.status !== 1) {
    errors.push(`Playwright exit=${String(processResult?.status)}; esperado=1`);
  }
  if (reportCurrent !== true) {
    errors.push('report não pertence à invocação atual');
  }
  if (!Array.isArray(report?.errors) || report.errors.length !== 0) {
    errors.push('report contém erro global ou campo errors inválido');
  }
  if (manifest?.expectedFailures !== 2 || manifestItems.length !== 2) {
    errors.push('known-broken exige exatamente dois casos manifestados');
  }
  if (manifest?.expectedFailures !== manifestItems.length) {
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
    if (results.length !== 1 || results[0]?.status !== 'failed') {
      errors.push(`${item.jira}: exige exatamente um result failed`);
      continue;
    }
    const messages = [results[0].error, ...(results[0].errors ?? [])]
      .map((error) => stripVTControlCharacters(String(error?.message ?? '')))
      .join('\n');
    for (const fragment of item.expectedErrorFragments ?? []) {
      if (!messages.includes(fragment)) {
        errors.push(`${item.jira}: assertion falhou por causa diferente; ausente: ${fragment}`);
      }
    }
  }

  const unexpected = Number(report?.stats?.unexpected ?? -1);
  if (unexpected !== manifest?.expectedFailures) {
    errors.push(`stats.unexpected=${unexpected}; manifest=${manifest?.expectedFailures}`);
  }
  return errors;
}
