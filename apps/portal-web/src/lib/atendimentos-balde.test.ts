import { describe, expect, it } from 'vitest';
import type { AtendimentoBaldeRow, AtendimentosListResponse } from './api-types';
import {
  centsToInput,
  clienteLabel,
  draftFromRow,
  formaPagamentoLabel,
  patchRowNaLista,
  patchVazio,
  profissionalLabel,
  removerRowDaLista,
  rowBadge,
  servicoLabel,
  somarTotalCents,
  validateEdit,
  valorLiquidoCents,
} from './atendimentos-balde';

const row = (over: Partial<AtendimentoBaldeRow> = {}): AtendimentoBaldeRow => ({
  id: 1,
  data: '2026-06-23',
  inicio_at: '2026-06-23T14:00:00.000Z',
  fim_at: '2026-06-23T14:30:00.000Z',
  cliente_nome: 'João',
  cliente_contato: '5535999990000',
  servico_nome: 'Corte',
  valor_cents: 5000,
  desconto_cents: 0,
  forma_pagamento: 'pix',
  colaborador_id: null,
  profissional_nome: null,
  origem: 'agenda',
  dirty_fields: [],
  status: 'ok',
  ...over,
});

describe('rótulos com fallback (campos nullable)', () => {
  it('forma null -> "Sem forma"; conhecida -> rótulo pt-BR', () => {
    expect(formaPagamentoLabel(null)).toBe('Sem forma');
    expect(formaPagamentoLabel('pix')).toBe('Pix');
    expect(formaPagamentoLabel('credito')).toBe('Crédito');
  });

  it('profissional null/vazio -> "Sem profissional"', () => {
    expect(profissionalLabel(null)).toBe('Sem profissional');
    expect(profissionalLabel('   ')).toBe('Sem profissional');
    expect(profissionalLabel('Maria')).toBe('Maria');
  });

  it('serviço e cliente têm fallback próprio', () => {
    expect(servicoLabel(null)).toBe('Sem serviço');
    expect(servicoLabel('Barba')).toBe('Barba');
    expect(clienteLabel(null)).toBe('Sem cliente');
    expect(clienteLabel('Ana')).toBe('Ana');
  });
});

describe('rowBadge (Editado / Auto / Manual)', () => {
  it('dirty não-vazio SEMPRE vence -> "editado" (mesmo origem agenda)', () => {
    expect(rowBadge({ origem: 'agenda', dirty_fields: ['valor_cents'] })).toBe('editado');
    expect(rowBadge({ origem: 'manual', dirty_fields: ['forma_pagamento'] })).toBe('editado');
  });

  it('sem dirty: agenda -> "auto", manual -> "manual"', () => {
    expect(rowBadge({ origem: 'agenda', dirty_fields: [] })).toBe('auto');
    expect(rowBadge({ origem: 'manual', dirty_fields: [] })).toBe('manual');
  });
});

describe('valorLiquidoCents', () => {
  it('subtrai o desconto e nunca fica negativo', () => {
    expect(valorLiquidoCents({ valor_cents: 5000, desconto_cents: 1000 })).toBe(4000);
    expect(valorLiquidoCents({ valor_cents: 5000, desconto_cents: 6000 })).toBe(0);
  });
});

