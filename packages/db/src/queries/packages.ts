/**
 * packages — camada de pacotes de serviço (ADR 0025).
 *
 * BLOCO 2a (leitura): listActiveTemplates / listClientCredits / listActiveClientCredits.
 *   Só calcula e lê — saldo/validade/cobertura/escopo decididos AQUI (server-side); o
 *   LLM nunca raciocina saldo.
 *
 * BLOCO 2b (escrita — ESTE PR): redeemForBooking / refundForBooking. Escrita no LEDGER
 *   (package_redemptions) ligada a um gcal_event_id, sob action-lock do chamador (ADR 0019)
 *   e idempotente por UNIQUE(gcal_event_id, reason) (ON CONFLICT DO NOTHING). NUNCA faz
 *   UPDATE solto em sessoes_restantes: o cache é reconstruído do ledger na MESMA transação.
 *   O SERVIDOR re-valida cobertura + saldo>0 + validade ANTES de gravar — o `usa_pacote`
 *   do LLM é só SUGESTÃO; nunca confiamos nele.
 *
 * Tudo aqui é escopado por `slot` (tenant key atual, ADR 0007) E, como defesa em
 * profundidade (P3 do review do #320), por `tenant_id` no WHERE quando o chamador o
 * fornece — a coluna já existe nas 3 tabelas. O telefone do cliente entra SEMPRE como
 * HMAC (packagePhoneHmac, pepper PRÓPRIO de pacotes — o caller hasheia; este módulo nunca
 * vê o número cru).
 *
 * FONTE DA VERDADE do saldo = ledger (package_redemptions): saldo = sessoes_total
 * + SUM(delta). sessoes_restantes em client_package_credits é cache; este módulo
 * recomputa do ledger e usa o cache só como cross-check de consistência (log).
 *
 * GATE: nada aqui é alcançado com PACOTES_ENABLED=OFF — o chamador (o bot) só invoca
 * estas funções com a flag ON. Flag OFF -> inserir_agendamento byte-a-byte o de hoje
 * (Cirilo/Samuel intocados).
 */
import { logger } from '@startap/core/logger';
import { pool, query } from '../client.js';

const log = logger.child({ module: 'packages-deducao' });

/** Estado calculado de um crédito, do ponto de vista do bot. */
export type PackageState = 'ATIVO' | 'EXPIRADO' | 'ESGOTADO' | 'CANCELADO';

/** Template de pacote (definido pelo dono) — listagem read-only. */
export interface ServicePackageTemplate {
  id: number;
  slot: string;
  nome: string;
  descricao: string | null;
  servicos_cobertos: string[];
  total_sessoes: number;
  validade_dias: number | null;
  data_validade_fixa: string | null; // 'YYYY-MM-DD'
  preco_cents: number | null;
  colaborador_id: number | null; // NULL = casa inteira; preenchido = só com aquele
  ativo: boolean;
}

/**
 * Crédito de um cliente final JÁ CALCULADO server-side: saldo (do ledger),
 * validade, cobertura e escopo, com estado explícito (ATIVO/EXPIRADO/ESGOTADO).
 */
export interface ClientPackageCredit {
  credit_id: number;
  package_id: number;
  slot: string;
  nome: string;
  /** Saldo real recomputado do ledger (sessoes_total + SUM(delta)). */
  sessoes_restantes: number;
  sessoes_total: number;
  data_expiracao: string; // 'YYYY-MM-DD'
  /** true se data_expiracao < hoje (UTC). */
  expirado: boolean;
  /** Estado para o bloco de prompt / tool. */
  estado: PackageState;
  /** Serviços que o pacote cobre. Vazio = não cobre nada (regra do ADR §4). */
  servicos_cobertos: string[];
  /** NULL = pacote da casa; preenchido = só vale com aquele colaborador. */
  colaborador_id: number | null;
  /** cobre(servicoNome) calculado já considerando o array acima. */
  cobre: (servicoNome: string) => boolean;
}

function toStringArray(v: unknown): string[] {
  if (Array.isArray(v)) return v.filter((x): x is string => typeof x === 'string');
  return [];
}

