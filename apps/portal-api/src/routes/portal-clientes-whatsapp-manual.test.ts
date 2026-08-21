import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  configMock,
  getScopeMock,
  getTargetMock,
  claimMock,
  completeMock,
  sendTextMock,
  circuitClosedMock,
  circuitFailureMock,
  circuitSuccessMock,
} = vi.hoisted(() => ({
  configMock: {
    CRM_CLIENTES_ENABLED: true,
    CRM_WHATSAPP_MANUAL_ENABLED: true,
    CRM_WHATSAPP_MANUAL_TIMEOUT_MS: 20_000,
    CRM_WHATSAPP_MANUAL_COOLDOWN_MS: 30_000,
  } as Record<string, unknown>,
  getScopeMock: vi.fn(),
  getTargetMock: vi.fn(),
  claimMock: vi.fn(),
  completeMock: vi.fn(),
  sendTextMock: vi.fn(),
  circuitClosedMock: vi.fn(),
  circuitFailureMock: vi.fn(),
  circuitSuccessMock: vi.fn(),
}));

vi.mock('../config.js', () => ({ config: configMock }));
vi.mock('@startap/db', () => ({
  cloneColaboradores: { getScopeBySlot: (...args: unknown[]) => getScopeMock(...args) },
  crmWhatsAppManual: {
    getClienteWhatsAppManualTargetForOwner: (...args: unknown[]) => getTargetMock(...args),
    claimClienteWhatsAppManualSend: (...args: unknown[]) => claimMock(...args),
    completeClienteWhatsAppManualSend: (...args: unknown[]) => completeMock(...args),
  },
}));
vi.mock('@startap/integrations', () => ({
  waha: { sendText: (...args: unknown[]) => sendTextMock(...args) },
}));
vi.mock('../lib/crm-whatsapp-manual-circuit.js', () => ({
  isCrmWhatsAppManualCircuitClosed: (...args: unknown[]) => circuitClosedMock(...args),
  recordCrmWhatsAppManualFailure: (...args: unknown[]) => circuitFailureMock(...args),
  recordCrmWhatsAppManualSuccess: (...args: unknown[]) => circuitSuccessMock(...args),
}));
vi.mock('../lib/tenant.js', () => ({
  withTenant: vi.fn(
    async (
      req: { tenant?: unknown },
      reply: { code: (status: number) => { send: (body: unknown) => void } },
    ) => {
      if (
        (req as { headers?: Record<string, string | undefined> }).headers?.['x-role'] ===
        'colaborador'
      ) {
        reply.code(403).send({ error: 'acesso_restrito_ao_dono' });
        return;
      }
      req.tenant = { slot: 'clone_owner', userId: 7, username: 'owner', sid: 'sid-owner' };
    },
  ),
  requireTenant: (req: { tenant?: { slot: string; userId: number } }) => {
    if (!req.tenant) throw new Error('tenant missing');
    return req.tenant;
  },
}));

import Fastify, { type FastifyInstance } from 'fastify';
import { portalClientesWhatsAppManualRoutes } from './portal-clientes-whatsapp-manual.js';

const CLIENTE_ID = '11111111-1111-4111-8111-111111111111';

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  await app.register(portalClientesWhatsAppManualRoutes);
  await app.ready();
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
  configMock.CRM_CLIENTES_ENABLED = true;
  configMock.CRM_WHATSAPP_MANUAL_ENABLED = true;
  getScopeMock.mockResolvedValue({ tenant_id: '00000000-0000-4000-8000-000000000001' });
  getTargetMock.mockResolvedValue({ telefone: '553199998842', wahaSessao: 'sessao-clone-real' });
  claimMock.mockResolvedValue({
    sendId: '22222222-2222-4222-8222-222222222222',
    cooldownUntil: '2026-08-21T12:00:30Z',
  });
  completeMock.mockResolvedValue(undefined);
  sendTextMock.mockResolvedValue({ messageId: 'wamid.ignored' });
  circuitClosedMock.mockResolvedValue(true);
  circuitFailureMock.mockResolvedValue(undefined);
  circuitSuccessMock.mockResolvedValue(undefined);
});

