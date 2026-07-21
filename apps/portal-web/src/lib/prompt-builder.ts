'use client';

/**
 * Cliente do builder conversacional de persona (SCRUM-92) — "Monte seu atendente".
 *
 * O dono ENTREVISTA um meta-agente (DeepSeek) que PROPÕE a persona do assistente de
 * WhatsApp dele; ao aprovar, a persona (+ bloco estrutural colado por CÓDIGO no
 * servidor) vira o bot_prompt de produção. Aqui é SÓ o transporte tipado + a lógica
 * pura de estado do chat — sem React/DOM (testável em node).
 *
 * Contrato (portal-api, plugin prompt-builder.ts — TODAS autenticadas por sessão,
 * slot SÓ da sessão via withTenant; base /portal/prompt-builder):
 *   POST /start    -> { session_id, pergunta, draft_ready, retomada }
 *   POST /message  -> { reply, draft_ready, resumo?, nome_do_bot? }   (body { content, generate_now? })
 *   GET  /draft    -> { status, persona_rascunho, preview_final, nome_do_bot?, resumo? }
 *   POST /approve  -> { ok, persona_aplicada, version_saved }
 *   POST /reset    -> { ok }
 *
 * Gating: flag PROMPT_BUILDER_ENABLED OFF => TODAS respondem 404 recurso_indisponivel.
 * O front trata 404 como "feature off" (esconde a seção) — mesmo critério de
 * lembretes/atendimentos/google-conta. NUNCA envia slot; o cookie de sessão viaja
 * sozinho (apiFetch credentials:'include'). Nenhuma PII é logada no client.
 */
import { ApiError, apiFetch } from './api';

const BASE = '/portal/prompt-builder';

/** Espelha PROMPT_BUILDER_MAX_INPUT_CHARS do portal-api (content 1..4000). */
export const BUILDER_MAX_INPUT = 4000;

/** Espelha MAX_PERSONA_CHARS do prompt-builder-validator (persona editada 1..4000). */
export const PERSONA_MAX_CHARS = 4000;

/**
 * Texto enviado quando o dono clica "Gerar agora" SEM ter digitado nada — o backend exige
 * content >= 1 char, e com generate_now:true a geração é forçada de qualquer forma. A frase
 * também casa com o matchesGenerateIntent do servidor (defesa dupla).
 */
export const GENERATE_NOW_FALLBACK_CONTENT = 'Pode gerar a persona agora.';

export type BuilderRole = 'assistant' | 'user';

/** Uma bolha da conversa visível (id local incremental, texto cru do turno). */
export interface BuilderMessage {
  id: number;
  role: BuilderRole;
  text: string;
}

/** Status do rascunho no servidor (GET /draft). `indisponivel` = feature off (404). */
export type DraftStatus = 'nao_iniciado' | 'sem_rascunho' | 'pronto';

// ── Contratos crus (não exportados; a UI consome os outcomes normalizados) ──────

interface StartResponse {
  session_id: string;
  pergunta: string;
  draft_ready: boolean;
  retomada: boolean;
}

interface MessageResponse {
  reply: string;
  draft_ready: boolean;
  resumo?: string;
  nome_do_bot?: string | null;
}

interface DraftResponse {
  status: DraftStatus;
  persona_rascunho: string | null;
  preview_final: string | null;
  nome_do_bot?: string | null;
  resumo?: string;
}

interface ApproveResponse {
  ok: true;
  persona_aplicada: true;
  version_saved: number | null;
}

// ── Outcomes normalizados (a UI decide o caminho sem ler status HTTP cru) ────────

export type StartOutcome =
  | { kind: 'ok'; pergunta: string; draftReady: boolean; retomada: boolean }
  | { kind: 'unavailable' } // 404 (feature off / clone não encontrado) ou upstream fora
  | { kind: 'error' }; // soluço transitório -> "tentar de novo"

export type MessageOutcome =
  | {
      kind: 'ok';
      reply: string;
      draftReady: boolean;
      resumo: string | null;
      nomeBot: string | null;
    }
  | { kind: 'not_started' } // 409 entrevista_nao_iniciada (Redis expirou) -> recomeçar
  | { kind: 'invalid' } // 400 dados_invalidos / mensagem_vazia
  | { kind: 'unavailable' } // 503 builder_indisponivel (sem DeepSeek) / 404 feature off
  | { kind: 'error' };