const TEMPLATE_COLS = `id, slot, nome, descricao, servicos_cobertos, total_sessoes,
  validade_dias, to_char(data_validade_fixa, 'YYYY-MM-DD') AS data_validade_fixa,
  preco_cents, colaborador_id, ativo`;

interface TemplateRowRaw {
  id: string | number;
  slot: string;
  nome: string;
  descricao: string | null;
  servicos_cobertos: unknown;
  total_sessoes: number;
  validade_dias: number | null;
  data_validade_fixa: string | null;
  preco_cents: number | null;
  colaborador_id: string | number | null;
  ativo: boolean;
}

function normalizeTemplate(r: TemplateRowRaw): ServicePackageTemplate {
  return {
    id: Number(r.id),
    slot: r.slot,
    nome: r.nome,
    descricao: r.descricao,
    servicos_cobertos: toStringArray(r.servicos_cobertos),
    total_sessoes: Number(r.total_sessoes),
    validade_dias: r.validade_dias === null ? null : Number(r.validade_dias),
    data_validade_fixa: r.data_validade_fixa,
    preco_cents: r.preco_cents === null ? null : Number(r.preco_cents),
    colaborador_id: r.colaborador_id === null ? null : Number(r.colaborador_id),
    ativo: r.ativo,
  };
}

/**
 * Lista os templates ATIVOS de um slot (read-only). Usado pela UI (bloco 2b) e por
 * leituras informativas. Escopado por slot — nunca cruza clientes.
 *
 * `tenantId` (opcional) adiciona AND tenant_id = $N no WHERE — defesa em profundidade
 * (P3 do review do #320); a coluna já existe. Sem ele, escopo segue por slot (atual).
 */
export async function listActiveTemplates(
  slot: string,
  tenantId?: string,
): Promise<ServicePackageTemplate[]> {
  const params: unknown[] = [slot];
  let tenantClause = '';
  if (tenantId) {
    params.push(tenantId);
    tenantClause = ` AND tenant_id = $${params.length}`;
  }
  const r = await query<TemplateRowRaw>(
    `SELECT ${TEMPLATE_COLS}
       FROM service_packages
      WHERE slot = $1 AND ativo = TRUE${tenantClause}
      ORDER BY nome ASC`,
    params,
  );
  return r.rows.map(normalizeTemplate);
}

interface CreditRowRaw {
  credit_id: string | number;
  package_id: string | number;
  slot: string;
  nome: string;
  sessoes_total: number;
  sessoes_restantes_cache: number;
  /** Saldo real recomputado do ledger (sessoes_total + SUM(delta)). */
  saldo_ledger: string | number;
  data_expiracao: string;
  expirado: boolean;
  status: string;
  servicos_cobertos: unknown;
  colaborador_id: string | number | null;
}

function deriveEstado(input: {
  status: string;
  expirado: boolean;
  saldo: number;
}): PackageState {
  if (input.status === 'cancelled') return 'CANCELADO';
  if (input.expirado) return 'EXPIRADO';
  if (input.saldo <= 0) return 'ESGOTADO';
  return 'ATIVO';
}

function normalizeCredit(r: CreditRowRaw): ClientPackageCredit {
  const saldo = Math.max(0, Number(r.saldo_ledger));
  const servicos = toStringArray(r.servicos_cobertos);
  const estado = deriveEstado({ status: r.status, expirado: r.expirado, saldo });
  return {
    credit_id: Number(r.credit_id),
    package_id: Number(r.package_id),
    slot: r.slot,
    nome: r.nome,
    sessoes_restantes: saldo,
    sessoes_total: Number(r.sessoes_total),
    data_expiracao: r.data_expiracao,
    expirado: r.expirado,
    estado,
    servicos_cobertos: servicos,
    colaborador_id: r.colaborador_id === null ? null : Number(r.colaborador_id),
    cobre: (servicoNome: string) =>
      servicos.some((s) => s.trim().toLowerCase() === servicoNome.trim().toLowerCase()),
  };
}

