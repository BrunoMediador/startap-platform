import { createHash, createHmac } from 'node:crypto';
import { expect, request as playwrightRequest, test } from '@playwright/test';
import type { APIRequestContext } from '@playwright/test';
import { Redis } from 'ioredis';
import pg from 'pg';
import type { Client as PgClient } from 'pg';

const { Client } = pg;
const apiUrl = process.env.E2E_API_URL ?? 'http://api:3040';
const portalApiUrl = process.env.E2E_PORTAL_API_URL ?? 'http://portal-api:3051';
const portalWebUrl = process.env.E2E_PORTAL_WEB_URL ?? 'http://portal-web:3050';
const wahaUrl = process.env.E2E_WAHA_URL ?? 'http://fake-waha:4010';
const gcalUrl = process.env.E2E_GCAL_URL ?? 'http://fake-gcal:4011';
const abacateUrl = process.env.E2E_ABACATEPAY_URL ?? 'http://fake-abacatepay:4012';
const llmUrl = process.env.E2E_LLM_URL ?? 'http://fake-llm:4013';
const fakeUrls = [wahaUrl, gcalUrl, abacateUrl, llmUrl];
const syntheticChat = '990000000001@c.us';

type JournalEntry = {
  seq: number;
  kind: string;
  method: string;
  path: string;
  body: Record<string, unknown>;
};

type FakeState = {
  journal: JournalEntry[];
  state: {
    charges: unknown[];
    events: unknown[];
    sessions: Array<{ nameTag: string; status: string }>;
  };
  faults: unknown[];
};

type InboundResult = { upstreamStatus: number; upstreamBody: { status?: string } };

function envelope(
  session: string,
  id: string,
  options: {
    fromMe?: boolean;
    chat?: string;
    body?: string;
    omitBody?: boolean;
    media?: Record<string, unknown>;
    data?: Record<string, unknown>;
  } = {},
) {
  const payload: Record<string, unknown> = {
    id,
    from: options.chat ?? syntheticChat,
    fromMe: options.fromMe ?? false,
    hasMedia: options.media !== undefined,
    _data: {
      pushName: 'Pessoa E2E',
      messageTimestamp: Math.floor(Date.now() / 1000),
      ...(options.data ?? {}),
    },
  };
  if (!options.omitBody) payload.body = options.body ?? 'mensagem e2e';
  if (options.media) payload.media = options.media;
  return { event: 'message', session, payload };
}

function sessionNameTag(name: string) {
  return createHash('sha256').update(name).digest('hex').slice(0, 16);
}

async function inbound(
  body: object,
  options: { invalidHmac?: boolean; omitHmac?: boolean; tamperAfterSign?: boolean } = {},
): Promise<InboundResult> {
  const response = await fetch(`${wahaUrl}/__admin/inbound`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ envelope: body, ...options }),
  });
  expect(response.ok).toBeTruthy();
  return (await response.json()) as InboundResult;
}

async function signupPortal(input: {
  phone: string;
  name: string;
  password: string;
  type: 'individual' | 'estabelecimento';
  mode: 'agenda' | 'atende' | 'atendente';
}): Promise<APIRequestContext> {
  const context = await playwrightRequest.newContext({ baseURL: portalApiUrl });
  const response = await context.post('/auth/signup', {
    data: {
      nome_negocio: input.name,
      whatsapp: input.phone,
      senha: input.password,
      area: 'outro',
      timezone: 'America/Sao_Paulo',
      aceite_termos: true,
      tipo_atendimento: input.type,
      modo_ia: input.mode,
    },
  });
  expect(response.status()).toBe(201);
  expect((await response.json()).user.username).toBe(input.phone);
  expect((await context.get('/auth/me')).status()).toBe(200);
  return context;
}

async function fakeState(url: string): Promise<FakeState> {
  const response = await fetch(`${url}/__admin/state`);
  expect(response.ok).toBeTruthy();
  return (await response.json()) as FakeState;
}

async function journalCount(
  url: string,
  predicate: (entry: JournalEntry) => boolean,
): Promise<number> {
  return (await fakeState(url)).journal.filter(predicate).length;
}

