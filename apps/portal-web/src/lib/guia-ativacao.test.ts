import { describe, expect, it } from 'vitest';
import { TODAS_ABAS } from './abas';
import type { Horarios } from './api-types';
import {
  GUIA_HEADER,
  GUIA_PASSOS_COPY,
  type GuiaSinais,
  computeGuiaAtivacao,
  deriveConectado,
  temHorarioConfigurado,
} from './guia-ativacao';
import { NAV_SPEC } from './nav';

// Harness pure-fn do portal (sem RTL/jsdom): cobre o CONTRATO do checklist de
// ativação (SCRUM-96) — quais passos existem e quais estão feitos dado o estado,
// com ênfase na REGRA DURA: cliente já configurado tem `completo=true` → a UI
// esconde a seção (byte-idêntico pros pagantes em produção).

const CONFIGURADO: GuiaSinais = {
  conectado: true,
  temServicos: true,
  horariosConfigurados: true,
};

describe('computeGuiaAtivacao — passos e progresso', () => {
  it('sem personaCustom: 3 passos essenciais (conectar/servicos/horarios), nesta ordem', () => {
    const r = computeGuiaAtivacao({
      conectado: false,
      temServicos: false,
      horariosConfigurados: false,
    });
    expect(r.passos.map((p) => p.key)).toEqual(['conectar', 'servicos', 'horarios']);
    expect(r.total).toBe(3);
    expect(r.feitos).toBe(0);
    expect(r.completo).toBe(false);
  });

  it('clone já configurado (tudo feito, sem persona) -> completo=true => UI esconde', () => {
    const r = computeGuiaAtivacao(CONFIGURADO);
    expect(r.feitos).toBe(3);
    expect(r.total).toBe(3);
    expect(r.completo).toBe(true);
  });

  it('dono novo self-service (só falta conectar) -> 2 de 3, não completo', () => {
    // Clones self-service herdam serviços/horários-exemplo da matriz por área
    // (clone-provisioning), então esses passos costumam já vir "feitos".
    const r = computeGuiaAtivacao({
      conectado: false,
      temServicos: true,
      horariosConfigurados: true,
    });
    expect(r.feitos).toBe(2);
    expect(r.total).toBe(3);
    expect(r.completo).toBe(false);
    const conectar = r.passos.find((p) => p.key === 'conectar');
    expect(conectar?.done).toBe(false);
  });

  it('personaCustom presente entra como 4o passo, logo após conectar', () => {
    const r = computeGuiaAtivacao({ ...CONFIGURADO, personaCustom: false });
    expect(r.passos.map((p) => p.key)).toEqual(['conectar', 'persona', 'servicos', 'horarios']);
    expect(r.total).toBe(4);
    // persona pendente -> não completo mesmo com o resto feito.
    expect(r.completo).toBe(false);
    expect(r.feitos).toBe(3);
  });

  it('personaCustom=true com resto feito -> completo (4/4)', () => {
    const r = computeGuiaAtivacao({ ...CONFIGURADO, personaCustom: true });
    expect(r.total).toBe(4);
    expect(r.feitos).toBe(4);
    expect(r.completo).toBe(true);
  });

  it('personaCustom=undefined OMITE o passo persona (byte-idêntico enquanto o backend não expõe)', () => {
    const semPersona = computeGuiaAtivacao(CONFIGURADO);
    const comSinal = computeGuiaAtivacao({ ...CONFIGURADO, personaCustom: undefined });
    expect(semPersona).toEqual(comSinal);
    expect(semPersona.passos.some((p) => p.key === 'persona')).toBe(false);
  });

  it('feitos conta só os passos done (parcial)', () => {
    const r = computeGuiaAtivacao({
      conectado: true,
      temServicos: false,
      horariosConfigurados: true,
    });
    expect(r.feitos).toBe(2);
    expect(r.completo).toBe(false);
  });
});