/**
 * Lista TODOS os créditos de um cliente (por HMAC) num slot, com saldo/validade/
 * estado JÁ calculados server-side. Inclui EXPIRADO e ESGOTADO explicitamente
 * (não filtra) — o bloco de prompt precisa informar "expirou em DD/MM" / "acabou".
 *
 * O saldo é recomputado do LEDGER (fonte da verdade), não confia no cache
 * sessoes_restantes. LEFT JOIN no ledger cobre crédito sem nenhum movimento
 * (saldo = sessoes_total). data_expiracao < hoje (UTC) => expirado.
 *
 * NÃO loga o número (só HMAC entra). Escopado por (slot, hmac).
 */
export async function listClientCredits(input: {
  slot: string;
  phoneHmac: string;
  /** Defesa em profundidade (P3 #320): AND c.tenant_id = $N quando fornecido. */
  tenantId?: string;
}): Promise<ClientPackageCredit[]> {
  const params: unknown[] = [input.slot, input.phoneHmac];
  let tenantClause = '';
  if (input.tenantId) {
    params.push(input.tenantId);
    tenantClause = ` AND c.tenant_id = $${params.length}`;
  }
  const r = await query<CreditRowRaw>(
    `SELECT c.id            AS credit_id,
            c.package_id    AS package_id,
            c.slot          AS slot,
            sp.nome         AS nome,
            c.sessoes_total AS sessoes_total,
            c.sessoes_restantes AS sessoes_restantes_cache,
            (c.sessoes_total + COALESCE(SUM(pr.delta), 0)) AS saldo_ledger,
            to_char(c.data_expiracao, 'YYYY-MM-DD')        AS data_expiracao,
            (c.data_expiracao < (NOW() AT TIME ZONE 'utc')::date) AS expirado,
            c.status        AS status,
            sp.servicos_cobertos AS servicos_cobertos,
            sp.colaborador_id    AS colaborador_id
       FROM client_package_credits c
       JOIN service_packages sp ON sp.id = c.package_id
       LEFT JOIN package_redemptions pr ON pr.credit_id = c.id
      WHERE c.slot = $1 AND c.cliente_phone_hmac = $2${tenantClause}
      GROUP BY c.id, sp.nome, sp.servicos_cobertos, sp.colaborador_id
      ORDER BY c.data_expiracao ASC, c.data_compra ASC`,
    params,
  );
  return r.rows.map(normalizeCredit);
}

/**
 * Só os créditos ATIVOS (saldo>0 e dentro da validade) de um cliente — atalho para
 * a dedução (bloco 2b) e para decidir se injeta o bloco [SEU PACOTE]. Reusa
 * listClientCredits e filtra por estado ATIVO (cálculo já server-side).
 */
export async function listActiveClientCredits(input: {
  slot: string;
  phoneHmac: string;
  /** Defesa em profundidade (P3 #320): repassado a listClientCredits. */
  tenantId?: string;
}): Promise<ClientPackageCredit[]> {
  const all = await listClientCredits(input);
  return all.filter((c) => c.estado === 'ATIVO');
}

// ─────────────────────────────────────────────────────────────────────────────
// BLOCO 2b — DEDUÇÃO / ESTORNO (escrita no ledger). ADR 0025 §2/§3.
// ─────────────────────────────────────────────────────────────────────────────

/** Decisão de cobertura/precedência feita server-side (motivo legível pro log/tool). */
export type RedeemMotivo =
  | 'descontado' // gravou redemption (-1) ou já estava gravada (idempotente)
  | 'sem_pacote' // cliente não tem nenhum pacote ATIVO que cobre o serviço
  | 'nao_solicitado' // havia pacote elegível mas o cliente/LLM optou por não usar
  | 'pepper_ausente' // identidade de pacote indisponível (degrada p/ avulso)
  | 'erro'; // falha de DB — agenda avulso, nunca derruba o atendimento

/** Resultado da tentativa de dedução, já pronto para enriquecer a resposta da tool. */
export interface RedeemResult {
  /** true SÓ quando uma sessão foi (ou já estava) descontada deste evento. */
  descontou_do_pacote: boolean;
  /** true quando NÃO houve desconto (atendimento avulso / "por fora"). */
  avulso: boolean;
  motivo: RedeemMotivo;
  /** Saldo restante DEPOIS do desconto (recalculado do ledger). null se não descontou. */
  sessoes_restantes: number | null;
  /** Nome do pacote usado (se descontou). */
  pacote_nome?: string;
  credit_id?: number;
  /** Colaborador do pacote usado (NULL/ausente = pacote da casa). */
  colaborador_id?: number | null;
}

