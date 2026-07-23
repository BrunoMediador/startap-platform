/**
 * clone-colaboradores — leitura do tipo de conta e dos colaboradores de um
 * estabelecimento (ADR 0023/0024, Fase A).
 *
 * Este módulo só é exercitado quando o caminho ESTABELECIMENTO está ligado
 * (flag ESTABELECIMENTO_ENABLED + product_type='estabelecimento'). O caminho
 * individual nunca importa daqui. A resolução de calendarId por colaborador
 * (com client GCal e isolamento de cache por tenant) vive no resolvedor
 * `getGcalsForSlot` em @startap/integrations — aqui ficam só leituras de metadado
 * que o caller (apps/api) precisa pra decidir o caminho e validar.
 */
import { resolveNomeNegocio } from '@startap/core';
import type pg from 'pg';
import { pool, query } from '../client.js';

/** Tipo de conta de um clone. Default no banco é 'individual' (migration 052). */
export type ProductType = 'individual' | 'estabelecimento';

/**
 * Erro de regra de negócio (seat_cap cheio, homônimo, serviço fora do catálogo).
 * O caller mapeia: `unknown_servico` -> 400 (input inválido do operador/dono);
 * os demais -> 409 (conflito de estado/regra). Ver sendRuleError no portal e o
 * handler do gestão (server.js).
 */
export class ColaboradorRuleError extends Error {
  readonly code: 'seat_cap_full' | 'duplicate_name' | 'not_estabelecimento' | 'unknown_servico';
  constructor(code: ColaboradorRuleError['code'], message: string) {
    super(message);
    this.name = 'ColaboradorRuleError';
    this.code = code;
  }
}

/** Linha de colaborador devolvida ao caller (gestão e portal compartilham). */
export interface ColaboradorRow {
  id: number;
  nome: string;
  gcal_calendar_id: string | null;
  gcal_status: string;
  servicos: string[];
  ativo: boolean;
  ordem: number;
  /**
   * % de comissão do colaborador sobre o BRUTO (0–100, 2 casas; migration 058).
   * O pg devolve NUMERIC como string — este campo é SEMPRE normalizado pra number
   * (via mapColaboradorRow) antes de sair daqui, pra API entregar number no JSON.
   */
  comissao_pct: number;
  created_at: string;
  updated_at: string;
}

/**
 * Linha crua do banco. id é BIGINT e o driver pg o devolve como STRING (não number);
 * comissao_pct (NUMERIC) idem. Ambos são normalizados pra number em mapColaboradorRow.
 */
interface ColaboradorRowRaw extends Omit<ColaboradorRow, 'id' | 'comissao_pct'> {
  id: string | number;
  comissao_pct: string | number | null;
}

/**
 * Normaliza a linha crua do pg pro contrato público: o pg devolve BIGINT (id) e NUMERIC
 * (comissao_pct) como string. id vira number (o contrato ColaboradorRow.id é number — sem
 * isso, consumidores que comparam id com `===` quebram em runtime, ex.: gerar-senha do
 * portal) e comissao_pct vira number (NULL/indef -> 0, fallback seguro). Única porta de
 * saída das funções que retornam ColaboradorRow.
 */
function mapColaboradorRow(row: ColaboradorRowRaw): ColaboradorRow {
  return {
    ...row,
    id: Number(row.id),
    comissao_pct: row.comissao_pct == null ? 0 : Number(row.comissao_pct),
  };
}

/** Escopo do estabelecimento (product_type + teto de vagas) lido do clone. */
export interface CloneScope {
  product_type: ProductType;
  /** NULL = sem teto contratual de vagas. */
  seat_cap: number | null;
  /** tenant_id do clone (carimbado na criação de colaborador). NULL = dado inconsistente. */
  tenant_id: string | null;
  /**
   * Fuso (IANA) do relógio da barbearia (migration 068). DEFAULT 'America/Sao_Paulo'
   * — clone que não declarou outro fuso é byte-idêntico ao comportamento de hoje.
   */
  timezone: string;
}

const SELECT_COLAB_COLS =
  'id, nome, gcal_calendar_id, gcal_status, servicos, ativo, ordem, comissao_pct, created_at, updated_at';

