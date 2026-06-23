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

  /**
   * EVAL — proatividade de pacote (regra de ouro: não mexer em pacote sem eval).
   * Golden cases sobre o CONTEXTO/INSTRUÇÃO montado (sem LLM real — o repo não tem
   * harness de LLM). Cada caso = uma intenção do cliente; o assert garante que o
   * bloco injetado carrega a informação/instrução que faz o bot responder certo.
   */
  describe('EVAL proatividade — instrução + dados prontos no bloco injetado', () => {
    // 1) instrução de proatividade presente (pergunta pacote vs avulso, não decide sozinho)
    it('pacote ativo: instrui PERGUNTAR pacote vs avulso (não deduz silenciosamente)', () => {
      const b = buildSeuPacoteBlock([credit()]);
      expect(b).toContain('Seja PROATIVO');
      expect(b).toMatch(/pagar avulso/);
      expect(b).toContain('NÃO decida sozinho');
    });

    // 2) serviço NÃO coberto: instrui avisar avulso e oferecer
    it('serviço fora do pacote: instrui avisar avulso e oferecer o avulso', () => {
      const b = buildSeuPacoteBlock([credit({ servicos_cobertos: ['Corte'] })]);
      expect(b).toContain('NÃO está coberto');
      expect(b).toContain('avise');
      expect(b).toContain('avulso');
    });

    // 3) "quanto tenho de pacote?" → saldo pronto no bloco
    it('"quanto tenho?": saldo X de Y já pronto (bot lê, não recalcula)', () => {
      const b = buildSeuPacoteBlock([credit({ sessoes_restantes: 2, sessoes_total: 5 })]);
      expect(b).toContain('2 de 5 sessões restantes');
      expect(b).toContain('nunca invente nem recalcule');
    });

    // 4) "quando vence?" → validade BR pronta
    it('"quando vence?": validade em DD/MM/AAAA pronta', () => {
      const b = buildSeuPacoteBlock([credit({ data_expiracao: '2026-08-15' })]);
      expect(b).toContain('válido até 15/08/2026');
      expect(b).toMatch(/quando vence/i);
    });

    // 5) "esse corte é do meu pacote?" → cobertura listada
    it('"esse corte é do pacote?": cobertura explícita no bloco', () => {
      const b = buildSeuPacoteBlock([credit({ servicos_cobertos: ['Corte', 'Barba'] })]);
      expect(b).toContain('cobre: Corte, Barba');
      expect(b).toMatch(/o que cobre/i);
    });

    // 6) "quanto custou?" → instrução de informar preço (preço em si vem do #340)
    it('"quanto custou?": instrui informar preço pronto (não inventa)', () => {
      const b = buildSeuPacoteBlock([credit()]);
      expect(b).toMatch(/quanto custou/i);
      expect(b).toContain('preço');
    });

    // 7) a pergunta sugerida traz X/Y e validade (parâmetros corretos)
    it('a pergunta sugerida referencia sessões e data de validade', () => {
      const b = buildSeuPacoteBlock([credit()]);
      expect(b).toMatch(/sessões.*vence/);
      expect(b).toContain('Quer usar seu pacote');
    });

    // 8) EXPIRADO: NÃO oferece pacote (cai em avulso) — proatividade não fura validade
    it('pacote EXPIRADO: bloco mantém "NÃO pode ser usado" (proatividade respeita validade)', () => {
      const b = buildSeuPacoteBlock([credit({ estado: 'EXPIRADO', data_expiracao: '2024-01-10' })]);
      expect(b).toContain('EXPIRADO em 10/01/2024');
      expect(b).toContain('NÃO pode ser usado');
      // a instrução de proatividade segue presente (vale p/ outros pacotes ativos do cliente)
      expect(b).toContain('Seja PROATIVO');
    });

    // 9) ESGOTADO: idem — não oferece desconto de saldo zerado
    it('pacote ESGOTADO: bloco marca esgotado e não promete pacote', () => {
      const b = buildSeuPacoteBlock([credit({ estado: 'ESGOTADO', sessoes_restantes: 0 })]);
      expect(b).toContain('ESGOTADO');
      expect(b).toContain('NÃO pode ser usado');
    });

    // 10) múltiplos pacotes: a instrução aparece UMA vez (no rodapé), não por linha
    it('múltiplos pacotes: instrução de proatividade aparece só uma vez (rodapé)', () => {
      const b = buildSeuPacoteBlock([
        credit({ nome: 'Pacote Cortes' }),
        credit({ nome: 'Pacote Barba', servicos_cobertos: ['Barba'] }),
      ]);
      expect(b.match(/Seja PROATIVO/g)?.length).toBe(1);
      expect(b).toContain('Pacote Cortes');
      expect(b).toContain('Pacote Barba');
    });
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
