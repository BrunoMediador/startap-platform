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
 *   POST /start    -> { session_id, pergunta, draft_ready, retomada, turns?, modo? }
 *   POST /message  -> { reply, draft_ready, resumo?, nome_do_bot?, persona_rascunho?, preview_final? }
 *                     (body { content, generate_now? })
 *   GET  /draft    -> { status, persona_rascunho, preview_final, nome_do_bot?, resumo?, persona_base? }
 *   POST /approve  -> { ok, persona_aplicada, version_saved }
 *   POST /reset    -> { ok }
 *
 * Preview ao vivo + diff (ordem do Bruno, 31/07): `modo` distingue CRIAÇÃO (sem persona
 * anterior) de MELHORIA (conversa livre sobre o texto que já está no ar). `persona_base`
 * (só populada em melhoria) é o texto ATUAL no ar — a base do diff verde/vermelho contra
 * o `persona_rascunho` corrente. Campos ADITIVOS: ausentes/null -> degrada pro
 * comportamento antigo (sem preview ao vivo, sem diff) sem quebrar (o backend pode subir
 * fora de ordem).
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

/**
 * Modo da sessão do builder. `criacao` = sem persona anterior (entrevista do zero,
 * fluxo validado em prod — nunca muda). `melhoria` = já existe persona no ar; a
 * conversa é livre ("acrescenta"/"remove"/"refaz"), nunca uma entrevista estruturada.
 * Campo ADITIVO: ausente -> tratamos como 'criacao' (comportamento anterior).
 */
export type BuilderModo = 'criacao' | 'melhoria';

// ── Contratos crus (não exportados; a UI consome os outcomes normalizados) ──────

/** Um turno cru da entrevista viva devolvido no /start (retomada). Shape defensivo. */
interface RawTurn {
  role?: string;
  content?: string;
  text?: string;
}

interface StartResponse {
  session_id: string;
  pergunta: string;
  draft_ready: boolean;
  retomada: boolean;
  /**
   * SCRUM-92 (retomada, campo ADITIVO): histórico ordenado da entrevista viva pra
   * reidratar o chat "de onde parou". Ausente nos backends que ainda não expõem —
   * o front cai no `pergunta` (abertura) sozinho, sem quebrar (parseTurns([]) -> []).
   */
  turns?: RawTurn[];
  /** Campo ADITIVO (preview ao vivo, 31/07): ausente -> tratado como 'criacao'. */
  modo?: BuilderModo;
}

interface MessageResponse {
  reply: string;
  draft_ready: boolean;
  resumo?: string;
  nome_do_bot?: string | null;
  /**
   * Campos ADITIVOS (preview ao vivo, 31/07): o rascunho corrente pro painel de prévia
   * atualizar A CADA TURNO, sem esperar draft_ready. `preview_final` é uso INTERNO
   * (nunca exibido — contém o bloco estrutural/nomes de tool, item 3 do design
   * original); mantido no transporte só por paridade de contrato com /draft.
   */
  persona_rascunho?: string | null;
  preview_final?: string | null;
}

interface DraftResponse {
  status: DraftStatus;
  persona_rascunho: string | null;
  preview_final: string | null;
  nome_do_bot?: string | null;
  resumo?: string;
  /**
   * Campo ADITIVO (preview ao vivo, 31/07): no modo melhoria, a persona que está NO AR
   * hoje — base do diff verde/vermelho. null no modo criação ou se o backend não expõe.
   */
  persona_base?: string | null;
}

interface ApproveResponse {
  ok: true;
  persona_aplicada: true;
  version_saved: number | null;
}

// ── Outcomes normalizados (a UI decide o caminho sem ler status HTTP cru) ────────

export type StartOutcome =
  | {
      kind: 'ok';
      pergunta: string;
      draftReady: boolean;
      retomada: boolean;
      /** Histórico já normalizado em bolhas (retomada). Vazio numa entrevista nova. */
      turns: BuilderMessage[];
      /** Ausente no backend -> 'criacao' (comportamento anterior à sessão de melhoria). */
      modo: BuilderModo;
    }
  | { kind: 'unavailable' } // 404 (feature off / clone não encontrado) ou upstream fora
  | { kind: 'error' }; // soluço transitório -> "tentar de novo"

