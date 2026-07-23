import { describe, expect, it } from 'vitest';
import { NAV_SPEC, type NavGateContext, filterByGates } from './nav';

// Harness pure-fn do portal (sem RTL/jsdom): cobrimos o CONTRATO da nav —
// entrada FIXA da Agenda, desambiguação de ícone Agenda×Horários, ordem
// byte-idêntica dos demais itens e a filtragem por formato (individual vs
// estabelecimento, com os gates ligando/desligando itens). SCRUM-94.

const hrefs = (ctx: NavGateContext) => filterByGates(NAV_SPEC, ctx).map((i) => i.href);

const TUDO_LIGADO: NavGateContext = {
  conexaoEnabled: true,
  isEstabelecimento: true,
  atendimentosEnabled: true,
};

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
    };
    expect(hrefs(nenhumGate)).toContain('/agenda');
    expect(hrefs(TUDO_LIGADO)).toContain('/agenda');
  });
});

describe('nav — desambiguação de ícone Agenda × Horários', () => {
  it('Agenda usa o calendário; Horários (funcionamento) usa o relógio', () => {
    const agenda = NAV_SPEC.find((i) => i.href === '/agenda');
    const horarios = NAV_SPEC.find((i) => i.href === '/horarios');
    expect(agenda?.icon).toBe('calendar');
    expect(horarios?.icon).toBe('clock');
    // O bug do SCRUM-94: os dois dividiam 'calendar'. Nunca mais.
    expect(horarios?.icon).not.toBe('calendar');
  });
});

describe('nav — filtragem por formato', () => {
  it('individual (conexão + atendimentos, sem estabelecimento) não vê Equipe', () => {
    const individual: NavGateContext = {
      conexaoEnabled: true,
      isEstabelecimento: false,
      atendimentosEnabled: true,
    };
    expect(hrefs(individual)).toEqual([
      '/inicio',
      '/agenda',
      '/conectar',
      '/billing',
      '/servicos',
      '/horarios',
      '/perfil',
      '/pausas',
      '/mensalidade',
    ]);
  });

  it('estabelecimento com tudo ligado vê Equipe + Faturamento + Conectar', () => {
    expect(hrefs(TUDO_LIGADO)).toEqual([
      '/inicio',
      '/agenda',
      '/conectar',
      '/equipe',
      '/billing',
      '/servicos',
      '/horarios',
      '/perfil',
      '/pausas',
      '/mensalidade',
    ]);
  });

  it('conexão OFF esconde Conectar; atendimentos OFF esconde Faturamento', () => {
    const enxuto: NavGateContext = {
      conexaoEnabled: false,
      isEstabelecimento: false,
      atendimentosEnabled: false,
    };
    const lista = hrefs(enxuto);
    expect(lista).not.toContain('/conectar');
    expect(lista).not.toContain('/billing');
    expect(lista).not.toContain('/equipe');
    // Itens sempre-presentes (byte-idêntico ao de antes + Agenda nova):
    expect(lista).toEqual([
      '/inicio',
      '/agenda',
      '/servicos',
      '/horarios',
      '/perfil',
      '/pausas',
      '/mensalidade',
    ]);
  });
});

describe('nav — ordem byte-idêntica dos itens de sempre', () => {
  it('preserva a ordem relativa dos itens não-Agenda como antes do SCRUM-94', () => {
    const semAgenda = NAV_SPEC.filter((i) => i.href !== '/agenda').map((i) => i.href);
    expect(semAgenda).toEqual([
      '/inicio',
      '/conectar',
      '/equipe',
      '/billing',
      '/servicos',
      '/horarios',
      '/perfil',
      '/pausas',
      '/mensalidade',
    ]);
  });
});
