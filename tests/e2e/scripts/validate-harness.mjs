import { execFile as execFileCallback, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

const execFile = promisify(execFileCallback);
const root = process.cwd();

async function probeFakeSessionSinks() {
  const child = spawn(process.execPath, [path.join(root, 'tests/e2e/fakes/server.mjs')], {
    env: { ...process.env, FAKE_KIND: 'waha', PORT: '0' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  let stderr = '';
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
  });

  try {
    const port = await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('fake WAHA não iniciou em 5s')), 5_000);
      child.once('exit', (code) => {
        clearTimeout(timeout);
        reject(new Error(`fake WAHA encerrou antes do probe: ${code}; ${stderr}`));
      });
      child.stdout.on('data', (chunk) => {
        const match = String(chunk).match(/fake ready on (\d+)/u);
        if (!match) return;
        clearTimeout(timeout);
        resolve(Number(match[1]));
      });
    });
    const rawName = 'short-e2e-session';
    const baseUrl = `http://127.0.0.1:${port}`;
    const createdResponse = await fetch(`${baseUrl}/api/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: rawName, start: true }),
    });
    const created = await createdResponse.json();
    const listed = await fetch(`${baseUrl}/api/sessions`).then((response) => response.json());
    const adminState = await fetch(`${baseUrl}/__admin/state`).then((response) => response.json());
    const outputs = { created, listed, adminState };
    const serialized = JSON.stringify(outputs);
    if (serialized.includes(rawName)) {
      throw new Error('fake WAHA expôs identidade curta em sink HTTP/journal');
    }
    const nameTag = createHash('sha256').update(rawName).digest('hex').slice(0, 16);
    const expectedSession = { nameTag, status: 'STARTING' };
    if (
      !createdResponse.ok ||
      JSON.stringify(created) !== JSON.stringify(expectedSession) ||
      JSON.stringify(listed) !== JSON.stringify([expectedSession]) ||
      JSON.stringify(adminState.state?.sessions) !== JSON.stringify([expectedSession]) ||
      adminState.journal?.[0]?.body?.nameTag !== nameTag ||
      Object.hasOwn(adminState.journal?.[0]?.body ?? {}, 'name')
    ) {
      throw new Error('fake WAHA não aplicou projeção tag-only em todos os sinks de sessão');
    }
  } finally {
    const exited =
      child.exitCode === null
        ? new Promise((resolve) => child.once('exit', resolve))
        : Promise.resolve();
    child.kill('SIGTERM');
    await exited;
  }
}
const missionRelative = 'docs/missoes/030-e2e-compose-isolado.md';
const workflowRelative = '.github/workflows/ci.yml';
const required = [
  'tests/e2e/compose.yml',
  'tests/e2e/README.md',
  'tests/e2e/fakes/server.mjs',
  'tests/e2e/support/egress-guard.mjs',
  'tests/e2e/support/egress-probe.mjs',
  'tests/e2e/support/network-probe.mjs',
  'tests/e2e/support/api-entrypoint.mjs',
  'tests/e2e/specs/vertical.spec.ts',
  'tests/e2e/known-broken/known-broken.spec.ts',
  'tests/e2e/known-broken.json',
  'tests/e2e/known-broken.config.ts',
  'tests/e2e/scripts/known-broken-contract.mjs',
  'tests/e2e/scripts/run-known-broken.mjs',
  'tests/e2e/scripts/test-known-broken-contract.mjs',
  workflowRelative,
  missionRelative,
];
const excludedSegments = new Set([
  '.git',
  'node_modules',
  'dist',
  '.next',
  'coverage',
  'artifacts',
]);

function isExcluded(relative) {
  return relative.split('/').some((segment) => excludedSegments.has(segment));
}

function isRelevant(relative) {
  return (
    relative.startsWith('tests/e2e/') ||
    relative === workflowRelative ||
    relative === missionRelative ||
    relative === 'package.json' ||
    relative === 'package-lock.json' ||
    relative === 'vitest.config.ts'
  );
}

async function readText(relative) {
  const buffer = await readFile(path.join(root, relative));
  if (buffer.length > 2 * 1024 * 1024 || buffer.includes(0)) return null;
  return buffer.toString('utf8');
}

for (const file of required) await readFile(path.join(root, file));

const { stdout: listed } = await execFile(
  'git',
  ['ls-files', '-z', '--cached', '--others', '--exclude-standard'],
  { cwd: root, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 },
);
const repoFiles = listed
  .split('\0')
  .filter(Boolean)
  .filter((relative) => !isExcluded(relative));
const relevantFiles = repoFiles.filter(isRelevant);
for (const requiredFile of required) {
  if (!relevantFiles.includes(requiredFile)) {
    throw new Error(`scanner não incluiu artefato obrigatório tracked/untracked: ${requiredFile}`);
  }
}

// Autoteste contra no-op em checkout limpo e worktree suja: seleção independe de diff/HEAD.
const selectionSelfTest = [
  'package.json',
  'tests/e2e/untracked-probe.ts',
  workflowRelative,
  'node_modules/ignored.js',
].filter((relative) => !isExcluded(relative) && isRelevant(relative));
if (selectionSelfTest.length !== 3)
  throw new Error('autoteste da seleção tracked/untracked falhou');

const compose = await readFile(path.join(root, 'tests/e2e/compose.yml'), 'utf8');
const composeScript = await readFile(path.join(root, 'tests/e2e/scripts/compose.mjs'), 'utf8');
const seed = await readFile(path.join(root, 'tests/e2e/fixtures/seed.sql'), 'utf8');
const apiEntrypoint = await readFile(
  path.join(root, 'tests/e2e/support/api-entrypoint.mjs'),
  'utf8',
);
const legacyBaseline = await readFile(
  path.join(root, 'scripts/fixtures/001_legacy_schema.sql'),
  'utf8',
);
for (const lifecycleContract of [
  /const longRunningServices = \['api', 'worker', 'portal-api', 'portal-web'\];/u,
  /const oneShotServices = \['worker-once', 'integration-probe', 'egress-probe', 'network-probe'\];/u,
  /const locallyBuiltTestServices = \['worker-once', 'integration-probe', 'egress-probe', 'e2e'\];/u,
  /'--wait-timeout',[\s\S]*?'180',[\s\S]*?\.\.\.longRunningServices/u,
  /docker\(\['--profile', 'runner', 'build', \.\.\.locallyBuiltTestServices\]\)/u,
  /for \(const service of oneShotServices\) \{\s*await docker\(\['run', '--rm', '--no-deps', service\]\);\s*\}/u,
  /docker\(\['--profile', 'runner', 'run', '--rm', '--no-deps', 'e2e'\]\)/u,
]) {
  if (!lifecycleContract.test(composeScript)) {
    throw new Error(`lifecycle E2E long-running/one-shot incompleto: ${lifecycleContract}`);
  }
}
const testBody = composeScript.match(
  /async function test\(\) \{([\s\S]*?)\n\}\n\nasync function main/u,
)?.[1];
if (!testBody || /migrator|\['run', '--rm', (?!'--no-deps')/u.test(testBody)) {
  throw new Error(
    'test lifecycle não pode reexecutar migrator nem iniciar dependências implícitas',
  );
}
for (const oneShot of ['worker-once', 'integration-probe', 'egress-probe', 'network-probe']) {
  if (!new RegExp(`^  ${oneShot}:`, 'mu').test(compose)) {
    throw new Error(`${oneShot} ausente do Compose`);
  }
}
const runnerService = compose.match(/^ {2}e2e:\n([\s\S]*?)(?=^ {2}[a-z][\w-]*:|^networks:)/mu)?.[1];
if (!runnerService || /^ {4}depends_on:/mu.test(runnerService)) {
  throw new Error('runner E2E deve depender somente da sequência explícita do harness');
}
for (const legacyContract of [
  /CREATE TABLE message_log \(/u,
  /id SERIAL PRIMARY KEY/u,
  /phone VARCHAR\(50\) NOT NULL/u,
  /created_at TIMESTAMPTZ DEFAULT NOW\(\)/u,
  /chat_id VARCHAR\(100\)/u,
  /CREATE INDEX idx_message_log_phone_time ON message_log \(phone, created_at\)/u,
  /CREATE INDEX idx_message_log_chat_created ON message_log \(chat_id, created_at\)/u,
]) {
  if (!legacyContract.test(legacyBaseline)) {
    throw new Error(`baseline legado message_log divergente do schema medido: ${legacyContract}`);
  }
}
const tmpfsDeclarations = compose
  .split('\n')
  .map((line, index) => ({ line: line.trim(), number: index + 1 }))
  .filter(({ line }) => line.startsWith('tmpfs:'));
if (tmpfsDeclarations.length === 0) throw new Error('compose sem tmpfs hardenizado');
for (const declaration of tmpfsDeclarations) {
  if (!/^tmpfs:\s*\["\/tmp:rw,noexec,nosuid,size=\d+m"\]$/u.test(declaration.line)) {
    throw new Error(
      `tmpfs deve ser lista com um único scalar quoted; linha ${declaration.number}: ${declaration.line}`,
    );
  }
}
for (const pattern of [
  /container_name\s*:/u,
  /env_file\s*:/u,
  /^\s*ports\s*:/mu,
  /privileged\s*:\s*true/u,
  /network_mode\s*:\s*host/u,
  /extra_hosts\s*:/u,
  /docker\.sock/u,
]) {
  if (pattern.test(compose)) throw new Error(`compose inseguro: ${pattern}`);
}
for (const requiredNetwork of [
  /driver:\s*bridge/u,
  /internal:\s*true/u,
  /enable_ipv6:\s*false/u,
  /com\.docker\.network\.bridge\.gateway_mode_ipv4:\s*isolated/u,
]) {
  if (!requiredNetwork.test(compose)) {
    throw new Error(`barreira de rede ausente: ${requiredNetwork}`);
  }
}
if (!/WEBHOOK_ASYNC:\s*"true"/u.test(compose)) throw new Error('WEBHOOK_ASYNC deve estar true');
if (!/PORTAL_SIGNUP:\s*"true"/u.test(compose)) throw new Error('PORTAL_SIGNUP deve estar true');
if (!/PORTAL_SIGNUP_MATRIZ_SLOT:\s*teste_barbearia/u.test(compose)) {
  throw new Error('signup E2E deve usar a matriz real teste_barbearia');
}
const cloneSeedBlock = seed.match(
  /INSERT INTO flow_clones[\s\S]*?VALUES([\s\S]*?)ON CONFLICT/u,
)?.[1];
if (!cloneSeedBlock) throw new Error('seed não contém fixtures flow_clones reconhecíveis');
const seededClonePairs = [...cloneSeedBlock.matchAll(/\('([^']+)',\s*'([^']+)'/gu)].map(
  ([, slot, matrizSlot]) => ({ slot, matrizSlot }),
);
if (
  seededClonePairs.length === 0 ||
  seededClonePairs.some(
    ({ slot, matrizSlot }) => !slot?.startsWith('clone_') || matrizSlot !== 'teste_barbearia',
  )
) {
  throw new Error('todo flow_clone sintético deve usar prefixo clone_ e matriz teste_barbearia');
}
if (/e2e_matriz/u.test(seed) || /PORTAL_SIGNUP_MATRIZ_SLOT:\s*e2e_/u.test(compose)) {
  throw new Error('matriz sintética não pode desviar da factory real da API');
}
if (
  !/INSERT INTO bot_prompt \(slot, prompt\)\s*VALUES \('teste_barbearia', '[^']+'\)\s*ON CONFLICT \(slot\) DO NOTHING;/u.test(
    seed,
  )
) {
  throw new Error('seed deve garantir prompt sintético da matriz real sem sobrescrever migrations');
}
const apiService = compose.match(/^ {2}api:\n([\s\S]*?)(?=^ {2}[a-z][\w-]*:|^networks:)/mu)?.[1];
for (const apiBootstrapContract of [
  /\.\/support\/api-entrypoint\.mjs:\/app\/e2e-api-entrypoint\.mjs:ro/u,
  /command:\s*\[node,\s*\/app\/e2e-api-entrypoint\.mjs\]/u,
]) {
  if (!apiService || !apiBootstrapContract.test(apiService)) {
    throw new Error(`API não usa bootstrap read-only sob /app: ${apiBootstrapContract}`);
  }
}
const redisImportIndex = apiEntrypoint.indexOf("import('/app/app/dist/lib/redis.js')");
const redisReadyIndex = apiEntrypoint.indexOf('await waitForRedisReady(getRedis())');
const serverImportIndex = apiEntrypoint.indexOf("import('/app/app/dist/server.js')");
if (
  redisImportIndex < 0 ||
  redisReadyIndex <= redisImportIndex ||
  serverImportIndex <= redisReadyIndex ||
  !/redis\.status === 'ready'/u.test(apiEntrypoint) ||
  !/redis\.once\('ready', onReady\)/u.test(apiEntrypoint) ||
  !/REDIS_READY_TIMEOUT_MS/u.test(apiEntrypoint) ||
  !/process\.exit\(1\)/u.test(apiEntrypoint) ||
  /registerBot|registerCloneFactory/u.test(apiEntrypoint)
) {
  throw new Error('bootstrap deve aguardar o Redis real antes do server, sem registry sintético');
}
const integrationProbeSource = await readFile(
  path.join(root, 'tests/e2e/support/integration-probe.mjs'),
  'utf8',
);
for (const requiredProbeContract of [
  /\.\/support\/integration-probe\.mjs:\/app\/integration-probe\.mjs:ro/u,
  /command:\s*\[node,\s*\/app\/integration-probe\.mjs\]/u,
]) {
  if (!requiredProbeContract.test(compose)) {
    throw new Error(
      `integration-probe fora de /app; resolução ESM de /app/node_modules quebraria: ${requiredProbeContract}`,
    );
  }
}
for (const requiredImport of [
  /from\s+['"]pg['"]/u,
  /\/app\/packages\/integrations\/dist\/google-calendar\/index\.js/u,
  /SELECT count\(\*\)::text AS count FROM schema_migrations/u,
  /migrationResult\.rows\[0\]\?\.count !== '80'/u,
]) {
  if (!requiredImport.test(integrationProbeSource)) {
    throw new Error(`integration-probe deixou de exercitar dependência real: ${requiredImport}`);
  }
}
const egressGuardSource = await readFile(
  path.join(root, 'tests/e2e/support/egress-guard.mjs'),
  'utf8',
);
const fakeServerSource = await readFile(path.join(root, 'tests/e2e/fakes/server.mjs'), 'utf8');
const egressProbeSource = await readFile(
  path.join(root, 'tests/e2e/support/egress-probe.mjs'),
  'utf8',
);
const egressProbeService = compose.match(
  /^ {2}egress-probe:\n([\s\S]*?)(?=^ {2}[a-z][\w-]*:|^networks:)/mu,
)?.[1];
for (const egressProbeComposeContract of [
  /args:\s*\{ APP: api \}/u,
  /\.\/support\/egress-probe\.mjs:\/app\/egress-probe\.mjs:ro/u,
  /command:\s*\[node,\s*\/app\/egress-probe\.mjs\]/u,
  /E2E_ALLOWED_HOSTS:\s*fake-waha,fake-llm/u,
]) {
  if (!egressProbeService || !egressProbeComposeContract.test(egressProbeService)) {
    throw new Error(
      `egress-probe não reproduz dependências da imagem da API: ${egressProbeComposeContract}`,
    );
  }
}
const networkProbeSource = await readFile(
  path.join(root, 'tests/e2e/support/network-probe.mjs'),
  'utf8',
);
const verticalSpecSource = await readFile(
  path.join(root, 'tests/e2e/specs/vertical.spec.ts'),
  'utf8',
);
const knownBrokenRunnerSource = await readFile(
  path.join(root, 'tests/e2e/scripts/run-known-broken.mjs'),
  'utf8',
);
const knownBrokenContractSource = await readFile(
  path.join(root, 'tests/e2e/scripts/known-broken-contract.mjs'),
  'utf8',
);
const knownBrokenConfigSource = await readFile(
  path.join(root, 'tests/e2e/known-broken.config.ts'),
  'utf8',
);
const e2eRunnerDockerfileSource = await readFile(
  path.join(root, 'tests/e2e/runner/Dockerfile'),
  'utf8',
);
for (const runnerContract of [
  /await rm\(reportPath, \{ force: true \}\)/u,
  /known-broken-results-\$\{randomUUID\(\)\}\.json/u,
  /E2E_KNOWN_BROKEN_REPORT_PATH: invocationReportPath/u,
  /await rename\(invocationReportPath, reportPath\)/u,
  /validateKnownBrokenRun\(\{ manifest, report, processResult: result, reportCurrent \}\)/u,
]) {
  if (!runnerContract.test(knownBrokenRunnerSource)) {
    throw new Error(`runner known-broken não é fail-closed por invocação: ${runnerContract}`);
  }
}
for (const reportContract of [
  /processResult\?\.error !== undefined/u,
  /processResult\?\.signal !== null/u,
  /processResult\?\.status !== 1/u,
  /reportCurrent !== true/u,
  /report\.errors\.length !== 0/u,
  /manifest\?\.expectedFailures !== 2 \|\| manifestItems\.length !== 2/u,
  /spec\.title === item\.test/u,
  /tests\.length !== 1 \|\| tests\[0\]\?\.status !== 'unexpected'/u,
  /annotation\.type === 'known-broken-cause' && annotation\.description === item\.causeId/u,
  /results\.length !== 1 \|\| results\[0\]\?\.status !== 'failed'/u,
  /stripVTControlCharacters\(String\(error\?\.message \?\? ''\)\)/u,
  /messages\.includes\(fragment\)/u,
  /unexpected !== manifest\?\.expectedFailures/u,
]) {
  if (!reportContract.test(knownBrokenContractSource)) {
    throw new Error(`contrato known-broken incompleto: ${reportContract}`);
  }
}
if (!/E2E_KNOWN_BROKEN_REPORT_PATH \?\?/u.test(knownBrokenConfigSource)) {
  throw new Error('JSON reporter known-broken deve receber path único da invocação');
}
if (
  !/COPY scripts\/known-broken-contract\.mjs \.\/scripts\/known-broken-contract\.mjs/u.test(
    e2eRunnerDockerfileSource,
  )
) {
  throw new Error('runner E2E deve incluir o contrato fail-closed do known-broken');
}
for (const signupPromptContract of [
  /SELECT slot, prompt FROM bot_prompt WHERE slot = ANY\(\$1::text\[\]\) ORDER BY slot/u,
  /prompts\.map\(\(prompt\) => prompt\.slot\)\)\.toEqual\(provisionedSlots\)/u,
  /expect\(prompts\)\.toHaveLength\(4\)/u,
  /prompt\.prompt\.trim\(\)\)\.not\.toBe\(''\)/u,
  /const expectedSessionTags = provisionedSlots\.map\(sessionNameTag\)\.sort\(\)/u,
  /journalSessionTags\)\.toEqual\(expectedSessionTags\)/u,
  /new Set\(journalSessionTags\)\.size\)\.toBe\(4\)/u,
  /stateSessionTags\)\.toEqual\(expectedSessionTags\)/u,
  /new Set\(stateSessionTags\)\.size\)\.toBe\(4\)/u,
  /const \[pixFirst, pixSecond\] = await Promise\.all\(/u,
  /expect\(\[pixFirst\?\.status\(\), pixSecond\?\.status\(\)\]\)\.toEqual\(\[200, 200\]\)/u,
  /const \[firstPixBody, secondPixBody\] = await Promise\.all\(/u,
  /secondPixBody\.br_code\)\.toBe\(firstPixBody\.br_code\)/u,
  /waitForJournal\(abacateUrl, \(entry\) => entry\.path === '\/v2\/transparents\/create', 1\)/u,
  /expect\(await journalCount\(abacateUrl, \(entry\) => entry\.path === '\/v2\/transparents\/create'\)\)\.toBe\(\s*1,?\s*\)/u,
  /fakeState\(abacateUrl\)\)\.state\.charges\)\.toHaveLength\(1\)/u,
  /SELECT id::text AS id, cycle, br_code[\s\S]*?FROM billing_charges WHERE slot = \$1 ORDER BY id/u,
  /persistedCharges\)\.toHaveLength\(1\)/u,
  /\[firstPixBody\.br_code, secondPixBody\.br_code\][\s\S]*?persistedCharge\?\.br_code/u,
]) {
  if (!signupPromptContract.test(verticalSpecSource)) {
    throw new Error(`signup não prova prompts exatos e não vazios: ${signupPromptContract}`);
  }
}
for (const fakeSessionContract of [
  /function identityTag\(value\)/u,
  /function sessionProjection\(session\)/u,
  /nameTag: typeof body\.name === 'string' \? identityTag\(body\.name\) : null/u,
  /const rawName = typeof input\.name === 'string' \? input\.name : `e2e_\$\{randomUUID\(\)\}`/u,
  /state\.sessions\.set\(rawName, session\)/u,
  /sessions: \[\.\.\.state\.sessions\.values\(\)\]\.map\(sessionProjection\)/u,
  /return json\(res, 200, \[\.\.\.state\.sessions\.values\(\)\]\.map\(sessionProjection\)\)/u,
  /return json\(res, 201, sessionProjection\(session\)\)/u,
]) {
  if (!fakeSessionContract.test(fakeServerSource)) {
    throw new Error(
      `fake WAHA não preserva identidade antes da sanitização: ${fakeSessionContract}`,
    );
  }
}
if (/typeof input\.name === 'string' \? sanitizeString\(input\.name\)/u.test(fakeServerSource)) {
  throw new Error('fake WAHA não pode usar valor sanitizado como chave de sessão');
}
if (/\bname:\s*rawName\b/u.test(fakeServerSource)) {
  throw new Error('fake WAHA não pode duplicar identidade crua no valor da sessão');
}
const wahaSessionJournalProjection = fakeServerSource.match(
  /if \(kind === 'waha' && pathname === '\/api\/sessions'\) \{([\s\S]*?)\n {2}\}/u,
)?.[1];
if (!wahaSessionJournalProjection || /(?:^|\n)\s*name:/mu.test(wahaSessionJournalProjection)) {
  throw new Error('journal WAHA deve projetar tag-only e nunca o nome da sessão');
}
for (const staleJournalContract of [
  /SELECT event_type, status[\s\S]*?WHERE execution_id = \$1[\s\S]*?ORDER BY id ASC/u,
  /stale: staleEvents\.rows\.at\(-1\)\?\.status/u,
  /event_type: 'e2e\.worker-stale', status: 'running'/u,
  /event_type: 'system\.stale-closed', status: 'error'/u,
]) {
  if (!staleJournalContract.test(verticalSpecSource)) {
    throw new Error(`readiness não prova transição append-only do worker: ${staleJournalContract}`);
  }
}
for (const asyncWebhookDrainContract of [
  /SELECT COALESCE\(max\(id\), 0\)::text AS id FROM flow_execution_logs/u,
  /received\.id > \$1::bigint/u,
  /terminal\.execution_id = received\.execution_id/u,
  /terminal\.event_type = 'bot\.finished'/u,
  /terminal\.status = 'success'/u,
  /\[before\.flowLogHighWatermark, 'e2e_session_a'\]/u,
  /\.not\.toBeNull\(\)/u,
]) {
  if (!asyncWebhookDrainContract.test(verticalSpecSource)) {
    throw new Error(
      `vertical async não aguarda conclusão pelo mesmo execution_id: ${asyncWebhookDrainContract}`,
    );
  }
}
const hmacNegativeBody = verticalSpecSource.match(
  /test\('P0 WAHA rejeita assinatura ausente\/inválida e body adulterado sem efeito',[\s\S]*?\n\}\);/u,
)?.[0];
if (!hmacNegativeBody) {
  throw new Error('cenário HMAC negativo ausente');
}
if (/setTimeout\(/u.test(hmacNegativeBody)) {
  throw new Error('cenário HMAC negativo não pode depender de sleep');
}
if (/Promise\.all\([\s\S]*?client\.query/u.test(hmacNegativeBody)) {
  throw new Error('snapshot HMAC não pode executar queries concorrentes no mesmo pg.Client');
}
if (!/SELECT[\s\S]*?AS logs,[\s\S]*?AS histories,[\s\S]*?AS pauses/u.test(hmacNegativeBody)) {
  throw new Error('snapshot HMAC deve medir efeitos em uma única consulta');
}
const allowedHostBody = egressGuardSource.match(
  /function allowedHost\(host\) \{([\s\S]*?)\n\}/u,
)?.[1];
if (!allowedHostBody || /['"](?:0\.0\.0(?:\.0)?|::)['"]/u.test(allowedHostBody)) {
  throw new Error('allowedHost não pode aceitar wildcard de bind');
}
const guardedDnsPromisesLookupBody = egressGuardSource.match(
  /dns\.promises\.lookup = async function guardedDnsPromisesLookup\(hostname, options\) \{([\s\S]*?)\n\};/u,
)?.[1];
if (
  !guardedDnsPromisesLookupBody ||
  !/allowedHost\(hostname\)/u.test(guardedDnsPromisesLookupBody) ||
  /allowedDnsLookupCallbackHost|['"](?:0\.0\.0(?:\.0)?|::)['"]/u.test(guardedDnsPromisesLookupBody)
) {
  throw new Error('dns.promises.lookup deve permanecer restrito a allowedHost');
}
for (const requiredGuardContract of [
  /function allowedDnsLookupCallbackHost\(host\)/u,
  /normalized === '0\.0\.0\.0' \|\| normalized === '0\.0\.0'/u,
  /callback && allowedDnsLookupCallbackHost\(hostname\)/u,
  /dns\.promises\.lookup = async function guardedDnsPromisesLookup/u,
  /\['api\.openai\.com', llmRedirect\]/u,
  /\['api\.deepseek\.com', llmRedirect\]/u,
  /function redirectedHttpRequest\(args, sourceUrl, targetBase\)/u,
  /if \(!allowedHost\(target\.hostname\)\) throw blocked\(target\.hostname\)/u,
  /return callback \? originalHttpRequest\(redirected, callback\) : originalHttpRequest\(redirected\)/u,
  /if \(target\) return redirectedHttpRequest\(args, url, target\)/u,
]) {
  if (!requiredGuardContract.test(egressGuardSource)) {
    throw new Error(`contrato de bind sem ampliar egress ausente: ${requiredGuardContract}`);
  }
}
for (const requiredEgressProbe of [
  /bindServer\.listen\(0, '0\.0\.0\.0', resolve\)/u,
  /fetch\('http:\/\/0\.0\.0\.0\/'\)/u,
  /request\(http, 'http:\/\/0\.0\.0\.0\/'\)/u,
  /request\(https, 'https:\/\/0\.0\.0\.0\/'\)/u,
  /connect\('0\.0\.0\.0'\)/u,
  /connect\('0\.0\.0'\)/u,
  /dns\.lookup\('0\.0\.0\.0'\)/u,
  /dns\.lookup\('0\.0\.0'\)/u,
  /fetchWithNodeFetch\('https:\/\/example\.invalid\/'\)/u,
  /new OpenAI\(\{ apiKey: 'e2e_openai_probe_key' \}\)/u,
  /baseURL: 'https:\/\/api\.deepseek\.com\/v1'/u,
  /\['egress-deepseek', 'egress-openai'\]/u,
]) {
  if (!requiredEgressProbe.test(egressProbeSource)) {
    throw new Error(`contraprova de wildcard ausente: ${requiredEgressProbe}`);
  }
}
if (!/dns\.resolve4\('example\.com'\)/u.test(networkProbeSource)) {
  throw new Error('network-probe deve provar bloqueio de dns.resolve4 externo sem guard');
}
if (
  !/mcr\.microsoft\.com\/playwright:v1\.55\.1-noble/u.test(
    await readFile(path.join(root, 'tests/e2e/runner/Dockerfile'), 'utf8'),
  )
) {
  throw new Error('imagem Playwright deve acompanhar @playwright/test 1.55.1');
}

const workflow = await readFile(path.join(root, workflowRelative), 'utf8');
for (const requiredWorkflow of [
  /^permissions:\s*\n\s+contents:\s*read/mu,
  /runs-on:\s*ubuntu-24\.04/u,
  /persist-credentials:\s*false/u,
  /npm run e2e:typecheck/u,
  /npm run e2e:preflight/u,
  /npm run e2e\s*$/mu,
]) {
  if (!requiredWorkflow.test(workflow)) {
    throw new Error(`workflow E2E incompleto: ${requiredWorkflow}`);
  }
}

const relevantSources = [];
for (const relative of relevantFiles) {
  const source = await readText(relative);
  if (source !== null) relevantSources.push({ relative, source });
}
for (const { relative, source } of relevantSources) {
  if (/\.(?:only)\s*\(/u.test(source)) throw new Error(`.only proibido: ${relative}`);
  if (/\b(?:test|it|describe)\.(?:skip|fixme)\s*\(/u.test(source)) {
    throw new Error(`skip/fixme proibido: ${relative}`);
  }
}

const forbiddenHosts = /187\.77\.242\.220|(?:^|[^\w.-])(?:gestao\.|app\.)?startap\.tech\b/iu;
const realPhone = /\b(?:\+?55)?\d{10,11}\b/u;
const secretPatterns = [
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----\s*(?:[A-Za-z0-9+/=]{32,}\s*)+-----END (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/u,
  /\bgh[opusr]_[A-Za-z0-9]{20,}\b/u,
  /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/u,
  /\bAKIA[0-9A-Z]{16}\b/u,
  /\bAIza[0-9A-Za-z_-]{30,}\b/u,
];
for (const { relative, source } of relevantSources) {
  if (forbiddenHosts.test(source)) throw new Error(`host de produção encontrado: ${relative}`);
  if (realPhone.test(source)) throw new Error(`telefone com formato real encontrado: ${relative}`);
}

// Segredos de alta confiança são varridos em toda a árvore tracked/untracked textual,
// não só no diff. Isso continua ativo em checkout limpo e inclui arquivos recém-criados.
for (const relative of repoFiles) {
  const source = await readText(relative);
  if (source === null) continue;
  for (const pattern of secretPatterns) {
    if (pattern.test(source)) throw new Error(`credencial potencial encontrada: ${relative}`);
  }
}

const syntheticAllowed = [
  "const phone = '880000000001'",
  "const chat = '990000000001@c.us'",
  "const apiKey = 'e2e_openai_key'",
].join('\n');
if (
  forbiddenHosts.test(syntheticAllowed) ||
  realPhone.test(syntheticAllowed) ||
  secretPatterns.some((pattern) => pattern.test(syntheticAllowed))
) {
  throw new Error('allowlist sintética deixou de aceitar identificadores E2E explícitos');
}
const syntheticLeaks = [
  ['187', '77', '242', '220'].join('.'),
  ['55', '11', '98765', '4321'].join(''),
  ['ghp', 'A'.repeat(24)].join('_'),
];
if (
  !forbiddenHosts.test(syntheticLeaks[0]) ||
  !realPhone.test(syntheticLeaks[1]) ||
  !secretPatterns.some((pattern) => pattern.test(syntheticLeaks[2]))
) {
  throw new Error('autoteste dos detectores de host/telefone/segredo falhou');
}

await probeFakeSessionSinks();
await execFile(process.execPath, ['tests/e2e/scripts/test-known-broken-contract.mjs'], {
  cwd: root,
  encoding: 'utf8',
});

process.stdout.write(
  `E2E harness estático + probes HTTP/known-broken: ${relevantFiles.length} arquivos relevantes + ${repoFiles.length} tracked/untracked inspecionados; sem dependência de diff HEAD.\n`,
);
