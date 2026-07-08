/**
 * Lógica pura da seção "Agendamento" (modo atendente, SCRUM-59) da tela Meu negócio.
 * Sem React/DOM — testável.
 *
 * O dono liga/desliga o "agendamento automático pela agenda (Google)". Quando
 * DESLIGADO (modo atendente), o assistente não marca horário sozinho: atende, tira
 * dúvidas e — se houver um link — manda o link externo pro cliente agendar. Sem link,
 * o bot coleta os dados e avisa a equipe pra confirmar.
 *
 * CONTRATO (backend PR-C/PR-E, combinado por este contrato):
 *   GET  /portal/perfil -> { perfil: { agenda_automatica?, link_agendamento? },
 *                            features?: { modo_atendente }, recepcao_telefone? }
 *   PUT  /portal/perfil body { perfil: { agenda_automatica, link_agendamento },
 *                             recepcao_telefone? }
 *        (perfil = parcial; recepcao_telefone é TOP-LEVEL, E.164 BR. Chave AUSENTE = não
 *        toca; string vazia "" = LIMPAR o telefone (SCRUM-62 — o dono pode remover o
 *        número da recepção; sem número, os avisos passam a sair pelo próprio WhatsApp
 *        conectado do negócio). A UI só envia "" quando o campo tinha número e foi
 *        esvaziado; campo intocado/sempre-vazio segue OMITIDO). Erros: 400
 *        telefone_invalido, 404 recepcao_telefone_indisponivel (feature off).
 *
 * O link é OPCIONAL mesmo com o automático desligado (decisão do Bruno 03/07: o cliente
 * piloto ainda não tem o link, insere depois). Só validamos o FORMATO quando preenchido.
 * O telefone da recepção também é opcional; só validamos formato BR quando preenchido.
 */
import { ApiError } from './api';
import type { AgendaConfig } from './api-types';
import { maskPhoneBR, phoneDigits } from './cadastro';

export interface AgendaConfigDraft {
  agenda_automatica: boolean;
  link_agendamento: string;
  /** Valor de EXIBIÇÃO/edição do telefone da recepção (mascarado "(11) 99999-9999"). */
  recepcao_telefone: string;
}

/** Resposta (flat) do backend -> draft de UI. Tolera campos ausentes (default = automático). */
export function toAgendaDraft(data: Partial<AgendaConfig> | null | undefined): AgendaConfigDraft {
  const link = data?.link_agendamento;
  const recep = data?.recepcao_telefone;
  return {
    agenda_automatica: data?.agenda_automatica ?? true,
    link_agendamento: typeof link === 'string' ? link : '',
    // Backend guarda RAW E.164 ("55DDDNUMERO"); maskPhoneBR tira o DDI 55 e formata BR.
    recepcao_telefone: typeof recep === 'string' ? maskPhoneBR(recep) : '',
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
    a.link_agendamento.trim() !== b.link_agendamento.trim() ||
    phoneDigits(a.recepcao_telefone) !== phoneDigits(b.recepcao_telefone)
  );
}

// ── Telefone da recepção (SCRUM-59 PR-E) ─────────────────────────────────────

/** Mensagem de erro do telefone (mesma microcopy do signup). */
export const RECEPCAO_TELEFONE_ERRO = 'Confere o número? Parece faltar dígito.';

/** Há algo digitado (após limpar máscara)? */
export function isRecepcaoPreenchida(display: string): boolean {
  return phoneDigits(display).length > 0;
}

/** Telefone BR válido (10 fixo / 11 móvel dígitos locais, sem o DDI 55). */
export function isRecepcaoValida(display: string): boolean {
  const d = phoneDigits(display);
  return d.length === 10 || d.length === 11;
}

/**
 * Converte o valor de exibição no E.164 BR ("55" + DDD + número) que o backend espera.
 * Vazio/inválido -> "". (Para decidir o payload do PUT use `recepcaoPayload`.)
 */
export function recepcaoToE164(display: string): string {
  const d = phoneDigits(display);
  return d.length === 10 || d.length === 11 ? `55${d}` : '';
}

/**
 * Decisão do que enviar no PUT pro campo `recepcao_telefone`, comparando o rascunho
 * editado com o valor salvo (ambos em formato de EXIBIÇÃO mascarado). SCRUM-62.
 *
 *   'omit'    -> não envia a chave (sem mudança OU campo sempre-vazio).
 *   'set'     -> envia o E.164 novo (`value`).
 *   'clear'   -> envia "" (o dono APAGOU um número que existia -> limpar no backend).
 *   'invalid' -> tem dígitos mas o formato BR é inválido (o chamador mostra o erro).
 */
export type RecepcaoPayload =
  | { kind: 'omit' }
  | { kind: 'set'; value: string }
  | { kind: 'clear' }
  | { kind: 'invalid' };

export function recepcaoPayload(draftDisplay: string, savedDisplay: string): RecepcaoPayload {
  if (isRecepcaoPreenchida(draftDisplay)) {
    if (!isRecepcaoValida(draftDisplay)) return { kind: 'invalid' };
    const e164 = recepcaoToE164(draftDisplay);
    if (e164 === recepcaoToE164(savedDisplay)) return { kind: 'omit' };
    return { kind: 'set', value: e164 };
  }
  // Campo vazio: só LIMPA (envia "") se antes havia um número salvo; senão nem toca.
  return isRecepcaoPreenchida(savedDisplay) ? { kind: 'clear' } : { kind: 'omit' };
}

/** Texto de ajuda fixo do campo de telefone da recepção (SCRUM-62: consequência de deixar vazio). */
export const AJUDA_RECEPCAO =
  'Opcional. É pra este número que o assistente envia os pedidos de agendamento e os casos que precisam de uma pessoa. Se deixar em branco, esses avisos chegam no próprio WhatsApp do seu negócio (o número que está conectado aqui).';

/** Código de erro (body.error) de um ApiError, quando string. */
function errorCode(err: unknown): string | undefined {
  if (!(err instanceof ApiError)) return undefined;
  const body = err.body;
  if (body && typeof body === 'object' && 'error' in body) {
    const code = (body as { error?: unknown }).error;
    if (typeof code === 'string') return code;
  }
  return undefined;
}

/** 400 telefone_invalido: o telefone da recepção não passou na validação do backend. */
export function isTelefoneInvalido(err: unknown): boolean {
  return err instanceof ApiError && err.status === 400 && errorCode(err) === 'telefone_invalido';
}

/** 404 recepcao_telefone_indisponivel: modo atendente off pro clone (não deveria ocorrer na UI gateada). */
export function isRecepcaoIndisponivel(err: unknown): boolean {
  return (
    err instanceof ApiError &&
    err.status === 404 &&
    errorCode(err) === 'recepcao_telefone_indisponivel'
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
