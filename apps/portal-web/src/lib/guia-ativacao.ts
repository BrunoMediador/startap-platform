/**
 * Guia de primeiros passos / checklist de ativação da Home (SCRUM-96).
 *
 * Lógica PURA (sem React/DOM) que decide, dado o estado do clone, QUAIS passos de
 * ativação existem e QUAIS já estão feitos — testável no harness pure-fn do portal
 * (sem RTL/jsdom, igual conexao-copy.ts). A UI (app/(app)/inicio/guia-ativacao.tsx)
 * só lê os hooks existentes, monta os `GuiaSinais` e renderiza o que sai daqui.
 *
 * OBJETIVO (produto): o dono novo conecta e vê "tela vazia e em dia", sem ser levado
 * a personalizar/cadastrar → o bot responde genérico e a percepção de valor nos 7
 * dias de trial cai. O checklist guia os primeiros passos e SOME quando tudo pronto.
 *
 * REGRA DURA (byte-idêntico): cliente já configurado NÃO pode ver nada novo. O
 * checklist só aparece quando há passo PENDENTE; `completo` (todos feitos) esconde a
 * seção inteira. Os passos que gatilham a visibilidade são universais — todo cliente
 * atual (Cirilo/Samuel/Ingrid/Meduzza) já passa neles → checklist escondido pra eles.
 *
 * DE ONDE VEM CADA SINAL (reuso dos GETs que o portal já faz, ZERO backend novo):
 *   - conectado          -> GET /portal/conexao (useConexao): ever_connected ?? connected.
 *                           ever_connected (SCRUM-95) = já pareou alguma vez (durável);
 *                           ausente -> cai em connected (WORKING agora).
 *   - temServicos        -> GET /portal/servicos (useServicos): servicos.length > 0.
 *   - horariosConfigurados -> GET /portal/horarios (useHorarios): algum dia aberto.
 *   - personaCustom      -> ⚠️ NÃO derivável no front hoje (ver abaixo). OPCIONAL.
 *
 * ⚠️ CONTRATO FALTANTE (persona) — FLAG pro backend:
 *   O GET /portal/perfil devolve features={modo_atendente,faq_personalizado,
 *   agenda_configurada} mas NÃO `prompt_custom`. O único vazamento indireto
 *   (locked_reason='prompt_custom' do GET /portal/cartao-config) é gated por
 *   CARTAO_RUNTIME_ENABLED (ON em prod desde 23/07/2026) e semanticamente não
 *   confiável (só aparece no ramo baked+prompt_custom). Sem um
 *   boolean durável no front, o passo "persona" é OMITIDO (personaCustom=undefined)
 *   pra NÃO inventar sinal nem quebrar o byte-idêntico. Mínimo que o backend precisa
 *   expor: `persona_custom: boolean` (= flow_clones.prompt_custom) no
 *   PerfilResponse.features do GET /portal/perfil. Com o campo presente, a UI passa
 *   personaCustom e o passo entra sozinho (lib e componente já suportam).
 */
import type { Horarios } from './api-types';
import { SEU_ASSISTENTE, TERMO_ASSISTENTE } from './termos';

export type GuiaPassoKey = 'conectar' | 'persona' | 'servicos' | 'horarios';

/**
 * Sinais normalizados do estado do clone (a UI monta a partir dos hooks). Os três
 * primeiros são obrigatórios (sempre deriváveis no front); `personaCustom` é
 * opcional — undefined = sinal indisponível → passo omitido (byte-idêntico).
 */
export interface GuiaSinais {
  /** GET /portal/conexao: ever_connected ?? connected. Já pareou/está pareado. */
  conectado: boolean;
  /** GET /portal/servicos: servicos.length > 0. */
  temServicos: boolean;
  /** GET /portal/horarios: algum dia com janela aberta (ver temHorarioConfigurado). */
  horariosConfigurados: boolean;
  /**
   * flow_clones.prompt_custom (persona feita à mão / builder aprovado). OPCIONAL: o
   * backend AINDA NÃO expõe no front (ver contrato flagueado no topo). undefined =>
   * passo "persona" NÃO entra no checklist (não conta, não aparece, não bloqueia o
   * `completo`) — garante byte-idêntico enquanto o sinal não existir.
   */
  personaCustom?: boolean;
}

export interface GuiaPasso {
  key: GuiaPassoKey;
  done: boolean;
}

