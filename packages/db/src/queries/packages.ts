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
import { hashEventIdForLog } from '@startap/core/gcal-event-log';
import { logger } from '@startap/core/logger';
import { DEFAULT_TIMEZONE } from '@startap/core/timezones';
import { pool, query } from '../client.js';

const log = logger.child({ module: 'packages-deducao' });

/**
 * Fragmento SQL: "hoje" (DATE) no FUSO DO CLONE (flow_clones.timezone, migration 068), com
 * fallback defensivo pro default '${DEFAULT_TIMEZONE}' quando o slot não tem linha/fuso conhecido.
 *
 * A validade do pacote (client_package_credits.data_expiracao — uma DATE de PAREDE, "vence dia X")
 * TEM de ser comparada contra o dia do RELÓGIO DO DONO, não UTC (SCRUM-46).
 *
 * BUG que isto corrige: antes a comparação usava `(NOW() AT TIME ZONE 'utc')::date`. A partir de
 * ~21h BRT o UTC já virou o dia seguinte, então perto da meia-noite um pacote que vence HOJE
 * aparecia EXPIRADO cedo demais (e um que venceu ONTEM podia parecer válido) — vencido/válido no
 * dia errado. Espelha o fix da coluna atendimentos.data (UTC -> fuso-do-clone).
 *
 * `NOW() AT TIME ZONE <tz>` projeta o instante no relógio de PAREDE do fuso; `::date` extrai o
 * dia-calendário local. Subquery escalar correlacionada por `c.slot` — legal sob GROUP BY (c.slot
 * é funcionalmente dependente de c.id, a PK agrupada) e sob FOR UPDATE OF c (não agrega no nível
 * externo). EXIGE que client_package_credits esteja aliasada como `c` no escopo onde é interpolado.
 * O `${DEFAULT_TIMEZONE}` é constante de código (não input) — sem risco de injeção.
 */
const HOJE_NO_FUSO_DO_CLONE = `(NOW() AT TIME ZONE COALESCE(
        (SELECT fc.timezone FROM flow_clones fc WHERE fc.slot = c.slot), '${DEFAULT_TIMEZONE}'
      ))::date`;

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
  /** true se data_expiracao < hoje NO FUSO DO CLONE (flow_clones.timezone; SCRUM-46). */
  expirado: boolean;
  /** Estado para o bloco de prompt / tool. */
  estado: PackageState;
  /** Serviços que o pacote cobre. Vazio = não cobre nada (regra do ADR §4). */
  servicos_cobertos: string[];
  /** NULL = pacote da casa; preenchido = só vale com aquele colaborador. */
  colaborador_id: number | null;
  /**
   * Preço do PACOTE em centavos (do template), p/ o bot informar "R$ X,XX" quando o
   * cliente perguntar o preço. INFORMATIVO (caixa do barbeiro) — NÃO toca client_billing/
   * AbacatePay/MRR (ADR 0025 §5). NULL = template sem preço cadastrado.
   */
  preco_cents: number | null;
  /** cobre(servicoNome) calculado já considerando o array acima. */
  cobre: (servicoNome: string) => boolean;
}

function toStringArray(v: unknown): string[] {
  if (Array.isArray(v)) return v.filter((x): x is string => typeof x === 'string');
  return [];
}

/**
 * Normaliza nome de serviço para casamento de cobertura: trim + lowercase + dobra de acento
 * (NFD + strip de marcas combinantes). Assim "Hidratação" casa com "Hidratacao", "Pé" com "Pe".
 * NÃO faz sinônimo nem stemming (decisão de produto: o dono cadastra o nome canônico). A direção
 * continua segura: só amplia o casamento de variações de acento da MESMA palavra. Exportado para
 * o package-context usar a MESMA regra (uma fonte da verdade de normalização).
 */
export function normalizeServiceName(s: string): string {
  // NFD separa a letra do diacr\u00edtico; \p{Diacritic} (Unicode property) remove as marcas de
  // acento sem o character-class de combining marks (que o Biome sinaliza como enganoso).
  return s
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .trim()
    .toLowerCase();
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
  preco_cents: number | null;
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
    preco_cents: r.preco_cents === null ? null : Number(r.preco_cents),
    cobre: (servicoNome: string) => {
      const alvo = normalizeServiceName(servicoNome);
      return servicos.some((s) => normalizeServiceName(s) === alvo);
    },
  };
}