async function waitForJournal(
  url: string,
  predicate: (entry: JournalEntry) => boolean,
  expected = 1,
): Promise<void> {
  await expect.poll(() => journalCount(url, predicate), { timeout: 12_000 }).toBe(expected);
}

async function withDb<T>(fn: (client: PgClient) => Promise<T>): Promise<T> {
  const client = new Client({ connectionString: process.env.E2E_PG_URL });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

async function resetFakes(): Promise<void> {
  for (const url of fakeUrls) {
    const response = await fetch(`${url}/__admin/reset`, { method: 'POST' });
    expect(response.ok).toBeTruthy();
  }
}

function abacateBody(eventId: string, slot: 'owner' | 'billing'): string {
  return JSON.stringify({
    id: eventId,
    event: 'transparent.completed',
    data: {
      transparent: {
        id: `pix_e2e_${slot}`,
        status: 'PAID',
        paidAmount: 10000,
        externalId: `e2e_${slot}-2099-01-01`,
      },
    },
  });
}

function abacateSignature(raw: string): string {
  return createHmac('sha256', 'e2e_abacate_hmac').update(raw).digest('base64');
}

async function postAbacate(
  raw: string,
  options: { query?: string; signature?: string; omitSignature?: boolean } = {},
) {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (!options.omitSignature) {
    headers['x-webhook-signature'] = options.signature ?? abacateSignature(raw);
  }
  return fetch(
    `${apiUrl}/webhooks/abacatepay?webhookSecret=${encodeURIComponent(options.query ?? 'e2e_abacate_query')}`,
    { method: 'POST', headers, body: raw },
  );
}

// O Compose configura WEBHOOK_MAX_INFLIGHT=1 para reproduzir backpressure. Um único
// worker/serial evita que cenários independentes disputem intencionalmente esse semáforo;
// cada teste usa IDs, chats e fixtures próprias e não depende do resultado do anterior.
test.describe.configure({ mode: 'serial' });

test.beforeEach(async ({ browserName: _browserName }, testInfo) => {
  if (testInfo.title.startsWith('readiness:')) return;
  await resetFakes();
});

test('readiness: apps, worker real, integrações reais, migrations, Redis e fakes', async ({
  page,
}) => {
  for (const url of [apiUrl, portalApiUrl]) {
    expect((await fetch(`${url}/health`)).status).toBe(200);
  }
  for (const url of fakeUrls) expect((await fetch(`${url}/health`)).status).toBe(200);

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${portalWebUrl}/cadastro`);
  await expect(page.getByText('Começar meu teste grátis')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.reload();
  await expect(page.getByText('Começar meu teste grátis')).toBeVisible();

  const state = await withDb(async (client) => {
    const migrations = await client.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM schema_migrations',
    );
    const staleEvents = await client.query<{ event_type: string; status: string }>(
      `SELECT event_type, status
         FROM flow_execution_logs
        WHERE execution_id = $1
        ORDER BY id ASC`,
      ['00000000-0000-4000-8000-000000000171'],
    );
    const integration = await client.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM flow_execution_logs WHERE event_type = $1',
      ['e2e.integration-probe'],
    );
    return {
      migrations: Number(migrations.rows[0]?.count ?? 0),
      staleEvents: staleEvents.rows,
      stale: staleEvents.rows.at(-1)?.status,
      integration: Number(integration.rows[0]?.count ?? 0),
    };
  });
  expect(state).toEqual({
    migrations: 80,
    staleEvents: [
      { event_type: 'e2e.worker-stale', status: 'running' },
      { event_type: 'system.stale-closed', status: 'error' },
    ],
    stale: 'error',
    integration: 1,
  });
  expect((await fakeState(gcalUrl)).journal.some((entry) => entry.kind === 'gcal')).toBeTruthy();
  expect(
    (await fakeState(abacateUrl)).journal.some((entry) => entry.kind === 'abacatepay'),
  ).toBeTruthy();

  const redis = new Redis(process.env.E2E_REDIS_URL ?? '');
  expect(await redis.ping()).toBe('PONG');
  redis.disconnect();
});

test('P0 vertical: HMAC válido atravessa API async, runtime, LLM, WAHA, PG e Redis', async () => {
  const before = await withDb(async (client) => {
    const result = await client.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM chat_histories
       WHERE session_id LIKE 'clone_e2e_tenant_a:e2e_session_a:%'`,
    );
    return Number(result.rows[0]?.count ?? 0);
  });
  const first = await inbound(envelope('e2e_session_a', 'vertical-1'));
  expect(first).toEqual({ upstreamStatus: 200, upstreamBody: { status: 'accepted' } });

  await waitForJournal(
    wahaUrl,
    (entry) => entry.path === '/api/sendText' && entry.body.session === 'e2e_session_a',
  );
  await waitForJournal(llmUrl, (entry) => entry.path.endsWith('/chat/completions'));
  await expect
    .poll(
      () =>
        withDb(async (client) => {
          const result = await client.query<{ count: string }>(
            `SELECT count(*)::text AS count FROM chat_histories
             WHERE session_id LIKE 'clone_e2e_tenant_a:e2e_session_a:%'`,
          );
          return Number(result.rows[0]?.count ?? 0);
        }),
      { timeout: 12_000 },
    )
    .toBe(before + 2);

  const redis = new Redis(process.env.E2E_REDIS_URL ?? '');
  const keys = await redis.keys('*vertical-1*');
  expect(keys).toHaveLength(1);
  expect(keys[0]).toContain('e2e_session_a');
  redis.disconnect();
});

