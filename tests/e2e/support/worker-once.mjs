import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { runCloseStaleRunning } from '/app/dist/jobs/close-stale-running.js';

const { Client } = pg;

function pgConnectionString() {
  if (process.env.E2E_PG_URL) return process.env.E2E_PG_URL;
  const user = encodeURIComponent(process.env.PG_USER ?? 'e2e_app');
  const pass = encodeURIComponent(process.env.PG_PASS ?? 'e2e_app_password');
  const host = process.env.PG_HOST ?? 'postgres';
  const port = process.env.PG_PORT ?? '5432';
  const db = process.env.PG_DB ?? 'startap_e2e';
  return `postgres://${user}:${pass}@${host}:${port}/${db}`;
}

const executionId = randomUUID();
const client = new Client({ connectionString: pgConnectionString() });
await client.connect();
try {
  await client.query(
    `INSERT INTO flow_execution_logs
       (execution_id, flow_id, flow_name, bot, session, event_type, status, message, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, 'running', $7, NOW() - INTERVAL '10 minutes')`,
    [
      executionId,
      'clone_e2e_tenant_a',
      'Empresa homonima',
      'clone_e2e_tenant_a',
      'e2e_worker_probe_once',
      'e2e.worker-stale-once',
      'Marcador sintetico isolado para worker-once E2E',
    ],
  );
} finally {
  await client.end();
}

const result = await runCloseStaleRunning();
if (result.closed < 1) {
  throw new Error(`worker-once expected at least one stale row, got ${result.closed}`);
}

const verifyClient = new Client({ connectionString: pgConnectionString() });
await verifyClient.connect();
try {
  const events = await verifyClient.query(
    `SELECT event_type, status
       FROM flow_execution_logs
      WHERE execution_id = $1
      ORDER BY id ASC`,
    [executionId],
  );
  const simplified = events.rows.map((row) => ({
    event_type: row.event_type,
    status: row.status,
  }));
  const expected = [
    { event_type: 'e2e.worker-stale-once', status: 'running' },
    { event_type: 'system.stale-closed', status: 'error' },
  ];
  if (JSON.stringify(simplified) !== JSON.stringify(expected)) {
    throw new Error(
      `worker-once stale transition mismatch: ${JSON.stringify({
        executionId,
        result,
        events: simplified,
      })}`,
    );
  }
} finally {
  await verifyClient.end();
}
