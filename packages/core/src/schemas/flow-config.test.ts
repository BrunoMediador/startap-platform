import { describe, expect, it } from 'vitest';
import {
  FORMAS_PAGAMENTO_OPCOES,
  formasPagamentoSchema,
  formasPagamentoToString,
  horarioDiaSchema,
  horariosSchema,
  parseFormasPagamento,
  perfilSchema,
  servicoSchema,
  servicosSchema,
} from './flow-config.js';

describe('servicoSchema', () => {
  it('aceita servico valido', () => {
    const r = servicoSchema.safeParse({ nome: 'Corte', preco_cents: 4500, duracao_min: 30 });
    expect(r.success).toBe(true);
  });

  it('rejeita preco_cents negativo', () => {
    const r = servicoSchema.safeParse({ nome: 'Corte', preco_cents: -1, duracao_min: 30 });
    expect(r.success).toBe(false);
  });

  it('rejeita preco_cents nao-inteiro (centavos devem ser inteiros)', () => {
    const r = servicoSchema.safeParse({ nome: 'Corte', preco_cents: 45.5, duracao_min: 30 });
    expect(r.success).toBe(false);
  });

  it('rejeita duracao_min zero ou negativa', () => {
    expect(servicoSchema.safeParse({ nome: 'X', preco_cents: 100, duracao_min: 0 }).success).toBe(
      false,
    );
    expect(servicoSchema.safeParse({ nome: 'X', preco_cents: 100, duracao_min: -5 }).success).toBe(
      false,
    );
  });

  it('aceita duracao_min multipla de 5 (grade de agenda em passos de 5min)', () => {
    expect(servicoSchema.safeParse({ nome: 'X', preco_cents: 100, duracao_min: 5 }).success).toBe(
      true,
    );
    expect(servicoSchema.safeParse({ nome: 'X', preco_cents: 100, duracao_min: 25 }).success).toBe(
      true,
    );
  });

  it('rejeita duracao_min fora do passo de 5 minutos', () => {
    expect(servicoSchema.safeParse({ nome: 'X', preco_cents: 100, duracao_min: 7 }).success).toBe(
      false,
    );
    expect(servicoSchema.safeParse({ nome: 'X', preco_cents: 100, duracao_min: 23 }).success).toBe(
      false,
    );
  });

  it('rejeita nome vazio', () => {
    const r = servicoSchema.safeParse({ nome: '   ', preco_cents: 100, duracao_min: 30 });
    expect(r.success).toBe(false);
  });

  it('rejeita campos extras (strict)', () => {
    const r = servicoSchema.safeParse({
      nome: 'Corte',
      preco_cents: 100,
      duracao_min: 30,
      slot: 'outro_clone',
    });
    expect(r.success).toBe(false);
  });
});

describe('servicosSchema', () => {
  it('aceita array vazio', () => {
    expect(servicosSchema.safeParse([]).success).toBe(true);
  });

  it('rejeita item invalido dentro do array', () => {
    const r = servicosSchema.safeParse([
      { nome: 'Corte', preco_cents: 4500, duracao_min: 30 },
      { nome: 'Barba', preco_cents: -1, duracao_min: 20 },
    ]);
    expect(r.success).toBe(false);
  });

  it('rejeita mais de 100 servicos', () => {
    const big = Array.from({ length: 101 }, (_, i) => ({
      nome: `S${i}`,
      preco_cents: 100,
      duracao_min: 10,
    }));
    expect(servicosSchema.safeParse(big).success).toBe(false);
  });
});

describe('horarioDiaSchema', () => {
  it('aceita dia aberto com abre < fecha', () => {
    const r = horarioDiaSchema.safeParse({ abre: '09:00', fecha: '18:00', fechado: false });
    expect(r.success).toBe(true);
  });

  it('rejeita abre >= fecha', () => {
    expect(
      horarioDiaSchema.safeParse({ abre: '18:00', fecha: '09:00', fechado: false }).success,
    ).toBe(false);
    expect(
      horarioDiaSchema.safeParse({ abre: '09:00', fecha: '09:00', fechado: false }).success,
    ).toBe(false);
  });

  it('rejeita HH:MM invalido', () => {
    expect(
      horarioDiaSchema.safeParse({ abre: '25:00', fecha: '26:00', fechado: false }).success,
    ).toBe(false);
    expect(
      horarioDiaSchema.safeParse({ abre: '9:0', fecha: '18:00', fechado: false }).success,
    ).toBe(false);
  });

  it('aceita dia fechado com abre/fecha nulos', () => {
    const r = horarioDiaSchema.safeParse({ abre: null, fecha: null, fechado: true });
    expect(r.success).toBe(true);
  });

  it('rejeita dia fechado com horario preenchido (incoerente)', () => {
    const r = horarioDiaSchema.safeParse({ abre: '09:00', fecha: '18:00', fechado: true });
    expect(r.success).toBe(false);
  });

  it('rejeita dia aberto sem abre/fecha', () => {
    const r = horarioDiaSchema.safeParse({ abre: null, fecha: null, fechado: false });
    expect(r.success).toBe(false);
  });
});