/**
 * Normaliza o array de serviços de um colaborador: trim + dedup case-insensitive,
 * descarta vazios, limita cada item a 80 chars e o array a 50 itens. ESPELHA o
 * `_pkgNormalizeServicos` do painel-admin (server.js) — fonte de verdade única
 * para os dois painéis. Entrada não-array vira [].
 */
export function normalizeColaboradorServicos(arr: unknown): string[] {
  if (!Array.isArray(arr)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of arr) {
    const s = String(raw ?? '')
      .trim()
      .slice(0, 80);
    if (!s) continue;
    const key = s.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(s);
    if (out.length >= 50) break;
  }
  return out;
}

/**
 * Chave de comparação de nome de serviço: trim + lowercase. Usada pra casar o
 * serviço vinculado ao colaborador contra o catálogo do clone tolerando
 * diferença de caixa/espaços (ex.: " Corte " == "corte"). NÃO normaliza acento
 * de propósito: o catálogo é a fonte de verdade e o operador escolhe de uma
 * lista; "Cirúrgia" != "cirurgia" só importaria se ambos existissem no catálogo.
 */
function servicoKey(s: string): string {
  return s.trim().toLowerCase();
}

/**
 * Lê o conjunto de nomes de serviço do CATÁLOGO do clone (flow_clones.servicos,
 * array de { nome, preco_cents, duracao_min }) como chaves normalizadas
 * (trim+lowercase). Usa o `client` da transação em curso pra ficar consistente
 * com o INSERT/UPDATE e escopado pelo MESMO slot (isolamento, regra de ouro 5).
 * Catálogo vazio/ausente -> Set vazio (nenhum serviço é vinculável; o caller
 * rejeita qualquer item — coerente com a UI "cadastre serviços primeiro").
 */
async function getCatalogoKeys(client: pg.PoolClient, slot: string): Promise<Set<string>> {
  const r = await client.query<{ servicos: unknown }>(
    'SELECT servicos FROM flow_clones WHERE slot = $1 LIMIT 1',
    [slot],
  );
  const raw = r.rows[0]?.servicos;
  const keys = new Set<string>();
  if (!Array.isArray(raw)) return keys;
  for (const item of raw) {
    const nome =
      item && typeof item === 'object' && 'nome' in item
        ? String((item as { nome: unknown }).nome ?? '')
        : typeof item === 'string'
          ? item
          : '';
    const key = servicoKey(nome);
    if (key) keys.add(key);
  }
  return keys;
}

/**
 * Valida que TODO serviço vinculado ao colaborador existe no catálogo do clone
 * (por nome, case/trim-insensitive). Lança ColaboradorRuleError('unknown_servico')
 * no primeiro que não existir — esse é o coração do fix: sem isso, um free-text
 * ("cirurgia") era aceito direto no banco. Lista vazia passa de propósito
 * (colaborador sem serviço = fallback pra TODOS, comportamento legítimo atual).
 * Roda DENTRO da transação (mesmo client/slot) pra ser atômico com o write.
 */
async function assertServicosNoCatalogo(
  client: pg.PoolClient,
  slot: string,
  servicos: string[],
): Promise<void> {
  if (servicos.length === 0) return;
  const catalogo = await getCatalogoKeys(client, slot);
  for (const s of servicos) {
    if (!catalogo.has(servicoKey(s))) {
      throw new ColaboradorRuleError(
        'unknown_servico',
        `o serviço "${s}" não existe no catálogo deste cliente — cadastre na aba Serviços antes de vinculá-lo ao colaborador`,
      );
    }
  }
}

/**
 * Lê { product_type, seat_cap, tenant_id } de um slot. Fonte do gating e do
 * enforcement de seat_cap. Mesma leitura do `_resolveCloneScope` do gestão, mas
 * por SLOT (o portal resolve o slot da sessão; nunca recebe cloneId/slot de input).
 * Sem linha em flow_clones (matriz/bot interno) -> 'individual'/null (fallback seguro).
 */
export async function getScopeBySlot(slot: string): Promise<CloneScope> {
  try {
    const r = await query<{
      product_type: string | null;
      seat_cap: number | null;
      tenant_id: string | null;
      timezone: string | null;
    }>(
      'SELECT product_type, seat_cap, tenant_id, timezone FROM flow_clones WHERE slot = $1 LIMIT 1',
      [slot],
    );
    const row = r.rows[0];
    return {
      product_type: row?.product_type === 'estabelecimento' ? 'estabelecimento' : 'individual',
      seat_cap: row?.seat_cap == null ? null : Number(row.seat_cap),
      tenant_id: row?.tenant_id ?? null,
      timezone: row?.timezone ?? 'America/Sao_Paulo',
    };
  } catch {
    return {
      product_type: 'individual',
      seat_cap: null,
      tenant_id: null,
      timezone: 'America/Sao_Paulo',
    };
  }
}

