/**
 * bot-detect — queries do job de detecção de bot (SCRUM-4 PR-C, Fase 1).
 *
 * Spec: docs/bot-detect/sinais.md + docs/bot-detect/README.md.
 *
 * Tudo escopado por CLONE: o `flow_id` (= slot do clone, mesma semântica de flow_pauses/antibot)
 * é a fronteira de tenant; a sessão WAHA (message_log.chat_id) e a chat_table são SEMPRE derivadas
 * do slot (nunca de input). Queries 100% parametrizadas. A leitura de conteúdo usa o nome da
 * chat_table validado contra isValidChatTableName (defesa contra SQL injection — nome de tabela
 * não pode ser parametrizado).
 *
 * Fonte de cache: tabela contact_classification (migration 067). Fase 1 grava 'bot' | 'human'
 * (heurística + allowlist) e nunca pausa.
 */
import { query } from '../client.js';
import { isValidChatTableName } from './chat-memory.js';

export type ContactVerdict = 'bot' | 'human' | 'gray';
export type ContactSource = 'allowlist' | 'heuristic' | 'llm';

export interface ContactClassificationRow {
  flow_id: string;
  telefone: string;
  verdict: ContactVerdict;
  confidence: number;
  signals: Record<string, unknown>;
  source: ContactSource;
  decided_at: Date;
  alerted_at: Date | null;
  paused_at: Date | null;
}

/** Info do clone necessária pro job: como filtrar message_log (sessão) + ler conteúdo (chat_table). */
export interface BotDetectCloneInfo {
  slot: string;
  waha_sessao: string;
  chat_table: string | null;
}

/** Candidato a classificar: telefone ativo na sessão do clone, ainda SEM veredito em cache. */
export interface CandidatePhone {
  telefone: string;
  total: number;
}

/**
 * Resolve os dados do clone a partir do slot. Retorna null se o slot não for um clone ou não tiver
 * sessão WAHA (sem sessão não há message_log -> nada a classificar). `waha_sessao` aqui já é
 * garantidamente não-vazio.
 */
export async function getCloneInfo(slot: string): Promise<BotDetectCloneInfo | null> {
  const r = await query<{ slot: string; waha_sessao: string | null; chat_table: string | null }>(
    `SELECT slot, waha_sessao, chat_table
       FROM flow_clones
      WHERE slot = $1
      LIMIT 1`,
    [slot],
  );
  const row = r.rows[0];
  if (!row || !row.waha_sessao || row.waha_sessao.trim() === '') return null;
  return { slot: row.slot, waha_sessao: row.waha_sessao, chat_table: row.chat_table };
}

/**
 * Lista telefones ATIVOS na sessão do clone (últimas ~24h — janela do message_log) que AINDA NÃO
 * têm veredito em cache (NOT EXISTS em contact_classification). Esse NOT EXISTS É o cache: número
 * já classificado nunca volta como candidato -> nunca é reclassificado.
 *
 * ISOLAMENTO: filtra por `chat_id = sessao` (a sessão é dedicada ao clone) E escopa o NOT EXISTS
 * por `flow_id = slot`. Ordena pelos mais ativos primeiro (mais provável de ser bot barulhento).
 */
export async function listUnclassifiedCandidates(
  slot: string,
  sessao: string,
  limit: number,
): Promise<CandidatePhone[]> {
  const r = await query<{ phone: string; total: string }>(
    `SELECT ml.phone, COUNT(*)::text AS total
       FROM message_log ml
      WHERE ml.chat_id = $1
        AND NOT EXISTS (
          SELECT 1 FROM contact_classification cc
           WHERE cc.flow_id = $2 AND cc.telefone = ml.phone
        )
      GROUP BY ml.phone
      ORDER BY COUNT(*) DESC
      LIMIT $3`,
    [sessao, slot, limit],
  );
  return r.rows.map((x) => ({ telefone: x.phone, total: Number(x.total) }));
}

/**
 * created_at (ascendente) das mensagens RECEBIDAS daquele telefone na sessão do clone (~24h). Base
 * dos sinais de TIMING (flood / cadência regular). Escopado por sessão + telefone.
 */
export async function getMessageTimestamps(sessao: string, telefone: string): Promise<Date[]> {
  const r = await query<{ created_at: Date }>(
    `SELECT created_at
       FROM message_log
      WHERE chat_id = $1 AND phone = $2
      ORDER BY created_at ASC`,
    [sessao, telefone],
  );
  return r.rows.map((x) => x.created_at);
}

