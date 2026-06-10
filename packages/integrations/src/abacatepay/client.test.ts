/**
 * Testes do AbacatePayClient — fetch MOCKADO, nao bate na API real.
 *
 * Cobre: criar cobranca (mapeamento de centavos + campos), erro da API tratado
 * (AbacatePayError sem vazar key), e getChargeStatus.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@startap/core/logger', () => ({
  logger: { child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }) },
}));

import { AbacatePayClient, AbacatePayError, AbacatePayNotConfiguredError } from './client.js';

const fetchMock = vi.fn();

beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock);
  fetchMock.mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

const client = new AbacatePayClient({
  apiKey: 'dev_key_xyz',
  baseUrl: 'https://api.abacatepay.com',
});

describe('AbacatePayClient.createPixCharge', () => {
  it('cria cobranca e mapeia o retorno (amount em CENTAVOS)', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        data: {
          id: 'pix_char_abc123',
          brCode: '00020126...PIX',
          brCodeBase64: 'data:image/png;base64,AAAA',
          status: 'PENDING',
          expiresAt: '2026-06-12T10:00:00.000Z',
          platformFee: 80,
        },
      }),
    );

    const charge = await client.createPixCharge({
      slot: 'barbearia-cirilo',
      cycle: '2026-06',
      amountCents: 19900,
      description: 'Mensalidade 2026-06',
      expiresInSec: 259200,
    });

    expect(charge.id).toBe('pix_char_abc123');
    expect(charge.brCode).toBe('00020126...PIX');
    expect(charge.brCodeBase64).toBe('data:image/png;base64,AAAA');
    expect(charge.status).toBe('pending'); // normalizado p/ minusculo
    expect(charge.expiresAt).toBe('2026-06-12T10:00:00.000Z');
    expect(charge.platformFee).toBe(80);

    // Conferir o body enviado: endpoint, amount em centavos, externalId, metadata.
    const [url, opts] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.abacatepay.com/v2/transparents/create');
    expect(opts.method).toBe('POST');
    const sent = JSON.parse(opts.body as string);
    expect(sent.method).toBe('PIX');
    expect(sent.data.amount).toBe(19900);
    expect(sent.data.externalId).toBe('barbearia-cirilo-2026-06');
    expect(sent.data.metadata).toEqual({ slot: 'barbearia-cirilo', cycle: '2026-06' });
    expect(sent.data.expiresIn).toBe(259200);

    // A key vai no header Authorization — e SO ali.
    const headers = opts.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer dev_key_xyz');
  });

  it('lanca AbacatePayError tipado em HTTP nao-2xx (sem vazar a key)', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ error: 'unauthorized' }, 401));

    const promise = client.createPixCharge({
      slot: 'slot-x',
      cycle: '2026-06',
      amountCents: 5000,
      description: 'teste',
      expiresInSec: 3600,
    });

    await expect(promise).rejects.toBeInstanceOf(AbacatePayError);
    await expect(promise).rejects.toMatchObject({ status: 401 });
    // A mensagem do erro nunca contem a chave.
    await promise.catch((err: AbacatePayError) => {
      expect(err.message).not.toContain('dev_key_xyz');
      expect(err.body).not.toContain('dev_key_xyz');
    });
  });

  it('lanca se a resposta nao tiver id de cobranca', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ data: { brCode: 'x' } }));
    await expect(
      client.createPixCharge({
        slot: 's',
        cycle: '2026-06',
        amountCents: 100,
        description: 'd',
        expiresInSec: 60,
      }),
    ).rejects.toBeInstanceOf(AbacatePayError);
  });
});

describe('AbacatePayClient.getChargeStatus', () => {
  it('consulta status e normaliza PAID + paidAmount em centavos', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ data: { id: 'pix_char_abc123', status: 'PAID', paidAmount: 19900 } }),
    );

    const res = await client.getChargeStatus('pix_char_abc123');

    expect(res.id).toBe('pix_char_abc123');
    expect(res.status).toBe('paid');
    expect(res.paidAmountCents).toBe(19900);

    const [url] = fetchMock.mock.calls[0] as [string];
    expect(url).toBe('https://api.abacatepay.com/v2/transparents/check?id=pix_char_abc123');
  });
});

describe('AbacatePayClient.simulatePayment', () => {
  it('POST no endpoint de simulacao (Dev) com o id na query e normaliza o status', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ data: { id: 'pix_char_abc123', status: 'PAID', paidAmount: 19900 } }),
    );

    const res = await client.simulatePayment('pix_char_abc123');

    expect(res.id).toBe('pix_char_abc123');
    expect(res.status).toBe('paid');
    expect(res.paidAmountCents).toBe(19900);

    const [url, opts] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(
      'https://api.abacatepay.com/v2/transparents/simulate-payment?id=pix_char_abc123',
    );
    expect(opts.method).toBe('POST');
    // A key vai SO no header Authorization.
    const headers = opts.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer dev_key_xyz');
  });

  it('propaga AbacatePayError em HTTP nao-2xx (ex.: simulacao recusada em Prod)', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ error: 'forbidden' }, 403));
    await expect(client.simulatePayment('pix_char_abc123')).rejects.toBeInstanceOf(AbacatePayError);
  });
});

describe('AbacatePayClient construtor (validacao no ponto de uso)', () => {
  // Postmortem P0 2026-06-09: a key e OPCIONAL no boot dos apps. A exigencia mora aqui —
  // ao instanciar o cliente pra usar a feature, key ausente = erro tipado e explicito.
  it('lanca AbacatePayNotConfiguredError se apiKey for string vazia', () => {
    expect(() => new AbacatePayClient({ apiKey: '' })).toThrow(AbacatePayNotConfiguredError);
  });

  it('lanca AbacatePayNotConfiguredError se apiKey for undefined (key opcional no boot)', () => {
    expect(() => new AbacatePayClient({ apiKey: undefined })).toThrow(AbacatePayNotConfiguredError);
  });

  it('a mensagem do erro nao vaza segredo e e clara', () => {
    try {
      new AbacatePayClient({ apiKey: undefined });
      expect.unreachable('deveria ter lancado');
    } catch (err) {
      expect(err).toBeInstanceOf(AbacatePayNotConfiguredError);
      expect((err as Error).message).toMatch(/ABACATEPAY_API_KEY/);
    }
  });
});