/**
 * Lista os colaboradores (ativos + inativos) de um slot, ordenados por ordem/id.
 * Escopado SEMPRE por slot (o caller injeta o slot da sessão, ADR 0012 Decisão 4).
 */
export async function listBySlot(slot: string): Promise<ColaboradorRow[]> {
  const r = await query<ColaboradorRowRaw>(
    `SELECT ${SELECT_COLAB_COLS} FROM clone_colaboradores WHERE slot = $1 ORDER BY ordem ASC, id ASC`,
    [slot],
  );
  return r.rows.map(mapColaboradorRow);
}

/** Conta colaboradores ATIVOS de um slot (vaga ocupada = colaborador ativo). */
async function countAtivos(
  client: pg.PoolClient,
  slot: string,
  exceptId?: number,
): Promise<number> {
  const sql = exceptId
    ? 'SELECT COUNT(*)::int AS c FROM clone_colaboradores WHERE slot = $1 AND ativo = TRUE AND id <> $2'
    : 'SELECT COUNT(*)::int AS c FROM clone_colaboradores WHERE slot = $1 AND ativo = TRUE';
  const args = exceptId ? [slot, exceptId] : [slot];
  const r = await client.query(sql, args);
  return r.rows[0]?.c ?? 0;
}

export interface CreateColaboradorInput {
  slot: string;
  /** tenant_id resolvido do clone pelo CALLER (getScopeBySlot). NOT NULL na tabela. */
  tenantId: string;
  nome: string;
  servicos?: unknown;
  ativo?: boolean;
  ordem?: number;
  /** % de comissão sobre o bruto (0–100). Ausente/indef -> 0 (default da coluna). */
  comissao_pct?: number;
}

/**
 * Saneia o % de comissão: number finito, clamp em [0, 100], 2 casas. Ausente/indef
 * ou inválido (NaN/Infinity/não-number) -> null = "não enviado" (caller decide se é
 * o default 0 do create ou "não altera" no update parcial).
 */
function sanitizeComissaoPct(v: unknown): number | null {
  if (typeof v !== 'number' || !Number.isFinite(v)) return null;
  const clamped = Math.min(100, Math.max(0, v));
  return Math.round(clamped * 100) / 100;
}

/**
 * Cria um colaborador respeitando seat_cap (conta só ATIVOS; NULL = sem teto) e a
 * unicidade de nome por estabelecimento (UNIQUE(slot, lower(nome)) -> 23505 vira
 * ColaboradorRuleError 'duplicate_name'). Transação: a checagem de teto e o INSERT
 * são atômicos. EXTRAÍDO da lógica inline do gestão (server.js:6024-6072) — uma
 * fonte de verdade pros dois painéis (a venda/gcal NÃO entra nesta fatia).
 *
 * O caller já validou product_type==='estabelecimento' (defesa em profundidade) e
 * passou o tenant_id; este módulo nunca recebe slot/tenant de input do cliente.
 */
