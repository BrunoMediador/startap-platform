/**
 * flow-clones — CRUD de clones de fluxos matriz.
 *
 * Um clone herda bot_config/bot_prompt/bot_media de uma matriz, com personalizacao
 * própria e sessão WAHA dedicada. Toda criação ocorre em transação única.
 */
import { isAgendaAutomaticaIntent } from '@startap/core/agenda-degrade';
import { resolveAtendFromAgendaEnabled } from '@startap/core/atend-from-agenda-gate';
import { resolveModoAtendenteEnabled } from '@startap/core/modo-atendente-gate';
import { meIdToDigits } from '@startap/core/phone';
import { OWNER_PAUSE_KIND } from '@startap/core/silence-gate';
import { DEFAULT_TIMEZONE, isValidIanaTimezone } from '@startap/core/timezones';
import { pool, query } from '../client.js';
import { invalidateTenantCache } from './tenant.js';

export type CloneStatus =
  | 'rascunho'
  | 'aguardando_qr'
  | 'conectado'
  | 'desconectado'
  // 'parado' (SCRUM-64): sessão WAHA PARADA de propósito (POST /stop). DISTINTO de
  // 'desconectado' (queda inesperada) — o monitor (alerts.listMonitoredSessions filtra
  // status IN ('conectado','desconectado')) exclui 'parado', então parar uma sessão de
  // propósito NÃO gera alerta de queda falso. Sem constraint no banco (status é VARCHAR(24)).
  | 'parado'
  | 'falhou';

export interface HorarioDia {
  abre: string | null; // "HH:MM" ou null se fechado
  fecha: string | null;
  fechado: boolean;
}

export interface HorariosFuncionamento {
  segunda?: HorarioDia;
  terca?: HorarioDia;
  quarta?: HorarioDia;
  quinta?: HorarioDia;
  sexta?: HorarioDia;
  sabado?: HorarioDia;
  domingo?: HorarioDia;
}

export interface ServicoConfig {
  nome: string;
  preco_cents: number;
  duracao_min: number;
}