/**
 * Escolhe, entre os créditos ATIVOS que cobrem o serviço, qual usar — DETERMINÍSTICO.
 *
 * PRECEDÊNCIA (ADR 0025): (1) colaborador-específico ANTES de casa; (2) MENOR validade
 * (expira antes — "use o que vence primeiro"); (3) MAIS ANTIGO (credit_id menor =
 * comprado antes, desempate estável). Recebe a lista já filtrada por cobertura.
 *
 * `colaboradorId` (estabelecimento): se informado, um pacote colaborador-específico só
 * é elegível se for DAQUELE colaborador. Pacote da casa (colaborador_id null) sempre vale.
 */
export function escolherCreditoParaDeducao(
  cobertos: ClientPackageCredit[],
  colaboradorId?: number | null,
): ClientPackageCredit | null {
  const elegiveis = cobertos.filter((c) => {
    if (c.colaborador_id === null) return true; // pacote da casa: sempre elegível
    // pacote colaborador-específico: só vale com aquele colaborador (se conhecido).
    return colaboradorId != null && c.colaborador_id === colaboradorId;
  });
  if (elegiveis.length === 0) return null;

  elegiveis.sort((a, b) => {
    // (1) colaborador-específico antes de casa
    const aEspecifico = a.colaborador_id === null ? 1 : 0;
    const bEspecifico = b.colaborador_id === null ? 1 : 0;
    if (aEspecifico !== bEspecifico) return aEspecifico - bEspecifico;
    // (2) menor validade (expira antes)
    if (a.data_expiracao !== b.data_expiracao) return a.data_expiracao < b.data_expiracao ? -1 : 1;
    // (3) mais antigo (credit_id menor)
    return a.credit_id - b.credit_id;
  });
  return elegiveis[0] ?? null;
}

export interface RedeemForBookingInput {
  slot: string;
  /** Defesa em profundidade (P3 #320): filtra os créditos por tenant_id também. */
  tenantId?: string;
  phoneHmac: string;
  /** Evento JÁ criado no GCal — âncora de idempotência (UNIQUE gcal_event_id,reason). */
  gcalEventId: string;
  /** Nome do serviço agendado, validado contra servicos_cobertos do pacote (case-insensitive). */
  servicoNome: string;
  /** Colaborador que atende (estabelecimento). NULL/undefined = caso individual/casa. */
  colaboradorId?: number | null;
  /**
   * SUGESTÃO do LLM (param usa_pacote). default true. O servidor SEMPRE re-valida
   * cobertura+saldo+validade; este flag só permite o cliente optar por NÃO usar o pacote
   * ("quero pagar avulso hoje"). NUNCA é usado para FORÇAR um desconto.
   */
  usarPacote?: boolean;
}

/**
 * DEDUZ uma sessão de pacote para um agendamento JÁ criado no GCal — bloco 2b.
 *
 * Fluxo (TUDO numa transação, idempotente sob retry):
 *  0. Se usarPacote=false -> não desconta (avulso, motivo 'nao_solicitado'). Sem tocar DB.
 *  1. Lê os créditos ATIVOS do cliente (saldo do ledger, validade, escopo) — server-side.
 *  2. Filtra os que COBREM o serviço (cobre(servicoNome)) e são elegíveis pro colaborador.
 *  3. escolherCreditoParaDeducao aplica a precedência determinística.
 *  4. Nenhum elegível -> avulso (motivo 'sem_pacote').
 *  5. INSERT redemption (delta=-1, reason='redeem') ON CONFLICT (gcal_event_id,reason)
 *     DO NOTHING -> 0 linhas = ESTE evento já descontou (retry) -> idempotente, recomputa
 *     saldo e reporta descontou=true sem dupla baixa.
 *  6. Reconstrói sessoes_restantes (cache) do ledger na MESMA transação (nunca UPDATE solto).
 *
 * Fail-safe: qualquer erro -> ROLLBACK + motivo 'erro' + avulso=true (o evento no GCal já
 * existe; o atendimento NÃO é derrubado por falha de pacote). O chamador loga e segue.
 *
 * Sob o action-lock do chamador (ADR 0019), só UM processamento desta mensagem chega aqui;
 * o UNIQUE cobre o caso de a action-lock degradar (Redis down) ou retry de WAHA.
 */