/**
 * Lista TODOS os créditos de um cliente (por HMAC) num slot, com saldo/validade/
 * estado JÁ calculados server-side. Inclui EXPIRADO e ESGOTADO explicitamente
 * (não filtra) — o bloco de prompt precisa informar "expirou em DD/MM" / "acabou".
 *
 * O saldo é recomputado do LEDGER (fonte da verdade), não confia no cache
 * sessoes_restantes. LEFT JOIN no ledger cobre crédito sem nenhum movimento
 * (saldo = sessoes_total). data_expiracao < hoje NO FUSO DO CLONE => expirado (SCRUM-46).
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
            (c.data_expiracao < ${HOJE_NO_FUSO_DO_CLONE}) AS expirado,
            c.status        AS status,
            sp.servicos_cobertos AS servicos_cobertos,
            sp.colaborador_id    AS colaborador_id,
            sp.preco_cents       AS preco_cents
       FROM client_package_credits c
       JOIN service_packages sp ON sp.id = c.package_id
       LEFT JOIN package_redemptions pr ON pr.credit_id = c.id
      WHERE c.slot = $1 AND c.cliente_phone_hmac = $2${tenantClause}
      GROUP BY c.id, sp.nome, sp.servicos_cobertos, sp.colaborador_id, sp.preco_cents
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

    // (2) cobertura (server-side; o LLM nunca decide) — acento/caixa-insensível via cobre().
    const cobertos = ativos.filter((c) => c.cobre(input.servicoNome));

    // NEAR-MISS: cliente TEM pacote ativo mas NENHUM cobriu o serviço pedido. Isso é
    // diferente de "cliente sem pacote" e merece rastro pro ops auditar (ex.: divergência
    // de nome de serviço entre o catálogo e o que o LLM gravou no summary). Não loga PII —
    // só slot + serviço + nº de pacotes ativos. Não muda o resultado (continua avulso).
    if (ativos.length > 0 && cobertos.length === 0) {
      log.warn(
        {
          slot: input.slot,
          servicoPedido: input.servicoNome,
          pacotesAtivos: ativos.length,
          servicosCobertosUniao: Array.from(new Set(ativos.flatMap((c) => c.servicos_cobertos))),
        },
        'pacote-near-miss: cliente tem pacote ATIVO mas nenhum cobre o serviço — agenda avulso (auditar nome de serviço)',
      );
    }

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
    //
    // GUARDA anti-over-consumption (defesa em profundidade além do FOR UPDATE OF c): o -1 só
    // é gravado se o saldo do ledger DESTE crédito ainda for > 0 NA MESMA transação (subquery
    // escalar recomputada agora, sob o row-lock). Se duas transações concorrentes do mesmo
    // cliente disputarem a ÚLTIMA sessão, o FOR UPDATE serializa: a 2ª só roda depois do COMMIT
    // da 1ª, vê saldo 0 aqui, e o INSERT não produz linha — `descontou` cai pra avulso (não
    // grava -1 abaixo de zero). NÃO confiamos só no CHECK do cache; barramos no ledger.
    const ins = await client.query(
      `INSERT INTO package_redemptions
         (credit_id, slot, tenant_id, gcal_event_id, colaborador_id, servico_nome, delta, reason)
       SELECT c.id, c.slot, c.tenant_id, $2, $3, $4, -1, 'redeem'
         FROM client_package_credits c
        WHERE c.id = $1
          AND (c.sessoes_total + COALESCE(
                (SELECT SUM(pr.delta) FROM package_redemptions pr WHERE pr.credit_id = c.id), 0
              )) > 0
       ON CONFLICT (gcal_event_id, reason) DO NOTHING`,
      [credito.credit_id, input.gcalEventId, input.colaboradorId ?? null, input.servicoNome],
    );

    // rowCount 0 PODE significar (a) retry do MESMO evento (ON CONFLICT pegou — idempotente,
    // já descontou antes) OU (b) a guarda saldo>0 barrou (corrida perdeu a última sessão). Só
    // o caso (b) precisa virar avulso. Distinguimos checando se já existe um redeem deste
    // evento: existe -> idempotente (descontou=true, sem dupla baixa); não existe -> guarda
    // barrou -> avulso (motivo 'sem_pacote').
    if (ins.rowCount === 0) {
      const ja = await client.query<{ existe: boolean }>(
        `SELECT EXISTS(
           SELECT 1 FROM package_redemptions
            WHERE gcal_event_id = $1 AND reason = 'redeem'
         ) AS existe`,
        [input.gcalEventId],
      );
      if (!ja.rows[0]?.existe) {
        // Guarda barrou: saldo zerou entre o SELECT e o INSERT (corrida). Avulso, sem -1.
        await client.query('COMMIT');
        return {
          descontou_do_pacote: false,
          avulso: true,
          motivo: 'sem_pacote',
          sessoes_restantes: null,
        };
      }
    }

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

// ─────────────────────────────────────────────────────────────────────────────
// BLOCO 2c — LIFECYCLE PÓS-VENDA (painel): RECARGA / MUDAR VENCIMENTO / CANCELAR.
// ADR 0025 — NOVA invariante: o PAINEL agora PODE escrever no ledger, mas SÓ com
// reason='recharge' (delta>0). Distinto de redeem (-1)/refund (+1, casado a evento).
// Recarga NÃO está ligada a um gcal_event_id real — usa uma CHAVE SINTÉTICA própria
// como âncora de idempotência ('recharge:<creditId>:<idempotencyKey>'), gravada na
// coluna gcal_event_id (NOT NULL) para reusar o UNIQUE(gcal_event_id,reason). Duas
// recargas distintas = chaves distintas (somam); retry da MESMA recarga = mesma chave
// (ON CONFLICT DO NOTHING — não dupla-conta). O saldo continua vindo do ledger.
// ─────────────────────────────────────────────────────────────────────────────

/** Como derivar a nova validade numa recarga. Exatamente UM dos dois (ou nenhum = mantém). */
export interface NovaValidade {
  /** Data fixa 'YYYY-MM-DD'. */
  dataExpiracao?: string;
  /** Dias a partir de HOJE (CURRENT_DATE + N), calculado no DB (evita fuso do Node). */
  adicionarDias?: number;
}

