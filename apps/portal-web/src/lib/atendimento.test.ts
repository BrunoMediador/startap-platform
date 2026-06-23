import { describe, expect, it } from 'vitest';
import { type Draft, emptyDraft, validate } from './atendimento';

const base = (over: Partial<Draft> = {}): Draft => ({ ...emptyDraft('2026-06-23'), ...over });

describe('emptyDraft', () => {
  it('nasce em dinheiro, sem valor, na data passada', () => {
    const d = emptyDraft('2026-06-23');
    expect(d.forma).toBe('dinheiro');
    expect(d.valor).toBe('');
    expect(d.colaboradorId).toBeNull();
    expect(d.data).toBe('2026-06-23');
  });
});

describe('validate (atendimento)', () => {
  it('aceita um atendimento simples e converte valor pra centavos', () => {
    const res = validate(base({ valor: '50,00' }));
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.value.valor_cents).toBe(5000);
      expect(res.value.forma_pagamento).toBe('dinheiro');
      expect(res.value.data).toBe('2026-06-23');
      // Campos opcionais ausentes não viajam.
      expect(res.value.colaborador_id).toBeUndefined();
      expect(res.value.cliente_nome).toBeUndefined();
      expect(res.value.desconto_cents).toBeUndefined();
    }
  });

  it('inclui só os opcionais preenchidos', () => {
    const res = validate(
      base({
        valor: '80',
        servicoNome: '  Corte  ',
        clienteNome: '  João  ',
        colaboradorId: 7,
        desconto: '10',
      }),
    );
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.value.servico_nome).toBe('Corte');
      expect(res.value.cliente_nome).toBe('João');
      expect(res.value.colaborador_id).toBe(7);
      expect(res.value.desconto_cents).toBe(1000);
    }
  });

  it('forma "pacote" ZERA o valor e não exige preenchê-lo', () => {
    const res = validate(base({ forma: 'pacote', valor: '' }));
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.value.valor_cents).toBe(0);
      expect(res.value.forma_pagamento).toBe('pacote');
    }
  });

  it('rejeita valor ausente fora do pacote', () => {
    const res = validate(base({ valor: '' }));
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.errors.valor).toBeTruthy();
  });

  it('rejeita valor zero/negativo', () => {
    expect(validate(base({ valor: '0' })).ok).toBe(false);
    const neg = validate(base({ valor: '-5' }));
    expect(neg.ok).toBe(false);
  });

  it('rejeita desconto maior que o valor', () => {
    const res = validate(base({ valor: '50', desconto: '60' }));
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.errors.desconto).toBeTruthy();
  });

  it('rejeita data fora do formato YYYY-MM-DD', () => {
    const res = validate(base({ valor: '50', data: '23/06/2026' }));
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.errors.data).toBeTruthy();
  });
});
