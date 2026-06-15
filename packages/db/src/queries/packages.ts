/**
 * packages — camada de LEITURA read-only de pacotes de serviço (ADR 0025, BLOCO 2a).
 *
 * Este módulo só calcula e lê. NÃO escreve em service_packages /
 * client_package_credits / package_redemptions — a DEDUÇÃO transacional (escrita
 * no ledger + atualização de sessoes_restantes dentro de inserir_agendamento, sob
 * action-lock) é o BLOCO 2b, num PR separado por ser a parte de maior risco.
 *
 * Tudo aqui é escopado por `slot` (tenant key atual, ADR 0007). O telefone do
 * cliente entra SEMPRE como HMAC (packagePhoneHmac, pepper PRÓPRIO de pacotes —
 * o caller hasheia; este módulo nunca vê o número cru). Saldo/validade/cobertura/
 * escopo são calculados AQUI (server-side) — o LLM nunca raciocina saldo.
 *
 * FONTE DA VERDADE do saldo = ledger (package_redemptions): saldo = sessoes_total
 * + SUM(delta). sessoes_restantes em client_package_credits é cache; este módulo
 * recomputa do ledger e usa o cache só como cross-check de consistência (log).
 */
import { query } from '../client.js';

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
 */
export async function listActiveTemplates(slot: string): Promise<ServicePackageTemplate[]> {
  const r = await query<TemplateRowRaw>(
    `SELECT ${TEMPLATE_COLS}
       FROM service_packages
      WHERE slot = $1 AND ativo = TRUE
      ORDER BY nome ASC`,
    [slot],
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
}): Promise<ClientPackageCredit[]> {
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
      WHERE c.slot = $1 AND c.cliente_phone_hmac = $2
      GROUP BY c.id, sp.nome, sp.servicos_cobertos, sp.colaborador_id
      ORDER BY c.data_expiracao ASC, c.data_compra ASC`,
    [input.slot, input.phoneHmac],
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
}): Promise<ClientPackageCredit[]> {
  const all = await listClientCredits(input);
  return all.filter((c) => c.estado === 'ATIVO');
}