test('P0 WAHA rejeita assinatura ausente/inválida e body adulterado sem efeito', async () => {
  const phone = '990000000021';
  const ids = ['missing-hmac-1', 'invalid-hmac-1', 'tampered-hmac-1'];
  const snapshot = () =>
    withDb(async (client) => {
      const [logs, histories, pauses] = await Promise.all([
        client.query<{ count: string }>(
          'SELECT count(*)::text AS count FROM flow_execution_logs WHERE session = $1',
          ['e2e_session_a'],
        ),
        client.query<{ count: string }>(
          'SELECT count(*)::text AS count FROM chat_histories WHERE session_id LIKE $1',
          [`%${phone}%`],
        ),
        client.query<{ count: string }>(
          'SELECT count(*)::text AS count FROM flow_pauses WHERE telefone = $1',
          [phone],
        ),
      ]);
      return {
        logs: Number(logs.rows[0]?.count ?? 0),
        histories: Number(histories.rows[0]?.count ?? 0),
        pauses: Number(pauses.rows[0]?.count ?? 0),
      };
    });
  const before = await snapshot();
  expect(before.histories).toBe(0);
  expect(before.pauses).toBe(0);

  const missing = await inbound(envelope('e2e_session_a', ids[0], { chat: `${phone}@c.us` }), {
    omitHmac: true,
  });
  const invalid = await inbound(envelope('e2e_session_a', ids[1], { chat: `${phone}@c.us` }), {
    invalidHmac: true,
  });
  const tampered = await inbound(envelope('e2e_session_a', ids[2], { chat: `${phone}@c.us` }), {
    tamperAfterSign: true,
  });
  expect(missing.upstreamStatus).toBe(401);
  expect(invalid.upstreamStatus).toBe(401);
  expect(tampered.upstreamStatus).toBe(401);
  expect(await journalCount(wahaUrl, (entry) => entry.path === '/api/sendText')).toBe(0);
  expect(await journalCount(llmUrl, (entry) => entry.path.endsWith('/chat/completions'))).toBe(0);
  await new Promise((resolve) => setTimeout(resolve, 250));
  const after = await snapshot();
  expect(after).toEqual(before);
  const redis = new Redis(process.env.E2E_REDIS_URL ?? '');
  for (const id of ids) expect(await redis.keys(`*${id}*`)).toHaveLength(0);
  redis.disconnect();
});