export interface RecargaInput {
  slot: string;
  /** Defesa em profundidade (P3 #320): AND tenant_id = $N no escopo do crédito. */
  tenantId?: string;
  creditId: number;
  /** Sessões a SOMAR (>0). Vira sessoes_total += N + redemption delta=+N. */
  sessoes: number;
  /** Opcional: nova validade (data fixa OU dias). Ausente = mantém data_expiracao atual. */
  novaValidade?: NovaValidade;
  /**
   * Chave de idempotência da recarga (UUID gerado pelo chamador por requisição). MESMA chave
   * retried = no-op (não soma 2x). Chaves distintas = recargas distintas (somam). Obrigatória:
   * sem ela não há como distinguir retry de nova recarga.
   */
  idempotencyKey: string;
  /** Quem disparou (operador do painel) — forense, no log e na coluna servico_nome. */
  actor?: string;
}

export interface RecargaResult {
  ok: boolean;
  reason: 'recharged' | 'already_applied' | 'not_found' | 'invalid' | 'erro';
  credit_id?: number;
  /** Saldo DEPOIS da recarga (recomputado do ledger). */
  sessoes_restantes?: number;
  sessoes_total?: number;
  data_expiracao?: string; // 'YYYY-MM-DD'
  status?: string;
}

/**
 * RECARREGA o MESMO crédito (renovação no mesmo card — decisão do Bruno: 1 card por cliente).
 *
 * Fluxo (TUDO numa transação, idempotente sob retry):
 *  1. SELECT ... FOR UPDATE do crédito escopado por slot(+tenant). 404 se não for deste clone.
 *  2. INSERT redemption (delta=+sessoes, reason='recharge') com gcal_event_id sintético
 *     ('recharge:<creditId>:<idempotencyKey>') ON CONFLICT (gcal_event_id,reason) DO NOTHING.
 *     0 linhas = MESMA recarga já aplicada (retry) -> NÃO soma de novo (idempotente). Nesse
 *     caso NÃO altera sessoes_total nem validade (a 1ª chamada já fez tudo).
 *  3. (só se inseriu) UPDATE sessoes_total += sessoes; se novaValidade veio, atualiza
 *     data_expiracao na MESMA transação. O CHECK (sessoes_restantes BETWEEN 0 AND sessoes_total)
 *     continua válido porque sessoes_total CRESCE.
 *  4. rebuildCreditCacheTx recomputa sessoes_restantes do ledger e RE-DERIVA o status: como
 *     o saldo passa a >0, exhausted -> active. (Validade nova futura também tira de "expired"
 *     na próxima leitura, que recalcula expirado por data.) cancelled NÃO é reativado por
 *     recarga: cancelar é decisão explícita do operador — para reativar um cancelado, o
 *     operador usa o endpoint próprio (reativar) que limpa o status antes.
 *
 * Idempotência ABSOLUTA por idempotencyKey: retry exato não soma sessão nem mexe na validade.
 * Escopo slot+tenant em TODA query. Saldo NUNCA fica negativo (recarga é delta>0).
 */