export async function redeemForBooking(input: RedeemForBookingInput): Promise<RedeemResult> {
  const usarPacote = input.usarPacote ?? true;

  if (!usarPacote) {
    return {
      descontou_do_pacote: false,
      avulso: true,
      motivo: 'nao_solicitado',
      sessoes_restantes: null,
    };
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // (1) créditos ATIVOS do cliente, com saldo do ledger e validade — FOR UPDATE no
    // crédito escolhido garante serialização entre dois agendamentos concorrentes do
    // MESMO cliente que disputam a última sessão (além do action-lock por horário).
    const ativos = await selectActiveCreditsTx(client, {
      slot: input.slot,
      phoneHmac: input.phoneHmac,
      tenantId: input.tenantId,
    });

    // (2) cobertura (server-side; o LLM nunca decide) — case-insensitive via cobre().
    const cobertos = ativos.filter((c) => c.cobre(input.servicoNome));

    // (3)+(4) precedência determinística; nenhum elegível -> avulso.
    const credito = escolherCreditoParaDeducao(cobertos, input.colaboradorId ?? null);
    if (!credito) {
      await client.query('COMMIT');
      return {
        descontou_do_pacote: false,
        avulso: true,
        motivo: 'sem_pacote',
        sessoes_restantes: null,
      };
    }

    // (5) grava o consumo no ledger — idempotente por evento. tenant_id e slot vêm do
    // PRÓPRIO crédito (já tenant-stamped) — nunca de campo livre. ON CONFLICT cobre retry.
    await client.query(
      `INSERT INTO package_redemptions
         (credit_id, slot, tenant_id, gcal_event_id, colaborador_id, servico_nome, delta, reason)
       SELECT c.id, c.slot, c.tenant_id, $2, $3, $4, -1, 'redeem'
         FROM client_package_credits c
        WHERE c.id = $1
       ON CONFLICT (gcal_event_id, reason) DO NOTHING`,
      [credito.credit_id, input.gcalEventId, input.colaboradorId ?? null, input.servicoNome],
    );

    // (6) reconstrói o cache sessoes_restantes do ledger (fonte da verdade) — clamp [0..total].
    const saldo = await rebuildCreditCacheTx(client, credito.credit_id);

    await client.query('COMMIT');
    return {
      descontou_do_pacote: true,
      avulso: false,
      motivo: 'descontado',
      sessoes_restantes: saldo,
      pacote_nome: credito.nome,
      credit_id: credito.credit_id,
      colaborador_id: credito.colaborador_id,
    };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    log.error(
      { err: err instanceof Error ? err.message : String(err), slot: input.slot },
      'redeemForBooking falhou — agenda avulso, atendimento NÃO derrubado',
    );
    return { descontou_do_pacote: false, avulso: true, motivo: 'erro', sessoes_restantes: null };
  } finally {
    client.release();
  }
}

export interface RefundForBookingInput {
  slot: string;
  tenantId?: string;
  /** Evento cujo desconto se quer estornar (idempotente por UNIQUE(gcal_event_id,'refund')). */
  gcalEventId: string;
  /** Quem disparou (ops/painel) — forense. */
  actor?: string;
}

/** Resultado de um estorno manual. */
export interface RefundResult {
  refunded: boolean;
  /** false quando não havia 'redeem' deste evento, ou o refund já existia (idempotente). */
  reason: 'refunded' | 'already_refunded' | 'no_redeem' | 'erro';
  credit_id?: number;
  sessoes_restantes?: number;
}