export interface CloneRow {
  id: number;
  slot: string;
  /**
   * Identidade UUID do tenant (ADR 0018). Âncora canônica; gerado por DEFAULT
   * gen_random_uuid() na criação do clone (migration 045). NOT NULL no banco para
   * flow_clones — opcional no tipo só pra rows de SELECTs que não pedem a coluna
   * (não quebra os normalizeCloneRow existentes). Dual-write Fase 2.
   */
  tenant_id?: string;
  matriz_slot: string;
  display_name: string;
  cliente_nome: string | null;
  cliente_telefone: string | null;
  personalizacao: Record<string, string>;
  waha_sessao: string | null;
  /**
   * Shard do container WAHA da sessão (ADR 0020, migration 047). 0 = shard atual
   * (`automacoes-waha-1`), onde TODAS as sessões vivem hoje. Default 0 no banco;
   * só clientes NOVOS em shards novos no futuro. Lido pelo roteamento por shard
   * apenas com a flag `WAHA_SHARDING` ON (default OFF) — hoje é informativo.
   */
  waha_shard_id: number;
  status: CloneStatus;
  /** false = fluxo suspenso por billing/férias — WAHA permanece conectado */
  flow_enabled: boolean;
  suspended_reason: string | null;
  /**
   * Categoria ESTRUTURADA da suspensão (ADR 0013 / threat-model C1; ADR 0014 F1).
   * ∈ billing | owner_request | manual_other | abuse | null.
   * - 'owner_request' = pausa self-service do PRÓPRIO cliente pelo portal (NUNCA
   *   reativada pelo PIX — só o dono levanta).
   * - 'billing' = inadimplência; ÚNICO kind que o auto-resume do webhook PIX reativa.
   * - 'manual_other' | 'abuse' = suspensão pela Startap; o cliente NÃO destrava (409).
   * null em rows de SELECTs que não pedem a coluna (não quebra normalizeCloneRow).
   */
  suspended_kind: string | null;
  suspended_at: Date | null;
  horarios_funcionamento: HorariosFuncionamento | null;
  servicos: ServicoConfig[] | null;
  /**
   * Fuso (IANA) do relógio da barbearia (migration 068). DEFAULT 'America/Sao_Paulo'
   * carimba todo clone existente — todo clone que não declarou outro fuso permanece
   * byte-idêntico ao comportamento de hoje. Ex.: 'America/Cuiaba' (Seven 7, Mato Grosso).
   * normalizeCloneRow garante 'America/Sao_Paulo' quando a coluna não vem no SELECT.
   */
  timezone: string;
  /**
   * true = o bot_prompt deste clone foi escrito à mão (persona custom); updateClone NÃO
   * re-renderiza do template da matriz ao mudar personalizacao (migration 070, SCRUM-59).
   * DEFAULT false = render default (Cirilo/Samuel — re-renderizam como hoje). normalizeCloneRow
   * garante false quando a coluna não vem no SELECT (byte-idêntico ao comportamento de hoje).
   */
  prompt_custom: boolean;
  /**
   * Gates de produtização POR-CLONE (migration 072, ADR 0030 D1). Cada um é o eixo `coluna` da
   * resolução env→coluna: `efetivo = isEnabledFromCsv(slot, envCsv) OR coluna`. DEFAULT false
   * carimba toda linha existente — enquanto o env cobrir o clone (ou for '*'), a UNIÃO mantém ON
   * INDEPENDENTE da coluna (byte-idêntico). normalizeCloneRow garante false quando a coluna não
   * vem no SELECT (só === true liga). A resolução vive nos gates de @startap/core (resolveX...) e
   * nos async helpers resolveXEnabledForSlot abaixo.
   */
  modo_atendente_enabled: boolean;
  billing_from_agenda_enabled: boolean;
  /**
   * Vencimento do billing do slot (LEFT JOIN client_billing). null se nao ha linha
   * de billing. Usado SO pelo gate de silencio por cobranca (ADR 0016) — derivado
   * puro, nunca escrito por este caminho. 'YYYY-MM-DD'.
   */
  next_due_date: string | null;
  /**
   * Valor do billing em centavos (LEFT JOIN client_billing). null/0 = sem cobranca
   * configurada -> o gate de silencio por cobranca NUNCA cala (ADR 0016, guard).
   */
  billing_amount_cents: number | null;
  /**
   * Carimbo da 1ª conexão bem-sucedida da sessão WAHA (migration 062). NUNCA
   * sobrescrito (COALESCE no markCloneConnected). NULL = clone que ainda não conectou
   * nenhuma vez. Só vem de SELECTs que pedem a coluna (getCloneBySlot); demais origens
   * (getCloneBySession, RETURNING *) -> null via normalizeCloneRow. Exposto ao portal
   * SÓ como booleano `ever_connected` (a DATA nunca sai da API — LGPD).
   */
  first_connected_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

export interface CloneSummary extends CloneRow {
  matriz_display_name: string | null;
}

// ---------------------------------------------------------------------------
// Cache TTL — reduz queries por webhook (hot path: getCloneBySession/BySlot)
// ---------------------------------------------------------------------------

const CACHE_TTL_MS = 60_000;
const bySessionCache = new Map<string, { value: CloneRow | null; expiresAt: number }>();
const bySlotCache = new Map<string, { value: CloneRow | null; expiresAt: number }>();

export function invalidateCloneCache(opts?: { sessao?: string; slot?: string }): void {
  if (!opts) {
    bySessionCache.clear();
    bySlotCache.clear();
    return;
  }
  if (opts.sessao) bySessionCache.delete(opts.sessao);
  if (opts.slot) bySlotCache.delete(opts.slot);
}

// ---------------------------------------------------------------------------
// Helpers internos
// ---------------------------------------------------------------------------

function slugify(text: string): string {
  return (
    text
      .toLowerCase()
      .normalize('NFD')
      // Remove diacríticos (combining marks U+0300–U+036F) após o NFD —
      // mesmo padrão do slugify de packages/integrations/src/provisioning/clone-provisioning.ts.
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
 * Aplica substituições {{chave}} no template usando personalizacao.
 * Fallback: se personalizacao contiver cliente_nome, substitui [Ricardo] por [clienteNome].
 */
function applyPersonalizacao(template: string, personalizacao: Record<string, unknown>): string {
  let result = template;

  // Substitui {{chave}} por valor correspondente. So valores STRING sao substituidos —
  // valores estruturados (ex.: faq_personalizado = array, SCRUM-65) nunca tem placeholder
  // no template e nao devem ser coeridos pra '[object Object]'; mantem o placeholder literal.
  result = result.replace(/\{\{(\w+)\}\}/g, (_match, key: string) => {
    const v = personalizacao[key];
    return typeof v === 'string' ? v : `{{${key}}}`;
  });

  // Fallback legado: [Ricardo] -> [clienteNome] quando cliente_nome fornecido
  if (typeof personalizacao.cliente_nome === 'string' && personalizacao.cliente_nome) {
    result = result.replace(/\[Ricardo\]/g, `[${personalizacao.cliente_nome}]`);
  }

  return result;
}

// ---------------------------------------------------------------------------
// Funções públicas
// ---------------------------------------------------------------------------

export async function createClone(input: {
  matrizSlot: string;
  displayName: string;
  clienteNome?: string | null;
  clienteTelefone?: string | null;
  personalizacao?: Record<string, string>;
  /** Fuso IANA do clone (migration 068). Ausente/vazio -> 'America/Sao_Paulo'
   * (byte-idêntico ao default do banco). Espera-se JÁ validado (isValidIanaTimezone). */
  timezone?: string | null;
}): Promise<CloneRow> {
  const { matrizSlot, displayName, clienteNome, clienteTelefone } = input;
  const personalizacao = input.personalizacao ?? {};
  // Guard IANA (defesa em profundidade, P3-1): valida contra a lista suportada —
  // ausente/inválido -> DEFAULT SP (nunca persiste lixo). Mesmo padrão de
  // createCloneRecords/provisioning. Sem lançar: só não deixa gravar tz quebrado
  // que derrubaria agenda/billing/GCal do clone com RangeError na leitura.
  const timezone = isValidIanaTimezone(input.timezone) ? input.timezone : DEFAULT_TIMEZONE;

  const slug = `clone_${slugify(displayName).slice(0, 40)}_${shortid(6)}`;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // 1. Copia bot_config da matriz
    const cfgRes = await client.query<{
      provider: string;
      model: string;
      temperature: string;
    }>('SELECT provider, model, temperature FROM bot_config WHERE slot = $1', [matrizSlot]);
    if (!cfgRes.rows[0]) {
      throw new Error(
        `flow-clones: createClone: matriz_slot "${matrizSlot}" não encontrado em bot_config`,
      );
    }
    const { provider, model, temperature } = cfgRes.rows[0];

    await client.query(
      `INSERT INTO bot_config (slot, display_name, provider, model, temperature, updated_at)
       VALUES ($1, $2, $3, $4, $5::numeric, NOW())`,
      [slug, displayName, provider, model, temperature],
    );

    // 2. Copia e personaliza bot_prompt
    const promptRes = await client.query<{ prompt: string }>(
      'SELECT prompt FROM bot_prompt WHERE slot = $1',
      [matrizSlot],
    );
    if (promptRes.rows[0]) {
      const promptPersonalizado = applyPersonalizacao(promptRes.rows[0].prompt, personalizacao);
      await client.query(
        'INSERT INTO bot_prompt (slot, prompt, updated_at) VALUES ($1, $2, NOW())',
        [slug, promptPersonalizado],
      );
    }

    // 3. Copia bot_media (inclui course_slug e is_course_intro para preservar vínculos de curso)
    const mediaRes = await client.query<{
      position: string;
      media_type: string;
      url: string | null;
      caption: string | null;
      context: string | null;
      position_order: number;
      enabled: boolean;
      course_slug: string | null;
      is_course_intro: boolean;
    }>(
      `SELECT position, media_type, url, caption, context, position_order, enabled,
              course_slug, is_course_intro
       FROM bot_media WHERE slot = $1`,
      [matrizSlot],
    );
    for (const m of mediaRes.rows) {
      await client.query(
        `INSERT INTO bot_media
           (slot, position, media_type, url, caption, context, position_order, enabled,
            course_slug, is_course_intro, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,NOW())`,
        [
          slug,
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

    // 3.5. Copia bot_courses (catálogo de cursos da matriz para o clone)
    const coursesRes = await client.query<{
      course_slug: string;
      name: string;
      description: string | null;
      price: number;
      duration: string | null;
      position_order: number;
      enabled: boolean;
    }>(
      `SELECT course_slug, name, description, price, duration, position_order, enabled
       FROM bot_courses WHERE slot = $1`,
      [matrizSlot],
    );
    for (const c of coursesRes.rows) {
      await client.query(
        `INSERT INTO bot_courses
           (slot, course_slug, name, description, price, duration, position_order, enabled, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,NOW(),NOW())
         ON CONFLICT (slot, course_slug) DO NOTHING`,
        [
          slug,
          c.course_slug,
          c.name,
          c.description,
          c.price,
          c.duration,
          c.position_order,
          c.enabled,
        ],
      );
    }

    // 4. Registra em flow_controls
    await client.query(
      `INSERT INTO flow_controls (flow_id, flow_name, source, active, updated_at)
       VALUES ($1, $2, 'clone', TRUE, NOW())
       ON CONFLICT (flow_id) DO UPDATE SET active = TRUE, updated_at = NOW()`,
      [slug, displayName],
    );

    // 5. INSERT flow_clones
    const cloneRes = await client.query<CloneRow>(
      `INSERT INTO flow_clones
         (slot, matriz_slot, display_name, cliente_nome, cliente_telefone, personalizacao, timezone, status, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, 'rascunho', NOW(), NOW())
       RETURNING *`,
      [
        slug,
        matrizSlot,
        displayName,
        clienteNome ?? null,
        clienteTelefone ?? null,
        JSON.stringify(personalizacao),
        timezone,
      ],
    );

    // Dual-write tenant_id (ADR 0018, Fase 2): as satélites acima foram inseridas
    // ANTES de flow_clones existir (o UUID nasce aqui, do DEFAULT gen_random_uuid()).
    // Carimba o tenant_id recém-gerado nelas DENTRO da mesma transação (atômico).
    // Idempotente (guard tenant_id IS NULL). Fail-safe: se ficar NULL, o backfill da
    // migration 045 / próximo write cobre — nunca derruba a criação do clone.
    const newTenantId = (cloneRes.rows[0] as unknown as { tenant_id?: string }).tenant_id ?? null;
    if (newTenantId) {
      for (const tbl of ['bot_config', 'bot_prompt', 'bot_media', 'bot_courses'] as const) {
        await client.query(
          `UPDATE ${tbl} SET tenant_id = $1 WHERE slot = $2 AND tenant_id IS NULL`,
          [newTenantId, slug],
        );
      }
    }

    await client.query('COMMIT');
    invalidateTenantCache(slug);
    return normalizeCloneRow(cloneRes.rows[0]);
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

export async function listClones(): Promise<CloneSummary[]> {
  const r = await query<CloneSummary & { id: string }>(
    `SELECT fc.id, fc.slot, fc.matriz_slot, fc.display_name, fc.cliente_nome,
            fc.cliente_telefone, fc.personalizacao, fc.waha_sessao, fc.status,
            fc.flow_enabled, fc.suspended_reason, fc.suspended_at,
            fc.horarios_funcionamento, fc.servicos, fc.timezone,
            fc.created_at, fc.updated_at,
            bc.display_name AS matriz_display_name
     FROM flow_clones fc
     LEFT JOIN bot_config bc ON bc.slot = fc.matriz_slot
     ORDER BY fc.created_at DESC`,
  );
  return r.rows.map((row) => ({
    ...normalizeCloneRow(row),
    matriz_display_name: (row as unknown as { matriz_display_name: string | null })
      .matriz_display_name,
  }));
}

export async function getClone(id: number): Promise<CloneSummary | null> {
  const r = await query<CloneSummary & { id: string }>(
    `SELECT fc.id, fc.slot, fc.matriz_slot, fc.display_name, fc.cliente_nome,
            fc.cliente_telefone, fc.personalizacao, fc.waha_sessao, fc.status,
            fc.flow_enabled, fc.suspended_reason, fc.suspended_at,
            fc.horarios_funcionamento, fc.servicos, fc.timezone,
            fc.created_at, fc.updated_at,
            bc.display_name AS matriz_display_name
     FROM flow_clones fc
     LEFT JOIN bot_config bc ON bc.slot = fc.matriz_slot
     WHERE fc.id = $1`,
    [id],
  );
  if (!r.rows[0]) return null;
  return {
    ...normalizeCloneRow(r.rows[0]),
    matriz_display_name: (r.rows[0] as unknown as { matriz_display_name: string | null })
      .matriz_display_name,
  };
}

export async function updateClone(
  id: number,
  patch: {
    displayName?: string;
    clienteNome?: string | null;
    clienteTelefone?: string | null;
    // `unknown` (nao `string`): personalizacao carrega valores estruturados alem das strings.
    // Gravado como JSONB as-is; o re-render do prompt so substitui placeholders de valores
    // string (applyPersonalizacao).
    personalizacao?: Record<string, unknown>;
    status?: CloneStatus;
  },
): Promise<CloneRow | null> {
  const sets: string[] = [];
  const vals: unknown[] = [];
  let i = 1;

  if (patch.displayName !== undefined) {
    sets.push(`display_name = $${i++}`);
    vals.push(patch.displayName);
  }
  if (patch.clienteNome !== undefined) {
    sets.push(`cliente_nome = $${i++}`);
    vals.push(patch.clienteNome);
  }
  if (patch.clienteTelefone !== undefined) {
    sets.push(`cliente_telefone = $${i++}`);
    vals.push(patch.clienteTelefone);
  }
  if (patch.personalizacao !== undefined) {
    sets.push(`personalizacao = $${i++}::jsonb`);
    vals.push(JSON.stringify(patch.personalizacao));
  }
  if (patch.status !== undefined) {
    sets.push(`status = $${i++}`);
    vals.push(patch.status);
  }

  if (sets.length === 0) return getClone(id);

  // SCRUM-112 (ADR 0027 / precedente SCRUM-121, PR #491): quando o SAVE do perfil contém a
  // chave `agenda_automatica` explicitamente e ela resolve para TRUE (isAgendaAutomaticaIntent),
  // ligamos `billing_from_agenda_enabled` NA MESMA transação — senão o clone que nasceu
  // atendente (sem billing-da-agenda) e depois ganha agenda fica SEM o gate ligado, e a única
  // forma de religar é um UPDATE manual (o buraco que gerou este card: caso Ingrid).
  //
  // FAIL-CLOSED em 3 níveis, mesmo desenho do gcal/test (SCRUM-121):
  //   1. Só quando `agenda_automatica` está PRESENTE no patch novo (chave explícita — chave
  //      ausente em outros saves do perfil, ex.: só telefone/endereço, nunca aciona o flip).
  //   2. Só na TRANSIÇÃO: intenção NOVA = true (isAgendaAutomaticaIntent) E o valor ANTERIOR
  //      gravado no JSONB era a string 'false' explícita (== estava atendente; ausência já
  //      conta como "já era agenda" por convenção de isAgendaAutomaticaIntent, então não é
  //      transição). Estado ANTERIOR lido via CTE `prev` no MESMO snapshot da statement — no
  //      PG não existe `RETURNING OLD.*`. true→true (já ligado) é no-op.
  //   3. Só se `billing_from_agenda_enabled` ainda NÃO estava ligado (evita re-escrever à toa;
  //      também não desliga nunca — o fix é one-way, só liga).
  // Dinheiro de cliente (regra de negócio): na dúvida, NÃO ligar — nunca fazemos o inverso
  // (nunca desligamos billing_from_agenda_enabled por aqui).
  const agendaAutomaticaPresente =
    patch.personalizacao !== undefined &&
    Object.prototype.hasOwnProperty.call(patch.personalizacao, 'agenda_automatica');
  const novaIntencaoAgenda = agendaAutomaticaPresente
    ? isAgendaAutomaticaIntent((patch.personalizacao as Record<string, unknown>).agenda_automatica)
    : false;

  sets.push('updated_at = NOW()');
  vals.push(id);
  const idParamIdx = i; // índice do $N do id, antes de reservar o índice do flip abaixo.
  i++;
  const flipParamIdx = i++; // $N = novaIntencaoAgenda (só relevante quando agendaAutomaticaPresente)
  vals.push(novaIntencaoAgenda);

  const r = await query<CloneRow & { id: string; billing_agenda_ativado?: boolean }>(
    `WITH prev AS (
       SELECT id,
              (
                $${flipParamIdx} = TRUE
                AND personalizacao->>'agenda_automatica' = 'false'
                AND billing_from_agenda_enabled IS NOT TRUE
              ) AS flip
         FROM flow_clones
        WHERE id = $${idParamIdx}
     )
     UPDATE flow_clones fc
        SET ${sets.join(', ')},
            billing_from_agenda_enabled = CASE
                                             WHEN prev.flip THEN TRUE
                                             ELSE fc.billing_from_agenda_enabled
                                           END
       FROM prev
      WHERE fc.id = prev.id
      RETURNING fc.*, prev.flip AS billing_agenda_ativado`,
    vals,
  );
  if (!r.rows[0]) return null;

  if (r.rows[0].billing_agenda_ativado === true) {
    // Nada silencioso: mudança de estado derivado precisa deixar rastro (lição SCRUM-121).
    console.log(
      `[updateClone] clone ${id} (${r.rows[0].slot}): billing_from_agenda_enabled ATIVADO — transição agenda_automatica 'false' -> true (ADR 0027, SCRUM-112).`,
    );
  }

  const row = normalizeCloneRow(r.rows[0]);

  // ADR 0035 §2.1 (emenda 30/07, decisão do Bruno): bot_prompt é CÓPIA MATERIALIZADA no
  // nascimento (createClone). Nenhum caminho de edição de perfil volta a regenerá-lo a
  // partir da matriz ou do template de atendente — a persona do clone é intocável por save
  // de personalizacao. Este `if` REMOVIA a persona editada à mão sempre que
  // `prompt_custom=false` (o estado default de todo clone), reintroduzindo o clobber que o
  // SCRUM-59/83/122 vinham tapando caso a caso — a causa-raiz era este bloco existir.
  //
  // `buildContextBlock` (packages/integrations/src/scheduling/free-slots.ts:516-531) já
  // injeta [FUNCIONAMENTO]/[SERVICOS E PRECOS]/[HORARIOS DISPONIVEIS] em runtime a cada
  // turno, direto de bot_config — o dado que esta releitura mantinha "atualizado" já chega
  // ao modelo por um caminho separado e autoritativo. `renderPrompt`
  // (apps/api/src/lib/render-prompt.ts:24-37) já lê só bot_prompt do slot, sem fallback pra
  // template — a invariante "runtime não deriva da matriz" já vive no leitor.
  //
  // Consequência ACEITA (Bruno, 30/07, não reabrir): melhoria de template só vale pra
  // cliente novo; clone existente se melhora à mão via regerar-prompt/edição, nunca em
  // massa. `flow_clones.prompt_custom` segue vivo — ainda consumido pelo guard
  // anti-cartão-duplo baked→runtime (isCartaoRuntimeFlipBlocked e afins), fora do escopo
  // desta mudança.
  invalidateCloneCache({ slot: row.slot, sessao: row.waha_sessao ?? undefined });
  return row;
}

export async function setCloneSession(id: number, sessaoName: string): Promise<CloneRow | null> {
  const r = await query<CloneRow & { id: string }>(
    `UPDATE flow_clones
     SET waha_sessao = $1, status = 'aguardando_qr', updated_at = NOW()
     WHERE id = $2 RETURNING *`,
    [sessaoName, id],
  );
  if (!r.rows[0]) return null;
  const row = normalizeCloneRow(r.rows[0]);
  invalidateCloneCache({ sessao: sessaoName, slot: row.slot });
  return row;
}

/**
 * Vincula waha_sessao + status 'aguardando_qr' SOMENTE quando a sessão ainda não
 * foi vinculada (waha_sessao IS NULL). É a guarda de concorrência do reparo
 * on-demand do portal (auditoria 13/07): um signup cujo createWahaSession falhou
 * deixa o clone em 'rascunho' com waha_sessao NULL, e a 1ª tentativa de reconectar
 * cria a sessão e a vincula aqui. Como o WHERE casa só a linha ainda-NULL, duas
 * requests simultâneas NUNCA vinculam duas vezes: a 1ª ganha (rowCount 1), a 2ª
 * casa 0 linhas — sem sobrescrever nem "religar" um clone que já progrediu.
 *
 * DISTINTA de setCloneSession (gestão), que é incondicional: aqui o predicado
 * IS NULL é o núcleo da idempotência. Só toca flow_clones (mesmo escopo do
 * setCloneSession do gestão) — NÃO espelha bot_config.
 *
 * @returns true se ESTA chamada vinculou (linha estava NULL); false se já estava
 *          vinculada (corrida perdida) ou o clone não existe.
 */
export async function bindSessionIfUnset(id: number, sessaoName: string): Promise<boolean> {
  const r = await query<CloneRow & { id: string }>(
    `UPDATE flow_clones
     SET waha_sessao = $1, status = 'aguardando_qr', updated_at = NOW()
     WHERE id = $2 AND waha_sessao IS NULL RETURNING *`,
    [sessaoName, id],
  );
  if (!r.rows[0]) return false;
  const row = normalizeCloneRow(r.rows[0]);
  invalidateCloneCache({ sessao: sessaoName, slot: row.slot });
  return true;
}

export async function setCloneStatus(id: number, status: CloneStatus): Promise<CloneRow | null> {
  const r = await query<CloneRow & { id: string }>(
    'UPDATE flow_clones SET status = $1, updated_at = NOW() WHERE id = $2 RETURNING *',
    [status, id],
  );
  if (!r.rows[0]) return null;
  const row = normalizeCloneRow(r.rows[0]);
  invalidateCloneCache({ slot: row.slot, sessao: row.waha_sessao ?? undefined });
  return row;
}

/**
 * Flipa flow_clones.status -> 'conectado' para o slot, IDEMPOTENTE, só quando ainda
 * não está 'conectado'. Desacoplado da contagem de trial: roda em TODO WORKING.
 *
 * POR QUÊ: antes o flip de status p/ 'conectado' vivia SÓ como efeito colateral dentro
 * de startTrial/consumeAdditionalNumber/markExempt (trial-ledger). Logo, quando o número
 * já tinha sido contado no trial (caminho 'trial-already-counted', reconexão do mesmo
 * número no mesmo clone), o hook de session.status retornava cedo SEM flipar — e o status
 * ficava preso em 'desconectado' mesmo com a sessão WORKING. Isso some do monitor de
 * sessões (alerts.listMonitoredSessions exige status='conectado') e dos alertas de
 * sessão-caída ao dono. Esta função separa a responsabilidade (a) "está conectado" da
 * (b) "contou o trial".
 *
 * SÓ toca `status` e `first_connected_at` — NUNCA trial_status/cliente_telefone (sem regressão
 * no dedup/tracking do trial). Invalida o cache apenas quando muda de fato.
 *
 * `first_connected_at` (migration 062): carimba NOW() na 1ª conexão e NUNCA sobrescreve
 * (COALESCE preserva o valor já gravado). É o sinal durável de "este clone JÁ pareou alguma vez"
 * que o monitor de sessões usa pra distinguir QUEDA REAL (alertar) de PRÉ-SETUP nunca-conectado
 * (FAILED esperado, NÃO alertar) — ver alerts.listMonitoredSessions. Reconexões repetidas mantêm
 * o carimbo original. NOTA: a UPDATE roda também quando o status já é 'conectado' MAS o carimbo
 * está NULL (clone legado conectado ANTES da 062 sem backfill), pra preencher first_connected_at
 * sem depender de backfill; o COALESCE garante no-op nessa coluna após a 1ª vez.
 *
 * @returns true se ESTA chamada flipou o STATUS (estava != 'conectado'); false se já estava
 *          'conectado' (ainda que tenha carimbado first_connected_at agora) ou o slot não é um
 *          clone (no-op idempotente). Contrato histórico preservado: o boolean reflete só a
 *          mudança de status.
 */
export async function markCloneConnectedBySlot(slot: string): Promise<boolean> {
  const r = await query<{ slot: string; status_changed: boolean }>(
    `UPDATE flow_clones
        SET status = 'conectado',
            first_connected_at = COALESCE(first_connected_at, NOW()),
            updated_at = NOW()
      WHERE slot = $1
        AND (status IS DISTINCT FROM 'conectado' OR first_connected_at IS NULL)
      RETURNING slot, (status IS DISTINCT FROM 'conectado') AS status_changed`,
    [slot],
  );
  const row = r.rows[0];
  // Linha afetada -> cache pode estar stale (status e/ou first_connected_at mudaram).
  if (row) invalidateCloneCache({ slot });
  // RETURNING avalia o predicado ANTES do SET (semântica do UPDATE) -> status_changed reflete o
  // estado PRÉVIO, exatamente o que o contrato pede (true só quando o status realmente mudou).
  return row?.status_changed === true;
}

/**
 * Flipa flow_clones.status -> 'parado' para a sessão WAHA parada de propósito (SCRUM-64),
 * IDEMPOTENTE e chaveado por `waha_sessao` (a mesma âncora do sync do painel-admin).
 *
 * POR QUÊ: o webhook `session.status` só flipava o status em WORKING (-> 'conectado'). Quando
 * a sessão era PARADA (POST /stop no WAHA) o evento STOPPED chegava mas o status seguia
 * 'conectado' — o painel/portal MENTIAM ("conectado" com a sessão morta) e o monitor
 * (alerts.listMonitoredSessions) seguia vigiando a sessão como se estivesse no ar, arriscando
 * um alerta de queda FALSO (STOPPED != WORKING no observeWaha).
 *
 * 'parado' é um estado HONESTO e DISTINTO de 'desconectado' (queda inesperada que EXIGE ação):
 * o operador vê "Parada" (foi de propósito) vs "Desconectado" (caiu, reconectar). E como o
 * filtro do monitor é `status IN ('conectado','desconectado')`, 'parado' fica FORA da vigia —
 * zero alerta de queda falso pra sessão parada de propósito, SEM tocar o código do monitor.
 *
 * TRANSICIONA APENAS de 'conectado'/'desconectado' -> 'parado': só as sessões que já estavam
 * no ar (e portanto candidatas ao "conectado mentiroso" e à vigia). NÃO clobbera estados de
 * pré-setup ('rascunho'/'aguardando_qr'/'falhou') — parar uma sessão em onboarding não a torna
 * "parada". Idempotente ('parado' -> 'parado' cai fora do WHERE). SÓ toca `status`.
 *
 * Quando a sessão volta (Bruno dá /start), o WAHA emite WORKING e markCloneConnectedBySlot
 * flipa de volta pra 'conectado' — recuperação normal, sem re-scan.
 *
 * @returns true se ESTA chamada flipou o status (estava conectado/desconectado); false se
 *          nada mudou (já 'parado', pré-setup, ou sessão inexistente) — no-op idempotente.
 */
export async function markCloneStoppedBySession(session: string): Promise<boolean> {
  const r = await query<{ slot: string }>(
    `UPDATE flow_clones
        SET status = 'parado',
            updated_at = NOW()
      WHERE waha_sessao = $1
        AND status IN ('conectado', 'desconectado')
      RETURNING slot`,
    [session],
  );
  const row = r.rows[0];
  if (row) invalidateCloneCache({ slot: row.slot, sessao: session });
  return !!row;
}

/**
 * Fuso (IANA) do clone (migration 068). Retorna 'America/Sao_Paulo' quando o slot
 * não existe ou a coluna vier vazia — nunca `null` (o default do banco garante o
 * carimbo). Consumido pelo GET /portal/perfil pra pré-selecionar o seletor.
 */
export async function getTimezoneBySlot(slot: string): Promise<string> {
  const r = await query<{ timezone: string | null }>(
    'SELECT timezone FROM flow_clones WHERE slot = $1',
    [slot],
  );
  return r.rows[0]?.timezone ?? 'America/Sao_Paulo';
}

/**
 * Grava o fuso (IANA) do clone. O único caller (portal-perfil) JÁ valida com
 * isValidIanaTimezone; a guarda interna abaixo (P3-2, defesa em profundidade) cobre
 * um 2º caller futuro: tz fora da lista IANA => NO-OP, retorna false (nunca escreve
 * lixo que derrubaria agenda/billing/GCal na leitura). Escopado por slot (SEMPRE
 * parametrizado, nunca interpolado) — o slot vem da sessão (withTenant), jamais do
 * input do cliente. Invalida o cache de clone (TTL 60s) pro bot/free-slots pegarem
 * o fuso novo. Retorna false se o tz é inválido OU se o slot não existe.
 */
export async function updateTimezoneBySlot(slot: string, timezone: string): Promise<boolean> {
  // Guard IANA (P3-2): tz inválido não toca a coluna — mantém o fuso atual do clone.
  if (!isValidIanaTimezone(timezone)) return false;
  const r = await query(
    'UPDATE flow_clones SET timezone = $2, updated_at = NOW() WHERE slot = $1',
    [slot, timezone],
  );
  if (r.rowCount === 0) return false;
  invalidateCloneCache({ slot });
  return true;
}

// ---------------------------------------------------------------------------
// Destino dos avisos ao DONO (alert_owner_phone) — editável no portal (SCRUM-59)
//
// O DONO edita no portal o número que recebe os avisos de lead/escalação do modo
// atendente. É a MESMA coluna alert_owner_phone (migration 050) que também é destino
// do aviso de DESCONEXÃO (CLIENT_DISCONNECT) — comportamento COMPARTILHADO e
// INTENCIONAL (é o "número da equipe" do negócio, um só destino p/ os avisos ao dono).
// ---------------------------------------------------------------------------

/** E.164 BR: 55 + DDD(2) + numero(8 ou 9) = 12 ou 13 dígitos. */
const ALERT_OWNER_PHONE_RE = /^55\d{10,11}$/;

/**
 * Lê o alert_owner_phone RAW (só dígitos) do clone — o que o DONO definiu, SEM o fallback
 * pra cliente_telefone do getCloneAlertOwner (que é do caminho de ENVIO). Pro portal exibir
 * o campo editável. Retorna null quando não setado ou o slot não existe. Parametrizado ($1).
 */
export async function getAlertOwnerPhoneBySlot(slot: string): Promise<string | null> {
  const r = await query<{ alert_owner_phone: string | null }>(
    'SELECT alert_owner_phone FROM flow_clones WHERE slot = $1',
    [slot],
  );
  if (r.rows.length === 0) return null;
  const digits = (r.rows[0].alert_owner_phone ?? '').replace(/\D/g, '');
  return digits.length > 0 ? digits : null;
}

/**
 * Grava alert_owner_phone do clone (destino dos avisos ao dono — lead/escalação E
 * desconexão). Guarda defensiva (12-13 dígitos começando com 55) — o caller (portal) JÁ
 * valida; guard aqui = defesa em profundidade: número inválido/vazio = NO-OP (retorna false,
 * NUNCA zera nem grava lixo). Escopado por slot (SEMPRE parametrizado; o slot vem da sessão
 * withTenant, jamais do input). Não invalida cache: alert_owner_phone NÃO está no CloneRow
 * cacheado e getCloneAlertOwner lê direto do banco. false se inválido OU slot inexistente.
 */
export async function updateAlertOwnerPhoneBySlot(slot: string, phone: string): Promise<boolean> {
  const digits = (phone ?? '').replace(/\D/g, '');
  if (!ALERT_OWNER_PHONE_RE.test(digits)) return false;
  const r = await query(
    'UPDATE flow_clones SET alert_owner_phone = $2, updated_at = NOW() WHERE slot = $1',
    [slot, digits],
  );
  return (r.rowCount ?? 0) > 0;
}

/**
 * LIMPA o alert_owner_phone do clone (grava NULL) — SCRUM-62. O DONO optou por não ter um
 * destino dedicado pros avisos de lead/escalação. Com a coluna NULL, getCloneAlertOwner cai
 * no FALLBACK cliente_telefone (= número pareado da PRÓPRIA sessão): o alerta sai como
 * self-send, SEM exigir chamada de rede no caminho do alerta. Grava NULL de fato (não
 * sentinela) — o autofill #329 passa a PULAR clones em modo atendente, então o clear PERSISTE
 * (senão o próximo WORKING re-preencheria com o me.id). Escopado por slot (SEMPRE
 * parametrizado; o slot vem da sessão withTenant, jamais do input — anti-IDOR). Invalida o
 * cache de clone (igual setCloneAlertOwnerPhoneIfEmpty; defensivo — getCloneAlertOwner lê
 * direto do banco). false se o slot não existir.
 */
export async function clearAlertOwnerPhoneBySlot(slot: string): Promise<boolean> {
  const r = await query(
    'UPDATE flow_clones SET alert_owner_phone = NULL, updated_at = NOW() WHERE slot = $1',
    [slot],
  );
  const updated = (r.rowCount ?? 0) > 0;
  if (updated) invalidateCloneCache({ slot });
  return updated;
}

/**
 * Remove o clone e todos os registros dependentes via CASCADE de bot_config.
 * bot_prompt, bot_media e flow_clones são limpos por FK CASCADE.
 * flow_controls usa flow_id = slot — removido explicitamente pois não tem FK.
 * Retorna o waha_sessao para o chamador poder fazer logout se necessário.
 */
export async function deleteClone(
  id: number,
): Promise<{ slot: string; waha_sessao: string | null } | null> {
  const existing = await query<{ slot: string; waha_sessao: string | null }>(
    'SELECT slot, waha_sessao FROM flow_clones WHERE id = $1',
    [id],
  );
  const row = existing.rows[0];
  if (!row) return null;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // flow_controls não tem FK para bot_config — remove manualmente
    await client.query('DELETE FROM flow_controls WHERE flow_id = $1', [row.slot]);
    // bot_config CASCADE limpa bot_prompt, bot_media e flow_clones
    await client.query('DELETE FROM bot_config WHERE slot = $1', [row.slot]);
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }

  invalidateCloneCache({ slot: row.slot, sessao: row.waha_sessao ?? undefined });
  invalidateTenantCache(row.slot);
  return { slot: row.slot, waha_sessao: row.waha_sessao };
}

/**
 * Retorna o clone associado a uma sessão WAHA dedicada.
 * Retorna null se nenhum clone estiver vinculado à sessão; lança apenas em falha de DB.
 * Cache TTL de 60s — hot path do router (chamada por webhook).
 */
export async function getCloneBySession(sessao: string): Promise<CloneRow | null> {
  const cached = bySessionCache.get(sessao);
  if (cached && cached.expiresAt > Date.now()) return cached.value;

  const r = await query<CloneRow & { id: string }>(
    `SELECT id, slot, matriz_slot, display_name, cliente_nome, cliente_telefone,
            personalizacao, waha_sessao, waha_shard_id, status,
            flow_enabled, suspended_reason, suspended_at,
            horarios_funcionamento, servicos, timezone,
            modo_atendente_enabled, billing_from_agenda_enabled,
            created_at, updated_at
     FROM flow_clones WHERE waha_sessao = $1 LIMIT 1`,
    [sessao],
  );
  const value = r.rows[0] ? normalizeCloneRow(r.rows[0]) : null;
  bySessionCache.set(sessao, { value, expiresAt: Date.now() + CACHE_TTL_MS });
  return value;
}

/**
 * Retorna o clone pelo slot (usado pelo dispatcher).
 * Cache TTL de 60s — hot path do router ao resolver clone dinamicamente.
 */
export async function getCloneBySlot(slot: string): Promise<CloneRow | null> {
  const cached = bySlotCache.get(slot);
  if (cached && cached.expiresAt > Date.now()) return cached.value;

  // LEFT JOIN client_billing (1 linha por slot) no MESMO SELECT — alimenta o gate de
  // silencio por cobranca (ADR 0016) sem query extra no hot path. Cache TTL 60s ja cobre
  // (vencimento muda 1x/dia). billing.next_due_date -> 'YYYY-MM-DD' via to_char.
  const r = await query<CloneRow & { id: string }>(
    `SELECT fc.id, fc.slot, fc.matriz_slot, fc.display_name, fc.cliente_nome, fc.cliente_telefone,
            fc.personalizacao, fc.waha_sessao, fc.waha_shard_id, fc.status,
            fc.flow_enabled, fc.suspended_reason, fc.suspended_kind, fc.suspended_at,
            fc.horarios_funcionamento, fc.servicos, fc.timezone,
            fc.modo_atendente_enabled, fc.billing_from_agenda_enabled,
            to_char(cb.next_due_date, 'YYYY-MM-DD') AS next_due_date,
            cb.amount_cents AS billing_amount_cents,
            fc.first_connected_at,
            fc.created_at, fc.updated_at
     FROM flow_clones fc
     LEFT JOIN client_billing cb ON cb.slot = fc.slot
     WHERE fc.slot = $1`,
    [slot],
  );
  const value = r.rows[0] ? normalizeCloneRow(r.rows[0]) : null;
  bySlotCache.set(slot, { value, expiresAt: Date.now() + CACHE_TTL_MS });
  return value;
}

// ---------------------------------------------------------------------------
// Resolução env→coluna dos gates de produtização (ADR 0030 D1, migration 072)
//
// efetivo(feature, slot) = isEnabledFromCsv(slot, envCsv)  OR  flow_clones.<coluna>
//
// Estes helpers async fazem a UNIÃO usando o clone JÁ CARREGADO no hot path (getCloneBySlot,
// cache 60s) — NÃO abrem query nova por-turno na prática. Curto-circuitam no env ANTES de
// qualquer leitura: se o env já cobre o slot (ou é '*'), retornam true sem tocar o banco (que é
// o caso de TODOS os clones vivos hoje -> byte-idêntico + zero leitura extra). Só quando o env
// NÃO cobre é que consultam a coluna (self-service: ligar por-clone sem env).
//
// O slot vem SEMPRE da sessão / requireTenant (isolamento P0) — nunca de input do usuário.
// ---------------------------------------------------------------------------

/** MODO ATENDENTE (SCRUM-59): env MODO_ATENDENTE_SLOTS OR flow_clones.modo_atendente_enabled. */
export async function resolveModoAtendenteEnabledForSlot(
  slot: string,
  envCsv: string | undefined | null,
): Promise<boolean> {
  // Curto-circuito no env (kill-switch global) — evita leitura pra quem já está no CSV/'*'.
  if (resolveModoAtendenteEnabled(slot, envCsv, false)) return true;
  const clone = await getCloneBySlot(slot);
  return resolveModoAtendenteEnabled(slot, envCsv, clone?.modo_atendente_enabled);
}

/** BILLING DA AGENDA (ADR 0027): env ATEND_FROM_AGENDA_SLOTS OR flow_clones.billing_from_agenda_enabled. */
export async function resolveAtendFromAgendaEnabledForSlot(
  slot: string,
  envCsv: string | undefined | null,
): Promise<boolean> {
  if (resolveAtendFromAgendaEnabled(slot, envCsv, false)) return true;
  const clone = await getCloneBySlot(slot);
  return resolveAtendFromAgendaEnabled(slot, envCsv, clone?.billing_from_agenda_enabled);
}

/** Escopo mínimo de um clone com o gate billing-da-agenda ligado (SCRUM-89). */
export interface AtendSyncSlotRow {
  slot: string;
  tenant_id: string | null;
  timezone: string;
  product_type: string;
}

/**
 * Lista os clones onde o billing DERIVADO da agenda está ligado (SCRUM-89 / ADR 0031), pra o
 * reconciler `gcal-atend-sync` iterar. É a MESMA UNIÃO env→coluna do gate do hook (ADR 0030 D1):
 *
 *     billing_from_agenda_enabled = TRUE   (gate por-clone; ex.: Ingrid)
 *   OR slot = ANY(explicitSlots)           (gate por ENV ATEND_FROM_AGENDA_SLOTS; ex.: dragon/cirilo/samuel)
 *
 * `explicitSlots` = CSV da env já parseado pelo caller (worker). Vazio = só a coluna decide. Um
 * '*' NÃO expande aqui (a query não lista o universo inteiro por wildcard — seria custo ilimitado
 * e fora do contrato do reconciler); wildcard global de billing-da-agenda não é caso de hoje e, se
 * um dia for, entra por-clone via coluna. O caller reconfirma o gate por slot antes de agir.
 *
 * Retorna slot + tenant_id + timezone (migration 068) + product_type — o job pula slot sem
 * tenant_id (regra 5) e escolhe o caminho individual/estabelecimento por product_type.
 */
export async function listAtendSyncSlots(explicitSlots: string[]): Promise<AtendSyncSlotRow[]> {
  const r = await query<{
    slot: string;
    tenant_id: string | null;
    timezone: string | null;
    product_type: string | null;
  }>(
    `SELECT slot, tenant_id, timezone, product_type
       FROM flow_clones
      WHERE billing_from_agenda_enabled = TRUE
         OR slot = ANY($1::text[])
      ORDER BY slot ASC`,
    [explicitSlots],
  );
  return r.rows.map((x) => ({
    slot: x.slot,
    tenant_id: x.tenant_id,
    timezone: x.timezone ?? 'America/Sao_Paulo',
    product_type: x.product_type === 'estabelecimento' ? 'estabelecimento' : 'individual',
  }));
}

/**
 * Estado "aguardando conexão da agenda" (ADR 0030 D3, Onda 3): clone que escolheu
 * AGENDA (personalizacao.agenda_automatica != false) mas cuja agenda Google AINDA NÃO
 * foi conectada pelo time (etapa manual, ADR 0024). Derivado de RUNTIME (NÃO é coluna
 * de estado): `agendaIntent && !gcalConfigured`.
 *
 * gcalConfigured por formato:
 *  - individual: flow_clones tem gcal_status='active' + credenciais + calendarId próprios.
 *  - estabelecimento: ao menos 1 colaborador ATIVO com agenda 'active' + calendarId.
 *
 * Usado pelo GET /portal/perfil pra o front mostrar o card "nossa equipe está conectando
 * sua agenda do Google (até 24h úteis)". Escopado por slot (SEMPRE da sessão / withTenant).
 * Best-effort: em erro de query devolve false (o card some — nunca derruba o perfil).
 */
export async function isAwaitingAgendaConnection(slot: string): Promise<boolean> {
  try {
    const r = await query<{
      product_type: string | null;
      personalizacao: unknown;
      gcal_status: string | null;
      has_creds: boolean;
      has_calendar: boolean;
    }>(
      `SELECT product_type, personalizacao, gcal_status,
              (gcal_credentials_json IS NOT NULL) AS has_creds,
              (gcal_calendar_id IS NOT NULL)      AS has_calendar
       FROM flow_clones WHERE slot = $1 LIMIT 1`,
      [slot],
    );
    const row = r.rows[0];
    if (!row) return false;

    const pers = parseJsonbOrNull<Record<string, unknown>>(row.personalizacao) ?? {};
    // Só clones de AGENDA aguardam conexão; atendente (agenda_automatica=false) nunca.
    if (!isAgendaAutomaticaIntent(pers.agenda_automatica)) return false;

    if (row.product_type === 'estabelecimento') {
      const c = await query<{ n: number }>(
        `SELECT COUNT(*)::int AS n FROM clone_colaboradores
         WHERE slot = $1 AND ativo = TRUE AND gcal_status = 'active' AND gcal_calendar_id IS NOT NULL`,
        [slot],
      );
      const configured = Number(c.rows[0]?.n ?? 0) > 0;
      return !configured;
    }

    // individual: mesma condição que getGcalForSlot exige pra devolver um client.
    const configured = row.gcal_status === 'active' && row.has_creds && row.has_calendar;
    return !configured;
  } catch {
    return false;
  }
}

/**
 * "Agenda configurada?" (SCRUM-74) — o clone tem um Google Calendar UTILIZÁVEL, conectado
 * pelo TIME via painel gestão (ADR 0024). É o MESMO critério (`gcalConfigured`) que
 * getGcalForSlot/getGcalsForSlot exigem pra devolver um client — só o inverso do que
 * isAwaitingAgendaConnection considera "aguardando" — derivado do MESMO jeito, sem inventar:
 *  - individual: flow_clones tem gcal_status='active' + credenciais + calendarId próprios.
 *  - estabelecimento: ≥1 colaborador ATIVO com agenda 'active' + calendarId (a credencial é a
 *    Service Account do CLONE, 1 por cliente — ADR 0024 §2).
 *
 * Usado pelo PUT /portal/perfil pra BARRAR a auto-religação do agendamento automático
 * (agenda_automatica false→true) quando a agenda ainda não foi configurada: habilitar é
 * comercial (preço novo) + o time conecta a agenda no gestão, NUNCA self-service pelo portal.
 *
 * Escopado por slot (SEMPRE da sessão / withTenant — nunca de input). NÃO decifra a credencial
 * (só checa presença): é pergunta de configuração, não de uso. Best-effort: em erro de query
 * devolve false (fail-closed — na dúvida, NÃO religa o agendamento).
 */
export async function isAgendaConfiguradaBySlot(slot: string): Promise<boolean> {
  try {
    const r = await query<{
      product_type: string | null;
      gcal_status: string | null;
      has_creds: boolean;
      has_calendar: boolean;
    }>(
      `SELECT product_type, gcal_status,
              (gcal_credentials_json IS NOT NULL) AS has_creds,
              (gcal_calendar_id IS NOT NULL)      AS has_calendar
       FROM flow_clones WHERE slot = $1 LIMIT 1`,
      [slot],
    );
    const row = r.rows[0];
    if (!row) return false;

    if (row.product_type === 'estabelecimento') {
      // estabelecimento: ≥1 colaborador ativo com agenda 'active' + calendarId (getGcalsForSlot).
      const c = await query<{ n: number }>(
        `SELECT COUNT(*)::int AS n FROM clone_colaboradores
         WHERE slot = $1 AND ativo = TRUE AND gcal_status = 'active' AND gcal_calendar_id IS NOT NULL`,
        [slot],
      );
      return Number(c.rows[0]?.n ?? 0) > 0;
    }

    // individual: mesma condição que getGcalForSlot exige pra devolver um client.
    return row.gcal_status === 'active' && row.has_creds && row.has_calendar;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Credencial Google do CLIENTE (login do Google Agenda no cel/PC) — migration 061
//
// É a credencial de LOGIN HUMANO que a empresa cria pro cliente entrar no app do
// Google Agenda — NÃO é a Service Account do bot (gcal_*, ADR 0024, escopo distinto).
//
// FORA do getCloneBySlot/CloneRow DE PROPÓSITO: a senha cifrada NUNCA pode entrar no
// cache de clone (TTL 60s, hot path do webhook) nem vazar pra outras rotas que leem
// CloneRow. Esta leitura é dedicada, SEM cache, parametrizada por slot, e só a usa o
// endpoint que entrega a credencial ao dono (GET /portal/google-conta), que decifra a
// senha server-side. Não seleciona NENHUMA coluna gcal_*.
// ---------------------------------------------------------------------------

export interface GoogleAccountRow {
  /** E-mail da conta Google do cliente (texto claro; identificador de login). null = não configurado. */
  google_account_email: string | null;
  /**
   * Senha CIFRADA (enc:v2:iv:tag:ciphertext). NUNCA decifrada aqui — a camada de cima
   * (rota) chama decryptSecret de @startap/core no ponto de uso. null = não configurada.
   */
  google_account_password_enc: string | null;
}

/**
 * Lê a credencial Google do cliente (e-mail + senha CIFRADA) de um slot. SEM cache (a
 * senha cifrada nunca encosta no cache de clone). Parametrizado por slot ($1). Devolve a
 * senha AINDA CIFRADA — quem chama decifra com decryptSecret no ponto de uso (e a senha
 * NUNCA pode ser logada). Retorna null se o slot não existe.
 */
export async function getGoogleAccountBySlot(slot: string): Promise<GoogleAccountRow | null> {
  const r = await query<{
    google_account_email: string | null;
    google_account_password_enc: string | null;
  }>(
    `SELECT google_account_email, google_account_password_enc
       FROM flow_clones WHERE slot = $1 LIMIT 1`,
    [slot],
  );
  const row = r.rows[0];
  if (!row) return null;
  return {
    google_account_email: row.google_account_email ?? null,
    google_account_password_enc: row.google_account_password_enc ?? null,
  };
}

// ---------------------------------------------------------------------------
// Cancelamento escalado — destino do alerta pro DONO do clone (Missão 023 W5)
// ---------------------------------------------------------------------------

export interface CloneAlertOwner {
  /** Telefone E.164 (só dígitos) do dono que RECEBE o alerta. null = sem destino. */
  phone: string | null;
  /** Toggle por-clone (coluna alert_owner_enabled, default TRUE). */
  enabled: boolean;
  /** Nome amigável do clone p/ a mensagem do alerta (display_name). */
  displayName: string;
}

/**
 * Lê o destino do alerta de cancelamento de um clone (migration 050).
 * Sem hardcode de número. Fonte do telefone, em ordem de precedência:
 *   1. flow_clones.alert_owner_phone (coluna dedicada, backfill da migration 050);
 *   2. FALLBACK -> flow_clones.cliente_telefone, quando alert_owner_phone for NULL/vazio.
 *
 * Por que o fallback: o provisioning de clone NOVO NÃO grava alert_owner_phone (a 050 só
 * fez backfill dos EXISTENTES). Sem o fallback, todo clone novo nasceria sem destino e o
 * escalonamento de cancelamento ficaria mudo até alguém preencher a coluna na mão. Com o
 * fallback, TODO clone (novo ou velho) tem destino sem depender de backfill/provisioning.
 *
 * Retorna null se o slot não for um clone (matriz/infra não têm dono).
 * `enabled` reflete o toggle por-clone (alert_owner_enabled); o gate macro (flag de ambiente
 * CANCELAMENTO_ESCALADO_ENABLED) é responsabilidade do chamador (apps/api).
 * Normaliza o telefone p/ dígitos e exige >=8 (senão phone=null → não escala).
 */
export async function getCloneAlertOwner(slot: string): Promise<CloneAlertOwner | null> {
  const r = await query<{
    alert_owner_phone: string | null;
    cliente_telefone: string | null;
    alert_owner_enabled: boolean | null;
    display_name: string;
  }>(
    `SELECT alert_owner_phone, cliente_telefone, alert_owner_enabled, display_name
       FROM flow_clones WHERE slot = $1 LIMIT 1`,
    [slot],
  );
  const row = r.rows[0];
  if (!row) return null;
  // Precedência: alert_owner_phone -> cliente_telefone (fallback p/ clones sem backfill).
  const ownerDigits = (row.alert_owner_phone ?? '').replace(/\D/g, '');
  const fallbackDigits = (row.cliente_telefone ?? '').replace(/\D/g, '');
  const digits = ownerDigits.length >= 8 ? ownerDigits : fallbackDigits;
  return {
    phone: digits.length >= 8 ? digits : null,
    enabled: row.alert_owner_enabled !== false,
    displayName: row.display_name,
  };
}

// ---------------------------------------------------------------------------
// Auto-aviso de DESCONEXÃO ao próprio cliente (B2B) — destino + nome do negócio
//
// Reusa o MESMO contrato/precedência de getCloneAlertOwner (alert_owner_phone ->
// cliente_telefone; toggle alert_owner_enabled), mas adiciona o nome do NEGÓCIO
// (personalizacao->>'nome_negocio') pra montar a copy "o WhatsApp da {NOME} caiu".
// SEPARADO de getCloneAlertOwner pra não inchar o caminho de cancelamento (W5) com
// uma coluna jsonb a mais. A flag macro (CLIENT_DISCONNECT_ALERT_ENABLED) é do chamador.
// ---------------------------------------------------------------------------

export interface CloneDisconnectAlertTarget {
  /** Telefone E.164 (só dígitos) do dono que RECEBE o aviso. null = sem destino -> não avisa. */
  phone: string | null;
  /** Toggle por-clone (alert_owner_enabled, default TRUE). false = opt-out -> não avisa. */
  enabled: boolean;
  /**
   * Nome do negócio p/ a mensagem (personalizacao->>'nome_negocio'). null/vazio -> o chamador
   * cai no fallback genérico ("seu atendimento"). NUNCA o display_name interno aqui (esse é nosso
   * rótulo de gestão; o cliente reconhece o nome do negócio dele).
   */
  nomeNegocio: string | null;
}

/**
 * Lê o destino do AUTO-AVISO DE DESCONEXÃO de um clone (mesma fonte de telefone do cancelamento
 * escalado — migration 050 — + nome do negócio da personalizacao). Retorna null se o slot não
 * for um clone. `enabled` reflete o opt-in por-clone; o gate macro de ambiente é do chamador.
 * Telefone normalizado p/ dígitos, exige >=8 (senão phone=null -> não avisa).
 */
export async function getCloneDisconnectAlertTarget(
  slot: string,
): Promise<CloneDisconnectAlertTarget | null> {
  const r = await query<{
    alert_owner_phone: string | null;
    cliente_telefone: string | null;
    alert_owner_enabled: boolean | null;
    nome_negocio: string | null;
  }>(
    `SELECT alert_owner_phone, cliente_telefone, alert_owner_enabled,
            NULLIF(TRIM(personalizacao->>'nome_negocio'), '') AS nome_negocio
       FROM flow_clones WHERE slot = $1 LIMIT 1`,
    [slot],
  );
  const row = r.rows[0];
  if (!row) return null;
  // Mesma precedência do cancelamento escalado: alert_owner_phone -> cliente_telefone.
  const ownerDigits = (row.alert_owner_phone ?? '').replace(/\D/g, '');
  const fallbackDigits = (row.cliente_telefone ?? '').replace(/\D/g, '');
  const digits = ownerDigits.length >= 8 ? ownerDigits : fallbackDigits;
  return {
    phone: digits.length >= 8 ? digits : null,
    enabled: row.alert_owner_enabled !== false,
    nomeNegocio: row.nome_negocio ?? null,
  };
}

/**
 * Preenche flow_clones.alert_owner_phone com o número da PRÓPRIA sessão WhatsApp
 * conectada (me.id), SOMENTE SE a coluna estiver vazia/NULL. Idempotente e seguro
 * para rodar em todo evento WORKING (Missão pós-023: clones novos nasciam sem
 * destino de alerta; o cancelamento escalado se perdia — não havia nada que
 * gravasse o telefone do dono no momento da conexão).
 *
 * REGRAS:
 *  - NUNCA sobrescreve valor já preenchido (respeita override manual / backfill 050).
 *    O guard `alert_owner_phone IS NULL OR alert_owner_phone = ''` garante isso no
 *    próprio UPDATE (não em read-then-write — sem TOCTOU).
 *  - Escopado por `slot` (âncora do tenant; flow_clones é a tabela-âncora — não há
 *    risco de cross-tenant pois 1 slot = 1 clone).
 *  - O telefone JÁ vem normalizado (dígitos puros) do chamador. Mesmo assim, defensa
 *    em profundidade: rejeita < 8 dígitos (não grava lixo).
 *  - SQL parametrizado com placeholders DISTINTOS ($1 phone, $2 slot) — nunca reusa
 *    o mesmo placeholder (lição ADR 0018 F2 / #309: "inconsistent types deduced for
 *    parameter $1").
 *
 * @returns true se ESTE chamada gravou o número (estava vazio); false se já havia
 *          valor (no-op) ou o slot não é um clone.
 */
export async function setCloneAlertOwnerPhoneIfEmpty(
  slot: string,
  phoneOrMeId: string,
): Promise<boolean> {
  // meIdToDigits corta sufixo de device (":12") e domínio ("@c.us"/"@s.whatsapp.net")
  // ANTES de limpar não-dígitos — replace(/\D/g) sozinho deixaria o "12" do device
  // colado no número. Preserva o 9 (NÃO usa canonicalE164).
  const digits = meIdToDigits(phoneOrMeId ?? '');
  if (!digits || digits.length < 8) return false; // não grava número inválido/curto

  const r = await query<{ slot: string }>(
    `UPDATE flow_clones
        SET alert_owner_phone = $1, updated_at = NOW()
      WHERE slot = $2
        AND (alert_owner_phone IS NULL OR alert_owner_phone = '')
      RETURNING slot`,
    [digits, slot],
  );
  const updated = (r.rowCount ?? 0) > 0;
  if (updated) invalidateCloneCache({ slot });
  return updated;
}

// ---------------------------------------------------------------------------
// Suspender / reativar fluxo (billing, inadimplência, férias)
// ---------------------------------------------------------------------------

export interface SuspensionLogEntry {
  id: number;
  slot: string;
  action: 'suspend' | 'resume';
  reason: string | null;
  actor: string;
  created_at: Date;
}

/**
 * Suspende o fluxo de um clone: flow_enabled=false, WAHA permanece conectado.
 * Registra em flow_suspension_log para auditoria.
 * Idempotente: se já suspenso, apenas atualiza reason/actor no log.
 */
export async function suspendClone(opts: {
  slot: string;
  reason?: string | null;
  actor: string;
}): Promise<CloneRow | null> {
  const { slot, reason, actor } = opts;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const r = await client.query<CloneRow & { id: string }>(
      `UPDATE flow_clones
       SET flow_enabled = false,
           suspended_reason = $1,
           suspended_at = NOW(),
           updated_at = NOW()
       WHERE slot = $2
       RETURNING *`,
      [reason ?? null, slot],
    );
    if (!r.rows[0]) {
      await client.query('ROLLBACK');
      return null;
    }

    await client.query(
      `INSERT INTO flow_suspension_log (slot, action, reason, actor)
       VALUES ($1, 'suspend', $2, $3)`,
      [slot, reason ?? null, actor],
    );

    await client.query('COMMIT');
    const row = normalizeCloneRow(r.rows[0]);
    invalidateCloneCache({ slot, sessao: row.waha_sessao ?? undefined });
    return row;
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

/**
 * Reativa o fluxo de um clone: flow_enabled=true, limpa suspended_reason/at.
 * Registra em flow_suspension_log para auditoria.
 */
export async function resumeClone(opts: {
  slot: string;
  actor: string;
}): Promise<CloneRow | null> {
  const { slot, actor } = opts;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const r = await client.query<CloneRow & { id: string }>(
      `UPDATE flow_clones
       SET flow_enabled = true,
           suspended_reason = NULL,
           suspended_at = NULL,
           updated_at = NOW()
       WHERE slot = $1
       RETURNING *`,
      [slot],
    );
    if (!r.rows[0]) {
      await client.query('ROLLBACK');
      return null;
    }

    await client.query(
      `INSERT INTO flow_suspension_log (slot, action, reason, actor)
       VALUES ($1, 'resume', NULL, $2)`,
      [slot, actor],
    );

    await client.query('COMMIT');
    const row = normalizeCloneRow(r.rows[0]);
    invalidateCloneCache({ slot, sessao: row.waha_sessao ?? undefined });
    return row;
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

// ---------------------------------------------------------------------------
// Pausa/retomada SELF-SERVICE pelo DONO no portal (suspended_kind='owner_request')
//
// SEPARADO dos helpers legados suspendClone/resumeClone (que NÃO setam/filtram por
// suspended_kind). O contrato é estrito: o cliente só mexe na PRÓPRIA pausa.
//   - pauseBotByOwner: só pausa se HOJE flow_enabled=true. Se já suspenso pela Startap
//     (billing/manual_other/abuse), NÃO sobrescreve o kind — devolve {changed:false}.
//   - resumeBotByOwner: só destrava se suspended_kind='owner_request'. Suspensão da
//     Startap não casa o WHERE -> {changed:false} -> o caller responde 409.
// NUNCA usa suspended_kind='billing' aqui (senão o PIX reativaria a pausa do dono).
// invalidateCloneCache é IMPRESCINDÍVEL (cache TTL 60s; senão a pausa demora a valer).
// ---------------------------------------------------------------------------

/**
 * kind canônico da pausa self-service. NUNCA 'billing' (anti auto-resume do PIX).
 * Reexportado de @startap/core/silence-gate (fonte ÚNICA, achado do security 31/07) — @startap/db
 * já depende de @startap/core, então reexportar aqui elimina o literal duplicado que um teste
 * "anti-divergência" comparando 2 constantes independentes não conseguiria pegar de verdade.
 */
export { OWNER_PAUSE_KIND };
const OWNER_PAUSE_REASON = 'Pausado pelo cliente no portal';

export interface OwnerPauseResult {
  /** true se ESTA chamada mudou o estado (pausou/retomou de fato). */
  changed: boolean;
  /** estado de flow_enabled APÓS a operação (refletido para o caller responder). */
  flow_enabled: boolean;
}

/**
 * Pausa o bot a pedido do DONO (self-service no portal): flow_enabled=false,
 * suspended_kind='owner_request'. WAHA permanece conectada.
 *
 * Idempotência/segurança (UPDATE condicional, sem read-then-write):
 *  - WHERE flow_enabled = TRUE -> só pausa quem está ATIVO. Se já suspenso (por
 *    qualquer kind), 0 linhas -> NÃO sobrescreve o kind da Startap (changed:false).
 *  - Idempotente em retry: 2ª chamada não casa o WHERE (já está false) -> changed:false,
 *    mas devolve flow_enabled=false (estado correto). SEM efeito colateral duplicado
 *    (não loga 2 vezes; o INSERT no log só roda quando rowCount>0).
 *  - slot é a âncora do tenant (vem da sessão pelo caller — anti-IDOR).
 */
export async function pauseBotByOwner(slot: string, actor: string): Promise<OwnerPauseResult> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const r = await client.query<{ slot: string; waha_sessao: string | null }>(
      `UPDATE flow_clones
          SET flow_enabled     = FALSE,
              suspended_kind   = $2,
              suspended_reason = $3,
              suspended_at     = NOW(),
              updated_at       = NOW()
        WHERE slot = $1
          AND flow_enabled = TRUE
        RETURNING slot, waha_sessao`,
      [slot, OWNER_PAUSE_KIND, OWNER_PAUSE_REASON],
    );

    const changed = (r.rowCount ?? 0) > 0;
    let sessao: string | null = null;
    if (changed) {
      sessao = r.rows[0].waha_sessao;
      await client.query(
        `INSERT INTO flow_suspension_log (slot, action, reason, actor)
         VALUES ($1, 'suspend', $2, $3)`,
        [slot, OWNER_PAUSE_REASON, actor],
      );
    }

    await client.query('COMMIT');
    if (changed) invalidateCloneCache({ slot, sessao: sessao ?? undefined });
    // flow_enabled APÓS a operação é sempre false (pausou agora ou já estava pausado).
    return { changed, flow_enabled: false };
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

/**
 * Retoma o bot a pedido do DONO: SÓ destrava a PRÓPRIA pausa (owner_request).
 *
 * UPDATE condicional WHERE flow_enabled=FALSE AND suspended_kind='owner_request':
 *  - Suspensão da Startap (billing/manual_other/abuse) NÃO casa -> 0 linhas ->
 *    changed:false -> o caller responde 409 suspensao_startap (o cliente NÃO levanta).
 *  - Já ativo -> 0 linhas -> changed:false; o caller trata como "nada a fazer" (200).
 *  - Idempotente em retry (2ª chamada não casa após reativar).
 * Limpa kind/reason/at ao reativar. Loga 'resume' apenas quando rowCount>0.
 */
export async function resumeBotByOwner(slot: string, actor: string): Promise<OwnerPauseResult> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const r = await client.query<{ slot: string; waha_sessao: string | null }>(
      `UPDATE flow_clones
          SET flow_enabled     = TRUE,
              suspended_kind   = NULL,
              suspended_reason = NULL,
              suspended_at     = NULL,
              updated_at       = NOW()
        WHERE slot = $1
          AND flow_enabled = FALSE
          AND suspended_kind = $2
        RETURNING slot, waha_sessao`,
      [slot, OWNER_PAUSE_KIND],
    );

    const changed = (r.rowCount ?? 0) > 0;
    let sessao: string | null = null;
    if (changed) {
      sessao = r.rows[0].waha_sessao;
      await client.query(
        `INSERT INTO flow_suspension_log (slot, action, reason, actor)
         VALUES ($1, 'resume', NULL, $2)`,
        [slot, actor],
      );
    }

    await client.query('COMMIT');
    if (changed) invalidateCloneCache({ slot, sessao: sessao ?? undefined });
    return { changed, flow_enabled: changed };
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

// ---------------------------------------------------------------------------
// Normalização de tipos
// ---------------------------------------------------------------------------

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

function normalizeCloneRow(row: CloneRow & { id: string | number }): CloneRow {
  return {
    ...row,
    id: Number(row.id),
    // pg retorna JSONB já parseado, mas garantimos o tipo
    personalizacao:
      typeof row.personalizacao === 'string'
        ? (JSON.parse(row.personalizacao) as Record<string, string>)
        : row.personalizacao,
    // flow_enabled vem como boolean do pg; fallback true para rows sem a coluna
    // (antes da migration 038 ser aplicada em dev)
    flow_enabled: (row as unknown as { flow_enabled?: unknown }).flow_enabled !== false,
    // waha_shard_id: pg devolve int -> number. Fallback 0 (shard atual) p/ rows que
    // não selecionam a coluna ou rodam antes da migration 047 em dev (ADR 0020).
    waha_shard_id: Number((row as unknown as { waha_shard_id?: unknown }).waha_shard_id ?? 0),
    suspended_reason:
      ((row as unknown as { suspended_reason?: unknown }).suspended_reason as string | null) ??
      null,
    // suspended_kind: só vem de SELECTs que pedem a coluna (getCloneBySlot). Rows de
    // outras origens (getCloneBySession, RETURNING * de queries legadas) -> null.
    suspended_kind:
      ((row as unknown as { suspended_kind?: unknown }).suspended_kind as string | null) ?? null,
    suspended_at:
      ((row as unknown as { suspended_at?: unknown }).suspended_at as Date | null) ?? null,
    horarios_funcionamento: parseJsonbOrNull<HorariosFuncionamento>(row.horarios_funcionamento),
    servicos: parseJsonbOrNull<ServicoConfig[]>(row.servicos),
    // timezone (migration 068): só vem de SELECTs que pedem a coluna. Rows de outras
    // origens (RETURNING * legado) ou antes da migration em dev -> 'America/Sao_Paulo'
    // (default chumbado = byte-idêntico ao comportamento de hoje).
    timezone:
      ((row as unknown as { timezone?: unknown }).timezone as string | null) ?? 'America/Sao_Paulo',
    // prompt_custom (migration 070): só vem de SELECTs que pedem a coluna (updateClone usa
    // RETURNING *). Rows de outras origens ou antes da migration em dev -> false (render default
    // = byte-idêntico ao comportamento de hoje). Só === true protege do re-render.
    prompt_custom: (row as unknown as { prompt_custom?: unknown }).prompt_custom === true,
    // Gates de produtização por-clone (migration 072): só vêm de SELECTs que pedem a coluna (hot
    // path getCloneBySession/BySlot). Rows de outras origens ou antes da migration em dev -> false
    // (= byte-idêntico: a UNIÃO com o env não muda nada). Só === true liga a coluna.
    modo_atendente_enabled:
      (row as unknown as { modo_atendente_enabled?: unknown }).modo_atendente_enabled === true,
    billing_from_agenda_enabled:
      (row as unknown as { billing_from_agenda_enabled?: unknown }).billing_from_agenda_enabled ===
      true,
    // Campos do LEFT JOIN client_billing (so vem de getCloneBySlot). Rows de outras
    // origens (getCloneBySession, RETURNING *) nao tem -> null. pg ja devolve
    // amount_cents como number; o ?? null cobre o caso da coluna ausente.
    next_due_date:
      ((row as unknown as { next_due_date?: unknown }).next_due_date as string | null) ?? null,
    billing_amount_cents:
      ((row as unknown as { billing_amount_cents?: unknown }).billing_amount_cents as
        | number
        | null) ?? null,
    // first_connected_at (migration 062): só vem de SELECTs que pedem a coluna
    // (getCloneBySlot). Demais origens (getCloneBySession, RETURNING *) -> null (byte-
    // idêntico: quem não projeta a coluna segue sem o campo). pg devolve Date | null.
    first_connected_at:
      ((row as unknown as { first_connected_at?: unknown }).first_connected_at as Date | null) ??
      null,
  };
}
