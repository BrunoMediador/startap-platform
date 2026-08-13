import { expect, request as playwrightRequest, test } from '@playwright/test';
import pg from 'pg';

const { Client } = pg;
const portalApiUrl = process.env.E2E_PORTAL_API_URL ?? 'http://portal-api:3051';

async function signup(phone: string, name: string) {
  const context = await playwrightRequest.newContext({ baseURL: portalApiUrl });
  const response = await context.post('/auth/signup', {
    data: {
      nome_negocio: name,
      whatsapp: phone,
      senha: 'E2e-Known-Broken-1!',
      area: 'outro',
      timezone: 'America/Sao_Paulo',
      aceite_termos: true,
      tipo_atendimento: 'individual',
      modo_ia: 'atendente',
    },
  });
  expect(response.status()).toBe(201);
  return context;
}

test('SCRUM-137 expected-red: troca de formato usa operação transacional única', async () => {
  test.info().annotations.push({
    type: 'known-broken-cause',
    description: 'missing-transactional-format-endpoint',
  });
  const context = await signup('880000000091', 'Formato Expected Red');
  const response = await context.post('/portal/formato', {
    data: { tipo_atendimento: 'estabelecimento', modo_ia: 'agenda' },
  });

  // Contrato alvo do ADR 0034. Hoje a superfície ainda não existe (404), logo o teste
  // precisa permanecer vermelho e separado até SCRUM-137 implementar a transição atômica.
  expect(response.status()).toBe(200);
  await context.dispose();
});

test('SCRUM-170 expected-red: overdue não comunica retomada efetiva de owner_request', async () => {
  test.info().annotations.push({
    type: 'known-broken-cause',
    description: 'owner-resume-ignores-overdue-silence',
  });
  const phone = '880000000092';
  const context = await signup(phone, 'Resume Expected Red');
  const client = new Client({ connectionString: process.env.E2E_PG_URL });
  await client.connect();
  const slotResult = await client.query<{ slot: string }>(
    'SELECT slot FROM portal_users WHERE username = $1',
    [phone],
  );
  const slot = slotResult.rows[0]?.slot;
  expect(slot).toBeTruthy();
  await client.query(
    `UPDATE flow_clones
     SET flow_enabled = FALSE, suspended_kind = 'owner_request', suspended_reason = 'E2E'
     WHERE slot = $1`,
    [slot],
  );
  await client.query(
    `UPDATE client_billing
     SET next_due_date = CURRENT_DATE - INTERVAL '10 days', status = 'overdue'
     WHERE slot = $1`,
    [slot],
  );

  const response = await context.post('/portal/bot/resume');
  const state = await client.query<{ flow_enabled: boolean; suspended_kind: string | null }>(
    'SELECT flow_enabled, suspended_kind FROM flow_clones WHERE slot = $1',
    [slot],
  );
  await client.end();
  await context.dispose();

  // Contrato alvo: não devolver sucesso nem limpar owner_request enquanto o gate de
  // inadimplência continuará mudo. Hoje a rota responde 200 e limpa a pausa.
  expect(response.status()).toBe(409);
  expect(state.rows[0]).toEqual({ flow_enabled: false, suspended_kind: 'owner_request' });
});
