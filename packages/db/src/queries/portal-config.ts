/**
 * portal-config — leitura/escrita de servicos, horarios e pausas escopadas por slot.
 *
 * ADR 0012 (Decisao 4 + 6): toda funcao recebe `slot` como PRIMEIRO parametro
 * explicito. O portal-api deriva esse slot SEMPRE de request.tenant.slot (nunca
 * do input do cliente). Queries 100% parametrizadas.
 *
 * Apos escrita em flow_clones, invalida o cache de clone (TTL 60s) para o webhook
 * pegar a versao nova em ate ~0s em vez de ate 60s.
 */
import type { Horarios, Perfil, Servicos } from '@startap/core/schemas';
import { PERFIL_KEYS, formasPagamentoToString, parseFormasPagamento } from '@startap/core/schemas';
import { query } from '../client.js';
import { invalidateCloneCache, updateClone } from './flow-clones.js';

function parseJsonbOrNull<T>(value: unknown): T | null {
  if (value == null) return null;
  if (typeof value === 'string') {
    try {
      return JSON.parse(value) as T;
    } catch {
      return null;
    }
  }
  return value as T;
}

// ---------------------------------------------------------------------------
// Servicos
// ---------------------------------------------------------------------------

/** Retorna os servicos do clone. `null` se o slot nao existe; `[]` se sem servicos. */
export async function getServicosBySlot(slot: string): Promise<Servicos | null> {
  const r = await query<{ servicos: unknown }>('SELECT servicos FROM flow_clones WHERE slot = $1', [
    slot,
  ]);
  if (r.rows.length === 0) return null;
  return parseJsonbOrNull<Servicos>(r.rows[0].servicos) ?? [];
}

/**
 * Grava os servicos do clone. Espera que `servicos` JA tenha passado pelo
 * servicosSchema do chamador. Retorna false se o slot nao existe.
 */
export async function updateServicosBySlot(slot: string, servicos: Servicos): Promise<boolean> {
  const r = await query(
    'UPDATE flow_clones SET servicos = $2::jsonb, updated_at = NOW() WHERE slot = $1',
    [slot, JSON.stringify(servicos)],
  );
  if (r.rowCount === 0) return false;
  invalidateCloneCache({ slot });
  return true;
}

// ---------------------------------------------------------------------------
// Horarios de funcionamento
// ---------------------------------------------------------------------------

/** Retorna a grade horaria do clone. `null` se o slot nao existe; `{}` se nao configurada. */
export async function getHorariosBySlot(slot: string): Promise<Horarios | null> {
  const r = await query<{ horarios_funcionamento: unknown }>(
    'SELECT horarios_funcionamento FROM flow_clones WHERE slot = $1',
    [slot],
  );
  if (r.rows.length === 0) return null;
  return parseJsonbOrNull<Horarios>(r.rows[0].horarios_funcionamento) ?? {};
}

/**
 * Grava a grade horaria do clone. Espera que `horarios` JA tenha passado pelo
 * horariosSchema do chamador. Retorna false se o slot nao existe.
 */
export async function updateHorariosBySlot(slot: string, horarios: Horarios): Promise<boolean> {
  const r = await query(
    'UPDATE flow_clones SET horarios_funcionamento = $2::jsonb, updated_at = NOW() WHERE slot = $1',
    [slot, JSON.stringify(horarios)],
  );
  if (r.rowCount === 0) return false;
  invalidateCloneCache({ slot });
  return true;
}

// ---------------------------------------------------------------------------
// Perfil do negocio (flow_clones.personalizacao JSONB — Missao 023 W13)
//
// As 6 chaves do perfil vivem no MESMO JSONB que o gestao grava (PATCH
// /api/clones/:id) — fonte unica, sem migration. CRITICO: o update MERGE as 6
// chaves no personalizacao existente; NUNCA sobrescreve o objeto inteiro (o
// admin/cliente pode ter cadastrado observacoes/promocoes/etc por outra via).
// ---------------------------------------------------------------------------