export async function recargaCredit(input: RecargaInput): Promise<RecargaResult> {
  if (!Number.isInteger(input.sessoes) || input.sessoes < 1 || input.sessoes > 1000) {
    return { ok: false, reason: 'invalid' };
  }
  if (!input.idempotencyKey || typeof input.idempotencyKey !== 'string') {
    return { ok: false, reason: 'invalid' };
  }
  // Valida a nova validade (no máximo um dos dois; data no formato; dias na faixa).
  const nv = input.novaValidade;
  if (nv) {
    const hasData = nv.dataExpiracao != null && nv.dataExpiracao !== '';
    const hasDias = nv.adicionarDias != null;
    if (hasData && hasDias) return { ok: false, reason: 'invalid' };
    if (hasData && !/^\d{4}-\d{2}-\d{2}$/.test(String(nv.dataExpiracao))) {
      return { ok: false, reason: 'invalid' };
    }
    if (hasDias && (!Number.isInteger(nv.adicionarDias) || (nv.adicionarDias ?? 0) < 1)) {
      return { ok: false, reason: 'invalid' };
    }
  }

  const syntheticEventId = `recharge:${input.creditId}:${input.idempotencyKey}`;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // (1) trava o crédito; escopa por slot(+tenant). FOR UPDATE serializa recargas concorrentes.
    const params: unknown[] = [input.creditId, input.slot];
    let tenantClause = '';
    if (input.tenantId) {
      params.push(input.tenantId);
      tenantClause = ` AND tenant_id = $${params.length}`;
    }
    const credRes = await client.query<{ id: string; slot: string; tenant_id: string }>(
      `SELECT id::text AS id, slot, tenant_id::text AS tenant_id
         FROM client_package_credits
        WHERE id = $1 AND slot = $2${tenantClause}
        FOR UPDATE`,
      params,
    );
    const cred = credRes.rows[0];
    if (!cred) {
      await client.query('COMMIT');
      return { ok: false, reason: 'not_found' };
    }

    // (2) ledger: append delta=+sessoes, reason='recharge'. tenant_id/slot vêm do PRÓPRIO
    // crédito (já tenant-stamped) — nunca de campo livre. ON CONFLICT cobre retry exato.
    const ins = await client.query(
      `INSERT INTO package_redemptions
         (credit_id, slot, tenant_id, gcal_event_id, colaborador_id, servico_nome, delta, reason)
       SELECT c.id, c.slot, c.tenant_id, $2, NULL, $3, $4, 'recharge'
         FROM client_package_credits c
        WHERE c.id = $1
       ON CONFLICT (gcal_event_id, reason) DO NOTHING`,
      [input.creditId, syntheticEventId, input.actor ?? 'recharge', input.sessoes],
    );

    // 0 linhas = ESTA recarga (mesma idempotencyKey) já foi aplicada antes -> idempotente.
    // NÃO mexe em sessoes_total/validade (a 1ª chamada já fez). Só recomputa e devolve o saldo.
    if (ins.rowCount === 0) {
      const saldo = await rebuildCreditCacheTx(client, input.creditId);
      const snap = await readCreditSnapshotTx(client, input.creditId);
      await client.query('COMMIT');
      return {
        ok: true,
        reason: 'already_applied',
        credit_id: input.creditId,
        sessoes_restantes: saldo,
        sessoes_total: snap.sessoes_total,
        data_expiracao: snap.data_expiracao,
        status: snap.status,
      };
    }

    // (3) cresce sessoes_total (o teto do cache sobe junto) + nova validade se veio. NUNCA
    // dropa coluna; só UPDATE. A nova validade é resolvida no DB (sem fuso do Node).
    const setVal: string[] = ['sessoes_total = sessoes_total + $2'];
    const upParams: unknown[] = [input.creditId, input.sessoes];
    if (nv?.dataExpiracao) {
      upParams.push(nv.dataExpiracao);
      setVal.push(`data_expiracao = $${upParams.length}::date`);
    } else if (nv?.adicionarDias != null) {
      upParams.push(nv.adicionarDias);
      setVal.push(`data_expiracao = CURRENT_DATE + ($${upParams.length}::int)`);
    }
    await client.query(
      `UPDATE client_package_credits SET ${setVal.join(', ')}, updated_at = NOW() WHERE id = $1`,
      upParams,
    );

    // (4) recomputa cache + RE-DERIVA status (exhausted -> active porque saldo subiu).
    const saldo = await rebuildCreditCacheTx(client, input.creditId);
    const snap = await readCreditSnapshotTx(client, input.creditId);
    await client.query('COMMIT');

    log.info(
      {
        slot: input.slot,
        creditId: input.creditId,
        sessoesAdd: input.sessoes,
        novaValidade:
          nv?.dataExpiracao ?? (nv?.adicionarDias != null ? `+${nv.adicionarDias}d` : 'mantida'),
        actor: input.actor ?? 'recharge',
      },
      'recargaCredit: crédito recarregado (renovação no mesmo card)',
    );
    return {
      ok: true,
      reason: 'recharged',
      credit_id: input.creditId,
      sessoes_restantes: saldo,
      sessoes_total: snap.sessoes_total,
      data_expiracao: snap.data_expiracao,
      status: snap.status,
    };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    log.error(
      { err: err instanceof Error ? err.message : String(err), slot: input.slot },
      'recargaCredit falhou',
    );
    return { ok: false, reason: 'erro' };
  } finally {
    client.release();
  }
}

