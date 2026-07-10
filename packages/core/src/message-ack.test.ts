import { describe, expect, it } from 'vitest';
import {
  ackStatusRank,
  extractSentMessageId,
  mapWahaAck,
  parseWahaAckPayload,
} from './message-ack.js';

describe('mapWahaAck — entrega vs falha vs read', () => {
  it('ack -1 / ERROR → terminal (nack/463)', () => {
    expect(mapWahaAck(-1)).toEqual({ status: 'ERROR', rank: -1, terminal: true });
    expect(mapWahaAck(0, 'ERROR')).toEqual({ status: 'ERROR', rank: -1, terminal: true });
  });

  it('ack 1 = SERVER (progresso, NÃO entregue)', () => {
    expect(mapWahaAck(1)).toEqual({ status: 'SERVER', rank: 1, terminal: false });
  });

  it('ack 2 = DEVICE = ENTREGUE (confirmação que importa)', () => {
    expect(mapWahaAck(2)).toEqual({ status: 'DEVICE', rank: 2, terminal: false });
    expect(mapWahaAck(0, 'DEVICE')).toEqual({ status: 'DEVICE', rank: 2, terminal: false });
  });

  it('read/played (ack 3/4) → READ, NUNCA terminal (não depender de recibo de leitura)', () => {
    expect(mapWahaAck(3)).toEqual({ status: 'READ', rank: 3, terminal: false });
    expect(mapWahaAck(4)).toEqual({ status: 'READ', rank: 3, terminal: false });
    expect(mapWahaAck(4, 'PLAYED').terminal).toBe(false);
    expect(mapWahaAck(4, 'READ').terminal).toBe(false);
  });

  it('nome é autoritativo sobre número divergente', () => {
    // número diz DEVICE(2) mas nome diz READ → confia no nome.
    expect(mapWahaAck(2, 'READ')).toEqual({ status: 'READ', rank: 3, terminal: false });
  });

  it('entrada desconhecida → fail-safe PENDING (nunca inventa ERROR)', () => {
    expect(mapWahaAck(Number.NaN, '')).toEqual({ status: 'PENDING', rank: 0, terminal: false });
    expect(mapWahaAck(99, 'WHATEVER').terminal).toBe(false);
  });

  it('ackStatusRank é monotônico ERROR<PENDING<SERVER<DEVICE<READ', () => {
    expect(ackStatusRank('ERROR')).toBeLessThan(ackStatusRank('PENDING'));
    expect(ackStatusRank('SERVER')).toBeLessThan(ackStatusRank('DEVICE'));
    expect(ackStatusRank('DEVICE')).toBeLessThan(ackStatusRank('READ'));
  });
});

describe('parseWahaAckPayload — fixture payload-ouro do evento message.ack', () => {
  it('payload NOWEB típico → messageId + ackCode + ackName + fromMe', () => {
    const payload = {
      id: 'true_5511999998888@c.us_ABCDEF123',
      from: '5511999998888@c.us',
      to: '5511999998888@c.us',
      ack: 2,
      ackName: 'DEVICE',
      fromMe: true,
    };
    expect(parseWahaAckPayload(payload)).toEqual({
      messageId: 'true_5511999998888@c.us_ABCDEF123',
      ackCode: 2,
      ackName: 'DEVICE',
      fromMe: true,
    });
  });

  it('ack como string numérica é coagido', () => {
    const r = parseWahaAckPayload({ id: 'x', ack: '-1', ackName: 'ERROR', fromMe: true });
    expect(r?.ackCode).toBe(-1);
    expect(r?.ackName).toBe('ERROR');
  });

  it('sem id → null (mensagem não identificável, ignora)', () => {
    expect(parseWahaAckPayload({ ack: 2 })).toBeNull();
  });

  it('sem ack numérico E sem ackName → null (nada a atualizar)', () => {
    expect(parseWahaAckPayload({ id: 'x' })).toBeNull();
  });

  it('payload não-objeto → null (fail-safe)', () => {
    expect(parseWahaAckPayload(null)).toBeNull();
    expect(parseWahaAckPayload('nope')).toBeNull();
  });
});

describe('extractSentMessageId — resposta do sendText (multi-engine)', () => {
  it('id string no topo', () => {
    expect(extractSentMessageId({ id: 'true_55@c.us_XYZ' })).toBe('true_55@c.us_XYZ');
  });

  it('id._serialized (WEBJS/objeto)', () => {
    expect(extractSentMessageId({ id: { _serialized: 'S1', id: 'raw' } })).toBe('S1');
  });

  it('_data.id._serialized', () => {
    expect(extractSentMessageId({ _data: { id: { _serialized: 'S2' } } })).toBe('S2');
  });

  it('key.id', () => {
    expect(extractSentMessageId({ key: { id: 'K1' } })).toBe('K1');
  });

  it('resposta sem id conhecido → null (best-effort, não quebra o envio)', () => {
    expect(extractSentMessageId({ foo: 'bar' })).toBeNull();
    expect(extractSentMessageId(null)).toBeNull();
    expect(extractSentMessageId(undefined)).toBeNull();
  });
});