/**
 * Le as 6 chaves do perfil do personalizacao do clone. `null` se o slot nao
 * existe (clone ausente). As 5 chaves de texto saem como '' (campo vazio) quando
 * ausentes, para o front renderizar inputs controlados sem `undefined`.
 *
 * `formas_pagamento` e guardado como STRING canonica no JSONB (o bot/gestao leem
 * string), mas o portal troca um ARRAY de opcoes fixas (checklist, SCRUM-23).
 * Aqui convertemos string->array best-effort (parseFormasPagamento): mapeia o
 * texto livre ANTIGO pras opcoes quando da; tokens nao-mapeaveis sao ignorados.
 * Migracao LAZY — nada e reescrito no banco ate o dono salvar o perfil.
 */
export async function getPerfilBySlot(slot: string): Promise<Perfil | null> {
  const r = await query<{ personalizacao: unknown }>(
    'SELECT personalizacao FROM flow_clones WHERE slot = $1',
    [slot],
  );
  if (r.rows.length === 0) return null;
  const pers = parseJsonbOrNull<Record<string, string>>(r.rows[0].personalizacao) ?? {};
  const perfil: Record<string, unknown> = {};
  for (const key of PERFIL_KEYS) {
    if (key === 'formas_pagamento') {
      perfil[key] = parseFormasPagamento(pers[key]);
      continue;
    }
    if (key === 'agenda_automatica') {
      // Storage e STRING 'true'/'false' no JSONB (pipeline e string-only), mas o JSONB pode
      // ter boolean cru (gestao/SQL). Default TRUE por AUSENCIA: so 'false'/false = modo
      // atendente. O front recebe boolean pra renderizar o toggle.
      const raw: unknown = (pers as Record<string, unknown>)[key];
      perfil[key] = !(raw === false || raw === 'false');
      continue;
    }
    const v = pers[key];
    perfil[key] = typeof v === 'string' ? v : '';
  }
  return perfil as Perfil;
}

/**
 * Grava o perfil do negocio MERGE-ando as 6 chaves no personalizacao existente
 * (preserva qualquer outra chave). Espera `data` JA validado pelo perfilSchema
 * do chamador. Campos `undefined` (ausentes no PUT) sao IGNORADOS.
 *
 * Semantica de "limpar" por tipo de chave:
 *   - texto simples (nome_negocio, etc.)   -> '' grava '' (campo vazio).
 *   - formas_pagamento                     -> [] grava '' (limpa).
 *   - link_agendamento / planos_beneficios -> '' DELETA a chave do JSONB (SCRUM-75). Um clone
 *     que limpou fica byte-identico a quem NUNCA preencheu (os consumidores — bot/free-slots —
 *     tratam ausencia e '' igual, entao removemos pra nao deixar string vazia residual). Antes,
 *     o schema mapeava '' -> undefined e o merge NUNCA tocava a chave -> limpar o link no portal
 *     era no-op silencioso (salvava 200 mas o link antigo ficava).
 *
 * Reusa updateClone -> re-renderiza o bot_prompt ({{nome_negocio}} etc.) e invalida o cache.
 * Retorna false se o slot nao existe.
 */
export async function updatePerfilBySlot(slot: string, data: Perfil): Promise<boolean> {
  // 1. Lê o personalizacao atual + id do clone (precisamos do id para updateClone,
  //    que re-renderiza o prompt). Uma query só.
  const r = await query<{ id: number; personalizacao: unknown }>(
    'SELECT id, personalizacao FROM flow_clones WHERE slot = $1',
    [slot],
  );
  const found = r.rows[0];
  if (!found) return false;

  const atual = parseJsonbOrNull<Record<string, string>>(found.personalizacao) ?? {};

  // 2. MERGE: parte do objeto existente e sobrescreve SÓ as chaves presentes no
  //    payload. `undefined` (campo nao enviado) nao toca a chave. As demais chaves
  //    do personalizacao (observacoes, promocoes, etc.) ficam intactas.
  const merged: Record<string, unknown> = { ...atual };
  for (const key of PERFIL_KEYS) {
    if (key === 'formas_pagamento') {
      // Array (ja validado contra a lista fixa) -> STRING canonica de storage.
      // Ausente no payload (undefined) = nao toca a chave; [] = limpa ('').
      const arr = data.formas_pagamento;
      if (arr !== undefined) merged[key] = formasPagamentoToString(arr);
      continue;
    }
    if (key === 'agenda_automatica') {
      // Boolean -> STRING 'true'/'false' no JSONB (pipeline string-only). Ausente
      // (undefined) NAO toca a chave -> preserva o modo atual (nunca clobbar em PATCH parcial).
      const v = data.agenda_automatica;
      if (v !== undefined) merged[key] = v ? 'true' : 'false';
      continue;
    }
    if (key === 'link_agendamento' || key === 'planos_beneficios') {
      // TRI-STATE (SCRUM-75): ausente (undefined) = nao toca; '' = LIMPAR (remove a chave do
      // JSONB, byte-identico a quem nunca preencheu); nao-vazio (ja validado) = grava. Nao
      // persistimos '' pra nao deixar string vazia residual no personalizacao.
      const v = (data as Record<string, string | undefined>)[key];
      if (v === '') delete merged[key];
      else if (v !== undefined) merged[key] = v;
      continue;
    }
    const v = (data as Record<string, string | undefined>)[key];
    if (v !== undefined) merged[key] = v;
  }

  // 3. Reusa updateClone (escreve personalizacao=$::jsonb, re-renderiza o prompt
  //    a partir da matriz e invalida o cache de clone). Idempotente.
  const updated = await updateClone(Number(found.id), { personalizacao: merged });
  return updated !== null;
}

