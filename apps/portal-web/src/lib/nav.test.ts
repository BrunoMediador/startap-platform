import { describe, expect, it } from 'vitest';
import { NAV_SPEC, type NavGateContext, filterByGates, isNavItemActive } from './nav';

// Harness pure-fn do portal (sem RTL/jsdom): cobrimos o CONTRATO da nav —
// menu de 8 itens pós-reorganização em telas (SCRUM-157: Serviços/Horários/
// Equipe saíram pra sub-abas de "Meu negócio"; "Meu atendente" é item novo),
// entrada FIXA da Agenda, ordem byte-idêntica dos demais itens e a filtragem
// por formato (individual vs estabelecimento, com os gates ligando/desligando
// itens). SCRUM-94 + SCRUM-157.

const hrefs = (ctx: NavGateContext) => filterByGates(NAV_SPEC, ctx).map((i) => i.href);

const TUDO_LIGADO: NavGateContext = {
  conexaoEnabled: true,
  isEstabelecimento: true,
  atendimentosEnabled: true,
  crmClientesEnabled: true,
};

describe('nav — 9 itens, na ordem canônica', () => {
  it('tem exatamente 9 itens', () => {
    expect(NAV_SPEC.length).toBe(9);
  });

  it('ordem: início, agenda, clientes, conectar, faturamento, meu negócio, meu atendente, pausas, mensalidade', () => {
    expect(NAV_SPEC.map((i) => i.href)).toEqual([
      '/inicio',
      '/agenda',
      '/clientes',
      '/conectar',
      '/billing',
      '/negocio',
      '/atendente',
      '/pausas',
      '/mensalidade',
    ]);
  });

  it('Serviços, Horários e Equipe NÃO estão mais no menu de topo (viraram sub-abas)', () => {
    const hrefsTodos = NAV_SPEC.map((i) => i.href);
    expect(hrefsTodos).not.toContain('/servicos');
    expect(hrefsTodos).not.toContain('/horarios');
    expect(hrefsTodos).not.toContain('/equipe');
  });

  it('"Meu negócio" trocou de /perfil pra /negocio, mantendo o ícone "user"', () => {
    const negocio = NAV_SPEC.find((i) => i.label === 'Meu negócio');
    expect(negocio?.href).toBe('/negocio');
    expect(negocio?.icon).toBe('user');
    expect(NAV_SPEC.some((i) => i.href === '/perfil')).toBe(false);
  });

  it('"Meu atendente" é item novo, com ícone "sparkle" e sem gate', () => {
    const atendente = NAV_SPEC.find((i) => i.href === '/atendente');
    expect(atendente?.label).toBe('Meu atendente');
    expect(atendente?.icon).toBe('sparkle');
    expect(atendente?.gated).toBeUndefined();
  });
});

describe('nav — Agenda com entrada fixa', () => {
  it('Agenda existe na spec, logo após Início e sem gate', () => {
    const inicio = NAV_SPEC.findIndex((i) => i.href === '/inicio');
    const agenda = NAV_SPEC.findIndex((i) => i.href === '/agenda');
    expect(agenda).toBe(inicio + 1);
    expect(NAV_SPEC[agenda]?.label).toBe('Agenda');
    expect(NAV_SPEC[agenda]?.gated).toBeUndefined();
  });

  it('Agenda aparece em TODOS os formatos — inclusive com todos os gates OFF', () => {
    const nenhumGate: NavGateContext = {
      conexaoEnabled: false,
      isEstabelecimento: false,
      atendimentosEnabled: false,
      crmClientesEnabled: false,
    };
    expect(hrefs(nenhumGate)).toContain('/agenda');
    expect(hrefs(TUDO_LIGADO)).toContain('/agenda');
  });
});

describe('nav — filtragem por formato', () => {
  it('individual (conexão + atendimentos, sem estabelecimento) vê o menu completo', () => {
    const individual: NavGateContext = {
      conexaoEnabled: true,
      isEstabelecimento: false,
      atendimentosEnabled: true,
      crmClientesEnabled: true,
    };
    expect(hrefs(individual)).toEqual([
      '/inicio',
      '/agenda',
      '/clientes',
      '/conectar',
      '/billing',
      '/negocio',
      '/atendente',
      '/pausas',
      '/mensalidade',
    ]);
  });

  it('estabelecimento com tudo ligado vê o mesmo menu de topo (Equipe agora é sub-aba)', () => {
    expect(hrefs(TUDO_LIGADO)).toEqual([
      '/inicio',
      '/agenda',
      '/clientes',
      '/conectar',
      '/billing',
      '/negocio',
      '/atendente',
      '/pausas',
      '/mensalidade',
    ]);
  });

  it('conexão OFF esconde Conectar; atendimentos OFF esconde Faturamento; CRM OFF esconde Clientes', () => {
    const enxuto: NavGateContext = {
      conexaoEnabled: false,
      isEstabelecimento: false,
      atendimentosEnabled: false,
      crmClientesEnabled: false,
    };
    const lista = hrefs(enxuto);
    expect(lista).not.toContain('/clientes');
    expect(lista).not.toContain('/conectar');
    expect(lista).not.toContain('/billing');
    // Itens sempre-presentes (byte-idêntico ao de antes, menos os que viraram sub-aba):
    expect(lista).toEqual([
      '/inicio',
      '/agenda',
      '/negocio',
      '/atendente',
      '/pausas',
      '/mensalidade',
    ]);
  });
});

describe('nav — isNavItemActive (SCRUM-157: sub-rotas de "Meu negócio"/"Meu atendente")', () => {
  it('itens com sub-abas acendem em match exato E em qualquer sub-rota', () => {
    expect(isNavItemActive('/negocio', '/negocio')).toBe(true);
    expect(isNavItemActive('/negocio/dados', '/negocio')).toBe(true);
    expect(isNavItemActive('/negocio/servicos', '/negocio')).toBe(true);
    expect(isNavItemActive('/atendente/personalidade', '/atendente')).toBe(true);
  });

  it('itens comuns exigem match EXATO (não acende por prefixo solto)', () => {
    expect(isNavItemActive('/agenda', '/agenda')).toBe(true);
    expect(isNavItemActive('/agenda/nova', '/agenda')).toBe(false);
    expect(isNavItemActive('/inicio', '/inicio')).toBe(true);
  });

  it('não confunde prefixo textual sem barra (ex.: "/negociosecreto" não é sub-rota de "/negocio")', () => {
    expect(isNavItemActive('/negociosecreto', '/negocio')).toBe(false);
  });

  it('"Meu negócio" nunca acende em rota de "Meu atendente" e vice-versa', () => {
    expect(isNavItemActive('/atendente/mensagens', '/negocio')).toBe(false);
    expect(isNavItemActive('/negocio/equipe', '/atendente')).toBe(false);
  });
});

describe('nav — ordem byte-idêntica dos itens de sempre', () => {
  it('preserva a ordem relativa dos itens não-Agenda pós-reorganização (SCRUM-157)', () => {
    const semAgenda = NAV_SPEC.filter((i) => i.href !== '/agenda').map((i) => i.href);
    expect(semAgenda).toEqual([
      '/inicio',
      '/clientes',
      '/conectar',
      '/billing',
      '/negocio',
      '/atendente',
      '/pausas',
      '/mensalidade',
    ]);
  });
});
