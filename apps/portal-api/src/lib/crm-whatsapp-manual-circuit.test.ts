import { beforeEach, describe, expect, it, vi } from 'vitest';

const { existsMock, incrMock, expireMock, setMock, delMock } = vi.hoisted(() => ({
  existsMock: vi.fn(),
  incrMock: vi.fn(),
  expireMock: vi.fn(),
  setMock: vi.fn(),
  delMock: vi.fn(),
}));

vi.mock('./session.js', () => ({
  getRedis: () => ({
    exists: (...args: unknown[]) => existsMock(...args),
    incr: (...args: unknown[]) => incrMock(...args),
    expire: (...args: unknown[]) => expireMock(...args),
    set: (...args: unknown[]) => setMock(...args),
    del: (...args: unknown[]) => delMock(...args),
  }),
}));

const {
  isCrmWhatsAppManualCircuitClosed,
  recordCrmWhatsAppManualFailure,
  recordCrmWhatsAppManualSuccess,
} = await import('./crm-whatsapp-manual-circuit.js');

beforeEach(() => {
  vi.clearAllMocks();
  existsMock.mockResolvedValue(0);
  incrMock.mockResolvedValue(1);
  expireMock.mockResolvedValue(1);
  setMock.mockResolvedValue('OK');
  delMock.mockResolvedValue(1);
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
});