test('security: fake redige path normal/percent-encoded, fault e 404 por allowlist', async () => {
  const email = ['probe', 'invalid.example'].join('@');
  const token = ['sk', 'synthetic', 'x'.repeat(40)].join('-');
  const rawPath = `/unknown/${email}/${token}`;
  const encodedPath = `/unknown/${encodeURIComponent(email)}/${encodeURIComponent(token)}`;

  for (const pathname of [rawPath, encodedPath]) {
    const response = await fetch(`${wahaUrl}${pathname}`);
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({
      error: 'fake_route_not_found',
      kind: 'waha',
      route: 'unmatched',
    });
  }

  const injected = await fetch(`${wahaUrl}/__admin/faults`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      path: rawPath,
      status: 503,
      body: { error: email, token },
    }),
  });
  expect(injected.status).toBe(200);
  const state = await fakeState(wahaUrl);
  expect(state.journal.map((entry) => entry.path)).toEqual(['unmatched', 'unmatched']);
  expect(state.faults).toEqual([
    expect.objectContaining({
      route: 'unmatched',
      status: 503,
      body: { error: '[email-redacted]', token: '[token-redacted]' },
    }),
  ]);
  const serialized = JSON.stringify(state);
  expect(serialized).not.toContain(email);
  expect(serialized).not.toContain(token);
});

test('P0 SCRUM-580: 503 antes do dedup permite retry do mesmo id e processa uma vez', async () => {
  const inject = await fetch(`${llmUrl}/__admin/faults`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      path: '/v1/chat/completions',
      delayMs: 2_000,
      passthrough: true,
      times: 1,
    }),
  });
  expect(inject.status).toBe(200);

  const blocker = await inbound(envelope('e2e_session_a', 'retry-blocker-1'));
  expect(blocker.upstreamBody.status).toBe('accepted');
  await waitForJournal(llmUrl, (entry) => entry.path.endsWith('/chat/completions'));

  const target = envelope('e2e_session_b', 'retry-target-580');
  const saturated = await inbound(target);
  expect(saturated).toEqual({ upstreamStatus: 503, upstreamBody: { status: 'busy:retry' } });

  const redis = new Redis(process.env.E2E_REDIS_URL ?? '');
  expect(await redis.keys('*retry-target-580*')).toHaveLength(0);
  await waitForJournal(
    wahaUrl,
    (entry) => entry.path === '/api/sendText' && entry.body.session === 'e2e_session_a',
  );

  const retry = await inbound(target);
  expect(retry.upstreamBody.status).toBe('accepted');
  await waitForJournal(
    wahaUrl,
    (entry) => entry.path === '/api/sendText' && entry.body.session === 'e2e_session_b',
  );
  expect(await redis.keys('*retry-target-580*')).toHaveLength(1);
  const duplicate = await inbound(target);
  expect(duplicate.upstreamBody.status).toBe('ignored:dedup');
  expect(
    await journalCount(
      wahaUrl,
      (entry) => entry.path === '/api/sendText' && entry.body.session === 'e2e_session_b',
    ),
  ).toBe(1);
  redis.disconnect();
});

test('P0 dois tenants homônimos e mesmo chat não cruzam PG, provider, WAHA nem Redis', async () => {
  expect((await inbound(envelope('e2e_session_a', 'tenant-a-isolation'))).upstreamBody.status).toBe(
    'accepted',
  );
  await waitForJournal(
    wahaUrl,
    (entry) => entry.path === '/api/sendText' && entry.body.session === 'e2e_session_a',
  );
  expect((await inbound(envelope('e2e_session_b', 'tenant-b-isolation'))).upstreamBody.status).toBe(
    'accepted',
  );
  await waitForJournal(
    wahaUrl,
    (entry) => entry.path === '/api/sendText' && entry.body.session === 'e2e_session_b',
  );

  const sessions = await withDb(async (client) => {
    const result = await client.query<{ session_id: string }>(
      `SELECT DISTINCT session_id FROM chat_histories
       WHERE session_id LIKE 'clone_e2e_tenant_a:e2e_session_a:%'
          OR session_id LIKE 'clone_e2e_tenant_b:e2e_session_b:%'`,
    );
    return result.rows.map((row) => row.session_id);
  });
  expect(sessions.some((session) => session.startsWith('clone_e2e_tenant_a:e2e_session_a:'))).toBe(
    true,
  );
  expect(sessions.some((session) => session.startsWith('clone_e2e_tenant_b:e2e_session_b:'))).toBe(
    true,
  );
  expect(sessions.every((session) => !session.includes('e2e_session_a:e2e_session_b'))).toBe(true);

  const models = (await fakeState(llmUrl)).journal
    .filter((entry) => entry.kind === 'llm')
    .map((entry) => entry.body.model);
  expect(models).toEqual(expect.arrayContaining(['gpt-e2e', 'deepseek-chat']));
  const redis = new Redis(process.env.E2E_REDIS_URL ?? '');
  const aKeys = await redis.keys('*tenant-a-isolation*');
  const bKeys = await redis.keys('*tenant-b-isolation*');
  expect(aKeys).toHaveLength(1);
  expect(bKeys).toHaveLength(1);
  expect(aKeys[0]).toContain('e2e_session_a');
  expect(bKeys[0]).toContain('e2e_session_b');
  redis.disconnect();
});

