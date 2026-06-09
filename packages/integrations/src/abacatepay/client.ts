/**
 * Cliente AbacatePay — cobrancas PIX (ADR 0013, Fase 1).
 *
 * Espelha o estilo de google-calendar/waha: classe instanciada com config injetada
 * ({ apiKey, baseUrl }) — NUNCA le a chave de process.env aqui. O app (apps/api ou
 * apps/worker) le ABACATEPAY_API_KEY/ABACATEPAY_BASE_URL do Zod config e injeta.
 * Isso mantem o package testavel (mock de fetch) e a chave fora do código.
 *
 * Ambiente Dev/Prod e definido PELA CHAVE (nao pela URL) — trocar Dev->Prod e so
 * rotacionar a key no .env, sem mudar codigo.
 *
 * Valores SEMPRE em CENTAVOS.
 *
 * Seguranca (C9 / threat-model): a key vai no header Authorization e NUNCA e logada.
 * Erros da API sao tipados (AbacatePayError) com status + corpo, sem vazar a key.
 */
import { logger } from '@startap/core/logger';

const log = logger.child({ module: 'abacatepay' });

const DEFAULT_BASE_URL = 'https://api.abacatepay.com';
// Timeout explicito (regra de ouro: nunca aguardar integracao externa infinito).
const REQUEST_TIMEOUT_MS = 15_000;

// ─── Tipos ────────────────────────────────────────────────────────────────────

export interface AbacatePayConfig {
  /**
   * Pode ser undefined: pagamento e feature DORMENTE e a key e OPCIONAL no boot dos apps
   * (postmortem P0 2026-06-09). O construtor valida e lanca AbacatePayNotConfiguredError
   * se faltar — falha SO no ponto de uso, nunca no boot do app.
   */
  apiKey: string | undefined;
  /** Default https://api.abacatepay.com. O ambiente e definido pela CHAVE, nao pela URL. */
  baseUrl?: string;
}

export interface CreatePixChargeInput {
  slot: string;
  cycle: string; // 'YYYY-MM'
  amountCents: number; // CENTAVOS
  description: string;
  /** Validade do PIX em segundos. */
  expiresInSec: number;
}

/** Subconjunto do retorno da AbacatePay que nos importa (data.*). */
export interface PixCharge {
  id: string; // 'pix_char_*'
  brCode: string; // copia-e-cola
  brCodeBase64: string; // QR data-URI
  status: PixChargeStatus;
  expiresAt: string | null; // ISO
  platformFee: number | null; // centavos (taxa do gateway)
}

export interface PixChargeStatusResult {
  id: string;
  status: PixChargeStatus;
  /** Valor efetivamente pago em centavos (preenchido quando PAID). */
  paidAmountCents: number | null;
}

/** Status da AbacatePay normalizado em minusculas no nosso lado. */
export type PixChargeStatus = 'pending' | 'paid' | 'expired' | 'cancelled' | 'refunded' | string;

/**
 * Erro tipado: a feature de pagamento foi acionada SEM ABACATEPAY_API_KEY configurada.
 *
 * A key e OPCIONAL no boot dos apps (feature dormente — postmortem P0 2026-06-09). A
 * exigencia mora aqui, no PONTO DE USO: ao instanciar o cliente pra falar com o gateway,
 * se a chave faltar, falha alta e explicita — mas SO quando a feature realmente roda,
 * nunca no boot do app. Mensagem nao carrega segredo.
 */
export class AbacatePayNotConfiguredError extends Error {
  constructor() {
    super(
      'AbacatePay nao configurado: defina ABACATEPAY_API_KEY no ambiente antes de gerar/consultar cobrancas PIX.',
    );
    this.name = 'AbacatePayNotConfiguredError';
  }
}

/** Erro tipado de chamada a API — nunca carrega a apiKey. */
export class AbacatePayError extends Error {
  readonly status: number;
  readonly endpoint: string;
  readonly body: string;
  constructor(endpoint: string, status: number, body: string) {
    super(`AbacatePay ${endpoint} -> HTTP ${status}`);
    this.name = 'AbacatePayError';
    this.status = status;
    this.endpoint = endpoint;
    // Trunca o corpo pra nao despejar payload gigante em log/erro.
    this.body = body.slice(0, 500);
  }
}

// ─── Mapeamento de status do gateway -> nosso enum ──────────────────────────────

function normalizeStatus(raw: unknown): PixChargeStatus {
  const s = String(raw ?? '').toUpperCase();
  switch (s) {
    case 'PAID':
      return 'paid';
    case 'PENDING':
      return 'pending';
    case 'EXPIRED':
      return 'expired';
    case 'CANCELLED':
    case 'CANCELED':
      return 'cancelled';
    case 'REFUNDED':
      return 'refunded';
    default:
      return s.toLowerCase();
  }
}

