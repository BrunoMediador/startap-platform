/**
 * Testes das primitivas de validacao do webhook AbacatePay (C3/C5/C6).
 *
 * Logica pura — sem HTTP nem banco. Cobre: HMAC raw-body valido/invalido,
 * query secret valido/invalido, redacao de PII, e parsing do envelope.
 */
import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  isPixCharge,
  parseWebhookEvent,
  redactWebhookPayload,
  safeEqual,
  verifyWebhookSecret,
  verifyWebhookSignature,
} from './webhook.js';

const SECRET = 'whsec_test_shared_key';

function sign(raw: Buffer | string, secret = SECRET): string {
  return createHmac('sha256', secret).update(raw).digest('base64');
}

describe('safeEqual', () => {
  it('true para iguais, false para diferentes', () => {
    expect(safeEqual('abc', 'abc')).toBe(true);
    expect(safeEqual('abc', 'abd')).toBe(false);
  });
  it('false para tamanhos diferentes sem lancar', () => {
    expect(safeEqual('abc', 'abcd')).toBe(false);
    expect(safeEqual('', 'x')).toBe(false);
  });
});

describe('verifyWebhookSecret (C6 — query secret)', () => {
  it('aceita secret correto', () => {
    expect(verifyWebhookSecret('s3cr3t', 's3cr3t')).toBe(true);
  });
  it('rejeita secret incorreto', () => {
    expect(verifyWebhookSecret('errado', 's3cr3t')).toBe(false);
  });
  it('rejeita quando provided ou expected ausente', () => {
    expect(verifyWebhookSecret(undefined, 's3cr3t')).toBe(false);
    expect(verifyWebhookSecret('s3cr3t', undefined)).toBe(false);
    expect(verifyWebhookSecret('', 's3cr3t')).toBe(false);
  });
});

describe('verifyWebhookSignature (C3/C6 — HMAC sobre RAW BODY)', () => {
  it('HMAC valido sobre o raw body confere', () => {
    const raw = Buffer.from('{"id":"evt_1","event":"transparent.completed"}', 'utf8');
    expect(verifyWebhookSignature(raw, sign(raw), SECRET)).toBe(true);
  });

  it('HMAC invalido (assinatura errada) -> false', () => {
    const raw = Buffer.from('{"id":"evt_1"}', 'utf8');
    expect(verifyWebhookSignature(raw, 'assinatura-forjada', SECRET)).toBe(false);
  });

  it('assinatura de OUTRO corpo nao confere (raw-body importa)', () => {
    const raw = Buffer.from('{"id":"evt_1","amount":19900}', 'utf8');
    const tampered = Buffer.from('{"id":"evt_1","amount":1}', 'utf8'); // pagador adulterou valor
    const sig = sign(raw); // assinatura do original
    // O HMAC e sobre o corpo recebido (tampered) — nao confere com a assinatura do original.
    expect(verifyWebhookSignature(tampered, sig, SECRET)).toBe(false);
  });

  it('secret errado nao confere', () => {
    const raw = Buffer.from('{"id":"evt_1"}', 'utf8');
    expect(verifyWebhookSignature(raw, sign(raw, 'outro-secret'), SECRET)).toBe(false);
  });

  it('rejeita quando header ou secret ausente', () => {
    const raw = Buffer.from('{}', 'utf8');
    expect(verifyWebhookSignature(raw, undefined, SECRET)).toBe(false);
    expect(verifyWebhookSignature(raw, sign(raw), undefined)).toBe(false);
  });
});