for (const mediaCase of [
  {
    name: 'áudio body vazio',
    phone: '990000000011',
    options: {
      fromMe: true,
      body: '',
      media: { mimetype: 'audio/ogg', data: 'synthetic-audio' },
    },
  },
  {
    name: 'PTT body ausente',
    phone: '990000000012',
    options: {
      fromMe: true,
      omitBody: true,
      media: { mimetype: 'audio/ogg; codecs=opus', data: 'synthetic-ptt' },
      data: { ptt: true },
    },
  },
  {
    name: 'imagem body ausente',
    phone: '990000000013',
    options: {
      fromMe: true,
      omitBody: true,
      media: { mimetype: 'image/png', data: 'synthetic-image' },
    },
  },
] as const) {
  test(`P0 fromMe ${mediaCase.name}: pausa tenant certo e zero LLM/outbound/cross-tenant`, async () => {
    const id = `fromme-media-${mediaCase.name.replace(/\s+/gu, '-')}`;
    const before = await withDb(async (client) => {
      const result = await client.query<{ count: string }>(
        'SELECT count(*)::text AS count FROM flow_pauses WHERE telefone = $1',
        [mediaCase.phone],
      );
      return Number(result.rows[0]?.count ?? 0);
    });
    expect(before).toBe(0);
    const startedAt = Date.now();
    const result = await inbound(
      envelope('e2e_session_a', id, {
        ...mediaCase.options,
        chat: `${mediaCase.phone}@c.us`,
      }),
    );
    expect(result.upstreamBody.status).toBe('accepted');

    await expect
      .poll(
        () =>
          withDb(async (client) => {
            const result = await client.query<{
              flow_id: string;
              source: string;
              updated_at_ms: string;
            }>(
              `SELECT flow_id, source,
                      (extract(epoch FROM updated_at) * 1000)::bigint::text AS updated_at_ms
               FROM flow_pauses
               WHERE telefone = $1 AND active = TRUE ORDER BY flow_id`,
              [mediaCase.phone],
            );
            return result.rows;
          }),
        { timeout: 12_000 },
      )
      .toEqual([
        expect.objectContaining({
          flow_id: 'clone_e2e_tenant_a',
          source: 'human_reply',
          updated_at_ms: expect.any(String),
        }),
      ]);
    const pause = await withDb(async (client) => {
      const result = await client.query<{ updated_at_ms: string }>(
        `SELECT (extract(epoch FROM updated_at) * 1000)::bigint::text AS updated_at_ms
         FROM flow_pauses WHERE flow_id = $1 AND telefone = $2`,
        ['clone_e2e_tenant_a', mediaCase.phone],
      );
      return result.rows[0];
    });
    expect(Number(pause?.updated_at_ms ?? 0)).toBeGreaterThanOrEqual(startedAt - 1_000);
    const crossTenant = await withDb(async (client) => {
      const result = await client.query<{ count: string }>(
        'SELECT count(*)::text AS count FROM flow_pauses WHERE telefone = $1 AND flow_id <> $2',
        [mediaCase.phone, 'clone_e2e_tenant_a'],
      );
      return Number(result.rows[0]?.count ?? 0);
    });
    expect(crossTenant).toBe(0);
    expect(await journalCount(wahaUrl, (entry) => entry.path === '/api/sendText')).toBe(0);
    expect(await journalCount(llmUrl, (entry) => entry.path.endsWith('/chat/completions'))).toBe(0);
  });
}