describe('temHorarioConfigurado', () => {
  it('undefined/null -> false (query ainda sem dado)', () => {
    expect(temHorarioConfigurado(undefined)).toBe(false);
    expect(temHorarioConfigurado(null)).toBe(false);
  });

  it('objeto vazio -> false', () => {
    expect(temHorarioConfigurado({})).toBe(false);
  });

  it('todos os dias fechados -> false', () => {
    const h: Horarios = {
      segunda: { abre: null, fecha: null, fechado: true },
      terca: { abre: null, fecha: null, fechado: true },
    };
    expect(temHorarioConfigurado(h)).toBe(false);
  });

  it('um dia aberto com abre+fecha -> true', () => {
    const h: Horarios = {
      segunda: { abre: null, fecha: null, fechado: true },
      terca: { abre: '09:00', fecha: '18:00', fechado: false },
    };
    expect(temHorarioConfigurado(h)).toBe(true);
  });

  it('dia com fechado=false mas sem abre/fecha -> false (não conta como setado)', () => {
    const h: Horarios = { sexta: { abre: null, fecha: null, fechado: false } };
    expect(temHorarioConfigurado(h)).toBe(false);
  });
});

describe('deriveConectado', () => {
  it('ever_connected true vence connected false (já pareou, mesmo se caiu agora)', () => {
    expect(deriveConectado(true, false)).toBe(true);
  });
  it('ever_connected false (nunca pareou) -> false mesmo com connected true transitório', () => {
    expect(deriveConectado(false, true)).toBe(false);
  });
  it('ever_connected undefined -> cai no connected (default seguro SCRUM-95)', () => {
    expect(deriveConectado(undefined, true)).toBe(true);
    expect(deriveConectado(undefined, false)).toBe(false);
  });
});

describe('copy (draft)', () => {
  it('progressoLabel injeta feitos/total', () => {
    expect(GUIA_HEADER.progressoLabel(2, 3)).toBe('Seu assistente está 2 de 3 pronto');
  });

  it('todo passo tem copy com href/cta', () => {
    for (const key of ['conectar', 'persona', 'servicos', 'horarios'] as const) {
      const c = GUIA_PASSOS_COPY[key];
      expect(c.titulo.length).toBeGreaterThan(0);
      expect(c.href.startsWith('/')).toBe(true);
      expect(c.cta.length).toBeGreaterThan(0);
    }
  });

  it('persona aponta pra "Meu atendente" > Personalidade (SCRUM-157, tela própria)', () => {
    expect(GUIA_PASSOS_COPY.persona.href).toBe('/atendente/personalidade');
  });

  // SCRUM-157/#SCRUM-157-links: trava de regressão — todo href do guia precisa
  // existir de verdade no NAV_SPEC (itens de topo) ou em TODAS_ABAS (sub-abas de
  // "Meu negócio"/"Meu atendente"), e nenhum pode carregar fragmento (`#...`).
  // Um builder virando tela própria (como aconteceu com /perfil#monte-assistente-title)
  // não pode voltar a deixar o guia de ativação com âncora morta.
  it('nenhum href do guia contém fragmento de âncora (#)', () => {
    for (const key of Object.keys(GUIA_PASSOS_COPY) as (keyof typeof GUIA_PASSOS_COPY)[]) {
      expect(GUIA_PASSOS_COPY[key].href, `passo "${key}"`).not.toContain('#');
    }
  });

  it('todo href do guia existe no NAV_SPEC ou em TODAS_ABAS (rota real, não órfã)', () => {
    const rotasValidas = new Set<string>([
      ...NAV_SPEC.map((item) => item.href),
      ...TODAS_ABAS.map((aba) => aba.href),
    ]);
    for (const key of Object.keys(GUIA_PASSOS_COPY) as (keyof typeof GUIA_PASSOS_COPY)[]) {
      const href = GUIA_PASSOS_COPY[key].href;
      expect(rotasValidas.has(href), `passo "${key}" aponta pra rota órfã: ${href}`).toBe(true);
    }
  });
});