export async function create(
  input: CreateColaboradorInput,
  seatCap: number | null,
): Promise<ColaboradorRow> {
  const nome = String(input.nome ?? '')
    .trim()
    .slice(0, 160);
  if (!nome) throw new ColaboradorRuleError('duplicate_name', 'nome obrigatorio');
  const servicos = normalizeColaboradorServicos(input.servicos);
  const ativo = input.ativo === undefined ? true : Boolean(input.ativo);
  const ordem = Number.isInteger(Number(input.ordem)) ? Number(input.ordem) : 0;
  // Ausente/inválido -> 0 (default da coluna, NOT NULL na migration 058).
  const comissaoPct = sanitizeComissaoPct(input.comissao_pct) ?? 0;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    if (ativo && seatCap !== null) {
      const usados = await countAtivos(client, input.slot);
      if (usados >= seatCap) {
        await client.query('ROLLBACK');
        throw new ColaboradorRuleError(
          'seat_cap_full',
          `limite do plano atingido (${seatCap} vagas). Desative um colaborador ou fale com o suporte para aumentar o plano.`,
        );
      }
    }
    // Coração do fix: todo serviço vinculado tem que existir no catálogo do clone.
    // Lança 'unknown_servico' (-> 400 no caller) e o catch abaixo dá ROLLBACK.
    await assertServicosNoCatalogo(client, input.slot, servicos);
    const ins = await client.query<ColaboradorRowRaw>(
      `INSERT INTO clone_colaboradores (slot, tenant_id, nome, gcal_calendar_id, gcal_status, servicos, ativo, ordem, comissao_pct)
       VALUES ($1, $2, $3, NULL, 'pending', $4::jsonb, $5, $6, $7)
       RETURNING ${SELECT_COLAB_COLS}`,
      [input.slot, input.tenantId, nome, JSON.stringify(servicos), ativo, ordem, comissaoPct],
    );
    await client.query('COMMIT');
    return mapColaboradorRow(ins.rows[0] as ColaboradorRowRaw);
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    if ((e as { code?: string }).code === '23505') {
      throw new ColaboradorRuleError(
        'duplicate_name',
        'ja existe um colaborador com esse nome neste estabelecimento',
      );
    }
    throw e;
  } finally {
    client.release();
  }
}

export interface UpdateColaboradorInput {
  nome?: string;
  servicos?: unknown;
  ativo?: boolean;
  ordem?: number;
  /** % de comissão (0–100). Ausente -> NÃO altera o valor atual (update parcial). */
  comissao_pct?: number;
}

/**
 * Edita campos de um colaborador (escopado por slot + id). Ao ATIVAR, revalida
 * seat_cap (a vaga só é consumida por ativos). 23505 -> 'duplicate_name'.
 * Retorna null se o colaborador não existe NESTE slot (caller -> 404). EXTRAÍDO de
 * server.js:6074-6142. NÃO toca gcal (agenda fica assistida pelo operador, ADR 0024).
 */
export async function update(
  slot: string,
  id: number,
  patch: UpdateColaboradorInput,
  seatCap: number | null,
): Promise<ColaboradorRow | null> {
  const sets: string[] = [];
  const vals: unknown[] = [];
  // Serviços normalizados quando o patch os inclui (validados contra o catálogo
  // DENTRO da transação, abaixo). null = patch não mexe em serviços.
  let servicosToValidate: string[] | null = null;

  if (patch.nome !== undefined) {
    const nome = String(patch.nome).trim().slice(0, 160);
    if (!nome) throw new ColaboradorRuleError('duplicate_name', 'nome nao pode ser vazio');
    vals.push(nome);
    sets.push(`nome = $${vals.length}`);
  }
  if (patch.servicos !== undefined) {
    servicosToValidate = normalizeColaboradorServicos(patch.servicos);
    vals.push(JSON.stringify(servicosToValidate));
    sets.push(`servicos = $${vals.length}::jsonb`);
  }
  if (patch.ordem !== undefined) {
    const ordem = Number(patch.ordem);
    if (!Number.isInteger(ordem))
      throw new ColaboradorRuleError('duplicate_name', 'ordem deve ser inteiro');
    vals.push(ordem);
    sets.push(`ordem = $${vals.length}`);
  }
  // Só toca comissao_pct quando o campo veio no patch (undefined = NÃO altera; nunca
  // zera quem não mandou). Valor inválido vira ColaboradorRuleError (caller -> 409).
  if (patch.comissao_pct !== undefined) {
    const pct = sanitizeComissaoPct(patch.comissao_pct);
    if (pct === null)
      throw new ColaboradorRuleError(
        'duplicate_name',
        'comissao_pct deve ser um numero entre 0 e 100',
      );
    vals.push(pct);
    sets.push(`comissao_pct = $${vals.length}`);
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Coração do fix (PATCH): se o patch troca os serviços, todo nome tem que existir
    // no catálogo do clone. Lança 'unknown_servico' (-> 400) e o catch dá ROLLBACK.
    if (servicosToValidate !== null) {
      await assertServicosNoCatalogo(client, slot, servicosToValidate);
    }
    if (patch.ativo !== undefined) {
      const ativo = Boolean(patch.ativo);
      if (ativo && seatCap !== null) {
        const usados = await countAtivos(client, slot, id);
        if (usados >= seatCap) {
          await client.query('ROLLBACK');
          throw new ColaboradorRuleError(
            'seat_cap_full',
            `limite do plano atingido (${seatCap} vagas).`,
          );
        }
      }
      vals.push(ativo);
      sets.push(`ativo = $${vals.length}`);
    }
    if (sets.length === 0) {
      await client.query('ROLLBACK');
      throw new ColaboradorRuleError('duplicate_name', 'nada a atualizar');
    }
    sets.push('updated_at = NOW()');
    vals.push(slot);
    vals.push(id);
    const r = await client.query<ColaboradorRowRaw>(
      `UPDATE clone_colaboradores SET ${sets.join(', ')}
         WHERE slot = $${vals.length - 1} AND id = $${vals.length}
       RETURNING ${SELECT_COLAB_COLS}`,
      vals,
    );
    if (r.rowCount === 0) {
      await client.query('ROLLBACK');
      return null;
    }
    await client.query('COMMIT');
    return mapColaboradorRow(r.rows[0] as ColaboradorRowRaw);
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    if ((e as { code?: string }).code === '23505') {
      throw new ColaboradorRuleError(
        'duplicate_name',
        'ja existe um colaborador com esse nome neste estabelecimento',
      );
    }
    throw e;
  } finally {
    client.release();
  }
}