// ---------------------------------------------------------------------------
// Pausas (flow_pauses, flow_id = slot)
// ---------------------------------------------------------------------------

export interface PortalPausaRow {
  telefone: string;
  source: string | null;
  reason: string | null;
  /** Nome do contato snapshotado na criação da pausa (SCRUM-144). NULL = não capturado. */
  contact_name: string | null;
  created_at: Date;
  updated_at: Date;
}

/**
 * Lista pausas ATIVAS do fluxo do cliente (escopado por slot/flow_id), EXCETO as de suspeita de bot
 * (source='bot_detected', SCRUM-4 PR-E) — essas têm seção própria no portal (listBotDetectPausasBySlot)
 * pra o dono reconhecer/despausar separado. `IS DISTINCT FROM` mantém as pausas de source NULL.
 * Byte-a-byte com o comportamento anterior enquanto não houver linha 'bot_detected' (auto-pausa OFF).
 */
export async function listPausasBySlot(slot: string): Promise<PortalPausaRow[]> {
  const r = await query<PortalPausaRow>(
    // Exclui pausas EXPIRADAS (SCRUM-59 human_reply com TTL vencido): o bot já voltou pra
    // esse contato, não mostrar como "pausado". Byte-a-byte enquanto não houver expires_at
    // (só o modo atendente seta) — clones fora do gate nunca têm linha com validade.
    `SELECT telefone, source, LEFT(reason, 200) AS reason, contact_name, created_at, updated_at
     FROM flow_pauses
     WHERE flow_id = $1 AND active = TRUE AND source IS DISTINCT FROM 'bot_detected'
       AND (expires_at IS NULL OR expires_at > NOW())
     ORDER BY updated_at DESC, created_at DESC
     LIMIT 500`,
    [slot],
  );
  return r.rows;
}

/**
 * Lista pausas ATIVAS por SUSPEITA DE BOT (source='bot_detected') do fluxo do cliente (escopado por
 * slot/flow_id). Alimenta a seção "Números pausados (suspeita de bot)" do portal — o dono vê e
 * despausa num clique (rede de proteção da auto-pausa). Vazio enquanto a auto-pausa estiver OFF.
 */
export async function listBotDetectPausasBySlot(slot: string): Promise<PortalPausaRow[]> {
  const r = await query<PortalPausaRow>(
    `SELECT telefone, source, LEFT(reason, 200) AS reason, contact_name, created_at, updated_at
     FROM flow_pauses
     WHERE flow_id = $1 AND active = TRUE AND source = 'bot_detected'
     ORDER BY updated_at DESC, created_at DESC
     LIMIT 500`,
    [slot],
  );
  return r.rows;
}