export interface MudarVencimentoInput {
  slot: string;
  tenantId?: string;
  creditId: number;
  /** Exatamente um: data fixa OU dias a partir de hoje. */
  dataExpiracao?: string;
  adicionarDias?: number;
  actor?: string;
}

export interface MudarVencimentoResult {
  ok: boolean;
  reason: 'updated' | 'not_found' | 'invalid' | 'erro';
  credit_id?: number;
  data_expiracao?: string;
  status?: string;
  sessoes_restantes?: number;
}

/**
 * MUDA o vencimento (data_expiracao) de um crédito. NÃO toca o ledger (não é movimento de
 * saldo). Escopo slot(+tenant). Após o UPDATE, recomputa o cache/status via rebuild para
 * re-derivar 'active' a partir de 'exhausted' se o saldo for >0 (estender a validade de um
 * crédito com saldo o reativa na próxima leitura, que recalcula 'expirado' por data).
 * cancelled NÃO é reativado aqui (decisão explícita do operador).
 */
export async function mudarVencimento(input: MudarVencimentoInput): Promise<MudarVencimentoResult> {
  const hasData = input.dataExpiracao != null && input.dataExpiracao !== '';
  const hasDias = input.adicionarDias != null;
  if (hasData === hasDias) return { ok: false, reason: 'invalid' }; // precisa de EXATAMENTE um
  if (hasData && !/^\d{4}-\d{2}-\d{2}$/.test(String(input.dataExpiracao))) {
    return { ok: false, reason: 'invalid' };
  }
  if (hasDias && (!Number.isInteger(input.adicionarDias) || (input.adicionarDias ?? 0) < 1)) {
    return { ok: false, reason: 'invalid' };
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const params: unknown[] = [input.creditId, input.slot];
    let tenantClause = '';
    if (input.tenantId) {
      params.push(input.tenantId);
      tenantClause = ` AND tenant_id = $${params.length}`;
    }
    // SET por data fixa OU dias. O placeholder da validade vem DEPOIS do escopo p/ não colidir.
    params.push(hasData ? input.dataExpiracao : input.adicionarDias);
    const validadeExpr = hasData
      ? `$${params.length}::date`
      : `CURRENT_DATE + ($${params.length}::int)`;
    const upd = await client.query<{ id: string }>(
      `UPDATE client_package_credits
          SET data_expiracao = ${validadeExpr}, updated_at = NOW()
        WHERE id = $1 AND slot = $2${tenantClause}
        RETURNING id::text AS id`,
      params,
    );
    if (upd.rowCount === 0) {
      await client.query('COMMIT');
      return { ok: false, reason: 'not_found' };
    }
    const saldo = await rebuildCreditCacheTx(client, input.creditId);
    const snap = await readCreditSnapshotTx(client, input.creditId);
    await client.query('COMMIT');
    log.info(
      {
        slot: input.slot,
        creditId: input.creditId,
        novaValidade: hasData ? input.dataExpiracao : `+${input.adicionarDias}d`,
        actor: input.actor ?? 'manual',
      },
      'mudarVencimento: data_expiracao atualizada',
    );
    return {
      ok: true,
      reason: 'updated',
      credit_id: input.creditId,
      data_expiracao: snap.data_expiracao,
      status: snap.status,
      sessoes_restantes: saldo,
    };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    log.error(
      { err: err instanceof Error ? err.message : String(err), slot: input.slot },
      'mudarVencimento falhou',
    );
    return { ok: false, reason: 'erro' };
  } finally {
    client.release();
  }
}

