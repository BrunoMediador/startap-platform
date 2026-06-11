/**
 * clone-provisioning — orquestração compartilhada de criação de clone + sessão WAHA.
 *
 * EXTRAÍDO de painel-admin/server.js (POST /api/clones/with-waha) na Missão 020 F1,
 * em caráter "move, não muda": mesma transação, mesmos defaults, mesmo render de
 * prompt, mesma criação de sessão WAHA com retry-friendly result. O painel-admin
 * passa a delegar pra cá (zero duplicação) e o portal-api (signup self-service)
 * usa o MESMO caminho — herda o isolamento já validado em prod.
 *
 * POR QUE dependency-injection (db/config como parâmetros, sem importar
 * @startap/db): o painel-admin roda em container próprio que só embarca os dists
 * de @startap/core e @startap/integrations (ver painel-admin/Dockerfile) e tem o
 * próprio pg.Pool. Injetar o executor SQL deixa o módulo consumível pelos dois
 * mundos sem mudar o build do painel.
 *
 * Multi-tenant: tudo keyed por slot; sessão WAHA derivada do slot; defaults vêm
 * do banco da MATRIZ (bot_config) — zero default de modelo hardcoded.
 */
import { logger } from '@startap/core/logger';

const log = logger.child({ module: 'clone-provisioning' });

// ---------------------------------------------------------------------------
// Contratos de injeção (pg.Pool e pg.PoolClient satisfazem estruturalmente)
// ---------------------------------------------------------------------------

export interface SqlResult {
  rows: Array<Record<string, unknown>>;
}

export interface SqlClient {
  query(text: string, values?: unknown[]): Promise<SqlResult>;
  release(): void;
}

export interface SqlPool {
  query(text: string, values?: unknown[]): Promise<SqlResult>;
  connect(): Promise<SqlClient>;
}

export interface WahaConfig {
  /** Base da API WAHA (ex: http://waha:3000). */
  url: string;
  apiKey: string;
  /** URL do webhook do apps/api (TS_WEBHOOK_URL). */
  webhookUrl: string;
}

// ---------------------------------------------------------------------------
// Defaults por matriz (movido de painel-admin/server.js — fallback quando a
// matriz não tem horarios/servicos preenchidos em bot_config)
// ---------------------------------------------------------------------------

const CLONE_DEFAULTS_BARBEARIA = {
  horarios_funcionamento: {
    segunda: { abre: null, fecha: null, fechado: true },
    terca: { abre: '09:00', fecha: '18:00', fechado: false },
    quarta: { abre: '09:00', fecha: '18:00', fechado: false },
    quinta: { abre: '09:00', fecha: '18:00', fechado: false },
    sexta: { abre: '09:00', fecha: '18:00', fechado: false },
    sabado: { abre: '09:00', fecha: '18:00', fechado: false },
    domingo: { abre: null, fecha: null, fechado: true },
  },
  servicos: [
    { nome: 'Corte', preco_cents: 5000, duracao_min: 30 },
    { nome: 'Barba', preco_cents: 5000, duracao_min: 30 },
    { nome: 'Sobrancelha', preco_cents: 5000, duracao_min: 30 },
    { nome: 'Pezinho', preco_cents: 5000, duracao_min: 30 },
  ],
} as const;

export interface CloneDefaults {
  horarios_funcionamento: unknown | null;
  servicos: unknown | null;
}

/**
 * Defaults para clone novo (movido de painel-admin). Hierarquia:
 *  1) bot_config.horarios_funcionamento + bot_config.servicos da MATRIZ.
 *  2) Hardcoded por matriz (teste_barbearia).
 *  3) null/null (outras matrizes).
 */
export async function getCloneDefaults(db: SqlPool, matrizSlot: string): Promise<CloneDefaults> {
  try {
    const r = await db.query(
      'SELECT horarios_funcionamento, servicos FROM bot_config WHERE slot = $1',
      [matrizSlot],
    );
    const row = r.rows[0];
    if (row && (row.horarios_funcionamento || row.servicos)) {
      const fallback: CloneDefaults =
        matrizSlot === 'teste_barbearia'
          ? CLONE_DEFAULTS_BARBEARIA
          : { horarios_funcionamento: null, servicos: null };
      return {
        horarios_funcionamento: row.horarios_funcionamento ?? fallback.horarios_funcionamento,
        servicos: row.servicos ?? fallback.servicos,
      };
    }
  } catch (e) {
    log.warn(
      { matrizSlot, err: e instanceof Error ? e.message : String(e) },
      'getCloneDefaults: falha ao ler bot_config da matriz',
    );
  }
  if (matrizSlot === 'teste_barbearia') return CLONE_DEFAULTS_BARBEARIA;
  return { horarios_funcionamento: null, servicos: null };
}