/**
 * Remove um colaborador (escopado por slot + id). Retorna false se não havia linha
 * NESTE slot (caller -> 404). FK service_packages.colaborador_id é ON DELETE SET NULL
 * (não bloqueia). EXTRAÍDO de server.js:6144-6161.
 */
export async function remove(slot: string, id: number): Promise<boolean> {
  const r = await query('DELETE FROM clone_colaboradores WHERE slot = $1 AND id = $2', [slot, id]);
  return (r.rowCount ?? 0) > 0;
}

/**
 * Lê o product_type de um slot. Retorna 'individual' como fallback seguro quando:
 *  - a coluna não existe ainda (migration 052 não aplicada neste ambiente);
 *  - o slot não tem linha em flow_clones (matriz/bot interno);
 *  - valor nulo/desconhecido.
 *
 * Fallback 'individual' é DELIBERADO: na dúvida, o caminho é o atual (nenhum
 * código novo é alcançado). Isso protege Cirilo/Samuel mesmo se a migration
 * ainda não tiver rodado — o bot nunca tenta o caminho estabelecimento por engano.
 *
 * Lê SÓ de flow_clones (estabelecimento é sempre 'clone_'); não consulta bot_config.
 */
export async function getProductType(slot: string): Promise<ProductType> {
  try {
    const r = await query<{ product_type: string | null }>(
      'SELECT product_type FROM flow_clones WHERE slot = $1 LIMIT 1',
      [slot],
    );
    const v = r.rows[0]?.product_type;
    return v === 'estabelecimento' ? 'estabelecimento' : 'individual';
  } catch {
    // Coluna ausente (pré-052) ou erro de query → fallback seguro pro caminho atual.
    return 'individual';
  }
}

/**
 * Lê a área/vertical de um slot (flow_clones.area, migration 051).
 *
 * Retorna `null` (NÃO uma string default) quando a coluna não existe, o slot não
 * tem linha em flow_clones, ou o valor é nulo — assim o chamador distingue "sem
 * área conhecida" de uma área concreta e aplica o fallback genérico DELE. A
 * normalização da taxonomia (barbearia/cabeleireiro/manicure/estetica/...) é
 * responsabilidade da camada de emojis (apps/api), não daqui — este reader só
 * devolve o texto cru do banco em lowercase, sem inventar default.
 *
 * Fallback `null` é DELIBERADO e seguro: o consumidor (cartão de confirmação)
 * trata null como "área desconhecida" → não muda emoji nenhum (caminho atual).
 */
export async function getArea(slot: string): Promise<string | null> {
  try {
    const r = await query<{ area: string | null }>(
      'SELECT area FROM flow_clones WHERE slot = $1 LIMIT 1',
      [slot],
    );
    const v = r.rows[0]?.area;
    return v ? v.trim().toLowerCase() : null;
  } catch {
    // Coluna ausente (pré-051) ou erro de query → null = área desconhecida.
    return null;
  }
}