export type MessageOutcome =
  | {
      kind: 'ok';
      reply: string;
      draftReady: boolean;
      resumo: string | null;
      nomeBot: string | null;
      /** Rascunho corrente pro preview ao vivo (item 1). Ausente/null -> sem atualização. */
      personaRascunho: string | null;
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
      /** null no modo criação, ou se o backend ainda não expõe o campo. */
      personaBase: string | null;
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
      turns: parseTurns(r.turns),
      modo: r.modo === 'melhoria' ? 'melhoria' : 'criacao',
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
      personaRascunho: typeof r.persona_rascunho === 'string' ? r.persona_rascunho : null,
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
      personaBase: typeof r.persona_base === 'string' ? r.persona_base : null,
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

/**
 * Normaliza os `turns` crus do /start (retomada) em bolhas renderizáveis, pra reidratar o
 * chat "de onde parou" em vez de reiniciar na 1ª pergunta. Aceita `content` ou `text` como
 * corpo; descarta item sem papel válido ('assistant'|'user') ou sem texto. IDs sequenciais
 * (1..n) batendo com appendMessage. Entrada não-array/ausente -> [] (backend sem o campo).
 * Puro/testável sem DOM.
 */
export function parseTurns(raw: unknown): BuilderMessage[] {
  if (!Array.isArray(raw)) return [];
  const out: BuilderMessage[] = [];
  for (const t of raw) {
    if (!t || typeof t !== 'object') continue;
    const role = (t as RawTurn).role;
    if (role !== 'assistant' && role !== 'user') continue;
    const body = (t as RawTurn).content ?? (t as RawTurn).text;
    if (typeof body !== 'string' || body.trim().length === 0) continue;
    out.push({ id: out.length + 1, role, text: body });
  }
  return out;
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

// ── Preview ao vivo + diff (ordem do Bruno, 31/07) ───────────────────────────────

/** Um pedaço do diff: token (palavra ou run de espaço) + o que aconteceu com ele. */
export interface DiffPart {
  text: string;
  kind: 'equal' | 'added' | 'removed';
}

/**
 * Tokeniza preservando espaços/quebras como tokens PRÓPRIOS (não só palavras) — assim o
 * diff reconstrói o texto original byte-a-byte ao concatenar os `text` dos parts, o que
 * a suíte usa como invariante (nunca perder/inventar espaço).
 */
function tokenize(text: string): string[] {
  return text.match(/\s+|\S+/g) ?? [];
}

/**
 * Diff por palavra entre duas versões da persona (LCS clássico — O(n*m), textos de até
 * ~4000 chars/algumas centenas de tokens, custo desprezível). Devolve uma sequência de
 * partes 'equal'/'removed'/'added': tokens só em `before` = removidos (vermelho), só em
 * `after` = adicionados (verde), presentes nos dois na mesma posição relativa = iguais.
 *
 * Requisito de acessibilidade (não depender só de cor): o CALL SITE deve marcar 'added'/
 * 'removed' também com texto/ícone (ex.: prefixo "+"/"−" ou aria-label), não só className.
 *
 * Degradação: `before` null/'' -> tudo 'added' (não há base ainda: primeira prévia da
 * sessão, ou modo criação sem persona_base). `after` vazio -> tudo 'removed'.
 */
export function diffPersona(before: string | null, after: string): DiffPart[] {
  const a = tokenize(before ?? '');
  const b = tokenize(after);
  if (a.length === 0) return b.length > 0 ? [{ text: after, kind: 'added' }] : [];

  // Tabela de LCS (comprimento) — clássica, bottom-up.
  const n = a.length;
  const m = b.length;
  const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }

  // Backtrack acumulando runs contíguos do mesmo tipo (evita 1 DiffPart por token).
  const parts: DiffPart[] = [];
  const push = (text: string, kind: DiffPart['kind']) => {
    const last = parts[parts.length - 1];
    if (last && last.kind === kind) last.text += text;
    else parts.push({ text, kind });
  };
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      push(a[i], 'equal');
      i++;
      j++;
    } else if (lcs[i + 1][j] >= lcs[i][j + 1]) {
      push(a[i], 'removed');
      i++;
    } else {
      push(b[j], 'added');
      j++;
    }
  }
  while (i < n) {
    push(a[i], 'removed');
    i++;
  }
  while (j < m) {
    push(b[j], 'added');
    j++;
  }
  return parts;
}

/**
 * Reconstrói o texto "limpo" (sem marcações) a partir do diff — usado na alternância
 * "ver texto limpo" (mostra só o `after`, ou seja, tudo exceto os tokens removidos).
 */
export function diffToPlainText(parts: DiffPart[]): string {
  return parts
    .filter((p) => p.kind !== 'removed')
    .map((p) => p.text)
    .join('');
}

/**
 * Qual texto usar como BASE do diff, e se há algo pra comparar. Regras (item 1 do design):
 * - `melhoria` com `personaBase` conhecida: base = a persona QUE ESTÁ NO AR (rótulo "texto
 *   atual"), SEMPRE — o diff mostra a distância entre o rascunho corrente e o que roda hoje,
 *   não "turno a turno" (evita diff que parece reduzir a mudança acumulada).
 * - `criacao` (ou melhoria sem base ainda carregada): sem base -> primeira prévia é toda
 *   'added' (nada a comparar; ver diffPersona(null, ...)).
 */
export function resolveDiffBase(modo: BuilderModo, personaBase: string | null): string | null {
  return modo === 'melhoria' ? personaBase : null;
}