describe('horariosSchema', () => {
  it('aceita grade parcial valida', () => {
    const r = horariosSchema.safeParse({
      segunda: { abre: null, fecha: null, fechado: true },
      terca: { abre: '09:00', fecha: '18:00', fechado: false },
    });
    expect(r.success).toBe(true);
  });

  it('rejeita dia desconhecido (strict)', () => {
    const r = horariosSchema.safeParse({
      funday: { abre: '09:00', fecha: '18:00', fechado: false },
    });
    expect(r.success).toBe(false);
  });
});

describe('formasPagamentoSchema', () => {
  it('aceita subconjunto valido das opcoes fixas', () => {
    const r = formasPagamentoSchema.safeParse(['PIX', 'Dinheiro']);
    expect(r.success).toBe(true);
  });

  it('normaliza para a ordem canonica e deduplica', () => {
    const r = formasPagamentoSchema.safeParse(['Cartão de crédito', 'PIX', 'PIX', 'Dinheiro']);
    expect(r.success).toBe(true);
    if (r.success) expect(r.data).toEqual(['Dinheiro', 'PIX', 'Cartão de crédito']);
  });

  it('aceita lista vazia (limpar) e undefined (opcional)', () => {
    expect(formasPagamentoSchema.safeParse([]).success).toBe(true);
    expect(formasPagamentoSchema.safeParse(undefined).success).toBe(true);
  });

  it('rejeita valor fora da lista permitida (400 no portal-api)', () => {
    expect(formasPagamentoSchema.safeParse(['Boleto']).success).toBe(false);
    expect(formasPagamentoSchema.safeParse(['PIX', 'fiado']).success).toBe(false);
  });

  it('rejeita tipo invalido (string em vez de array)', () => {
    expect(formasPagamentoSchema.safeParse('PIX').success).toBe(false);
  });
});

describe('parseFormasPagamento (migracao best-effort do texto livre antigo)', () => {
  it('mapeia free-text com acento/caixa pras opcoes canonicas', () => {
    expect(parseFormasPagamento('Pix, dinheiro, cartão')).toEqual([
      'Dinheiro',
      'PIX',
      'Cartão de débito',
      'Cartão de crédito',
    ]);
  });

  it('distingue debito de credito quando o texto qualifica', () => {
    expect(parseFormasPagamento('cartão de débito e dinheiro')).toEqual([
      'Dinheiro',
      'Cartão de débito',
    ]);
  });

  it('ignora tokens nao-mapeaveis (ex.: fiado/boleto)', () => {
    expect(parseFormasPagamento('Pix, fiado, boleto')).toEqual(['PIX']);
  });

  it('entrada vazia/invalida vira []', () => {
    expect(parseFormasPagamento('')).toEqual([]);
    expect(parseFormasPagamento('   ')).toEqual([]);
    expect(parseFormasPagamento(null)).toEqual([]);
    expect(parseFormasPagamento(42)).toEqual([]);
  });
});

describe('formasPagamentoToString (serializacao pro storage)', () => {
  it('junta na ordem canonica com ", "', () => {
    expect(formasPagamentoToString(['Cartão de crédito', 'PIX'])).toBe('PIX, Cartão de crédito');
  });

  it('lista vazia vira ""', () => {
    expect(formasPagamentoToString([])).toBe('');
  });

  it('round-trip estavel: parse(toString(x)) preserva o conjunto', () => {
    const x = [...FORMAS_PAGAMENTO_OPCOES];
    expect(parseFormasPagamento(formasPagamentoToString(x))).toEqual(x);
  });
});