export interface CancelarCreditoInput {
  slot: string;
  tenantId?: string;
  creditId: number;
  actor?: string;
}

export interface CancelarCreditoResult {
  ok: boolean;
  reason: 'cancelled' | 'not_found' | 'erro';
  credit_id?: number;
  status?: string;
}

/**
 * CANCELA um crédito (status='cancelled'). NÃO mexe no ledger (o histórico de consumo fica
 * intacto — append-only). Marca o crédito como inutilizável: deriveEstado() devolve CANCELADO
 * e o bot nunca desconta dele. rebuildCreditCacheTx PRESERVA 'cancelled' (não re-deriva).
 * Reversível pelo endpoint de reativar/recarregar (que limpa o status antes). Escopo slot(+tenant).
 */
export async function cancelarCredito(input: CancelarCreditoInput): Promise<CancelarCreditoResult> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const params: unknown[] = [input.creditId, input.slot];
    let tenantClause = '';
    if (input.tenantId) {
      params.push(input.tenantId);
      tenantClause = ` AND tenant_id = $${params.length}`;
    }
    const upd = await client.query<{ status: string }>(
      `UPDATE client_package_credits
          SET status = 'cancelled', updated_at = NOW()
        WHERE id = $1 AND slot = $2${tenantClause}
        RETURNING status`,
      params,
    );
    if (upd.rowCount === 0) {
      await client.query('COMMIT');
      return { ok: false, reason: 'not_found' };
    }
    await client.query('COMMIT');
    log.info(
      { slot: input.slot, creditId: input.creditId, actor: input.actor ?? 'manual' },
      'cancelarCredito: crédito marcado como cancelled (ledger intacto)',
    );
    return { ok: true, reason: 'cancelled', credit_id: input.creditId, status: 'cancelled' };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    log.error(
      { err: err instanceof Error ? err.message : String(err), slot: input.slot },
      'cancelarCredito falhou',
    );
    return { ok: false, reason: 'erro' };
  } finally {
    client.release();
  }
}

/**
 * REATIVA um crédito cancelled: limpa o status (volta a 'active'/'exhausted'/'expired' conforme
 * saldo+validade) e recarrega o crédito. Necessário porque rebuildCreditCacheTx PRESERVA
 * 'cancelled' — sem limpar antes, a recarga não conseguiria sair de CANCELADO. Para esgotado/
 * expirado SEM cancelamento, basta recargaCredit direto (este wrapper só adiciona o passo de
 * limpar 'cancelled'). Idempotente pela própria recargaCredit (idempotencyKey).
 */