/**
 * ESTORNA o desconto de um evento (delta=+1, reason='refund') — DISPARO MANUAL no MVP.
 *
 * ⚠️ MVP: NÃO há gatilho automático. O bot NUNCA cancela (escala o cancelamento pro dono,
 * Missão 023 W5). Esta função existe para o painel/ops devolverem a sessão à mão quando o
 * dono confirma que o horário não vai acontecer. Idempotente por UNIQUE(gcal_event_id,
 * 'refund'): chamar 2x devolve no máximo 1 sessão.
 *
 * Pré-condição: tem de existir um 'redeem' deste gcal_event_id (senão não há o que estornar).
 * O delta é casado ao MESMO credit_id do redeem original (não inventa crédito).
 */
export async function refundForBooking(input: RefundForBookingInput): Promise<RefundResult> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Acha o redeem original deste evento (e o crédito que ele consumiu), escopado por slot
    // (+tenant se fornecido). FOR UPDATE serializa com outro refund concorrente.
    const params: unknown[] = [input.gcalEventId, input.slot];
    let tenantClause = '';
    if (input.tenantId) {
      params.push(input.tenantId);
      tenantClause = ` AND tenant_id = $${params.length}`;
    }
    const redeemRes = await client.query<{ credit_id: string }>(
      `SELECT credit_id::text AS credit_id
         FROM package_redemptions
        WHERE gcal_event_id = $1 AND reason = 'redeem' AND slot = $2${tenantClause}
        FOR UPDATE`,
      params,
    );
    const redeem = redeemRes.rows[0];
    if (!redeem) {
      await client.query('COMMIT');
      return { refunded: false, reason: 'no_redeem' };
    }
    const creditId = Number(redeem.credit_id);

    const ins = await client.query(
      `INSERT INTO package_redemptions
         (credit_id, slot, tenant_id, gcal_event_id, colaborador_id, servico_nome, delta, reason)
       SELECT c.id, c.slot, c.tenant_id, $2, NULL, NULL, 1, 'refund'
         FROM client_package_credits c
        WHERE c.id = $1
       ON CONFLICT (gcal_event_id, reason) DO NOTHING`,
      [creditId, input.gcalEventId],
    );

    const saldo = await rebuildCreditCacheTx(client, creditId);
    await client.query('COMMIT');

    if (ins.rowCount === 0) {
      // refund já existia (idempotente) — não devolveu sessão de novo.
      return {
        refunded: false,
        reason: 'already_refunded',
        credit_id: creditId,
        sessoes_restantes: saldo,
      };
    }
    log.info(
      {
        slot: input.slot,
        creditId,
        gcalEventId: input.gcalEventId,
        actor: input.actor ?? 'manual',
      },
      'refundForBooking: 1 sessão estornada (disparo manual)',
    );
    return { refunded: true, reason: 'refunded', credit_id: creditId, sessoes_restantes: saldo };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    log.error(
      { err: err instanceof Error ? err.message : String(err), slot: input.slot },
      'refundForBooking falhou',
    );
    return { refunded: false, reason: 'erro' };
  } finally {
    client.release();
  }
}

/**
 * Hook de RECONCILIAÇÃO — STUB (ADR 0025, dívida 5: furo cancelar+reagendar).
 *
 * DÍVIDA EXPLÍCITA: quando o cliente cancela e reagenda, o GCal gera um event_id NOVO.
 * O UNIQUE(gcal_event_id, reason) impede dupla baixa do MESMO evento, mas NÃO liga o
 * evento velho (que ficou descontado) ao novo (que descontaria de novo) -> risco de
 * consumir 2 sessões de UM atendimento. Como o bot NÃO cancela (escala pro dono), não há
 * gatilho automático de refund hoje; o saneamento é o refund MANUAL acima.
 *
 * Este hook NÃO resolve o furo — ele só deixa RASTRO (log estruturado) para um job de
 * reconciliação futuro detectar e o ops auditar. Chamado pelo caminho de dedução quando
 * descontou, registrando o vínculo (telefone-hmac + serviço + evento) sem PII.
 */