/**
 * Lê área (migration 051) + prompt_custom (migration 070) do slot numa ÚNICA query
 * (SCRUM-84). Serve o caminho INDIVIDUAL do bot, que precisa da área pra escolher o
 * emoji do cartão E do prompt_custom pra saber se a persona é autoridade final (nesse
 * caso NÃO injeta o override de emojis — ver buildCartaoEmojiOverrideBlock). É a MESMA
 * leitura por slot (PK) que getArea já fazia, só com uma coluna a mais — NÃO adiciona
 * query nova ao hot path.
 *
 * Fallbacks DELIBERADOS e seguros (byte-idênticos ao comportamento pré-fix):
 *   - área null (coluna/linha ausente ou valor nulo) → área desconhecida;
 *   - promptCustom false só é true com prompt_custom === true no banco (migration 070);
 *   - erro de query (ex.: coluna prompt_custom ausente em dev pré-070) → { null, false },
 *     o que mantém o override no comportamento atual (não custom).
 */
export async function getAreaAndPromptCustom(
  slot: string,
): Promise<{ area: string | null; promptCustom: boolean }> {
  // Wrapper fino sobre o reader unificado (SCRUM-92 inc.2): mesma query, mesmos
  // fallbacks — só descarta as colunas do cartão. Mantido pra NÃO tocar call-sites.
  const { area, promptCustom } = await getAreaPromptCustomCartao(slot);
  return { area, promptCustom };
}

/** Fonte do cartão de confirmação deste clone (flow_clones.cartao_mode, migration 075).
 *  'baked' = vem do bot_prompt (comportamento de hoje); 'runtime' = montado por código. */
export type CartaoMode = 'baked' | 'runtime';

/**
 * Config JSONB do cartão em runtime (flow_clones.cartao_config, migration 075). Espelha
 * (estruturalmente) a CartaoConfig de @startap/integrations — definida LOCAL de propósito:
 * @startap/db NÃO depende de @startap/integrations (a dependência é o contrário; importar
 * de lá criaria ciclo). O caller (apps/api) passa este objeto direto pro buildCartaoRuntimeBlock
 * (tipo estruturalmente compatível). Só campos VALIDADOS entram — o resto é descartado.
 */
export interface CloneCartaoConfig {
  template?: 'padrao' | 'compacto' | 'detalhado';
  emojis?: Partial<
    Record<'marca' | 'dia' | 'horario' | 'servico' | 'valor' | 'confirma' | 'profissional', string>
  >;
  /** Cartão LEGADO capturado verbatim do bot_prompt de um clone MIGRADO (refinamento Bruno
   *  23/07). Presente → o runtime EMITE esse texto exato (zero mudança visível). Ver
   *  buildCartaoRuntimeBlock e o script migrate-cartao-runtime. */
  verbatim?: string;
}

const CARTAO_EMOJI_KEYS = [
  'marca',
  'dia',
  'horario',
  'servico',
  'valor',
  'confirma',
  'profissional',
] as const;

/**
 * Valida DEFENSIVAMENTE o JSONB cru de cartao_config numa CloneCartaoConfig. Nunca lança:
 * shape inesperado (não-objeto, template fora do domínio, emoji não-string) é descartado
 * silenciosamente → null ou objeto parcial. O buildCartaoRuntimeBlock é puro/tolerante, mas
 * validar aqui garante que o tipo forte (`template` union) não é uma mentira sobre o dado.
 */
function parseCartaoConfig(raw: unknown): CloneCartaoConfig | null {
  if (!raw || typeof raw !== 'object') return null;
  const obj = raw as Record<string, unknown>;
  const out: CloneCartaoConfig = {};
  if (obj.template === 'padrao' || obj.template === 'compacto' || obj.template === 'detalhado') {
    out.template = obj.template;
  }
  if (obj.emojis && typeof obj.emojis === 'object') {
    const src = obj.emojis as Record<string, unknown>;
    const emojis: Partial<Record<(typeof CARTAO_EMOJI_KEYS)[number], string>> = {};
    for (const k of CARTAO_EMOJI_KEYS) {
      const v = src[k];
      if (typeof v === 'string' && v !== '') emojis[k] = v;
    }
    if (Object.keys(emojis).length > 0) out.emojis = emojis;
  }
  // Cartão legado capturado (refinamento Bruno 23/07): string não-vazia só. Preservado cru.
  if (typeof obj.verbatim === 'string' && obj.verbatim.trim() !== '') out.verbatim = obj.verbatim;
  return Object.keys(out).length > 0 ? out : null;
}