export async function reativarCredito(input: RecargaInput): Promise<RecargaResult> {
  const client = await pool.connect();
  try {
    const params: unknown[] = [input.creditId, input.slot];
    let tenantClause = '';
    if (input.tenantId) {
      params.push(input.tenantId);
      tenantClause = ` AND tenant_id = $${params.length}`;
    }
    // Tira de 'cancelled' SÓ se estiver cancelled (idempotente). rebuildCreditCacheTx dentro
    // de recargaCredit re-deriva o status final a partir do saldo. Escopo slot(+tenant).
    const upd = await client.query(
      `UPDATE client_package_credits
          SET status = 'active', updated_at = NOW()
        WHERE id = $1 AND slot = $2${tenantClause} AND status = 'cancelled'`,
      params,
    );
    if (upd.rowCount === 0) {
      // Não estava cancelled (ou não existe). Segue pra recarga: se não existe, ela devolve
      // not_found; se existe e não estava cancelled, a recarga reativa esgotado/expirado igual.
      const exists = await query<{ id: string }>(
        `SELECT id::text AS id FROM client_package_credits WHERE id = $1 AND slot = $2${tenantClause}`,
        params,
      );
      if (exists.rowCount === 0) return { ok: false, reason: 'not_found' };
    }
  } finally {
    client.release();
  }
  // Recarrega (soma sessões + nova validade + re-deriva status) numa transação própria.
  return recargaCredit(input);
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
 *
 * ⚠️ SCRUM-148 item 2: o gcalEventId sai HASHEADO (mesmo `hashEventIdForLog` do SCRUM-91/#531).
 * Diferente do reconcile-packages (cron OFF hoje), ESTE hook roda em PROD a cada dedução de
 * pacote — era o sink cru de maior volume. O id cru continua na linha do ledger.
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
      gcalEventId: hashEventIdForLog(entry.gcalEventId),
      creditId: entry.creditId,
      servico: entry.servicoNome,
      stub: true,
    },
    'reconciliation-hook: desconto registrado (dívida cancelar+reagendar — rastro p/ job futuro)',
  );
}

/** Uma suspeita de dupla-baixa por cancelar+reagendar (heurística, sem PII). */
export interface SuspectDoubleRedeem {
  credit_id: number;
  slot: string;
  servico_nome: string;
  /** Quantos 'redeem' do MESMO serviço no MESMO crédito dentro da janela. */
  redeems: number;
  /** Quantos 'refund' já lançados nesse crédito na janela (compensação parcial). */
  refunds: number;
  /** Eventos GCal envolvidos (para o ops cruzar com a agenda). */
  gcal_event_ids: string[];
  primeiro: string; // ISO do redeem mais antigo na janela
  ultimo: string; // ISO do redeem mais recente na janela
}

/**
 * RELATÓRIO de reconciliação (READ-ONLY) — ADR 0025 dívida 5, mitigação de runtime.
 *
 * Varre o ledger procurando a ASSINATURA de cancelar+reagendar: 2+ 'redeem' do MESMO serviço
 * no MESMO crédito dentro de `janelaHoras` (default 48h), com mais redeems que refunds (ou
 * seja, baixa líquida > 1 num atendimento que deveria ser 1). NÃO estorna nada — só devolve a
 * lista para o job/ops AGIR (refund manual). Sem PII: agrega por crédito+serviço, nunca toca
 * telefone. Escopado por slot quando fornecido; sem slot, varre todos (uso do cron global).
 *
 * É deliberadamente conservador (heurística): pode ter falso-positivo legítimo (cliente que
 * de fato fez 2 cortes em 2 dias) — por isso é RELATÓRIO pra humano, não auto-refund.
 */