describe('cache otimista da lista', () => {
  const lista = (): AtendimentosListResponse => ({
    atendimentos: [row({ id: 1, valor_cents: 5000 }), row({ id: 2, valor_cents: 3000 })],
    total_cents: 8000,
  });

  it('patchRowNaLista substitui in-place e recomputa o total', () => {
    const next = patchRowNaLista(
      lista(),
      row({ id: 1, valor_cents: 4000, dirty_fields: ['valor_cents'] }),
    );
    expect(next.atendimentos[0].valor_cents).toBe(4000);
    expect(next.atendimentos[0].dirty_fields).toEqual(['valor_cents']);
    expect(next.total_cents).toBe(7000); // 4000 + 3000
  });

  it('patchRowNaLista com id ausente devolve a MESMA referência', () => {
    const prev = lista();
    expect(patchRowNaLista(prev, row({ id: 99 }))).toBe(prev);
  });

  it('removerRowDaLista tira a linha e recomputa o total', () => {
    const next = removerRowDaLista(lista(), 1);
    expect(next.atendimentos.map((r) => r.id)).toEqual([2]);
    expect(next.total_cents).toBe(3000);
  });

  it('removerRowDaLista é idempotente (id ausente -> mesma referência)', () => {
    const prev = lista();
    expect(removerRowDaLista(prev, 99)).toBe(prev);
  });

  it('somarTotalCents usa o líquido (desconta)', () => {
    expect(
      somarTotalCents([
        row({ id: 1, valor_cents: 5000, desconto_cents: 1000 }),
        row({ id: 2, valor_cents: 3000 }),
      ]),
    ).toBe(7000); // 4000 + 3000
  });
});

describe('draftFromRow / centsToInput', () => {
  it('formata centavos pro input monetário', () => {
    expect(centsToInput(5000)).toBe('50,00');
    expect(centsToInput(4050)).toBe('40,50');
  });

  it('monta o rascunho com fallbacks (forma null -> dinheiro, desconto 0 -> vazio)', () => {
    const d = draftFromRow(row({ forma_pagamento: null, desconto_cents: 0, servico_nome: null }));
    expect(d.forma).toBe('dinheiro');
    expect(d.desconto).toBe('');
    expect(d.servicoNome).toBe('');
    expect(d.valor).toBe('50,00');
  });

  it('preenche desconto quando > 0', () => {
    expect(draftFromRow(row({ desconto_cents: 500 })).desconto).toBe('5,00');
  });
});

describe('validateEdit (PATCH mínimo, só o que mudou)', () => {
  it('edita só o valor: PATCH carrega APENAS valor_cents', () => {
    const original = row({ valor_cents: 5000, forma_pagamento: 'pix', servico_nome: 'Corte' });
    const draft = { ...draftFromRow(original), valor: '40,00' };
    const res = validateEdit(original, draft);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.patch).toEqual({ valor_cents: 4000 });
      expect(patchVazio(res.patch)).toBe(false);
    }
  });

  it('nada mudou -> PATCH vazio (botão Salvar trava)', () => {
    const original = row();
    const res = validateEdit(original, draftFromRow(original));
    expect(res.ok).toBe(true);
    if (res.ok) expect(patchVazio(res.patch)).toBe(true);
  });

  it('pacote zera o valor sem exigir o campo', () => {
    const original = row({ valor_cents: 5000, forma_pagamento: 'pix' });
    const draft = { ...draftFromRow(original), forma: 'pacote' as const, valor: '' };
    const res = validateEdit(original, draft);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.patch.valor_cents).toBe(0);
      expect(res.patch.forma_pagamento).toBe('pacote');
    }
  });

  it('valor não-pacote vazio/zero -> erro', () => {
    const original = row({ valor_cents: 5000 });
    expect(validateEdit(original, { ...draftFromRow(original), valor: '' }).ok).toBe(false);
    expect(validateEdit(original, { ...draftFromRow(original), valor: '0' }).ok).toBe(false);
  });

  it('desconto maior que o valor -> erro', () => {
    const original = row({ valor_cents: 5000, desconto_cents: 0 });
    const draft = { ...draftFromRow(original), desconto: '60,00' };
    const res = validateEdit(original, draft);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.errors.desconto).toBeDefined();
  });

  it('limpar o serviço editado manda servico_nome="" (limpa no backend)', () => {
    const original = row({ servico_nome: 'Corte' });
    const draft = { ...draftFromRow(original), servicoNome: '' };
    const res = validateEdit(original, draft);
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.patch.servico_nome).toBe('');
  });
});