export function reconciliationHook(entry: {
  slot: string;
  gcalEventId: string;
  creditId: number;
  servicoNome: string;
}): void {
  // STUB: por ora só loga. Futuro: enfileirar para job que cruza redemptions órfãs com
  // eventos cancelados no GCal e sugere refund ao ops. NÃO desconta nem estorna sozinho.
  log.info(
    {
      slot: entry.slot,
      gcalEventId: entry.gcalEventId,
      creditId: entry.creditId,
      servico: entry.servicoNome,
      stub: true,
    },
    'reconciliation-hook: desconto registrado (dívida cancelar+reagendar — rastro p/ job futuro)',
  );
}

// ── helpers transacionais (privados) ─────────────────────────────────────────

interface PgLikeClient {
  query<T extends import('pg').QueryResultRow = import('pg').QueryResultRow>(
    text: string,
    params?: unknown[],
  ): Promise<import('pg').QueryResult<T>>;
}

/**
 * Lê os créditos ATIVOS do cliente DENTRO da transação, com saldo do ledger, e trava as
 * linhas de crédito (FOR UPDATE) para serializar agendamentos concorrentes do mesmo cliente.
 */
async function selectActiveCreditsTx(
  client: PgLikeClient,
  input: { slot: string; phoneHmac: string; tenantId?: string },
): Promise<ClientPackageCredit[]> {
  const params: unknown[] = [input.slot, input.phoneHmac];
  let tenantClause = '';
  if (input.tenantId) {
    params.push(input.tenantId);
    tenantClause = ` AND c.tenant_id = $${params.length}`;
  }
  // FOR UPDATE OF c: trava só as linhas de crédito (não os agregados do LEFT JOIN).
  const r = await client.query<CreditRowRaw>(
    `SELECT c.id            AS credit_id,
            c.package_id    AS package_id,
            c.slot          AS slot,
            sp.nome         AS nome,
            c.sessoes_total AS sessoes_total,
            c.sessoes_restantes AS sessoes_restantes_cache,
            (c.sessoes_total + COALESCE(SUM(pr.delta), 0)) AS saldo_ledger,
            to_char(c.data_expiracao, 'YYYY-MM-DD')        AS data_expiracao,
            (c.data_expiracao < (NOW() AT TIME ZONE 'utc')::date) AS expirado,
            c.status        AS status,
            sp.servicos_cobertos AS servicos_cobertos,
            sp.colaborador_id    AS colaborador_id
       FROM client_package_credits c
       JOIN service_packages sp ON sp.id = c.package_id
       LEFT JOIN package_redemptions pr ON pr.credit_id = c.id
      WHERE c.slot = $1 AND c.cliente_phone_hmac = $2${tenantClause}
      GROUP BY c.id, sp.nome, sp.servicos_cobertos, sp.colaborador_id
      ORDER BY c.data_expiracao ASC, c.data_compra ASC
      FOR UPDATE OF c`,
    params,
  );
  return r.rows.map(normalizeCredit).filter((c) => c.estado === 'ATIVO');
}

/**
 * Reconstrói o cache sessoes_restantes de UM crédito a partir do LEDGER (fonte da verdade),
 * dentro da transação. NUNCA faz aritmética solta no cache — recomputa do zero. Clampa em
 * [0..sessoes_total] (o CHECK da tabela exige; e saldo negativo nunca deve vazar). Devolve o
 * saldo já gravado.
 */
async function rebuildCreditCacheTx(client: PgLikeClient, creditId: number): Promise<number> {
  const r = await client.query<{ saldo: string | number }>(
    `UPDATE client_package_credits c
        SET sessoes_restantes = GREATEST(0, LEAST(c.sessoes_total,
              c.sessoes_total + COALESCE(
                (SELECT SUM(pr.delta) FROM package_redemptions pr WHERE pr.credit_id = c.id), 0))),
            status = CASE
              WHEN c.status = 'cancelled' THEN 'cancelled'
              WHEN (c.sessoes_total + COALESCE(
                (SELECT SUM(pr.delta) FROM package_redemptions pr WHERE pr.credit_id = c.id), 0)) <= 0
                THEN 'exhausted'
              ELSE 'active' END,
            updated_at = NOW()
      WHERE c.id = $1
      RETURNING c.sessoes_restantes AS saldo`,
    [creditId],
  );
  return Math.max(0, Number(r.rows[0]?.saldo ?? 0));
}