export async function findSuspectDoubleRedeems(input?: {
  slot?: string;
  janelaHoras?: number;
  limit?: number;
}): Promise<SuspectDoubleRedeem[]> {
  const janelaHoras = input?.janelaHoras ?? 48;
  const limit = input?.limit ?? 200;
  const params: unknown[] = [janelaHoras, limit];
  let slotClause = '';
  if (input?.slot) {
    params.push(input.slot);
    slotClause = ` AND pr.slot = $${params.length}`;
  }
  // Agrupa redeems do MESMO (credit_id, servico_nome) na janela; conta refunds do crédito na
  // mesma janela como compensação. Sinaliza só quando redeems - refunds > 1.
  const r = await query<{
    credit_id: string | number;
    slot: string;
    servico_nome: string | null;
    redeems: string | number;
    refunds: string | number;
    gcal_event_ids: string[];
    primeiro: string;
    ultimo: string;
  }>(
    `WITH redeems AS (
       SELECT pr.credit_id, pr.slot, pr.servico_nome,
              COUNT(*)                       AS redeems,
              array_agg(pr.gcal_event_id)    AS gcal_event_ids,
              MIN(pr.created_at)             AS primeiro,
              MAX(pr.created_at)             AS ultimo
         FROM package_redemptions pr
        WHERE pr.reason = 'redeem'
          AND pr.created_at >= NOW() - ($1 || ' hours')::interval${slotClause}
        GROUP BY pr.credit_id, pr.slot, pr.servico_nome
       HAVING COUNT(*) > 1
     ),
     refunds AS (
       SELECT pr.credit_id, COUNT(*) AS refunds
         FROM package_redemptions pr
        WHERE pr.reason = 'refund'
          AND pr.created_at >= NOW() - ($1 || ' hours')::interval
        GROUP BY pr.credit_id
     )
     SELECT rd.credit_id, rd.slot, rd.servico_nome,
            rd.redeems::int                              AS redeems,
            COALESCE(rf.refunds, 0)::int                 AS refunds,
            rd.gcal_event_ids                            AS gcal_event_ids,
            to_char(rd.primeiro AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS primeiro,
            to_char(rd.ultimo   AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS ultimo
       FROM redeems rd
       LEFT JOIN refunds rf ON rf.credit_id = rd.credit_id
      WHERE rd.redeems - COALESCE(rf.refunds, 0) > 1
      ORDER BY rd.ultimo DESC
      LIMIT $2`,
    params,
  );
  return r.rows.map((row) => ({
    credit_id: Number(row.credit_id),
    slot: row.slot,
    servico_nome: row.servico_nome ?? '',
    redeems: Number(row.redeems),
    refunds: Number(row.refunds),
    gcal_event_ids: Array.isArray(row.gcal_event_ids) ? row.gcal_event_ids : [],
    primeiro: row.primeiro,
    ultimo: row.ultimo,
  }));
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
  // PostgreSQL 16 PROÍBE locking clause (FOR UPDATE) com GROUP BY (erro 0A000). Por isso o
  // saldo do ledger vem de SUBQUERY ESCALAR CORRELACIONADA (SUM(pr.delta) por credit_id), NÃO
  // de GROUP BY + agregado no SELECT externo. Sem agregação no nível externo, o
  // `FOR UPDATE OF c` é legal e trava SÓ as linhas de client_package_credits (serializa
  // dois agendamentos concorrentes do MESMO cliente que disputam a última sessão).
  const r = await client.query<CreditRowRaw>(
    `SELECT c.id            AS credit_id,
            c.package_id    AS package_id,
            c.slot          AS slot,
            sp.nome         AS nome,
            c.sessoes_total AS sessoes_total,
            c.sessoes_restantes AS sessoes_restantes_cache,
            (c.sessoes_total + COALESCE(
              (SELECT SUM(pr.delta) FROM package_redemptions pr WHERE pr.credit_id = c.id), 0)
            ) AS saldo_ledger,
            to_char(c.data_expiracao, 'YYYY-MM-DD')        AS data_expiracao,
            (c.data_expiracao < ${HOJE_NO_FUSO_DO_CLONE}) AS expirado,
            c.status        AS status,
            sp.servicos_cobertos AS servicos_cobertos,
            sp.colaborador_id    AS colaborador_id,
            sp.preco_cents       AS preco_cents
       FROM client_package_credits c
       JOIN service_packages sp ON sp.id = c.package_id
      WHERE c.slot = $1 AND c.cliente_phone_hmac = $2${tenantClause}
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

/**
 * Lê o snapshot pós-update de um crédito (total/validade/status) DENTRO da transação, para
 * o lifecycle devolver o estado final ao painel. Read-only; não toca o ledger.
 */
async function readCreditSnapshotTx(
  client: PgLikeClient,
  creditId: number,
): Promise<{ sessoes_total: number; data_expiracao: string; status: string }> {
  const r = await client.query<{
    sessoes_total: number;
    data_expiracao: string;
    status: string;
  }>(
    `SELECT sessoes_total,
            to_char(data_expiracao, 'YYYY-MM-DD') AS data_expiracao,
            status
       FROM client_package_credits WHERE id = $1`,
    [creditId],
  );
  const row = r.rows[0];
  return {
    sessoes_total: Number(row?.sessoes_total ?? 0),
    data_expiracao: row?.data_expiracao ?? '',
    status: row?.status ?? '',
  };
}