/**
 * Conteúdo das últimas N mensagens `human` (= do número analisado, não as respostas `ai` do nosso
 * bot) na chat_table do clone. Base dos sinais de CONTEÚDO (templated/repetido + marketing).
 *
 * ⚠️ ISOLAMENTO (A1, SCRUM-4 #404): a chat_table é COMPARTILHADA entre clones — a migration 017
 * atribui `chat_table` por `matriz_slot` com `ELSE 'chat_histories'`, então em prod cirilo/samuel/
 * barber_dragon/seven_7 dividem `chat_histories`. Filtrar SÓ pelo sufixo do telefone casaria
 * mensagens de TODOS os clones daquela tabela -> leitura cross-tenant de conteúdo de conversa (PII).
 * Por isso a query é ANCORADA POR SLOT.
 *
 * session_id em chat_histories = `${slot}:${sessao}:${flowId}:${telefone}` -> SEMPRE começa com
 * `${slot}:` e termina em `:<telefone>`. Âncoras (ambas bindadas):
 *  - SLOT: `split_part(session_id, ':', 1) = $1` -> igualdade EXATA no 1º segmento (slot não tem
 *    `:`); evita o footgun do `_` do slot virar curinga single-char num `LIKE $slot || ...`.
 *  - TELEFONE: `session_id LIKE '%:' || $2` -> sufixo. `telefone` é validado como só-dígitos antes
 *    (sem `%`/`_`), e é parâmetro bindado (não interpolado).
 * O NOME DA TABELA é validado contra isValidChatTableName ANTES de interpolar (não dá pra
 * parametrizar identificador) — defesa SQLi.
 */
export async function getHumanMessages(
  chatTable: string,
  slot: string,
  telefone: string,
  limit: number,
): Promise<string[]> {
  if (!isValidChatTableName(chatTable)) {
    throw new Error(`chat_table inválida: ${chatTable}`);
  }
  // A2 (#404): higiene — telefone tem que ser só dígitos. Sem isso, um `%`/`_` vindo do input
  // viraria curinga no LIKE (mesmo bindado, é higiene). Não-dígito -> não lê conteúdo (não classifica).
  if (!/^\d+$/.test(telefone)) {
    return [];
  }
  const r = await query<{ content: string | null }>(
    `SELECT COALESCE(message->'data'->>'content', message->>'content') AS content
       FROM ${chatTable}
      WHERE split_part(session_id, ':', 1) = $1
        AND session_id LIKE '%:' || $2
        AND message->>'type' = 'human'
      ORDER BY id DESC
      LIMIT $3`,
    [slot, telefone, limit],
  );
  return r.rows
    .map((x) => x.content)
    .filter((c): c is string => typeof c === 'string' && c.length > 0);
}

/**
 * Grava (ou atualiza) o veredito no cache. Idempotente: ON CONFLICT atualiza o veredito + sinais
 * (re-rodar não duplica). PRESERVA `alerted_at`/`paused_at` no UPDATE (não zera trilha de alerta).
 */
export async function upsertClassification(input: {
  flowId: string;
  telefone: string;
  verdict: ContactVerdict;
  confidence: number;
  signals: Record<string, unknown>;
  source: ContactSource;
}): Promise<void> {
  await query(
    `INSERT INTO contact_classification
       (flow_id, telefone, verdict, confidence, signals, source, decided_at, updated_at)
     VALUES ($1, $2, $3, $4, $5::jsonb, $6, NOW(), NOW())
     ON CONFLICT (flow_id, telefone) DO UPDATE SET
       verdict    = EXCLUDED.verdict,
       confidence = EXCLUDED.confidence,
       signals    = EXCLUDED.signals,
       source     = EXCLUDED.source,
       decided_at = NOW(),
       updated_at = NOW()`,
    [
      input.flowId,
      input.telefone,
      input.verdict,
      input.confidence,
      JSON.stringify(input.signals),
      input.source,
    ],
  );
}

/**
 * Carimba `alerted_at` (1× por número). Guarda `alerted_at IS NULL` -> idempotente: 2 ciclos
 * concorrentes não duplicam o alerta. Retorna true se ESTE chamador foi quem carimbou.
 */
export async function markAlerted(
  flowId: string,
  telefone: string,
  at: Date = new Date(),
): Promise<boolean> {
  const r = await query(
    `UPDATE contact_classification
        SET alerted_at = $3, updated_at = NOW()
      WHERE flow_id = $1 AND telefone = $2 AND alerted_at IS NULL`,
    [flowId, telefone, at],
  );
  return (r.rowCount ?? 0) > 0;
}