/**
 * Cria (ou reativa) a pausa de um numero no fluxo do cliente, via portal.
 * source = 'portal' para rastreabilidade. `session` resolvido a partir do clone.
 * `telefone` deve ser apenas digitos (10-15) — validado pelo chamador.
 *
 * Semantica de produto (regra canonica de pausa): pausa via portal/app e INDETERMINADA
 * — expires_at NULL, so o cliente remove. O INSERT nao lista expires_at (default NULL);
 * o ON CONFLICT DO UPDATE FORCA `expires_at = NULL` pra PROMOVER a permanente qualquer
 * linha pre-existente (ex.: uma pausa human_reply com TTL de 60min vencido — SCRUM-86).
 * Sem isso a linha herdava o TTL vencido e sumia do painel/soltava o bot em <1h, mesmo
 * o dono tendo pausado de proposito pelo portal.
 *
 * SCRUM-144: `nome` opcional (o front manda o nome que ele JA tem do contato selecionado no
 * sheet de recentes) e SNAPSHOTA em contact_name — pra o nome DURAR independente da janela de
 * recentes/store do WAHA. No conflito, so sobrescreve se veio nome novo (COALESCE/NULLIF):
 * re-pausar sem nome nao apaga um contact_name ja capturado.
 */
export async function addPausaBySlot(input: {
  slot: string;
  telefone: string;
  nome?: string | null;
}): Promise<PortalPausaRow | null> {
  const { slot, telefone } = input;
  const nome = input.nome?.trim() ? input.nome.trim() : null;

  // Resolve flow_name + session a partir do clone (graceful: NULL se nao achar).
  const meta = await query<{ display_name: string | null; waha_sessao: string | null }>(
    'SELECT display_name, waha_sessao FROM flow_clones WHERE slot = $1',
    [slot],
  );
  const flowName = meta.rows[0]?.display_name ?? null;
  const session = meta.rows[0]?.waha_sessao ?? null;

  const r = await query<PortalPausaRow>(
    `INSERT INTO flow_pauses
       (flow_id, flow_name, telefone, session, active, source, reason, contact_name, updated_at)
     VALUES ($1, $2, $3, $4, TRUE, 'portal', 'Pausado via portal', $5, NOW())
     ON CONFLICT (flow_id, telefone) DO UPDATE
       SET active     = TRUE,
           flow_name  = COALESCE(EXCLUDED.flow_name, flow_pauses.flow_name),
           session    = COALESCE(EXCLUDED.session, flow_pauses.session),
           source     = 'portal',
           expires_at = NULL,
           contact_name = COALESCE(NULLIF(EXCLUDED.contact_name, ''), flow_pauses.contact_name),
           reason     = CASE
             WHEN flow_pauses.reason IS NULL OR flow_pauses.reason = ''
             THEN 'Pausado via portal'
             ELSE flow_pauses.reason || ' | reativado via portal'
           END,
           updated_at = NOW()
     RETURNING telefone, source, LEFT(reason, 200) AS reason, contact_name, created_at, updated_at`,
    [slot, flowName, telefone, session, nome],
  );
  return r.rows[0] ?? null;
}

/**
 * Despausa (soft delete: active=false) um numero do fluxo do cliente.
 * O dono e o usuario do portal — pode gerenciar QUALQUER pausa do PROPRIO fluxo
 * (inclusive source='fromMe'/'antibot'), mas NUNCA de outro fluxo (slot e fixo).
 * Retorna false se nao havia pausa ativa para aquele numero.
 */
export async function removePausaBySlot(input: {
  slot: string;
  telefone: string;
}): Promise<boolean> {
  const r = await query(
    `UPDATE flow_pauses
       SET active = FALSE,
           updated_at = NOW(),
           reason = CASE
             WHEN reason IS NULL OR reason = '' THEN 'despausado via portal'
             ELSE reason || ' | despausado via portal'
           END
     WHERE flow_id = $1 AND telefone = $2 AND active = TRUE`,
    [input.slot, input.telefone],
  );
  return (r.rowCount ?? 0) > 0;
}

/** Contagem de pausas ativas do fluxo (usado na home/status). */
export async function countPausasAtivasBySlot(slot: string): Promise<number> {
  const r = await query<{ count: string }>(
    // Não conta pausa expirada (SCRUM-59): bate com listPausasBySlot e com o que o bot faz.
    `SELECT COUNT(*)::text AS count FROM flow_pauses
      WHERE flow_id = $1 AND active = TRUE AND (expires_at IS NULL OR expires_at > NOW())`,
    [slot],
  );
  return Number(r.rows[0]?.count ?? 0);
}