export type ApproveOutcome =
  | { kind: 'ok'; versionSaved: number | null }
  | { kind: 'no_draft' } // 409 sem_rascunho (rascunho expirou)
  | { kind: 'invalid' } // 422 rascunho_insuficiente/prompt_muito_longo | 400 persona_editada fora de 1..4000
  | { kind: 'unavailable' } // 404 feature off
  | { kind: 'error' }; // 500 falha_ao_salvar / rede

/** Prévia read-only do rascunho. `indisponivel` some a seção (feature off). */
export type BuilderDraft =
  | { status: 'indisponivel' }
  | {
      status: DraftStatus;
      personaRascunho: string | null;
      previewFinal: string | null;
      nomeBot: string | null;
      resumo: string | null;
    };

/** 404 = feature off no backend (não é erro do cliente). Esconde a seção. */
export function isBuilderUnavailable(err: unknown): boolean {
  return err instanceof ApiError && err.status === 404;
}

/** 404/502/503 = feature off / upstream fora -> degrade neutro (não é "erro"). */
function isDegrade(err: unknown): boolean {
  return (
    err instanceof ApiError && (err.status === 404 || err.status === 502 || err.status === 503)
  );
}

// ── Chamadas ────────────────────────────────────────────────────────────────────

/** Inicia (ou retoma, idempotente por slot) a entrevista. Não chama LLM no backend. */
export async function startBuilder(signal?: AbortSignal): Promise<StartOutcome> {
  try {
    const r = await apiFetch<StartResponse>(`${BASE}/start`, { method: 'POST', signal });
    return {
      kind: 'ok',
      pergunta: typeof r.pergunta === 'string' ? r.pergunta : '',
      draftReady: r.draft_ready === true,
      retomada: r.retomada === true,
    };
  } catch (err) {
    if (isDegrade(err)) return { kind: 'unavailable' };
    return { kind: 'error' };
  }
}

/** Opções de um turno de conversa. `generateNow` = botão "Gerar agora" (força a geração). */
export interface SendBuilderMessageOpts {
  /** Botão "Gerar agora": manda generate_now:true -> o backend força a tool propor_prompt. */
  generateNow?: boolean;
  signal?: AbortSignal;
}

/**
 * 1 turno de conversa. Rate-limit vem como 200 com copy canned (tratado como ok).
 * Com `generateNow`, envia `generate_now:true` -> o backend GARANTE draft_ready NESTE turno
 * (não depende do gpt-4o chamar a tool sozinho). Sem a flag, o body fica `{ content }`
 * byte-idêntico ao fluxo original (o modelo decide quando gerar) — a entrevista normal não muda.
 */
export async function sendBuilderMessage(
  content: string,
  opts: SendBuilderMessageOpts = {},
): Promise<MessageOutcome> {
  // generate_now só entra no body quando true: fluxo normal = { content } byte-a-byte (o schema
  // .strict() do backend rejeita chave desconhecida, e enviar false seria ruído inútil).
  const body: { content: string; generate_now?: boolean } = { content };
  if (opts.generateNow) body.generate_now = true;
  try {
    const r = await apiFetch<MessageResponse>(`${BASE}/message`, {
      method: 'POST',
      body,
      signal: opts.signal,
    });
    return {
      kind: 'ok',
      reply: typeof r.reply === 'string' ? r.reply : '',
      draftReady: r.draft_ready === true,
      resumo: typeof r.resumo === 'string' ? r.resumo : null,
      nomeBot: typeof r.nome_do_bot === 'string' ? r.nome_do_bot : null,
    };
  } catch (err) {
    if (err instanceof ApiError) {
      if (err.status === 409) return { kind: 'not_started' };
      if (err.status === 400) return { kind: 'invalid' };
      if (err.status === 404 || err.status === 502 || err.status === 503) {
        return { kind: 'unavailable' };
      }
    }
    return { kind: 'error' };
  }
}

/** Prévia read-only do rascunho. 404 -> feature off (some a seção); outros erros propagam. */
export async function fetchBuilderDraft(signal?: AbortSignal): Promise<BuilderDraft> {
  try {
    const r = await apiFetch<DraftResponse>(`${BASE}/draft`, { signal });
    return {
      status: r.status,
      personaRascunho: r.persona_rascunho ?? null,
      previewFinal: r.preview_final ?? null,
      nomeBot: r.nome_do_bot ?? null,
      resumo: typeof r.resumo === 'string' ? r.resumo : null,
    };
  } catch (err) {
    if (isBuilderUnavailable(err)) return { status: 'indisponivel' };
    throw err; // erro real (rede/500) -> a seção mostra ErrorState com retry
  }
}