/** Lê o veredito em cache de um número (null = nunca classificado). Usado por testes/observabilidade. */
export async function getClassification(
  flowId: string,
  telefone: string,
): Promise<ContactClassificationRow | null> {
  const r = await query<ContactClassificationRow & { confidence: string }>(
    `SELECT flow_id, telefone, verdict, confidence, signals, source, decided_at, alerted_at, paused_at
       FROM contact_classification
      WHERE flow_id = $1 AND telefone = $2
      LIMIT 1`,
    [flowId, telefone],
  );
  const row = r.rows[0];
  if (!row) return null;
  return { ...row, confidence: Number(row.confidence) };
}

// ─────────────────────────────────────────────────────────────────────────────
// PR-E (SCRUM-4, Fase 2: auto-pausa após carência) — queries ADITIVAS.
//
// Nada aqui altera a Fase 1: estas funções SÓ são chamadas pelo job bot-detect-autopause, gated
// por BOT_DETECT_AUTOPAUSE (default OFF). Reusam a coluna `paused_at` (reservada na migration 067)
// e o índice (flow_id, verdict) — ZERO migration nova. `paused_at` é o marcador ONE-SHOT: uma vez
// carimbado (auto-pausa nossa OU o dono já tinha pausado), o número NUNCA volta à escalação —
// rede de proteção contra loop pausa/despausa. Tudo escopado por flow_id (fronteira de tenant).
// ─────────────────────────────────────────────────────────────────────────────

/** Candidato à ESCALAÇÃO: bot já alertado, carência vencida, ainda NÃO auto-pausado. */
export interface EscalationCandidate {
  telefone: string;
  alerted_at: Date;
}

/**
 * Lista os números do clone elegíveis a auto-pausa: verdict='bot' E já alertado (alerted_at NOT
 * NULL) E a carência venceu (alerted_at <= graceCutoff) E ainda NÃO auto-pausado (paused_at IS
 * NULL). Usa o índice (flow_id, verdict). Ordena pelos alertados há mais tempo. Escopo por flow_id.
 */
export async function listEscalationCandidates(
  flowId: string,
  graceCutoff: Date,
  limit: number,
): Promise<EscalationCandidate[]> {
  const r = await query<{ telefone: string; alerted_at: Date }>(
    `SELECT telefone, alerted_at
       FROM contact_classification
      WHERE flow_id = $1
        AND verdict = 'bot'
        AND alerted_at IS NOT NULL
        AND alerted_at <= $2
        AND paused_at IS NULL
      ORDER BY alerted_at ASC
      LIMIT $3`,
    [flowId, graceCutoff, limit],
  );
  return r.rows;
}

/**
 * Carimba `paused_at` (1× — guarda `paused_at IS NULL` -> idempotente). Marca que a escalação
 * concluiu que o número está pausado (auto-pausa nossa OU o dono já tinha pausado manualmente).
 * Uma vez carimbado, o número NUNCA volta à fila de escalação (one-shot). Retorna true se ESTE
 * chamador carimbou.
 */
export async function markPaused(
  flowId: string,
  telefone: string,
  at: Date = new Date(),
): Promise<boolean> {
  const r = await query(
    `UPDATE contact_classification
        SET paused_at = $3, updated_at = NOW()
      WHERE flow_id = $1 AND telefone = $2 AND paused_at IS NULL`,
    [flowId, telefone, at],
  );
  return (r.rowCount ?? 0) > 0;
}

/**
 * Rebaixa o veredito pra 'human' (override). Usado quando, na escalação/auto-resume, o número se
 * revela cliente real (allowlist / agendou) ou a heurística não confirma mais bot. Tira o número
 * da fila de escalação PRA SEMPRE (verdict != 'bot'). PRESERVA `paused_at`/`alerted_at`. `signals`
 * recebe um patch (merge jsonb) — nunca grava texto de conversa.
 */
export async function markHumanOverride(input: {
  flowId: string;
  telefone: string;
  source: ContactSource;
  signalsPatch?: Record<string, unknown>;
}): Promise<void> {
  await query(
    `UPDATE contact_classification
        SET verdict    = 'human',
            confidence = 1,
            source     = $3,
            signals    = signals || $4::jsonb,
            updated_at = NOW()
      WHERE flow_id = $1 AND telefone = $2`,
    [input.flowId, input.telefone, input.source, JSON.stringify(input.signalsPatch ?? {})],
  );
}

/** true se há mensagem RECEBIDA daquele número na sessão DESDE `since` (sinal "não parou"). */
export async function hasRecentMessages(
  sessao: string,
  telefone: string,
  since: Date,
): Promise<boolean> {
  const r = await query(
    `SELECT 1
       FROM message_log
      WHERE chat_id = $1 AND phone = $2 AND created_at >= $3
      LIMIT 1`,
    [sessao, telefone, since],
  );
  return (r.rowCount ?? 0) > 0;
}
