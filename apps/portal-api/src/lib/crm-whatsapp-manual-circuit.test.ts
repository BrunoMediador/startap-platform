import { beforeEach, describe, expect, it, vi } from 'vitest';

const { existsMock, incrMock, expireMock, setMock, delMock, evalMock } = vi.hoisted(() => ({
  existsMock: vi.fn(),
  incrMock: vi.fn(),
  expireMock: vi.fn(),
  setMock: vi.fn(),
  delMock: vi.fn(),
  evalMock: vi.fn(),
}));

vi.mock('./session.js', () => ({
  getRedis: () => ({
    exists: (...args: unknown[]) => existsMock(...args),
    incr: (...args: unknown[]) => incrMock(...args),
    expire: (...args: unknown[]) => expireMock(...args),
    set: (...args: unknown[]) => setMock(...args),
    del: (...args: unknown[]) => delMock(...args),
    eval: (...args: unknown[]) => evalMock(...args),
  }),
}));

const {
  isCrmWhatsAppManualCircuitClosed,
  recordCrmWhatsAppManualFailure,
  recordCrmWhatsAppManualSuccess,
  reserveCrmWhatsAppManualSlotSend,
} = await import('./crm-whatsapp-manual-circuit.js');

beforeEach(() => {
  vi.clearAllMocks();
  existsMock.mockResolvedValue(0);
  incrMock.mockResolvedValue(1);
  expireMock.mockResolvedValue(1);
  setMock.mockResolvedValue('OK');
  delMock.mockResolvedValue(1);
  evalMock.mockResolvedValue(1);
});

describe('CRM WhatsApp manual circuit breaker', () => {
  it('aceita somente circuito fechado e fecha o envio quando Redis falha', async () => {
    await expect(isCrmWhatsAppManualCircuitClosed('clone_owner')).resolves.toBe(true);
    existsMock.mockResolvedValueOnce(1);
    await expect(isCrmWhatsAppManualCircuitClosed('clone_owner')).resolves.toBe(false);
    existsMock.mockRejectedValueOnce(new Error('redis unavailable'));
    await expect(isCrmWhatsAppManualCircuitClosed('clone_owner')).resolves.toBe(false);
  });

  it('abre por slot na terceira falha e limpa o contador', async () => {
    incrMock.mockResolvedValue(3);
    await recordCrmWhatsAppManualFailure('clone_owner');
    expect(setMock).toHaveBeenCalledWith(
      'portal:crm:whatsapp-manual:circuit:open:clone_owner',
      '1',
      'EX',
      60,
    );
    expect(delMock).toHaveBeenCalledWith('portal:crm:whatsapp-manual:circuit:failures:clone_owner');
  });

  it('remove somente o contador daquele slot apos envio bem-sucedido', async () => {
    await recordCrmWhatsAppManualSuccess('clone_owner');
    expect(delMock).toHaveBeenCalledWith('portal:crm:whatsapp-manual:circuit:failures:clone_owner');
  });

  it('reserva atomica por slot e fecha quando Redis falha ou excede a janela', async () => {
    await expect(reserveCrmWhatsAppManualSlotSend('clone_owner', 3, 60)).resolves.toBe(true);
    expect(evalMock).toHaveBeenCalledWith(
      expect.stringContaining("redis.call('INCR'"),
      1,
      'portal:crm:whatsapp-manual:sends:clone_owner',
      '60',
    );

    evalMock.mockResolvedValueOnce(4);
    await expect(reserveCrmWhatsAppManualSlotSend('clone_owner', 3, 60)).resolves.toBe(false);
    evalMock.mockRejectedValueOnce(new Error('redis unavailable'));
    await expect(reserveCrmWhatsAppManualSlotSend('clone_owner', 3, 60)).resolves.toBe(false);
  });
});
