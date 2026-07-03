/**
 * Lógica pura da seção "Agendamento" (modo atendente, SCRUM-59) da tela Meu negócio.
 * Sem React/DOM — testável.
 *
 * O dono liga/desliga o "agendamento automático pela agenda (Google)". Quando
 * DESLIGADO (modo atendente), o assistente não marca horário sozinho: atende, tira
 * dúvidas e — se houver um link — manda o link externo pro cliente agendar. Sem link,
 * o bot coleta os dados e avisa a equipe pra confirmar.
 *
 * CONTRATO (backend PR-C, em paralelo — combinado por este contrato):
 *   GET  /portal/perfil -> { perfil: { agenda_automatica?, link_agendamento? },
 *                            features?: { modo_atendente } }
 *   PUT  /portal/perfil body { perfil: { agenda_automatica, link_agendamento } }
 *        (parcial: chave ausente = não toca).
 *
 * O link é OPCIONAL mesmo com o automático desligado (decisão do Bruno 03/07: o cliente
 * piloto ainda não tem o link, insere depois). Só validamos o FORMATO quando preenchido.
 */
import type { AgendaConfig } from './api-types';

export interface AgendaConfigDraft {
  agenda_automatica: boolean;
  link_agendamento: string;
}

/** Resposta (flat) do backend -> draft de UI. Tolera campos ausentes (default = automático). */
export function toAgendaDraft(data: Partial<AgendaConfig> | null | undefined): AgendaConfigDraft {
  const link = data?.link_agendamento;
  return {
    agenda_automatica: data?.agenda_automatica ?? true,
    link_agendamento: typeof link === 'string' ? link : '',
  };
}

/**
 * Normaliza o link: trim + garante esquema http(s). Aceita o usuário colar sem
 * "https://" (ex.: "booksy.com/ze") e completa. Vazio permanece vazio.
 */
export function normalizeLink(raw: string): string {
  const v = raw.trim();
  if (v === '') return '';
  if (/^https?:\/\//i.test(v)) return v;
  return `https://${v}`;
}

/** True se `raw` (já normalizado ou não) é uma URL http(s) plausível (host com ponto). */
export function isLinkValido(raw: string): boolean {
  const v = normalizeLink(raw);
  if (v === '') return false;
  try {
    const u = new URL(v);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
    return u.hostname.includes('.');
  } catch {
    return false;
  }
}

export interface AgendaValue {
  agenda_automatica: boolean;
  link_agendamento: string;
}

/**
 * Valida + normaliza o draft. Link é sempre OPCIONAL; só checamos o FORMATO quando
 * preenchido. Em sucesso devolve o payload pronto pro PUT (link normalizado, ou "").
 */
export function validateAgenda(
  d: AgendaConfigDraft,
): { ok: true; value: AgendaValue } | { ok: false; error: string } {
  const link = normalizeLink(d.link_agendamento);
  if (link !== '' && !isLinkValido(link)) {
    return {
      ok: false,
      error: 'Link inválido. Use o endereço completo, ex.: https://booksy.com/seu-perfil',
    };
  }
  return { ok: true, value: { agenda_automatica: d.agenda_automatica, link_agendamento: link } };
}

/** True quando o draft difere do salvo (libera o botão Salvar). */
export function isAgendaDirty(a: AgendaConfigDraft, b: AgendaConfigDraft): boolean {
  return (
    a.agenda_automatica !== b.agenda_automatica ||
    a.link_agendamento.trim() !== b.link_agendamento.trim()
  );
}

/**
 * Texto de ajuda mostrado sob o campo de link quando o automático está DESLIGADO.
 * Depende de haver link: com link o bot direciona; sem link o bot coleta e avisa a
 * equipe (comportamento real do modo atendente).
 */
export function ajudaLink(linkPreenchido: boolean): string {
  return linkPreenchido
    ? 'O assistente envia este link para o cliente marcar o horário.'
    : 'Sem o link, o assistente anota os dados de quem quer marcar e avisa sua equipe pra confirmar o horário.';
}
