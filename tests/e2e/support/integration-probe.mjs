import { generateKeyPairSync, randomUUID } from 'node:crypto';
import pg from 'pg';
import { AbacatePayClient } from '/app/packages/integrations/dist/abacatepay/index.js';
import { GoogleCalendarClient } from '/app/packages/integrations/dist/google-calendar/index.js';

const { Client } = pg;
const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const privateKeyPem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();

const calendar = new GoogleCalendarClient({
  calendarId: 'e2e-calendar',
  credentialsJson: JSON.stringify({
    type: 'service_account',
    client_email: 'probe@invalid.example',
    private_key: privateKeyPem,
    token_uri: 'https://oauth2.googleapis.com/token',
  }),
});
await calendar.listEvents({
  timeMin: '2099-01-01T00:00:00.000Z',
  timeMax: '2099-01-02T00:00:00.000Z',
});

const abacate = new AbacatePayClient({
  apiKey: 'abc_dev_e2e',
  baseUrl: 'http://fake-abacatepay:4012',
});
await abacate.createPixCharge({
  slot: 'e2e_probe',
  cycle: '2099-01',
  amountCents: 1234,
  description: 'probe e2e',
  expiresInSec: 600,
});

const [gcalState, abacateState] = await Promise.all([
  fetch('http://fake-gcal:4011/__admin/state').then((response) => response.json()),
  fetch('http://fake-abacatepay:4012/__admin/state').then((response) => response.json()),
]);
const gcalPaths = Array.isArray(gcalState.journal)
  ? gcalState.journal.map((entry) => entry.path)
  : [];
const abacatePaths = Array.isArray(abacateState.journal)
  ? abacateState.journal.map((entry) => entry.path)
  : [];
if (!gcalPaths.includes('/token') || !gcalPaths.some((path) => path.endsWith('/events'))) {
  throw new Error('GoogleCalendarClient não atravessou token + events no fake');
}
if (!abacatePaths.includes('/v2/transparents/create')) {
  throw new Error('AbacatePayClient não atravessou create no fake');
}

const client = new Client({ connectionString: process.env.E2E_PG_URL });
await client.connect();
try {
  // NAO reimplementa a contagem EXATA de migrations aqui (SCRUM-173/181): esse guard
  // forte e derivado (baseline + contagem real de packages/db/migrations/*.sql) ja roda
  // em migrate-e2e.sh, ANTES deste probe (compose.yml: depends_on migrator com
  // service_completed_successfully — se o guard do migrator falhar, este container nem
  // inicia). Um numero hardcoded AQUI TAMBEM quebraria a cada migration nova (foi
  // exatamente o que aconteceu com a 081 do SCRUM-173) e a imagem runtime deste container
  // nem tem os .sql fonte pra contar de novo (o Dockerfile so copia dist/, nao
  // packages/db/migrations/). Esta checagem prova so que o schema FOI migrado (nao
  // esta vazio/incompleto por algum motivo o migrator nao pegou) — a garantia forte de
  // "= N migrations exatas" e do guard derivado em migrate-e2e.sh.
  const migrationResult = await client.query(
    'SELECT count(*)::int AS count FROM schema_migrations',
  );
  const migrationCount = migrationResult.rows[0]?.count ?? 0;
  if (migrationCount < 2) {
    // < 2 = nem o baseline (001) + alguma migration versionada aplicaram — schema vazio
    // ou o migrator não rodou de fato (o depends_on deveria ter impedido isso).
    throw new Error(
      `schema_migrations vazio/incompleto: esperado >=2 (baseline+versionadas), obtido=${migrationCount}`,
    );
  }
  await client.query(
    `INSERT INTO flow_execution_logs
       (execution_id, flow_id, flow_name, event_type, status, message, metadata)
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)`,
    [
      randomUUID(),
      'e2e_integration_probe',
      'e2e-integration-probe',
      'e2e.integration-probe',
      'success',
      'GCal e AbacatePay clientes reais alcançaram fakes isolados',
      JSON.stringify({ gcal: true, abacatepay: true }),
    ],
  );
} finally {
  await client.end();
}