describe('redactWebhookPayload (C5 — LGPD)', () => {
  it('redige CPF/email/telefone/brCode/receiptUrl', () => {
    const payload = {
      id: 'evt_1',
      event: 'transparent.completed',
      data: {
        transparent: {
          id: 'pix_char_x',
          status: 'PAID',
          amount: 19900,
          paidAmount: 19900,
          externalId: 'barbearia-cirilo-2026-06',
          brCode: '00020126...PIX-COPIA-E-COLA',
          brCodeBase64: 'data:image/png;base64,AAAA',
          receiptUrl: 'https://abacatepay.com/recibo/abc',
          customer: {
            name: 'Cirilo da Silva',
            email: 'cirilo@example.com',
            taxId: '123.456.789-00',
            phone: '5519998887766',
          },
        },
      },
    };
    const r = redactWebhookPayload(payload) as Record<string, unknown>;
    const data = (r.data as Record<string, unknown>).transparent as Record<string, unknown>;
    const customer = data.customer as Record<string, unknown>;

    // PII redigida
    expect(data.brCode).toBe('[REDACTED]');
    expect(data.brCodeBase64).toBe('[REDACTED]');
    expect(data.receiptUrl).toBe('[REDACTED]');
    expect(customer.name).toBe('[REDACTED]');
    expect(customer.email).toBe('[REDACTED]');
    expect(customer.taxId).toBe('[REDACTED]');
    expect(customer.phone).toBe('[REDACTED]');

    // Dados de auditoria mantidos (nao-PII)
    expect(data.id).toBe('pix_char_x');
    expect(data.status).toBe('PAID');
    expect(data.amount).toBe(19900);
    expect(data.paidAmount).toBe(19900);
    expect(data.externalId).toBe('barbearia-cirilo-2026-06');
  });

  it('nao muta a entrada original', () => {
    const payload = { brCode: 'segredo' };
    redactWebhookPayload(payload);
    expect(payload.brCode).toBe('segredo');
  });

  it('lida com arrays e primitivos', () => {
    expect(redactWebhookPayload([{ email: 'a@b.com' }, 'x', 1])).toEqual([
      { email: '[REDACTED]' },
      'x',
      1,
    ]);
    expect(redactWebhookPayload('plain')).toBe('plain');
    expect(redactWebhookPayload(null)).toBe(null);
  });
});

describe('parseWebhookEvent', () => {
  it('extrai os campos do envelope transparent.completed PAID', () => {
    const body = {
      id: 'evt_123',
      event: 'transparent.completed',
      data: {
        transparent: {
          id: 'pix_char_abc',
          status: 'PAID',
          externalId: 'barbearia-cirilo-2026-06',
          paidAmount: 19900,
          receiptUrl: 'https://r/abc',
        },
      },
    };
    const evt = parseWebhookEvent(body);
    expect(evt).not.toBeNull();
    expect(evt?.eventId).toBe('evt_123');
    expect(evt?.event).toBe('transparent.completed');
    expect(evt?.status).toBe('paid');
    expect(evt?.abacateChargeId).toBe('pix_char_abc');
    expect(evt?.paidAmountCents).toBe(19900);
    expect(evt?.externalId).toBe('barbearia-cirilo-2026-06');
  });

  it('retorna null sem event_id (sem dedupe possivel)', () => {
    expect(parseWebhookEvent({ event: 'transparent.completed' })).toBeNull();
    expect(parseWebhookEvent('nao-objeto')).toBeNull();
    expect(parseWebhookEvent(null)).toBeNull();
  });
});

describe('isPixCharge (fail-closed — fallback so com sinal POSITIVO de PIX)', () => {
  it('true: methods contem PIX (case-insensitive)', () => {
    expect(isPixCharge({ methods: ['pix'] }, {}, null)).toBe(true);
    expect(isPixCharge({ methods: ['PIX'] }, {}, null)).toBe(true);
  });
  it('true: id comeca com pix_char_ / pix_', () => {
    expect(isPixCharge({}, {}, 'pix_char_CyfaX5D6yWm1QpnFx2kubqDc')).toBe(true);
    expect(isPixCharge({}, {}, 'pix_abc')).toBe(true);
  });
  it('true: campo de metodo singular == pix', () => {
    expect(isPixCharge({ kind: 'PIX' }, {}, null)).toBe(true);
    expect(isPixCharge({ method: 'pix' }, {}, null)).toBe(true);
    expect(isPixCharge({ paymentMethod: 'Pix' }, {}, null)).toBe(true);
  });
  it('false: sem nenhum sinal de PIX (fail-closed)', () => {
    expect(isPixCharge({}, {}, null)).toBe(false);
    expect(isPixCharge({ methods: ['CARD'] }, {}, 'char_generic')).toBe(false);
    expect(isPixCharge({ method: 'boleto' }, {}, 'bol_123')).toBe(false);
  });
});