test('P0 inadimplente tem silêncio total: sem LLM, WAHA ou memória', async () => {
  const before = await withDb(async (client) => {
    const result = await client.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM chat_histories
       WHERE session_id LIKE 'clone_e2e_overdue:e2e_session_overdue:%'`,
    );
    return Number(result.rows[0]?.count ?? 0);
  });
  const result = await inbound(envelope('e2e_session_overdue', 'overdue-silence-1'));
  expect(result.upstreamBody.status).toBe('accepted');
  await expect
    .poll(
      () =>
        withDb(async (client) =>
          client
            .query<{ count: string }>(
              `SELECT count(*)::text AS count FROM flow_execution_logs
               WHERE flow_id = $1 AND event_type = 'router.billing-overdue'`,
              ['clone_e2e_overdue'],
            )
            .then((query) => Number(query.rows[0]?.count ?? 0)),
        ),
      { timeout: 12_000 },
    )
    .toBeGreaterThan(0);
  expect(await journalCount(wahaUrl, (entry) => entry.path === '/api/sendText')).toBe(0);
  expect(await journalCount(llmUrl, (entry) => entry.path.endsWith('/chat/completions'))).toBe(0);
  const after = await withDb(async (client) => {
    const result = await client.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM chat_histories
       WHERE session_id LIKE 'clone_e2e_overdue:e2e_session_overdue:%'`,
    );
    return Number(result.rows[0]?.count ?? 0);
  });
  expect(after).toBe(before);
});

test('P0 AbacatePay rejeita assinatura ausente/errada/adulterada/query inválida sem efeito', async () => {
  const before = await withDb(async (client) => {
    const result = await client.query<{ status: string; next_due_date: Date | null }>(
      'SELECT status, next_due_date FROM client_billing WHERE slot = $1',
      ['clone_e2e_owner'],
    );
    return result.rows[0];
  });
  const raw = abacateBody('paid-owner-negative', 'owner');
  const cases = [
    postAbacate(raw, { omitSignature: true }),
    postAbacate(raw, { signature: 'invalid-signature' }),
    postAbacate(`${raw} `, { signature: abacateSignature(raw) }),
    postAbacate(raw, { query: 'invalid-query' }),
  ];
  for (const response of await Promise.all(cases)) expect(response.status).toBe(401);
  const after = await withDb(async (client) => {
    const result = await client.query<{ status: string; next_due_date: Date | null }>(
      'SELECT status, next_due_date FROM client_billing WHERE slot = $1',
      ['clone_e2e_owner'],
    );
    return result.rows[0];
  });
  expect(after).toEqual(before);
});

test('P0 pagamento remove billing, preserva owner_request e mantém silêncio do owner', async () => {
  const owner = await postAbacate(abacateBody('paid-owner-valid', 'owner'));
  const billing = await postAbacate(abacateBody('paid-billing-valid', 'billing'));
  expect(owner.status).toBe(200);
  expect(await owner.json()).toMatchObject({ status: 'applied', resumed: false });
  expect(billing.status).toBe(200);
  expect(await billing.json()).toMatchObject({ status: 'applied', resumed: true });

  const states = await withDb(async (client) => {
    const result = await client.query<{
      slot: string;
      flow_enabled: boolean;
      suspended_kind: string | null;
    }>(
      `SELECT slot, flow_enabled, suspended_kind FROM flow_clones
       WHERE slot IN ($1, $2) ORDER BY slot`,
      ['clone_e2e_owner', 'clone_e2e_billing'],
    );
    return result.rows;
  });
  expect(states).toEqual([
    { slot: 'clone_e2e_billing', flow_enabled: true, suspended_kind: null },
    { slot: 'clone_e2e_owner', flow_enabled: false, suspended_kind: 'owner_request' },
  ]);

  expect(
    (await inbound(envelope('e2e_session_billing', 'billing-after-paid'))).upstreamBody.status,
  ).toBe('accepted');
  await waitForJournal(
    wahaUrl,
    (entry) => entry.path === '/api/sendText' && entry.body.session === 'e2e_session_billing',
  );
  expect(
    (await inbound(envelope('e2e_session_owner', 'owner-after-paid'))).upstreamBody.status,
  ).toBe('accepted');
  await expect
    .poll(
      () =>
        withDb(async (client) =>
          client
            .query<{ count: string }>(
              `SELECT count(*)::text AS count FROM flow_execution_logs
               WHERE flow_id = $1 AND event_type = 'router.owner-paused'`,
              ['clone_e2e_owner'],
            )
            .then((query) => Number(query.rows[0]?.count ?? 0)),
        ),
      { timeout: 12_000 },
    )
    .toBeGreaterThan(0);
  expect(
    await journalCount(
      wahaUrl,
      (entry) => entry.path === '/api/sendText' && entry.body.session === 'e2e_session_owner',
    ),
  ).toBe(0);
});

