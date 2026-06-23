/**
 * Testa package-context (ADR 0025 BLOCO 2a — read-only):
 *  - resolveClientPackages degrada para [] sem lançar quando o pepper falta
 *    (validação LAZY — boot nunca crasha, lição #247) ou o telefone é inválido;
 *  - hasheia com o pepper PRÓPRIO e consulta por (slot, hmac);
 *  - buildSeuPacoteBlock formata ATIVO/EXPIRADO/ESGOTADO/CANCELADO explicitamente
 *    e devolve '' quando não há pacote (caller não injeta bloco).
 *
 * Mocka @startap/db (packages) + @startap/core (packagePhoneHmac).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  listActiveClientCredits: vi.fn(),
  listClientCredits: vi.fn(),
  redeemForBooking: vi.fn(),
  reconciliationHook: vi.fn(),
  packagePhoneHmac: vi.fn(),
}));

vi.mock('@startap/db', () => ({
  packages: {
    listActiveClientCredits: mocks.listActiveClientCredits,
    listClientCredits: mocks.listClientCredits,
    redeemForBooking: mocks.redeemForBooking,
    reconciliationHook: mocks.reconciliationHook,
  },
}));

// canonicalE164/logger reais; só o HMAC é mockado (controla o erro de pepper).
class FakePepperMissing extends Error {
  constructor() {
    super('missing');
    this.name = 'PackagePepperMissingError';
  }
}
vi.mock('@startap/core', () => ({
  PackagePepperMissingError: FakePepperMissing,
  packagePhoneHmac: (...a: unknown[]) => mocks.packagePhoneHmac(...a),
}));

const {
  resolveClientPackages,
  buildSeuPacoteBlock,
  deduzirPacoteNoAgendamento,
  servicoFromSummary,
} = await import('./package-context.js');

beforeEach(() => {
  vi.clearAllMocks();
  mocks.packagePhoneHmac.mockReturnValue('hmac-abc');
  mocks.listActiveClientCredits.mockResolvedValue([]);
  mocks.listClientCredits.mockResolvedValue([]);
  mocks.redeemForBooking.mockResolvedValue({
    descontou_do_pacote: false,
    avulso: true,
    motivo: 'sem_pacote',
    sessoes_restantes: null,
  });
});

describe('resolveClientPackages', () => {
  it('telefone válido: hasheia e consulta por (slot, hmac); apenasAtivos=true por default', async () => {
    mocks.listActiveClientCredits.mockResolvedValue([{ estado: 'ATIVO' }]);
    const out = await resolveClientPackages({ slot: 'cirilobarbearia', telefone: '5531999998842' });
    expect(mocks.packagePhoneHmac).toHaveBeenCalledTimes(1);
    expect(mocks.listActiveClientCredits).toHaveBeenCalledWith({
      slot: 'cirilobarbearia',
      phoneHmac: 'hmac-abc',
    });
    expect(out).toEqual([{ estado: 'ATIVO' }]);
  });

  it('apenasAtivos=false usa listClientCredits (inclui expirado/esgotado p/ o bloco)', async () => {
    mocks.listClientCredits.mockResolvedValue([{ estado: 'EXPIRADO' }]);
    const out = await resolveClientPackages({
      slot: 's',
      telefone: '5531999998842',
      apenasAtivos: false,
    });
    expect(mocks.listClientCredits).toHaveBeenCalled();
    expect(mocks.listActiveClientCredits).not.toHaveBeenCalled();
    expect(out).toEqual([{ estado: 'EXPIRADO' }]);
  });

  it('pepper AUSENTE: degrada para [] sem lançar (lição #247 — boot/atendimento nunca crasha)', async () => {
    mocks.packagePhoneHmac.mockImplementation(() => {
      throw new FakePepperMissing();
    });
    const out = await resolveClientPackages({ slot: 's', telefone: '5531999998842' });
    expect(out).toEqual([]);
    expect(mocks.listActiveClientCredits).not.toHaveBeenCalled();
  });

  it('telefone irrecuperável: [] sem hashear nem consultar (LGPD — não vaza número)', async () => {
    const out = await resolveClientPackages({ slot: 's', telefone: '123' });
    expect(out).toEqual([]);
    expect(mocks.packagePhoneHmac).not.toHaveBeenCalled();
    expect(mocks.listActiveClientCredits).not.toHaveBeenCalled();
  });

  it('erro de DB: degrada para [] (atendimento não quebra)', async () => {
    mocks.listActiveClientCredits.mockRejectedValue(new Error('pg down'));
    const out = await resolveClientPackages({ slot: 's', telefone: '5531999998842' });
    expect(out).toEqual([]);
  });
});

describe('buildSeuPacoteBlock', () => {
  function credit(over: Record<string, unknown> = {}) {
    return {
      credit_id: 1,
      package_id: 1,
      slot: 's',
      nome: 'Pacote 5 Cortes',
      sessoes_restantes: 3,
      sessoes_total: 5,
      data_expiracao: '2026-12-31',
      expirado: false,
      estado: 'ATIVO',
      servicos_cobertos: ['Corte', 'Barba'],
      colaborador_id: null,
      cobre: () => true,
      ...over,
    } as unknown as Parameters<typeof buildSeuPacoteBlock>[0][number];
  }

  it('sem pacote: retorna string vazia (caller não injeta o bloco)', () => {
    expect(buildSeuPacoteBlock([])).toBe('');
  });

  it('ATIVO: mostra saldo, total, validade BR e cobertura', () => {
    const b = buildSeuPacoteBlock([credit()]);
    expect(b).toContain('[SEU PACOTE]');
    expect(b).toContain('3 de 5 sessões restantes');
    expect(b).toContain('válido até 31/12/2026');
    expect(b).toContain('cobre: Corte, Barba');
    expect(b).toContain('vale com qualquer profissional'); // colaborador_id null = casa
  });

  it('EXPIRADO: estado explícito com a data (bot informa "expirou em DD/MM")', () => {
    const b = buildSeuPacoteBlock([credit({ estado: 'EXPIRADO', data_expiracao: '2024-01-10' })]);
    expect(b).toContain('EXPIRADO em 10/01/2024');
    expect(b).toContain('NÃO pode ser usado');
  });

  it('ESGOTADO: estado explícito', () => {
    const b = buildSeuPacoteBlock([credit({ estado: 'ESGOTADO', sessoes_restantes: 0 })]);
    expect(b).toContain('ESGOTADO');
  });

  it('escopo por colaborador quando colaborador_id preenchido (estabelecimento)', () => {
    const b = buildSeuPacoteBlock([credit({ colaborador_id: 42 })]);
    expect(b).toContain('só com o profissional definido');
  });

  it('cobertura vazia: "sem serviços vinculados" (regra do ADR §4: não cobre nada)', () => {
    const b = buildSeuPacoteBlock([credit({ servicos_cobertos: [] })]);
    expect(b).toContain('sem serviços vinculados');
  });

  it('PREÇO do pacote: "R$ X,XX" no bloco quando preco_cents está setado (pro bot informar)', () => {
    const b = buildSeuPacoteBlock([credit({ preco_cents: 8500 })]);
    expect(b).toContain('preço do pacote: R$ 85,00');
  });

  it('preço com centavos: 12990 → R$ 129,90', () => {
    const b = buildSeuPacoteBlock([credit({ preco_cents: 12990 })]);
    expect(b).toContain('R$ 129,90');
  });

  it('sem preço (preco_cents null): NÃO injeta rótulo de preço', () => {
    const b = buildSeuPacoteBlock([credit({ preco_cents: null })]);
    expect(b).not.toContain('preço do pacote');
  });
});

describe('servicoFromSummary — fallback de nome do serviço', () => {
  it('extrai do padrão "Nome - Servico | WhatsApp: numero"', () => {
    expect(servicoFromSummary('Fulano - Corte | WhatsApp: 5531999998842')).toBe('Corte');
  });
  it('sem o " - " separador → string vazia (server re-valida cobertura)', () => {
    expect(servicoFromSummary('texto solto')).toBe('');
  });
  it('serviço com espaços é preservado e trim aplicado', () => {
    expect(servicoFromSummary('Cliente - Barba e Cabelo | WhatsApp: 5531')).toBe('Barba e Cabelo');
  });
});

describe('deduzirPacoteNoAgendamento — wrapper de dedução (BLOCO 2b)', () => {
  it('descontou: chama redeemForBooking com hmac e dispara o reconciliation-hook', async () => {
    mocks.redeemForBooking.mockResolvedValue({
      descontou_do_pacote: true,
      avulso: false,
      motivo: 'descontado',
      sessoes_restantes: 2,
      credit_id: 7,
      pacote_nome: 'Pacote 5 Cortes',
      colaborador_id: null,
    });
    const r = await deduzirPacoteNoAgendamento({
      slot: 'cirilobarbearia',
      tenantId: 't-1',
      telefone: '5531999998842',
      gcalEventId: 'evt-1',
      servicoNome: 'Corte',
    });
    expect(r.descontou_do_pacote).toBe(true);
    expect(mocks.redeemForBooking).toHaveBeenCalledWith(
      expect.objectContaining({
        slot: 'cirilobarbearia',
        tenantId: 't-1',
        phoneHmac: 'hmac-abc',
        gcalEventId: 'evt-1',
        servicoNome: 'Corte',
        usarPacote: true,
      }),
    );
    // dívida cancelar+reagendar: rastro p/ job de reconciliação.
    expect(mocks.reconciliationHook).toHaveBeenCalledWith(
      expect.objectContaining({ gcalEventId: 'evt-1', creditId: 7 }),
    );
  });

  it('avulso (não descontou): NÃO dispara o reconciliation-hook', async () => {
    mocks.redeemForBooking.mockResolvedValue({
      descontou_do_pacote: false,
      avulso: true,
      motivo: 'sem_pacote',
      sessoes_restantes: null,
    });
    await deduzirPacoteNoAgendamento({
      slot: 's',
      telefone: '5531999998842',
      gcalEventId: 'e',
      servicoNome: 'Corte',
    });
    expect(mocks.reconciliationHook).not.toHaveBeenCalled();
  });

  it('pepper AUSENTE: degrada para avulso (motivo pepper_ausente), não chama redeem', async () => {
    mocks.packagePhoneHmac.mockImplementation(() => {
      throw new FakePepperMissing();
    });
    const r = await deduzirPacoteNoAgendamento({
      slot: 's',
      telefone: '5531999998842',
      gcalEventId: 'e',
      servicoNome: 'Corte',
    });
    expect(r.avulso).toBe(true);
    expect(r.descontou_do_pacote).toBe(false);
    expect(r.motivo).toBe('pepper_ausente');
    expect(mocks.redeemForBooking).not.toHaveBeenCalled();
  });

  it('telefone irrecuperável: avulso sem hashear nem deduzir (LGPD)', async () => {
    const r = await deduzirPacoteNoAgendamento({
      slot: 's',
      telefone: '123',
      gcalEventId: 'e',
      servicoNome: 'Corte',
    });
    expect(r.avulso).toBe(true);
    expect(mocks.packagePhoneHmac).not.toHaveBeenCalled();
    expect(mocks.redeemForBooking).not.toHaveBeenCalled();
  });

  it('erro no redeem: degrada para avulso (motivo erro), não lança', async () => {
    mocks.redeemForBooking.mockRejectedValue(new Error('pg down'));
    const r = await deduzirPacoteNoAgendamento({
      slot: 's',
      telefone: '5531999998842',
      gcalEventId: 'e',
      servicoNome: 'Corte',
    });
    expect(r.avulso).toBe(true);
    expect(r.motivo).toBe('erro');
  });
});
