/**
 * Copy do CARD DE SUCESSO da tela /conectar (fase `sucesso`), decidida pelo FORMATO
 * do clone (SCRUM-100 item-6):
 *
 *   - 'agenda'    -> clone que usa agenda (Google Calendar). Mantém o bloco "Falta só
 *     a sua agenda" (byte-idêntico ao de hoje): a equipe configura o calendário depois.
 *   - 'atendente' -> clone de PRÉ-VENDA (modo atendente, sem agenda automática). NÃO
 *     depende de agenda nenhuma, então não faz sentido dizer "falta a agenda": ele já
 *     está no ar. Bloco de agenda = null.
 *
 * DEGRADAÇÃO SEGURA: a fonte do formato (perfil) pode não ter carregado quando o card
 * aparece. `resolveConexaoFormato(undefined)` -> 'agenda' = comportamento ATUAL, byte
 * idêntico. Só `agenda_automatica === false` explícito vira 'atendente' — nunca some
 * o aviso de agenda de um clone que de fato usa agenda.
 *
 * Termo canônico "assistente" (SCRUM-97, lib/termos): a copy nova reusa SEU_ASSISTENTE.
 * Módulo PURO (sem React/DOM) — testável no harness pure-fn do portal (sem jsdom).
 */
import { SEU_ASSISTENTE } from './termos';

export type ConexaoFormato = 'agenda' | 'atendente';

export interface SucessoConexaoCopy {
  /** Subtítulo abaixo do "Conectado! 🎉". */
  subtitulo: string;
  /** Bloco "próximo passo: agenda" — `null` quando o formato não usa agenda (atendente). */
  agenda: { titulo: string; texto: string } | null;
}

/** Clone com agenda (default): mantém o aviso de agenda vigente (não regride). */
const COPY_AGENDA: SucessoConexaoCopy = {
  subtitulo: 'Seu assistente já está atendendo no WhatsApp.',
  agenda: {
    titulo: 'Falta só a sua agenda',
    texto:
      'Nossa equipe vai entrar em contato em breve pra configurar a sua agenda do Google Calendar — assim os horários marcados caem direto no seu calendário.',
  },
};

/** Modo atendente (pré-venda, sem agenda): já está tudo pronto, sem bloco de agenda. */
const COPY_ATENDENTE: SucessoConexaoCopy = {
  subtitulo: `Tudo pronto — ${SEU_ASSISTENTE} já está no ar, atendendo no WhatsApp.`,
  agenda: null,
};

/**
 * Deriva o formato do clone pra escolher a copy do card de sucesso.
 * @param input recorte do perfil (`useAgendaConfig`). `undefined` / sem o campo ->
 *   'agenda' (default seguro, byte-idêntico ao de hoje).
 */
export function resolveConexaoFormato(
  input: { agenda_automatica?: boolean } | undefined | null,
): ConexaoFormato {
  return input?.agenda_automatica === false ? 'atendente' : 'agenda';
}

/** Copy do card de sucesso para o formato dado. */
export function sucessoConexaoCopy(formato: ConexaoFormato): SucessoConexaoCopy {
  return formato === 'atendente' ? COPY_ATENDENTE : COPY_AGENDA;
}
