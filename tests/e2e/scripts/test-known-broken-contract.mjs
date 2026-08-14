import assert from 'node:assert/strict';
import { validateKnownBrokenRun } from './known-broken-contract.mjs';

const manifest = {
  expectedFailures: 1,
  items: [
    {
      jira: 'SCRUM-A',
      test: 'SCRUM-A expected-red: contrato A',
      causeId: 'cause-a',
      expectedErrorFragments: ['Expected: 200', 'Received: 404'],
    },
  ],
};
const processResult = { status: 1, signal: null, error: undefined };

function failedSpec(item, expected, received) {
  return {
    title: item.test,
    tests: [
      {
        status: 'unexpected',
        annotations: [{ type: 'known-broken-cause', description: item.causeId }],
        results: [
          {
            status: 'failed',
            error: {
              message: `Expected: \u001b[32m${expected}\u001b[39m\nReceived: \u001b[31m${received}\u001b[39m`,
            },
            errors: [],
          },
        ],
      },
    ],
  };
}

function validReport() {
  return {
    suites: [
      {
        specs: [failedSpec(manifest.items[0], 200, 404)],
      },
    ],
    errors: [],
    stats: { unexpected: 1 },
  };
}

function validate(overrides = {}) {
  return validateKnownBrokenRun({
    manifest,
    report: validReport(),
    processResult,
    reportCurrent: true,
    ...overrides,
  });
}

function expectRejected(label, errors, fragment) {
  assert.ok(
    errors.some((error) => error.includes(fragment)),
    `${label}: ${errors.join('; ')}`,
  );
}

assert.deepEqual(validate(), [], 'fixture ANSI correta deve ser aceita');

const wrongValue = validReport();
wrongValue.suites[0].specs[0].tests[0].results[0].error.message =
  'Expected: \u001b[32m201\u001b[39m\nReceived: \u001b[31m500\u001b[39m';
expectRejected('valor errado', validate({ report: wrongValue }), 'ausente: Expected: 200');

expectRejected('exit 0', validate({ processResult: { status: 0, signal: null } }), 'esperado=1');
expectRejected(
  'ENOENT',
  validate({
    processResult: { status: null, signal: null, error: { code: 'ENOENT' } },
    reportCurrent: false,
  }),
  'Playwright não iniciou: ENOENT',
);
expectRejected(
  'signal',
  validate({ processResult: { status: null, signal: 'SIGTERM' }, reportCurrent: false }),
  'Playwright terminou por sinal: SIGTERM',
);
expectRejected('report stale', validate({ reportCurrent: false }), 'invocação atual');

const zeroResults = validReport();
zeroResults.suites[0].specs[0].tests[0].results = [];
expectRejected('zero results', validate({ report: zeroResults }), 'exatamente um result failed');

const globalError = validReport();
globalError.errors = [{ message: 'global failure' }];
expectRejected('global error', validate({ report: globalError }), 'erro global');

const multipleResults = validReport();
multipleResults.suites[0].specs[0].tests[0].results.push(
  structuredClone(multipleResults.suites[0].specs[0].tests[0].results[0]),
);
expectRejected(
  'multiple results',
  validate({ report: multipleResults }),
  'exatamente um result failed',
);

process.stdout.write('known-broken contract self-test: 9 casos passaram\n');