// ---------------------------------------------------------------------------
// Render de prompt por clone (movido de painel-admin/server.js)
// ---------------------------------------------------------------------------

const DIAS_SEMANA: ReadonlyArray<readonly [string, string]> = [
  ['segunda', 'Segunda'],
  ['terca', 'Terca'],
  ['quarta', 'Quarta'],
  ['quinta', 'Quinta'],
  ['sexta', 'Sexta'],
  ['sabado', 'Sabado'],
  ['domingo', 'Domingo'],
];

interface HorarioDiaLike {
  abre?: string | null;
  fecha?: string | null;
  fechado?: boolean;
}

export function renderHorariosFuncionamento(horarios: unknown): string {
  if (!horarios || typeof horarios !== 'object') return 'Nao configurado.';
  const h = horarios as Record<string, HorarioDiaLike | undefined>;
  const linhas: string[] = [];
  for (const [key, label] of DIAS_SEMANA) {
    const dia = h[key];
    if (!dia || dia.fechado) {
      linhas.push(`${label}: fechado`);
    } else if (dia.abre && dia.fecha) {
      linhas.push(`${label}: ${dia.abre} as ${dia.fecha}`);
    } else {
      linhas.push(`${label}: nao configurado`);
    }
  }
  return linhas.join('\n');
}

interface ServicoLike {
  nome?: unknown;
  preco_cents?: unknown;
  duracao_min?: unknown;
}

export function renderServicosPrecos(servicos: unknown): string {
  if (!Array.isArray(servicos) || servicos.length === 0) return 'Nenhum servico cadastrado.';
  return (
    (servicos as ServicoLike[])
      .filter((s) => s && typeof s === 'object' && s.nome)
      .map((s) => {
        const nome = String(s.nome).trim();
        const preco = Number(s.preco_cents);
        const dur = Number(s.duracao_min);
        const precoStr =
          Number.isFinite(preco) && preco > 0
            ? `R$${(preco / 100).toFixed(2).replace('.', ',')}`
            : 'a combinar';
        const durStr = Number.isFinite(dur) && dur > 0 ? `${dur} min` : 'duracao a combinar';
        return `${nome}: ${precoStr} (${durStr})`;
      })
      .join('\n') || 'Nenhum servico cadastrado.'
  );
}

/**
 * Aplica os 3 grupos de placeholders {{double_brace}} sobre o template da matriz.
 * Placeholders não resolvidos são preservados ({{key}}).
 */
export function renderClonePrompt(
  matrizPrompt: string,
  personalizacao: unknown,
  horarios: unknown,
  servicos: unknown,
): string {
  const pers: Record<string, unknown> =
    personalizacao && typeof personalizacao === 'object' && !Array.isArray(personalizacao)
      ? (personalizacao as Record<string, unknown>)
      : {};
  const ctx: Record<string, unknown> = {
    ...pers,
    horarios_funcionamento_render: renderHorariosFuncionamento(horarios),
    servicos_precos_render: renderServicosPrecos(servicos),
  };
  let out = matrizPrompt.replace(/\{\{(\w+)\}\}/g, (_m, k: string) =>
    Object.prototype.hasOwnProperty.call(ctx, k) ? String(ctx[k] ?? '') : `{{${k}}}`,
  );
  const clienteNome = pers.cliente_nome;
  if (clienteNome) {
    out = out.replace(/\[Ricardo\]/g, `[${String(clienteNome)}]`);
  }
  return out;
}

export interface CloneRowLike {
  id: number;
  slot: string;
  matriz_slot: string;
  personalizacao: unknown;
  horarios_funcionamento: unknown;
  servicos: unknown;
}

/**
 * Re-renderiza o prompt do clone a partir do template da MATRIZ e sobrescreve
 * bot_prompt do slot do clone. Idempotente (UPSERT).
 */