/**
 * Persiste a persona (ação NÃO-LLM). Efeito: bot_prompt + prompt_custom=true + versão.
 *
 * `personaEditada` (caminho "Editar"): quando o dono ajustou o TEXTO da persona antes de
 * aprovar, envia { persona_editada }. Vazio/só-espaço/ausente => aprova o RASCUNHO do Redis
 * (caminho "Aprovar", request byte-idêntico ao original SEM body). Em AMBOS os casos o backend
 * re-valida (stripPII + validatePersona) e SEMPRE cola o BLOCO_ESTRUTURAL por código — editar a
 * persona NÃO remove a mecânica de confirmação.
 */
export async function approveBuilder(personaEditada?: string): Promise<ApproveOutcome> {
  const body = buildApproveBody(personaEditada);
  try {
    const r = await apiFetch<ApproveResponse>(
      `${BASE}/approve`,
      body ? { method: 'POST', body } : { method: 'POST' },
    );
    return { kind: 'ok', versionSaved: r.version_saved ?? null };
  } catch (err) {
    if (err instanceof ApiError) {
      if (err.status === 409) return { kind: 'no_draft' };
      if (err.status === 422) return { kind: 'invalid' };
      // 400 = persona_editada fora de 1..4000 ou campo extra (schema .strict()).
      if (err.status === 400) return { kind: 'invalid' };
      if (err.status === 404) return { kind: 'unavailable' };
    }
    return { kind: 'error' };
  }
}

/** Recomeça do zero (deleta o estado Redis). Best-effort: erro não trava a UI. */
export async function resetBuilder(): Promise<boolean> {
  try {
    await apiFetch<{ ok: true }>(`${BASE}/reset`, { method: 'POST' });
    return true;
  } catch {
    return false;
  }
}

// ── Lógica pura de estado do chat (testável) ─────────────────────────────────────

/**
 * Monta o body do POST /approve a partir do que o dono digitou no editor de persona.
 * - undefined/vazio/só-espaço => `undefined` (aprova o RASCUNHO do Redis; caminho "Aprovar",
 *   request SEM body, byte-idêntico ao comportamento original).
 * - texto não-vazio => `{ persona_editada: <trim> }` (caminho "Editar").
 * Nunca envia campo extra (o schema .strict() do backend rejeita com 400).
 */
export function buildApproveBody(
  personaEditada?: string | null,
): { persona_editada: string } | undefined {
  const t = (personaEditada ?? '').trim();
  return t.length > 0 ? { persona_editada: t } : undefined;
}

/**
 * Content do clique em "Gerar agora": aproveita o que o dono já digitou (se houver algo) ou
 * cai no texto padrão — o backend precisa de content >= 1 char. Puro/testável sem DOM.
 */
export function generateNowContent(input: string): string {
  const t = input.trim();
  return t.length > 0 ? t : GENERATE_NOW_FALLBACK_CONTENT;
}

/** O texto editado pode ser salvo? Não-vazio (após trim) e dentro do teto de 4000. */
export function isPersonaSavable(text: string): boolean {
  const t = text.trim();
  return t.length > 0 && t.length <= PERSONA_MAX_CHARS;
}

/** Caracteres restantes no editor de persona (negativo se colar texto acima do teto). */
export function personaCharsLeft(text: string): number {
  return PERSONA_MAX_CHARS - text.length;
}

/** Caracteres restantes no composer (pode ficar negativo se colar texto gigante). */
export function remainingChars(text: string): number {
  return BUILDER_MAX_INPUT - text.length;
}

/** Pode enviar? Não-vazio (após trim), dentro do teto e sem envio em andamento. */
export function isSendable(text: string, pending: boolean): boolean {
  if (pending) return false;
  const t = text.trim();
  return t.length > 0 && t.length <= BUILDER_MAX_INPUT;
}

/** Append imutável de uma bolha (id = último+1; começa em 1). */
export function appendMessage(
  list: BuilderMessage[],
  role: BuilderRole,
  text: string,
): BuilderMessage[] {
  const lastId = list.length > 0 ? list[list.length - 1].id : 0;
  return [...list, { id: lastId + 1, role, text }];
}