test('P0 signup real provisiona os quatro formatos e valida PG, sessão WAHA e portal', async () => {
  const formats = [
    {
      phone: '880000000001',
      type: 'individual',
      mode: 'agenda',
      product: 'individual',
      seat: null,
      attendant: false,
      billingFromAgenda: true,
      amount: 14700,
      agendaOff: false,
    },
    {
      phone: '880000000002',
      type: 'individual',
      mode: 'atendente',
      product: 'individual',
      seat: null,
      attendant: true,
      billingFromAgenda: false,
      amount: 9700,
      agendaOff: true,
    },
    {
      phone: '880000000003',
      type: 'estabelecimento',
      mode: 'agenda',
      product: 'estabelecimento',
      seat: 5,
      attendant: false,
      billingFromAgenda: true,
      amount: 29700,
      agendaOff: false,
    },
    {
      phone: '880000000004',
      type: 'estabelecimento',
      mode: 'atende',
      product: 'estabelecimento',
      seat: 5,
      attendant: true,
      billingFromAgenda: false,
      amount: 19700,
      agendaOff: true,
    },
  ] as const;

  const contexts = [];
  for (const [index, format] of formats.entries()) {
    const context = await signupPortal({
      phone: format.phone,
      name: `Negocio Sintetico ${index + 1}`,
      password: `E2e-Synthetic-${index + 1}!`,
      type: format.type,
      mode: format.mode,
    });
    contexts.push(context);
  }

  const rows = await withDb(async (client) => {
    const result = await client.query<{
      username: string;
      slot: string;
      product_type: string;
      seat_cap: number | null;
      modo_atendente_enabled: boolean;
      billing_from_agenda_enabled: boolean;
      amount_cents: number;
      agenda_automatica: string | null;
    }>(
      `SELECT pu.username, fc.slot, fc.product_type, fc.seat_cap,
              fc.modo_atendente_enabled, fc.billing_from_agenda_enabled,
              cb.amount_cents, fc.personalizacao->>'agenda_automatica' AS agenda_automatica
       FROM portal_users pu
       JOIN flow_clones fc ON fc.slot = pu.slot
       JOIN client_billing cb ON cb.slot = fc.slot
       WHERE pu.username = ANY($1::text[])
       ORDER BY pu.username`,
      [formats.map((format) => format.phone)],
    );
    return result.rows;
  });
  expect(rows).toHaveLength(4);
  for (const [index, format] of formats.entries()) {
    const row = rows[index];
    expect(row).toMatchObject({
      username: format.phone,
      product_type: format.product,
      seat_cap: format.seat,
      modo_atendente_enabled: format.attendant,
      billing_from_agenda_enabled: format.billingFromAgenda,
      amount_cents: format.amount,
      agenda_automatica: format.agendaOff ? 'false' : null,
    });
  }
  const provisionedSlots = rows.map((row) => row.slot).sort();
  const prompts = await withDb(async (client) => {
    const result = await client.query<{ slot: string; prompt: string }>(
      'SELECT slot, prompt FROM bot_prompt WHERE slot = ANY($1::text[]) ORDER BY slot',
      [provisionedSlots],
    );
    return result.rows;
  });
  expect(prompts.map((prompt) => prompt.slot)).toEqual(provisionedSlots);
  expect(prompts).toHaveLength(4);
  for (const prompt of prompts) expect(prompt.prompt.trim()).not.toBe('');

  await waitForJournal(wahaUrl, (entry) => entry.path === '/api/sessions', 4);
  const expectedSessionTags = provisionedSlots.map(sessionNameTag).sort();
  const wahaState = await fakeState(wahaUrl);
  const journalSessionTags = wahaState.journal
    .filter((entry) => entry.method === 'POST' && entry.path === '/api/sessions')
    .map((entry) => entry.body.nameTag)
    .filter((tag): tag is string => typeof tag === 'string')
    .sort();
  expect(journalSessionTags).toEqual(expectedSessionTags);
  expect(new Set(journalSessionTags).size).toBe(4);
  const stateSessionTags = wahaState.state.sessions.map((session) => session.nameTag).sort();
  expect(stateSessionTags).toEqual(expectedSessionTags);
  expect(new Set(stateSessionTags).size).toBe(4);
  expect(wahaState.state.sessions).toHaveLength(4);
  expect(wahaState.state.sessions.every((session) => session.status === 'STARTING')).toBe(true);

  const pix = await contexts[0]?.post('/portal/mensalidade/pix');
  expect(pix?.status()).toBe(200);
  await waitForJournal(abacateUrl, (entry) => entry.path === '/v2/transparents/create');
  const chargeCount = await withDb(async (client) => {
    const result = await client.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM billing_charges WHERE slot = $1',
      [rows[0]?.slot],
    );
    return Number(result.rows[0]?.count ?? 0);
  });
  expect(chargeCount).toBe(1);
  await Promise.all(contexts.map((context) => context.dispose()));
});