describe('perfilSchema', () => {
  it('aceita perfil completo valido', () => {
    const r = perfilSchema.safeParse({
      nome_negocio: 'Barbearia do Edu',
      nome_prestador: 'Edu',
      telefone_contato: '(11) 99999-0000',
      endereco: 'Rua X, 123',
      instagram: 'barbeariaedu',
      formas_pagamento: ['PIX', 'Dinheiro'],
    });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.formas_pagamento).toEqual(['Dinheiro', 'PIX']);
  });

  it('rejeita forma de pagamento fora da lista', () => {
    const r = perfilSchema.safeParse({ formas_pagamento: ['Boleto'] });
    expect(r.success).toBe(false);
  });

  it('aceita objeto vazio (todos os campos opcionais)', () => {
    expect(perfilSchema.safeParse({}).success).toBe(true);
  });

  it('aceita campos vazios ("" / []) como limpar o campo', () => {
    const r = perfilSchema.safeParse({ nome_negocio: '', formas_pagamento: [] });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.nome_negocio).toBe('');
      expect(r.data.formas_pagamento).toEqual([]);
    }
  });

  it('normaliza instagram removendo o @ inicial (nao precisa do @)', () => {
    const com = perfilSchema.safeParse({ instagram: '@barbeariaedu' });
    const sem = perfilSchema.safeParse({ instagram: 'barbeariaedu' });
    expect(com.success && com.data.instagram).toBe('barbeariaedu');
    expect(sem.success && sem.data.instagram).toBe('barbeariaedu');
  });

  it('rejeita campo extra (strict) — nao deixa cliente injetar outras chaves', () => {
    const r = perfilSchema.safeParse({ nome_negocio: 'X', slot: 'outro_clone' });
    expect(r.success).toBe(false);
  });

  it('rejeita nome_negocio acima do maxlength', () => {
    const r = perfilSchema.safeParse({ nome_negocio: 'a'.repeat(121) });
    expect(r.success).toBe(false);
  });

  it('rejeita tipo invalido (numero em vez de string)', () => {
    const r = perfilSchema.safeParse({ nome_negocio: 123 });
    expect(r.success).toBe(false);
  });

  // ── MODO ATENDENTE (SCRUM-59) ────────────────────────────────────────────
  it('aceita agenda_automatica boolean (true/false)', () => {
    expect(perfilSchema.safeParse({ agenda_automatica: false }).success).toBe(true);
    expect(perfilSchema.safeParse({ agenda_automatica: true }).success).toBe(true);
  });

  it('rejeita agenda_automatica nao-boolean', () => {
    expect(perfilSchema.safeParse({ agenda_automatica: 'false' }).success).toBe(false);
    expect(perfilSchema.safeParse({ agenda_automatica: 1 }).success).toBe(false);
  });

  it('agenda_automatica NAO tem default (ausente = undefined, pra nao clobbar no PATCH)', () => {
    const r = perfilSchema.safeParse({});
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.agenda_automatica).toBeUndefined();
  });

  it('link_agendamento: aceita URL valida e e OPCIONAL SEMPRE (mesmo com agenda_automatica=false)', () => {
    expect(perfilSchema.safeParse({ link_agendamento: 'https://booksy.com/x' }).success).toBe(true);
    // link opcional mesmo quando o modo atendente esta ligado (decisao Bruno 03/07).
    expect(perfilSchema.safeParse({ agenda_automatica: false }).success).toBe(true);
  });

  it('link_agendamento: rejeita string que nao e URL', () => {
    const r = perfilSchema.safeParse({ link_agendamento: 'nao-e-url' });
    expect(r.success).toBe(false);
  });

  it('SCRUM-75: link_agendamento "" (e só-espaços) é ACEITO e vira "" (sentinela de LIMPAR)', () => {
    // Fluxo primario do piloto: ligar modo atendente SEM link -> front envia ''.
    // ANTES (SCRUM-59) '' virava undefined e o data layer nunca limpava -> impossivel remover
    // o link. AGORA '' e sentinela de limpar (o data layer apaga a chave do JSONB).
    const vazio = perfilSchema.safeParse({ agenda_automatica: false, link_agendamento: '' });
    expect(vazio.success).toBe(true);
    if (vazio.success) expect(vazio.data.link_agendamento).toBe('');

    // so-espacos normaliza pra '' (mesma sentinela de limpar).
    const espacos = perfilSchema.safeParse({ link_agendamento: '   ' });
    expect(espacos.success).toBe(true);
    if (espacos.success) expect(espacos.data.link_agendamento).toBe('');
  });

  it('SCRUM-75: link_agendamento AUSENTE segue ausente (undefined — não toca a chave)', () => {
    const r = perfilSchema.safeParse({ nome_negocio: 'X' });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.link_agendamento).toBeUndefined();
  });

  it('link_agendamento: rejeita esquemas perigosos (javascript:/data:/ftp:) — so http(s)', () => {
    expect(perfilSchema.safeParse({ link_agendamento: 'javascript:alert(1)' }).success).toBe(false);
    expect(perfilSchema.safeParse({ link_agendamento: 'data:text/html,<script>' }).success).toBe(
      false,
    );
    expect(perfilSchema.safeParse({ link_agendamento: 'ftp://x.co/a' }).success).toBe(false);
    // http e https continuam OK.
    expect(perfilSchema.safeParse({ link_agendamento: 'http://booksy.com/x' }).success).toBe(true);
    expect(perfilSchema.safeParse({ link_agendamento: 'https://booksy.com/x' }).success).toBe(true);
  });

  // "Planos e assinaturas" (planos_beneficios, SCRUM-59) foi removido do perfil em SCRUM-160
  // (01/08) — o schema é .strict(), então o campo agora é rejeitado com 400 (ver teste abaixo).
  it('SCRUM-160: planos_beneficios não é mais aceito pelo schema (.strict() rejeita a chave legada)', () => {
    const r = perfilSchema.safeParse({ planos_beneficios: 'Plano Mensal R$99' });
    expect(r.success).toBe(false);
  });
});