// ─── Cliente ────────────────────────────────────────────────────────────────────

export class AbacatePayClient {
  private readonly apiKey: string;
  private readonly baseUrl: string;

  constructor(cfg: AbacatePayConfig) {
    if (!cfg.apiKey) {
      // Ponto de uso: a feature foi acionada sem a chave. Falha tipada e explicita aqui,
      // nunca no boot do app (key e opcional no config — postmortem P0 2026-06-09).
      throw new AbacatePayNotConfiguredError();
    }
    this.apiKey = cfg.apiKey;
    this.baseUrl = (cfg.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
  }

  private async request<T>(method: 'GET' | 'POST', endpoint: string, body?: unknown): Promise<T> {
    const url = `${this.baseUrl}${endpoint}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    let res: Response;
    try {
      res = await fetch(url, {
        method,
        headers: {
          // A key vai SO no header. NUNCA logar este objeto.
          Authorization: `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      // Log sem URL completa de auth e sem key. endpoint e seguro (path fixo).
      log.error({ endpoint, error: msg }, 'AbacatePay request falhou (rede/timeout)');
      throw new AbacatePayError(endpoint, 0, msg);
    } finally {
      clearTimeout(timer);
    }

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      // Loga status + endpoint, NUNCA a key nem o brCode/PII do corpo.
      log.error({ endpoint, status: res.status }, 'AbacatePay HTTP nao-2xx');
      throw new AbacatePayError(endpoint, res.status, text);
    }

    return (await res.json()) as T;
  }

  /**
   * Cria uma cobranca PIX transparente (POST /v2/transparents/create).
   *
   * externalId = "{slot}-{cycle}" e metadata.slot/cycle amarram a cobranca ao nosso
   * slot/ciclo (gancho usado pelo webhook na F2). amount em CENTAVOS.
   */
  async createPixCharge(input: CreatePixChargeInput): Promise<PixCharge> {
    const externalId = `${input.slot}-${input.cycle}`;
    const payload = {
      method: 'PIX' as const,
      data: {
        amount: input.amountCents,
        description: input.description,
        expiresIn: input.expiresInSec,
        externalId,
        metadata: { slot: input.slot, cycle: input.cycle },
      },
    };

    const json = await this.request<{ data?: RawCharge } | RawCharge>(
      'POST',
      '/v2/transparents/create',
      payload,
    );
    return mapCharge(unwrap(json), '/v2/transparents/create');
  }

  /**
   * Consulta o status atual de uma cobranca (GET /v2/transparents/check?id={id}).
   * Usado pela reconciliacao (F2) como rede de seguranca se um webhook se perder.
   */
  async getChargeStatus(chargeId: string): Promise<PixChargeStatusResult> {
    const json = await this.request<{ data?: RawCharge } | RawCharge>(
      'GET',
      `/v2/transparents/check?id=${encodeURIComponent(chargeId)}`,
    );
    const raw = unwrap(json);
    return {
      id: String(raw.id ?? chargeId),
      status: normalizeStatus(raw.status),
      paidAmountCents: toIntOrNull(raw.paidAmount ?? raw.paid_amount),
    };
  }
}

// ─── Helpers de parsing do retorno ──────────────────────────────────────────────

interface RawCharge {
  id?: unknown;
  brCode?: unknown;
  brCodeBase64?: unknown;
  status?: unknown;
  expiresAt?: unknown;
  platformFee?: unknown;
  paidAmount?: unknown;
  paid_amount?: unknown;
}

/** AbacatePay v2 retorna `{ data: {...} }`; tolera retorno plano em mocks/testes. */
function unwrap(json: { data?: RawCharge } | RawCharge): RawCharge {
  if (json && typeof json === 'object' && 'data' in json && json.data) {
    return json.data as RawCharge;
  }
  return json as RawCharge;
}

function mapCharge(raw: RawCharge, endpoint: string): PixCharge {
  const id = raw.id;
  if (typeof id !== 'string' || !id) {
    throw new AbacatePayError(endpoint, 502, 'resposta sem id de cobranca');
  }
  return {
    id,
    brCode: typeof raw.brCode === 'string' ? raw.brCode : '',
    brCodeBase64: typeof raw.brCodeBase64 === 'string' ? raw.brCodeBase64 : '',
    status: normalizeStatus(raw.status),
    expiresAt: typeof raw.expiresAt === 'string' ? raw.expiresAt : null,
    platformFee: toIntOrNull(raw.platformFee),
  };
}

function toIntOrNull(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return Math.round(v);
  if (typeof v === 'string' && v.trim() !== '' && !Number.isNaN(Number(v))) {
    return Math.round(Number(v));
  }
  return null;
}