describe('parseWebhookEvent — fallback de valor PIX (amount quando paidAmount ausente)', () => {
  // T1 (obrigatorio): payload REAL do simulate-payment AbacatePay — paidAmount null,
  // valor real em amount, id pix_char_*, PAID. Hoje vinha null e era descartado.
  it('T1: PIX real (pix_char_*, amount:9500, paidAmount:null, PAID) -> 9500 via fallback', () => {
    const body = {
      id: 'log_mWKtP0Q0UQPskTXRTFBpzB31',
      event: 'transparent.completed',
      apiVersion: 2,
      devMode: true,
      data: {
        transparent: {
          id: 'pix_char_CyfaX5D6yWm1QpnFx2kubqDc',
          externalId: null,
          amount: 9500,
          paidAmount: null,
          platformFee: 80,
          status: 'PAID',
          methods: [],
          frequency: 'ONE_TIME',
          metadata: { slot: 'debug' },
        },
      },
    };
    const evt = parseWebhookEvent(body);
    expect(evt).not.toBeNull();
    expect(evt?.status).toBe('paid');
    expect(evt?.abacateChargeId).toBe('pix_char_CyfaX5D6yWm1QpnFx2kubqDc');
    // isPix detectado pelo prefixo pix_char_ (methods veio vazio).
    expect(isPixCharge(body.data.transparent, body.data, evt?.abacateChargeId ?? null)).toBe(true);
    expect(evt?.paidAmountCents).toBe(9500);
    expect(evt?.amountFromFallback).toBe(true);
    expect(evt?.method).toBe('pix');
  });

  // T2: PIX com paidAmount preenchido -> usa o valor DIRETO, sem fallback.
  it('T2: PIX com paidAmount:9500 -> usa direto, amountFromFallback=false', () => {
    const body = {
      id: 'evt_pix_direto',
      event: 'transparent.completed',
      data: {
        transparent: {
          id: 'pix_char_abc',
          amount: 9500,
          paidAmount: 9500,
          status: 'PAID',
          methods: ['PIX'],
        },
      },
    };
    const evt = parseWebhookEvent(body);
    expect(evt?.paidAmountCents).toBe(9500);
    expect(evt?.amountFromFallback).toBe(false);
  });

  // T4 (obrigatorio): SEM sinal de PIX, paidAmount null -> paidAmountCents null (C2 intacto
  // p/ nao-PIX: nao caimos em `amount`, handler ainda ignoraria como no-amount).
  it('T4: charge SEM sinal de PIX, amount:9500, paidAmount:null -> paidAmountCents=null', () => {
    const body = {
      id: 'evt_card',
      event: 'transparent.completed',
      data: {
        charge: {
          id: 'char_generic_001',
          amount: 9500,
          paidAmount: null,
          status: 'PAID',
          methods: ['CARD'],
          method: 'card',
        },
      },
    };
    const evt = parseWebhookEvent(body);
    expect(evt?.paidAmountCents).toBeNull();
    expect(evt?.amountFromFallback).toBe(false);
  });

  // T5: id generico, sem methods/method, sem paidAmount -> fail-closed -> null.
  it('T5: id generico, sem methods/method/paidAmount -> fail-closed, paidAmountCents=null', () => {
    const body = {
      id: 'evt_ambiguo',
      event: 'transparent.completed',
      data: {
        transparent: {
          id: 'char_xyz',
          amount: 9500,
          status: 'PAID',
        },
      },
    };
    const evt = parseWebhookEvent(body);
    expect(evt?.paidAmountCents).toBeNull();
    expect(evt?.amountFromFallback).toBe(false);
    expect(evt?.method).toBeNull();
  });
});