export interface GuiaEstado {
  /** Passos presentes (persona só entra quando o sinal existe), na ordem de exibição. */
  passos: GuiaPasso[];
  /** Denominador do "X de N pronto" = passos presentes. */
  total: number;
  /** Numerador = passos feitos. */
  feitos: number;
  /**
   * true quando TODOS os passos presentes estão feitos → a UI esconde a seção
   * inteira (byte-idêntico pra quem já configurou). Nunca true com 0 passos.
   */
  completo: boolean;
}

/**
 * Há pelo menos um dia com janela de funcionamento aberta? "Setado" = dia não
 * fechado com abre E fecha preenchidos. Robusto ao shape parcial do backend
 * (Partial<Record<DiaSemana, HorarioDia>>) e a `undefined` (query ainda sem dado).
 */
export function temHorarioConfigurado(horarios: Horarios | undefined | null): boolean {
  if (!horarios) return false;
  return Object.values(horarios).some(
    (d) => d != null && d.fechado !== true && Boolean(d.abre) && Boolean(d.fecha),
  );
}

/**
 * Deriva conectado do GET /portal/conexao: prioriza o durável `ever_connected`
 * (já pareou alguma vez — não some se cair depois), com fallback pro `connected`
 * (WORKING agora) quando o backend ainda não expõe o campo (SCRUM-95).
 */
export function deriveConectado(everConnected: boolean | undefined, connected: boolean): boolean {
  return everConnected ?? connected;
}

/**
 * Núcleo puro: monta os passos e o progresso a partir dos sinais. Ordem de exibição
 * = onboarding natural: Conectar → (Persona) → Serviços → Horários. Persona entra
 * logo após Conectar SÓ quando o sinal existe.
 */
export function computeGuiaAtivacao(sinais: GuiaSinais): GuiaEstado {
  const passos: GuiaPasso[] = [{ key: 'conectar', done: sinais.conectado }];

  // Persona: OMITIDA quando o sinal é indisponível (undefined). Ver contrato no topo.
  if (sinais.personaCustom !== undefined) {
    passos.push({ key: 'persona', done: sinais.personaCustom });
  }

  passos.push({ key: 'servicos', done: sinais.temServicos });
  passos.push({ key: 'horarios', done: sinais.horariosConfigurados });

  const feitos = passos.reduce((n, p) => n + (p.done ? 1 : 0), 0);
  return {
    passos,
    total: passos.length,
    feitos,
    completo: passos.length > 0 && feitos === passos.length,
  };
}

// ── Copy centralizada (draft — PM confirma) ──────────────────────────────────────
//
// Voz de dono de PME: curta, motivadora, concreta. Sem jargão, sem emoji. A UI
// injeta {feitos}/{total} em progressoLabel. Deep-links levam à tela certa.

export const GUIA_HEADER = {
  kicker: 'Primeiros passos',
  titulo: `Configure ${SEU_ASSISTENTE}`,
  subtitulo: 'Complete pra ele atender com a sua cara — e não no automático genérico.',
  /** "Seu assistente está X de N pronto" (frase do card). */
  progressoLabel: (feitos: number, total: number): string =>
    `Seu ${TERMO_ASSISTENTE} está ${feitos} de ${total} pronto`,
} as const;

export interface GuiaPassoCopy {
  titulo: string;
  descricao: string;
  /** Deep-link pra tela certa. Persona aponta pra "Meu negócio" → seção do builder. */
  href: string;
  /** Rótulo do CTA quando pendente. */
  cta: string;
}

export const GUIA_PASSOS_COPY: Record<GuiaPassoKey, GuiaPassoCopy> = {
  conectar: {
    titulo: 'Conecte seu WhatsApp',
    descricao: 'Ligue o número que vai atender seus clientes.',
    href: '/conectar',
    cta: 'Conectar',
  },
  persona: {
    titulo: `Dê personalidade ao ${TERMO_ASSISTENTE}`,
    descricao: 'Nome, tom e jeito de falar — pra não soar robô.',
    // SCRUM-157: builder virou tela própria "Meu atendente" > "Personalidade"
    // (/atendente/personalidade). Sem fragmento: a âncora antiga
    // (#monte-assistente-title) não existe mais nessa tela.
    href: '/atendente/personalidade',
    cta: 'Personalizar',
  },
  servicos: {
    titulo: 'Cadastre seus serviços',
    descricao: 'Os serviços e preços que ele vai passar.',
    href: '/negocio/servicos',
    cta: 'Cadastrar',
  },
  horarios: {
    titulo: 'Defina seus horários',
    descricao: 'Quando você abre e fecha, dia a dia.',
    href: '/negocio/horarios',
    cta: 'Configurar',
  },
};