/**
 * Reader UNIFICADO do caminho do bot (SCRUM-92 inc.2 / ADR 0032 §2.3): lê área (051) +
 * prompt_custom (070) + cartao_mode/cartao_config (075) do slot numa ÚNICA query por PK —
 * NÃO adiciona read novo ao hot path (é a mesma leitura por slot que getArea/
 * getAreaAndPromptCustom já faziam, com 2 colunas a mais).
 *
 * Fallbacks DELIBERADOS e byte-seguros (coluna ausente / linha ausente / valor nulo / erro
 * de query → NUNCA lança): cartaoMode='baked' (comportamento de HOJE — cartão vem do
 * bot_prompt) e cartaoConfig=null. Assim, mesmo se a migration 075 não tiver rodado neste
 * ambiente, o bot cai no caminho baked e nada muda.
 */
export async function getAreaPromptCustomCartao(slot: string): Promise<{
  area: string | null;
  promptCustom: boolean;
  cartaoMode: CartaoMode;
  cartaoConfig: CloneCartaoConfig | null;
  /** Nome AMIGÁVEL do negócio (SCRUM-92 inc.2): cabeado no `<nome do negócio>` do cartão
   *  montado em RUNTIME. Resolvido na MESMA leitura por slot (zero read extra no hot path);
   *  null quando não há linha/erro (o builder cai no placeholder). */
  nomeNegocio: string | null;
}> {
  try {
    const r = await query<{
      area: string | null;
      prompt_custom: boolean | null;
      cartao_mode: string | null;
      cartao_config: unknown;
      display_name: string | null;
      cliente_nome: string | null;
      personalizacao: unknown;
    }>(
      `SELECT area, prompt_custom, cartao_mode, cartao_config, display_name, cliente_nome, personalizacao
         FROM flow_clones WHERE slot = $1 LIMIT 1`,
      [slot],
    );
    const row = r.rows[0];
    // nomeNegocio só é resolvido quando há linha (fonte única: @startap/core, sem drift com o
    // builder do portal). Sem linha → null (o caller usa o placeholder <nome do negócio>).
    const nomeNegocio = row
      ? resolveNomeNegocio({
          display_name: row.display_name,
          cliente_nome: row.cliente_nome,
          personalizacao:
            row.personalizacao && typeof row.personalizacao === 'object'
              ? (row.personalizacao as Record<string, string>)
              : null,
        })
      : null;
    return {
      area: row?.area ? row.area.trim().toLowerCase() : null,
      promptCustom: row?.prompt_custom === true,
      // Só 'runtime' explícito liga o caminho novo; qualquer outra coisa → 'baked' (seguro).
      cartaoMode: row?.cartao_mode === 'runtime' ? 'runtime' : 'baked',
      cartaoConfig: parseCartaoConfig(row?.cartao_config),
      nomeNegocio,
    };
  } catch {
    // Coluna ausente (pré-051/070/075) ou erro → caminho atual: área desconhecida, não
    // custom, cartão BAKED, sem config. Nunca lança (não derruba o bot).
    return {
      area: null,
      promptCustom: false,
      cartaoMode: 'baked',
      cartaoConfig: null,
      nomeNegocio: null,
    };
  }
}

/**
 * Grava flow_clones.cartao_config (JSONB) escopado por SLOT (o caller injeta o slot da SESSÃO —
 * nunca de input; anti-IDOR, regra de ouro 5). SCRUM-92 inc.2 / ADR 0032. NÃO toca cartao_mode:
 * a config é inerte enquanto o clone é 'baked' (ativação de modo é decisão SEPARADA — approve
 * runtime ou o script de migração). `config=null` LIMPA a coluna (volta aos defaults por área).
 * Retorna false se não havia linha NESTE slot (caller → 404).
 */
export async function setCartaoConfigBySlot(
  slot: string,
  config: CloneCartaoConfig | null,
): Promise<boolean> {
  const r = await query(
    'UPDATE flow_clones SET cartao_config = $2::jsonb, updated_at = NOW() WHERE slot = $1',
    [slot, config === null ? null : JSON.stringify(config)],
  );
  return (r.rowCount ?? 0) > 0;
}
