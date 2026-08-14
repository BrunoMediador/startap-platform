import { expect, request as playwrightRequest, test } from '@playwright/test';

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