describe('POST /portal/clientes/:id/whatsapp', () => {
  it('envia um unico texto validado pelo owner usando sessao WAHA do flow clone e humanizacao obrigatoria', async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: `/portal/clientes/${CLIENTE_ID}/whatsapp`,
      payload: { texto: '  Oi, tudo bem?  ' },
    });

    expect(res.statusCode).toBe(202);
    expect(getTargetMock).toHaveBeenCalledWith(
      'clone_owner',
      '00000000-0000-4000-8000-000000000001',
      CLIENTE_ID,
    );
    expect(claimMock).toHaveBeenCalledWith({
      slot: 'clone_owner',
      tenantId: '00000000-0000-4000-8000-000000000001',
      clienteId: CLIENTE_ID,
      operatorUserId: 7,
      cooldownMs: 30_000,
    });
    expect(sendTextMock).toHaveBeenCalledWith(
      expect.objectContaining({
        sessao: 'sessao-clone-real',
        chatId: '553199998842@c.us',
        texto: 'Oi, tudo bem?',
        typing: true,
        delayMs: 12_000,
        signal: expect.any(AbortSignal),
      }),
    );
    expect(completeMock).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: 'sent', sendId: '22222222-2222-4222-8222-222222222222' }),
    );
    await app.close();
  });

  it('rejeita feature OFF e texto invalido antes de criar claim ou chamar WAHA', async () => {
    configMock.CRM_WHATSAPP_MANUAL_ENABLED = false;
    const app = await buildApp();
    const off = await app.inject({
      method: 'POST',
      url: `/portal/clientes/${CLIENTE_ID}/whatsapp`,
      payload: { texto: 'oi' },
    });
    expect(off.statusCode).toBe(404);
    expect(getTargetMock).not.toHaveBeenCalled();

    configMock.CRM_WHATSAPP_MANUAL_ENABLED = true;
    const invalid = await app.inject({
      method: 'POST',
      url: `/portal/clientes/${CLIENTE_ID}/whatsapp`,
      payload: { texto: ' ' },
    });
    expect(invalid.statusCode).toBe(400);
    expect(claimMock).not.toHaveBeenCalled();
    expect(sendTextMock).not.toHaveBeenCalled();
    await app.close();
  });

  it('fecha colaborador, cooldown e falha WAHA sem novo envio ou PII na resposta', async () => {
    const app = await buildApp();
    const denied = await app.inject({
      method: 'POST',
      url: `/portal/clientes/${CLIENTE_ID}/whatsapp`,
      headers: { 'x-role': 'colaborador' },
      payload: { texto: 'oi' },
    });
    expect(denied.statusCode).toBe(403);
    expect(getTargetMock).not.toHaveBeenCalled();

    claimMock.mockResolvedValueOnce(null);
    const cooldown = await app.inject({
      method: 'POST',
      url: `/portal/clientes/${CLIENTE_ID}/whatsapp`,
      payload: { texto: 'oi' },
    });
    expect(cooldown.statusCode).toBe(409);
    expect(sendTextMock).not.toHaveBeenCalled();

    sendTextMock.mockRejectedValueOnce(new Error('WAHA HTTP 500'));
    const failed = await app.inject({
      method: 'POST',
      url: `/portal/clientes/${CLIENTE_ID}/whatsapp`,
      payload: { texto: 'oi' },
    });
    expect(failed.statusCode).toBe(503);
    expect(failed.json()).toEqual({ error: 'envio_indisponivel' });
    expect(JSON.stringify(failed.json())).not.toContain('553199998842');
    expect(completeMock).toHaveBeenLastCalledWith(
      expect.objectContaining({ outcome: 'failed', failureCode: 'timeout_or_waha_error' }),
    );
    expect(circuitFailureMock).toHaveBeenCalledWith('clone_owner');
    await app.close();
  });
});