test('P1 portal equipe cobre 0/1/N e isolamento entre estabelecimentos reais', async () => {
  const fixtures = [
    {
      phone: '880000000021',
      name: 'Equipe Fixture A',
      password: 'E2e-Team-Fixture-1!',
    },
    {
      phone: '880000000022',
      name: 'Equipe Fixture B',
      password: 'E2e-Team-Fixture-2!',
    },
  ] as const;
  const [first, second] = await Promise.all(
    fixtures.map((fixture) =>
      signupPortal({
        ...fixture,
        type: 'estabelecimento',
        mode: 'atendente',
      }),
    ),
  );
  const owners = await withDb(async (client) => {
    const result = await client.query<{ username: string; slot: string; tenant_id: string }>(
      `SELECT pu.username, fc.slot, fc.tenant_id::text
       FROM portal_users pu JOIN flow_clones fc ON fc.slot = pu.slot
       WHERE pu.username IN ($1, $2) ORDER BY pu.username`,
      [fixtures[0].phone, fixtures[1].phone],
    );
    return result.rows;
  });
  expect(owners).toHaveLength(2);
  expect((await first.get('/portal/equipe')).status()).toBe(200);
  expect((await (await first.get('/portal/equipe')).json()).colaboradores).toHaveLength(0);

  await withDb(async (client) => {
    await client.query(
      `INSERT INTO clone_colaboradores
         (slot, tenant_id, nome, gcal_status, ativo, ordem, servicos)
       VALUES ($1, $2::uuid, $3, 'active', TRUE, 1, '[]'::jsonb)`,
      [owners[0]?.slot, owners[0]?.tenant_id, 'Profissional Sintetico A'],
    );
  });
  const one = await first.get('/portal/equipe');
  expect((await one.json()).colaboradores).toHaveLength(1);
  await withDb(async (client) => {
    await client.query(
      `INSERT INTO clone_colaboradores
         (slot, tenant_id, nome, gcal_status, ativo, ordem, servicos)
       VALUES ($1, $2::uuid, $3, 'pending', TRUE, 2, '[]'::jsonb)`,
      [owners[0]?.slot, owners[0]?.tenant_id, 'Profissional Sintetico B'],
    );
  });
  const many = await first.get('/portal/equipe');
  expect((await many.json()).colaboradores).toHaveLength(2);
  const isolated = await second.get('/portal/equipe');
  expect((await isolated.json()).colaboradores).toHaveLength(0);
  await Promise.all([first.dispose(), second.dispose()]);
});