export async function regerarPromptClone(
  db: SqlPool,
  cloneRow: CloneRowLike,
): Promise<{ ok: true; prompt: string } | { ok: false; error: string }> {
  try {
    const matrizPrompt = await db.query('SELECT prompt FROM bot_prompt WHERE slot = $1', [
      cloneRow.matriz_slot,
    ]);
    const tpl = matrizPrompt.rows[0]?.prompt;
    if (typeof tpl !== 'string') {
      return { ok: false, error: `Matriz ${cloneRow.matriz_slot} sem prompt em bot_prompt` };
    }
    const prompt = renderClonePrompt(
      tpl,
      cloneRow.personalizacao,
      cloneRow.horarios_funcionamento,
      cloneRow.servicos,
    );
    await db.query(
      `INSERT INTO bot_prompt (slot, prompt, updated_at) VALUES ($1, $2, NOW())
       ON CONFLICT (slot) DO UPDATE SET prompt = EXCLUDED.prompt, updated_at = NOW()`,
      [cloneRow.slot, prompt],
    );
    return { ok: true, prompt };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

// ---------------------------------------------------------------------------
// Sessão WAHA (movido de painel-admin/server.js)
// ---------------------------------------------------------------------------

/**
 * Deriva o nome da sessão WAHA a partir do slot do clone (movido do painel).
 * WAHA aceita apenas [a-zA-Z0-9_-]: troca hífens por underscores e prefixa
 * "clone_" para namespacing.
 */
export function wahaSessionName(slot: string): string {
  return `clone_${slot.replace(/-/g, '_')}`;
}

export interface WahaSessionResult {
  ok: boolean;
  status: string;
  error?: string;
}

/**
 * Cria sessão WAHA com webhook configurado. NUNCA lança — encapsula falha pra o
 * caller decidir (clone permanece em rascunho; retry-waha cobre).
 */
export async function createWahaSession(
  waha: WahaConfig,
  name: string,
): Promise<WahaSessionResult> {
  try {
    const r = await fetch(`${waha.url}/api/sessions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(waha.apiKey ? { 'X-Api-Key': waha.apiKey } : {}),
      },
      body: JSON.stringify({
        name,
        start: true,
        // events MUST include 'message.any' — engine NOWEB do WAHA so manda
        // audio/video/imagem sob 'message.any', nao 'message'. Sem isso o bot
        // fica surdo pra audio (Bruno 2026-05-21) e o pause do dono quebra
        // (memoria reference_waha_fromme_message_any). 'session.status' alimenta
        // o hook de trial do pareamento (Missao 020 F1).
        config: {
          webhooks: [
            { url: waha.webhookUrl, events: ['message', 'message.any', 'session.status'] },
          ],
        },
      }),
    });
    const body = (await r.json().catch(() => ({}))) as Record<string, unknown>;
    if (!r.ok) {
      const msg = (body.message ?? body.error ?? `HTTP ${r.status}`) as string;
      return { ok: false, status: 'failed', error: `WAHA: ${msg}` };
    }
    return { ok: true, status: (body.status as string | undefined) ?? 'STARTING' };
  } catch (e) {
    return {
      ok: false,
      status: 'failed',
      error: `Falha ao contatar WAHA: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
}

/**
 * Derruba a sessão WAHA (DELETE /api/sessions/{name} — para e remove). NUNCA
 * lança. Guarda: só sessões prefixadas clone_ (jamais toca sessão de matriz/
 * cliente manual como cirilobarbearia/startap).
 */
export async function deleteWahaSession(waha: WahaConfig, name: string): Promise<boolean> {
  if (!name.startsWith('clone_')) {
    log.error({ session: name }, 'deleteWahaSession recusado: sessão sem prefixo clone_');
    return false;
  }
  try {
    const r = await fetch(`${waha.url}/api/sessions/${encodeURIComponent(name)}`, {
      method: 'DELETE',
      headers: waha.apiKey ? { 'X-Api-Key': waha.apiKey } : {},
      signal: AbortSignal.timeout(8_000),
    });
    return r.ok;
  } catch (e) {
    log.warn(
      { session: name, err: e instanceof Error ? e.message : String(e) },
      'deleteWahaSession falhou (cleanup cron de órfãos cobre — card próprio)',
    );
    return false;
  }
}

export interface TeardownResult {
  wahaDeleted: boolean;
  dbDeleted: boolean;
}

/**
 * Compensating teardown de clone ÓRFÃO de falha parcial do signup (security
 * review PR #268, item P2 #5): provisionamento ok mas criação de conta/billing
 * falhou — sem isso, sessões WAHA sem dono acumulam e amplificam o DoS de RAM.
 *
 * Remove APENAS o que o próprio fluxo de signup acabou de criar, keyed pelo
 * slot fresco (sufixo aleatório, gerado neste mesmo request). NUNCA toca o
 * trial_ledger (permanente por design — e nesta fase nenhum trial foi consumido).
 *
 * Guardas (defesa em profundidade):
 *  - slot precisa do prefixo clone_;
 *  - a row de flow_clones precisa estar em rascunho/aguardando_qr (clone que já
 *    progrediu — conectado/pareado — JAMAIS é derrubado por aqui).
 *
 * Best-effort: NUNCA lança (o caller já está num caminho de erro 4xx/5xx).
 */
export async function teardownProvisionedClone(
  deps: { db: SqlPool; waha: WahaConfig },
  input: { slot: string; sessionName: string },
): Promise<TeardownResult> {
  const out: TeardownResult = { wahaDeleted: false, dbDeleted: false };
  if (!input.slot.startsWith('clone_')) {
    log.error({ slot: input.slot }, 'teardown recusado: slot sem prefixo clone_');
    return out;
  }

  out.wahaDeleted = await deleteWahaSession(deps.waha, input.sessionName);

  let client: SqlClient | null = null;
  try {
    client = await deps.db.connect();
    await client.query('BEGIN');
    const st = await client.query('SELECT status FROM flow_clones WHERE slot = $1 FOR UPDATE', [
      input.slot,
    ]);
    const status = st.rows[0]?.status as string | undefined;
    if (status !== undefined && status !== 'rascunho' && status !== 'aguardando_qr') {
      await client.query('ROLLBACK');
      log.error({ slot: input.slot, status }, 'teardown abortado: clone já progrediu de estado');
      return out;
    }
    // Espelho exato do que createCloneRecords + signup criaram para este slot.
    // portal_users/portal_user_clones por SLOT (nunca por username): no 23505 a
    // conta pré-existente tem outro slot e não é tocada.
    await client.query('DELETE FROM portal_user_clones WHERE slot = $1', [input.slot]);
    await client.query('DELETE FROM portal_users WHERE slot = $1', [input.slot]);
    await client.query('DELETE FROM client_billing WHERE slot = $1', [input.slot]);
    await client.query('DELETE FROM bot_media WHERE slot = $1', [input.slot]);
    await client.query('DELETE FROM bot_prompt WHERE slot = $1', [input.slot]);
    await client.query('DELETE FROM bot_config WHERE slot = $1', [input.slot]);
    await client.query('DELETE FROM flow_controls WHERE flow_id = $1', [input.slot]);
    await client.query('DELETE FROM flow_clones WHERE slot = $1', [input.slot]);
    await client.query('COMMIT');
    out.dbDeleted = true;
    log.info({ slot: input.slot, wahaDeleted: out.wahaDeleted }, 'clone órfão removido (teardown)');
  } catch (e) {
    if (client) await client.query('ROLLBACK').catch(() => {});
    log.error(
      { slot: input.slot, err: e instanceof Error ? e.message : String(e) },
      'teardown de clone órfão falhou — cleanup cron cobre (card próprio)',
    );
  } finally {
    client?.release();
  }
  return out;
}

// ---------------------------------------------------------------------------
// Geração de slot (signup self-service — espelha flow-clones.ts createClone)
// ---------------------------------------------------------------------------

function slugify(text: string): string {
  return (
    text
      .toLowerCase()
      .normalize('NFD')
      // Remove diacríticos (combining marks U+0300–U+036F) após o NFD —
      // mesmo padrão do slugify de packages/db/src/queries/flow-clones.ts.
      // biome-ignore lint/suspicious/noMisleadingCharacterClass: faixa de combining marks é proposital pós-NFD
      .replace(/[̀-ͯ]/g, '')
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '')
  );
}

function shortid(len: number): string {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let out = '';
  for (let i = 0; i < len; i++) {
    out += chars[Math.floor(Math.random() * chars.length)];
  }
  return out;
}

/**
 * Gera slot único para clone do signup: `clone_<slug>_<rand>`. O prefixo
 * "clone_" é OBRIGATÓRIO — o gate de billing (router 6b), o per-clone GCal e o
 * resolveCloneBot todos discriminam por `startsWith('clone_')`.
 */
export function generateCloneSlot(displayName: string): string {
  const slug = slugify(displayName).slice(0, 40) || 'negocio';
  return `clone_${slug}_${shortid(6)}`;
}

// ---------------------------------------------------------------------------
// Orquestração principal
// ---------------------------------------------------------------------------

/** Slot já existe em bot_config ou flow_clones. */
export class CloneSlotConflictError extends Error {
  constructor(slot: string) {
    super(`slot "${slot}" já existe`);
    this.name = 'CloneSlotConflictError';
  }
}

export class MatrizNotFoundError extends Error {
  constructor(matrizSlot: string) {
    super(`matriz_slot "${matrizSlot}" não encontrado em bot_config`);
    this.name = 'MatrizNotFoundError';
  }
}

export async function slotExists(db: SqlPool, slot: string): Promise<boolean> {
  const [bc, fc] = await Promise.all([
    db.query('SELECT 1 FROM bot_config WHERE slot = $1', [slot]),
    db.query('SELECT 1 FROM flow_clones WHERE slot = $1', [slot]),
  ]);
  return bc.rows.length > 0 || fc.rows.length > 0;
}

export interface ProvisionInput {
  matrizSlot: string;
  novoSlot: string;
  displayName: string;
  telefoneContato?: string | null;
  personalizacao?: Record<string, unknown>;
  /** Nome da sessão WAHA. Default: wahaSessionName(novoSlot) — comportamento do gestão. */
  sessionName?: string;
}

export interface ProvisionResult {
  cloneId: number;
  slot: string;
  sessionName: string;
  wahaStatus: string;
  wahaError?: string;
  cloneStatus: 'rascunho' | 'aguardando_qr';
}

/**
 * Cria os registros do clone em transação única (mesma sequência do with-waha):
 * bot_config (com overrides de personalizacao) -> bot_prompt (placeholders) ->
 * bot_media -> flow_controls -> flow_clones (status 'rascunho', defaults de
 * horarios/servicos da matriz). Retorna a row de flow_clones.
 */
export async function createCloneRecords(
  db: SqlPool,
  input: Omit<ProvisionInput, 'sessionName'>,
): Promise<CloneRowLike & Record<string, unknown>> {
  const pers =
    input.personalizacao &&
    typeof input.personalizacao === 'object' &&
    !Array.isArray(input.personalizacao)
      ? input.personalizacao
      : {};

  // Unicidade (defesa em profundidade — rotas também checam antes).
  if (await slotExists(db, input.novoSlot)) {
    throw new CloneSlotConflictError(input.novoSlot);
  }

  const client = await db.connect();
  try {
    await client.query('BEGIN');

    const cfgR = await client.query(
      'SELECT provider, model, temperature FROM bot_config WHERE slot = $1',
      [input.matrizSlot],
    );
    if (!cfgR.rows[0]) {
      await client.query('ROLLBACK');
      throw new MatrizNotFoundError(input.matrizSlot);
    }
    const { provider, model, temperature } = cfgR.rows[0] as {
      provider: string;
      model: string;
      temperature: string;
    };

    // Campos de bot_config podem ser sobrescritos por personalizacao (gestão).
    // No signup self-service NÃO passamos override — modelo vem da matriz (banco).
    const finalProvider = (pers.provider as string | undefined) ?? provider;
    const finalModel = (pers.model as string | undefined) ?? model;
    const finalTemperature = (pers.temperature as string | undefined) ?? temperature;

    await client.query(
      `INSERT INTO bot_config (slot, display_name, provider, model, temperature, updated_at)
       VALUES ($1, $2, $3, $4, $5::numeric, NOW())`,
      [input.novoSlot, input.displayName, finalProvider, finalModel, finalTemperature],
    );

    const promptR = await client.query('SELECT prompt FROM bot_prompt WHERE slot = $1', [
      input.matrizSlot,
    ]);
    const tpl = promptR.rows[0]?.prompt;
    if (typeof tpl === 'string') {
      let prompt = tpl.replace(/\{\{(\w+)\}\}/g, (_m, k: string) =>
        Object.prototype.hasOwnProperty.call(pers, k) ? String(pers[k] ?? '') : `{{${k}}}`,
      );
      const clienteNome = pers.cliente_nome;
      if (clienteNome) {
        prompt = prompt.replace(/\[Ricardo\]/g, `[${String(clienteNome)}]`);
      }
      await client.query(
        'INSERT INTO bot_prompt (slot, prompt, updated_at) VALUES ($1, $2, NOW())',
        [input.novoSlot, prompt],
      );
    }

    // bot_media herdado da matriz (inclui course_slug e is_course_intro)
    const mediaR = await client.query(
      `SELECT position, media_type, url, caption, context, position_order, enabled,
              course_slug, is_course_intro
       FROM bot_media WHERE slot = $1`,
      [input.matrizSlot],
    );
    for (const m of mediaR.rows) {
      await client.query(
        `INSERT INTO bot_media
           (slot, position, media_type, url, caption, context, position_order, enabled,
            course_slug, is_course_intro, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,NOW())`,
        [
          input.novoSlot,
          m.position,
          m.media_type,
          m.url,
          m.caption,
          m.context,
          m.position_order,
          m.enabled,
          m.course_slug ?? null,
          m.is_course_intro ?? false,
        ],
      );
    }

    await client.query(
      `INSERT INTO flow_controls (flow_id, flow_name, source, active, updated_at)
       VALUES ($1, $2, 'clone', TRUE, NOW())
       ON CONFLICT (flow_id) DO UPDATE SET active = TRUE, updated_at = NOW()`,
      [input.novoSlot, input.displayName],
    );

    // Defaults de horarios/servicos conforme a matriz (clone novo já sai
    // oferecendo serviços comuns — evita "Nenhum servico cadastrado").
    const defaults = await getCloneDefaults(db, input.matrizSlot);
    const cloneR = await client.query(
      `INSERT INTO flow_clones
         (slot, matriz_slot, display_name, cliente_nome, cliente_telefone,
          personalizacao, horarios_funcionamento, servicos,
          status, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8::jsonb, 'rascunho', NOW(), NOW())
       RETURNING *`,
      [
        input.novoSlot,
        input.matrizSlot,
        input.displayName,
        null,
        input.telefoneContato ?? null,
        JSON.stringify(pers),
        defaults.horarios_funcionamento ? JSON.stringify(defaults.horarios_funcionamento) : null,
        defaults.servicos ? JSON.stringify(defaults.servicos) : null,
      ],
    );

    await client.query('COMMIT');
    const row = cloneR.rows[0] as CloneRowLike & Record<string, unknown>;
    return { ...row, id: Number(row.id) };
  } catch (e) {
    // ROLLBACK já feito nos caminhos conhecidos; garante nos inesperados.
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

/**
 * Orquestração completa (mesmo contrato do POST /api/clones/with-waha):
 *  1. createCloneRecords (transação).
 *  2. regerarPromptClone (fora da transação — UPSERT idempotente).
 *  3. createWahaSession (falha NÃO reverte o clone — decisão Bruno 005-B;
 *     clone fica 'rascunho' e o retry-waha do gestão cobre).
 *  4. Vincula waha_sessao em flow_clones E bot_config (memória
 *     mapping_slot_waha_sessao) + status 'aguardando_qr'.
 */
export async function provisionCloneWithWaha(
  deps: { db: SqlPool; waha: WahaConfig },
  input: ProvisionInput,
): Promise<ProvisionResult> {
  const cloneRow = await createCloneRecords(deps.db, input);

  const rendered = await regerarPromptClone(deps.db, cloneRow);
  if (!rendered.ok) {
    log.warn({ slot: input.novoSlot, error: rendered.error }, 'regerarPromptClone falhou');
  }

  const sessionName = input.sessionName ?? wahaSessionName(input.novoSlot);
  const waha = await createWahaSession(deps.waha, sessionName);

  if (!waha.ok) {
    log.warn(
      { slot: input.novoSlot, cloneId: cloneRow.id, error: waha.error },
      'clone criado mas WAHA falhou',
    );
    return {
      cloneId: cloneRow.id,
      slot: input.novoSlot,
      sessionName,
      wahaStatus: 'failed',
      wahaError: waha.error,
      cloneStatus: 'rascunho',
    };
  }

  await Promise.all([
    deps.db
      .query(
        `UPDATE flow_clones SET waha_sessao = $1, status = 'aguardando_qr', updated_at = NOW() WHERE id = $2`,
        [sessionName, cloneRow.id],
      )
      .catch((e: unknown) =>
        log.error(
          { slot: input.novoSlot, err: e instanceof Error ? e.message : String(e) },
          'falha ao vincular sessão no DB',
        ),
      ),
    deps.db
      .query('UPDATE bot_config SET waha_sessao = $1, updated_at = NOW() WHERE slot = $2', [
        sessionName,
        input.novoSlot,
      ])
      .catch((e: unknown) =>
        log.error(
          { slot: input.novoSlot, err: e instanceof Error ? e.message : String(e) },
          'falha ao espelhar waha_sessao em bot_config',
        ),
      ),
  ]);

  log.info(
    { slot: input.novoSlot, cloneId: cloneRow.id, sessionName },
    'clone criado e sessão WAHA iniciada',
  );

  return {
    cloneId: cloneRow.id,
    slot: input.novoSlot,
    sessionName,
    wahaStatus: waha.status,
    cloneStatus: 'rascunho',
  };
}
