import { describe, expect, it } from 'vitest';
import {
  ATENDENTE_ABAS,
  type AbaKey,
  NEGOCIO_ABAS,
  type SecaoKey,
  TODAS_ABAS,
  TODAS_SECOES,
  abaDaSecao,
  filterAtendenteAbas,
  filterNegocioAbas,
} from './abas';
import type { NavGateContext } from './nav';

// Harness pure-fn do portal (sem RTL/jsdom), SCRUM-157: cobre o CONTRATO das
// sub-abas de "Meu negócio"/"Meu atendente" — completude do mapa seção->aba
// (herdado da extinta perfil-grupos.ts), sem href duplicado, ordem travada, e
// os gates ligando/desligando cada aba (individual × estabelecimento, feature
// on/off).

const BASE: NavGateContext = {
  conexaoEnabled: false,
  isEstabelecimento: false,
  atendimentosEnabled: false,
};

describe('abas — completude do mapa seção -> aba (herdado da extinta perfil-grupos.ts)', () => {
  it('toda SecaoKey resolve pra alguma aba', () => {
    for (const secao of TODAS_SECOES) {
      expect(abaDaSecao(secao), `seção "${secao}" sem aba mapeada`).toBeDefined();
    }
  });

  it('mapeamento exato seção -> aba', () => {
    const mapa: Record<SecaoKey, AbaKey> = {
      'dados-negocio': 'negocio-dados',
      planos: 'negocio-dados',
      recepcao: 'negocio-dados',
      'monte-assistente': 'atendente-personalidade',
      tom: 'atendente-personalidade',
      cartao: 'atendente-mensagens',
      faq: 'atendente-mensagens',
      agendamento: 'negocio-agenda',
      lembretes: 'negocio-agenda',
      'google-agenda': 'negocio-agenda',
    };
    for (const [secao, aba] of Object.entries(mapa) as [SecaoKey, AbaKey][]) {
      expect(abaDaSecao(secao)).toBe(aba);
    }
  });
});

describe('abas — hrefs sem duplicidade e ordem travada', () => {
  it('nenhum href se repete entre NEGOCIO_ABAS e ATENDENTE_ABAS', () => {
    const hrefs = TODAS_ABAS.map((a) => a.href);
    expect(new Set(hrefs).size).toBe(hrefs.length);
  });

  it('nenhuma AbaKey se repete', () => {
    const keys = TODAS_ABAS.map((a) => a.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('NEGOCIO_ABAS na ordem dados -> serviços -> horários -> equipe -> agenda', () => {
    expect(NEGOCIO_ABAS.map((a) => a.href)).toEqual([
      '/negocio/dados',
      '/negocio/servicos',
      '/negocio/horarios',
      '/negocio/equipe',
      '/negocio/agenda',
    ]);
  });

  it('ATENDENTE_ABAS na ordem personalidade -> mensagens -> testar', () => {
    expect(ATENDENTE_ABAS.map((a) => a.href)).toEqual([
      '/atendente/personalidade',
      '/atendente/mensagens',
      '/atendente/testar',
    ]);
  });

  it('TODAS_ABAS concatena negócio antes de atendente, sem perder nem duplicar item', () => {
    expect(TODAS_ABAS).toEqual([...NEGOCIO_ABAS, ...ATENDENTE_ABAS]);
    expect(TODAS_ABAS.length).toBe(NEGOCIO_ABAS.length + ATENDENTE_ABAS.length);
  });
});

describe('abas — gates de "Meu negócio"', () => {
  it('Dados, Serviços e Horários aparecem sempre (sem gate)', () => {
    const hrefs = filterNegocioAbas(BASE).map((a) => a.href);
    expect(hrefs).toContain('/negocio/dados');
    expect(hrefs).toContain('/negocio/servicos');
    expect(hrefs).toContain('/negocio/horarios');
  });

  it('Equipe só aparece pra estabelecimento', () => {
    const individual = filterNegocioAbas({ ...BASE, isEstabelecimento: false });
    const estabelecimento = filterNegocioAbas({ ...BASE, isEstabelecimento: true });
    expect(individual.map((a) => a.href)).not.toContain('/negocio/equipe');
    expect(estabelecimento.map((a) => a.href)).toContain('/negocio/equipe');
  });

  it('Agenda aparece com QUALQUER um dos 3 sinais ligado (OR já resolvido pelo chamador)', () => {
    const nenhum = filterNegocioAbas({ ...BASE, negocioAgenda: false });
    const algum = filterNegocioAbas({ ...BASE, negocioAgenda: true });
    expect(nenhum.map((a) => a.href)).not.toContain('/negocio/agenda');
    expect(algum.map((a) => a.href)).toContain('/negocio/agenda');
  });

  it('Agenda some quando o gate não é passado (undefined = fail-closed)', () => {
    const semGate = filterNegocioAbas(BASE);
    expect(semGate.map((a) => a.href)).not.toContain('/negocio/agenda');
  });
});

describe('abas — gates de "Meu atendente"', () => {
  it('Personalidade aparece com builder OU tom (composto em atendentePersonalidade)', () => {
    const off = filterAtendenteAbas({ ...BASE, atendentePersonalidade: false });
    const on = filterAtendenteAbas({ ...BASE, atendentePersonalidade: true });
    expect(off.map((a) => a.href)).not.toContain('/atendente/personalidade');
    expect(on.map((a) => a.href)).toContain('/atendente/personalidade');
  });

  it('Mensagens aparece com cartão OU faq (composto em atendenteMensagens)', () => {
    const off = filterAtendenteAbas({ ...BASE, atendenteMensagens: false });
    const on = filterAtendenteAbas({ ...BASE, atendenteMensagens: true });
    expect(off.map((a) => a.href)).not.toContain('/atendente/mensagens');
    expect(on.map((a) => a.href)).toContain('/atendente/mensagens');
  });

  it('Testar só aparece com sandbox ligado', () => {
    const off = filterAtendenteAbas({ ...BASE, sandbox: false });
    const on = filterAtendenteAbas({ ...BASE, sandbox: true });
    expect(off.map((a) => a.href)).not.toContain('/atendente/testar');
    expect(on.map((a) => a.href)).toContain('/atendente/testar');
  });

  it('tudo OFF esvazia "Meu atendente" por completo (fail-closed)', () => {
    expect(filterAtendenteAbas(BASE)).toEqual([]);
  });
});

describe('abas — cenário combinado (estabelecimento com tudo ligado)', () => {
  it('vê as 5 abas de negócio + as 3 de atendente', () => {
    const ctxTudo: NavGateContext = {
      conexaoEnabled: true,
      isEstabelecimento: true,
      atendimentosEnabled: true,
      negocioAgenda: true,
      atendentePersonalidade: true,
      atendenteMensagens: true,
      sandbox: true,
    };
    expect(filterNegocioAbas(ctxTudo).map((a) => a.href)).toEqual([
      '/negocio/dados',
      '/negocio/servicos',
      '/negocio/horarios',
      '/negocio/equipe',
      '/negocio/agenda',
    ]);
    expect(filterAtendenteAbas(ctxTudo).map((a) => a.href)).toEqual([
      '/atendente/personalidade',
      '/atendente/mensagens',
      '/atendente/testar',
    ]);
  });
});
