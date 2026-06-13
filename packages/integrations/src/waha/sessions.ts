/**
 * Gerenciamento de sessões WAHA — criar, iniciar, parar, QR, status, logout,
 * código de pareamento e orquestração de reconexão (ADR 0015).
 *
 * Reutiliza WAHA_URL e WAHA_API_KEY do ambiente (mesmos do client.ts).
 *
 * TIMEOUT: TODA chamada WAHA passa por wahaReq/wahaFetch com AbortController
 * (default 8s, configurável por opts). A auditoria 2026-06-10 apontou ausência
 * total de timeout aqui — sem isso, uma instabilidade do WAHA penduraria o
 * portal-api indefinidamente (regra de ouro: nunca aguardar integração externa
 * por tempo infinito).
 */

const WAHA_URL = process.env.WAHA_URL ?? 'http://waha:3000';
const WAHA_API_KEY = process.env.WAHA_API_KEY ?? '';

/** Timeout default (ms) por chamada WAHA. */
export const DEFAULT_WAHA_TIMEOUT_MS = 8_000;

/** Opções comuns a toda chamada WAHA: timeout e/ou um AbortSignal externo. */
export interface WahaCallOpts {
  /** Timeout por chamada (ms). Default DEFAULT_WAHA_TIMEOUT_MS. */
  timeoutMs?: number;
  /** Signal externo (ex.: encadear um deadline maior do orquestrador). */
  signal?: AbortSignal;
}

/**
 * Erro tipado de timeout/aborto de chamada WAHA — o chamador pode distinguir
 * "WAHA demorou demais" de "WAHA respondeu erro" e traduzir em 504/503.
 */
export class WahaTimeoutError extends Error {
  readonly path: string;
  constructor(path: string, timeoutMs: number) {
    super(`WAHA timeout após ${timeoutMs}ms em ${path}`);
    this.name = 'WahaTimeoutError';
    this.path = path;
  }
}

/**
 * Erro tipado de estado incompatível (ex.: pedir QR fora de SCAN_QR_CODE). O
 * chamador (portal-api) traduz em 409 com o status atual no corpo.
 */
export class WahaWrongStateError extends Error {
  readonly status: string;
  constructor(message: string, status: string) {
    super(message);
    this.name = 'WahaWrongStateError';
    this.status = status;
  }
}

/**
 * Erro tipado de sessão INEXISTENTE no WAHA (HTTP 404 em GET /api/sessions/{name}).
 * Distinto de um erro genérico de rede/timeout: significa que a sessão foi
 * descartada (ex.: deploy/restart do WAHA entre o cadastro e o pareamento — bug
 * sistêmico de onboarding). O chamador (portal-api) usa este sinal para RECRIAR a
 * sessão com a config-padrão do provisionamento e seguir pro pareamento, em vez de
 * tratar como "WAHA fora" (503). NUNCA confundir com WahaTimeoutError — só 404.
 */
export class WahaSessionNotFoundError extends Error {
  readonly session: string;
  constructor(session: string) {
    super(`WAHA: sessão "${session}" não existe (404)`);
    this.name = 'WahaSessionNotFoundError';
    this.session = session;
  }
}

function headers(): Record<string, string> {
  const h: Record<string, string> = { 'Content-Type': 'application/json' };
  if (WAHA_API_KEY) h['X-Api-Key'] = WAHA_API_KEY;
  return h;
}

/**
 * Une o signal externo (se houver) com o AbortController de timeout local: o
 * fetch aborta no que disparar primeiro (timeout OU deadline do orquestrador).
 */
function buildSignal(opts: WahaCallOpts | undefined): {
  signal: AbortSignal;
  cleanup: () => void;
  timedOut: () => boolean;
} {
  const timeoutMs = opts?.timeoutMs ?? DEFAULT_WAHA_TIMEOUT_MS;
  const controller = new AbortController();
  let didTimeout = false;
  const timer = setTimeout(() => {
    didTimeout = true;
    controller.abort();
  }, timeoutMs);

  const external = opts?.signal;
  const onExternalAbort = () => controller.abort();
  if (external) {
    if (external.aborted) controller.abort();
    else external.addEventListener('abort', onExternalAbort, { once: true });
  }

  return {
    signal: controller.signal,
    timedOut: () => didTimeout,
    cleanup: () => {
      clearTimeout(timer);
      if (external) external.removeEventListener('abort', onExternalAbort);
    },
  };
}

/** fetch com timeout/abort embutido. Lança WahaTimeoutError se estourar o tempo. */
async function wahaFetch(path: string, init: RequestInit, opts?: WahaCallOpts): Promise<Response> {
  const { signal, cleanup, timedOut } = buildSignal(opts);
  try {
    return await fetch(`${WAHA_URL}${path}`, { ...init, signal });
  } catch (err) {
    if (timedOut() || (err instanceof Error && err.name === 'AbortError')) {
      throw new WahaTimeoutError(path, opts?.timeoutMs ?? DEFAULT_WAHA_TIMEOUT_MS);
    }
    throw err;
  } finally {
    cleanup();
  }
}

async function wahaReq<T = unknown>(
  method: 'GET' | 'POST',
  path: string,
  body?: unknown,
  opts?: WahaCallOpts,
): Promise<T> {
  const res = await wahaFetch(
    path,
    {
      method,
      headers: headers(),
      body: body !== undefined ? JSON.stringify(body) : undefined,
    },
    opts,
  );
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    // WAHA retorna 422 ou 409 quando sessão já existe
    if (res.status === 409 || (res.status === 422 && text.toLowerCase().includes('already'))) {
      throw new Error(`WAHA: nome de sessão já em uso: ${path}`);
    }
    throw new Error(`WAHA sessoes ${path} -> HTTP ${res.status}: ${text}`);
  }
  // 204 No Content — sem body
  if (res.status === 204) return undefined as unknown as T;
  return (await res.json()) as T;
}

export interface SessionStatusResponse {
  name: string;
  status: string;
  me?: { id: string; pushName: string } | null;
}

/**
 * Cria uma sessão WAHA nova e inicia automaticamente.
 * WAHA v2+: POST /api/sessions com body {name, start:true}.
 */
export async function createSession(
  name: string,
  opts?: WahaCallOpts,
): Promise<SessionStatusResponse> {
  return wahaReq<SessionStatusResponse>('POST', '/api/sessions', { name, start: true }, opts);
}

/**
 * Inicia uma sessão já existente (útil se foi criada sem start:true).
 */
export async function startSession(
  name: string,
  opts?: WahaCallOpts,
): Promise<SessionStatusResponse> {
  return wahaReq<SessionStatusResponse>('POST', `/api/sessions/${name}/start`, {}, opts);
}

/**
 * Para uma sessão sem fazer logout (mantém autenticação).
 */
export async function stopSession(name: string, opts?: WahaCallOpts): Promise<void> {
  await wahaReq('POST', `/api/sessions/${name}/stop`, {}, opts);
}

/**
 * Reinicia a sessão (FAILED/STOPPED/STARTING -> SCAN_QR_CODE). NÃO faz logout —
 * preserva a autenticação. WAHA: POST /api/sessions/{name}/restart.
 */
export async function restartSession(
  name: string,
  opts?: WahaCallOpts,
): Promise<SessionStatusResponse> {
  return wahaReq<SessionStatusResponse>('POST', `/api/sessions/${name}/restart`, {}, opts);
}

/**
 * Retorna QR code como string base64 PNG ("data:image/png;base64,...").
 * Se sessão já está WORKING, retorna {connected:true, qr:null}.
 *
 * GUARD (ADR 0015): o QR só existe em SCAN_QR_CODE. Em qualquer outro estado não
 * terminal (STARTING/FAILED/STOPPED) lança WahaWrongStateError — o portal-api
 * traduz em 409 e instrui o cliente a reconectar antes. Evita servir QR
 * inválido/expirado de uma sessão que ainda não está pronta para parear.
 */
export async function getSessionQR(
  name: string,
  opts?: WahaCallOpts,
): Promise<{ qr: string } | { connected: true; qr: null }> {
  const status = await getSessionStatus(name, opts);
  if (status.status === 'WORKING') return { connected: true, qr: null };
  if (status.status !== 'SCAN_QR_CODE') {
    throw new WahaWrongStateError(
      `QR indisponível: sessão em ${status.status} (precisa estar em SCAN_QR_CODE)`,
      status.status,
    );
  }

  // WAHA pode retornar PNG binário ou JSON {value: "data:image/png;base64,..."}
  const res = await wahaFetch(
    `/api/${name}/auth/qr`,
    { headers: WAHA_API_KEY ? { 'X-Api-Key': WAHA_API_KEY } : {} },
    opts,
  );

  if (!res.ok) {
    // Tenta endpoint alternativo
    const res2 = await wahaFetch(
      `/api/sessions/${name}/auth/qr`,
      { headers: WAHA_API_KEY ? { 'X-Api-Key': WAHA_API_KEY } : {} },
      opts,
    );
    if (!res2.ok) {
      const text = await res2.text().catch(() => '');
      throw new Error(`WAHA: falha ao obter QR para sessão "${name}": ${text}`);
    }
    return normalizeQrResponse(res2);
  }
  return normalizeQrResponse(res);
}

async function normalizeQrResponse(
  res: Response,
): Promise<{ qr: string } | { connected: true; qr: null }> {
  const contentType = res.headers.get('content-type') ?? '';

  if (contentType.includes('image/png')) {
    const buf = Buffer.from(await res.arrayBuffer());
    return { qr: `data:image/png;base64,${buf.toString('base64')}` };
  }

  // JSON: {value: "data:image/png;base64,..."} ou {imageBase64: "..."}
  const json = (await res.json()) as Record<string, unknown>;
  const raw = (json.value as string | undefined) ?? (json.imageBase64 as string | undefined) ?? '';

  const qr = raw.startsWith('data:') ? raw : `data:image/png;base64,${raw}`;
  return { qr };
}

/**
 * Retorna o status atual da sessão.
 *
 * Em HTTP 404 (sessão inexistente no WAHA) lança WahaSessionNotFoundError — sinal
 * tipado para o chamador distinguir "sessão sumiu" (recriar) de "WAHA fora"
 * (timeout/rede). Faz o GET cru aqui (não via wahaReq, que mapearia 404 num Error
 * genérico) só para inspecionar o status code; demais erros seguem o caminho
 * normal (Error genérico / WahaTimeoutError).
 */
export async function getSessionStatus(
  name: string,
  opts?: WahaCallOpts,
): Promise<SessionStatusResponse> {
  const path = `/api/sessions/${name}`;
  const res = await wahaFetch(path, { method: 'GET', headers: headers() }, opts);
  if (res.status === 404) {
    // drena o body para liberar a conexão; conteúdo é irrelevante.
    await res.text().catch(() => '');
    throw new WahaSessionNotFoundError(name);
  }
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`WAHA sessoes ${path} -> HTTP ${res.status}: ${text}`);
  }
  return (await res.json()) as SessionStatusResponse;
}

/**
 * Faz logout da sessão (desautentica o WhatsApp vinculado).
 */
export async function logoutSession(name: string, opts?: WahaCallOpts): Promise<void> {
  await wahaReq('POST', `/api/sessions/${name}/logout`, {}, opts);
}

// ─── Reconexão self-service (ADR 0015) ──────────────────────────────────────────

/**
 * Solicita um código de pareamento (8 chars, XXXX-XXXX) para o número informado.
 *
 * CONTRATO WAHA (NOWEB, congelado — ADR 0015):
 *   POST /api/{session}/auth/request-code  body { phoneNumber } (E.164, SÓ DÍGITOS,
 *   SEM "+"). NÃO enviar `method` (NOWEB devolve 422). Só funciona em SCAN_QR_CODE
 *   e o código expira em ~60s. Resposta { code: "XXXX-XXXX" }.
 *
 * Bug histórico A: mandar "+" no phoneNumber. Bug B: pedir o código fora de
 * SCAN_QR_CODE. Aqui validamos só o formato dos dígitos; o estado é garantido
 * pelo orquestrador (restartAndWaitForScan) ANTES de chamar este helper.
 *
 * @param phoneDigits número já normalizado para SÓ DÍGITOS (sem "+", sem máscara).
 */
export async function requestPairingCode(
  session: string,
  phoneDigits: string,
  opts?: WahaCallOpts,
): Promise<{ code: string }> {
  const digits = (phoneDigits ?? '').replace(/\D/g, '');
  if (digits.length < 8) {
    // Defesa em profundidade: nunca mandar número inválido pro WAHA (evita o 422).
    throw new Error('requestPairingCode: phoneNumber inválido (esperado E.164 só dígitos)');
  }
  // SEM `method` no body — NOWEB devolve 422 se enviado (ADR 0015).
  const json = await wahaReq<{ code?: unknown }>(
    'POST',
    `/api/${session}/auth/request-code`,
    { phoneNumber: digits },
    opts,
  );
  const code = typeof json.code === 'string' ? json.code : '';
  if (!code) throw new Error('WAHA request-code: resposta sem `code`');
  return { code };
}

/** Estados em que a sessão está pronta para parear (gerar código/QR). */
const SCAN_READY = 'SCAN_QR_CODE';
/** Estados terminais do poll (não adianta esperar mais). */
const TERMINAL_STATES = new Set(['WORKING', 'FAILED']);

export interface RestartAndWaitOpts extends WahaCallOpts {
  /** Deadline total da orquestração (ms). Default 30s. */
  totalTimeoutMs?: number;
  /** Intervalo entre polls de status (ms). Default 2s. */
  pollIntervalMs?: number;
}

export interface RestartAndWaitResult {
  /** Status final observado. */
  status: string;
  /** true se chegou em SCAN_QR_CODE (pronto para código/QR). */
  ready: boolean;
  /** true se já estava WORKING (nada a fazer — sessão saudável). */
  alreadyWorking: boolean;
}

/**
 * Orquestra restart + poll até a sessão ficar pronta para parear (ADR 0015).
 *
 * Fluxo:
 *  1. Lê o status atual.
 *  2. Se WORKING -> retorna {alreadyWorking:true} SEM tocar na sessão (protege a
 *     sessão pagante — o restart é responsabilidade do guard != WORKING na rota).
 *  3. Se já SCAN_QR_CODE -> retorna {ready:true} sem novo restart (evita invalidar
 *     um código/QR já válido — "nunca 2 restarts seguidos", ADR 0015).
 *  4. Caso contrário (FAILED/STOPPED/STARTING) -> restart e poll a cada
 *     pollIntervalMs até SCAN_QR_CODE/WORKING ou estourar totalTimeoutMs.
 *
 * NÃO usa logout em nenhum ponto (preserva a autenticação). Cada chamada interna
 * herda o timeout por-request; o deadline total é independente e encerra o poll.
 */
export async function restartAndWaitForScan(
  session: string,
  opts?: RestartAndWaitOpts,
): Promise<RestartAndWaitResult> {
  const totalTimeoutMs = opts?.totalTimeoutMs ?? 30_000;
  const pollIntervalMs = opts?.pollIntervalMs ?? 2_000;
  const perCall: WahaCallOpts = { timeoutMs: opts?.timeoutMs, signal: opts?.signal };
  const deadline = Date.now() + totalTimeoutMs;

  const current = await getSessionStatus(session, perCall);
  if (current.status === 'WORKING') {
    return { status: 'WORKING', ready: false, alreadyWorking: true };
  }
  if (current.status === SCAN_READY) {
    // Já pronto — não reinicia (não invalida código/QR vigente).
    return { status: SCAN_READY, ready: true, alreadyWorking: false };
  }

  // FAILED/STOPPED/STARTING -> dispara restart (leva a sessão rumo a SCAN_QR_CODE).
  await restartSession(session, perCall);

  // Poll até pronto, terminal ou deadline.
  for (;;) {
    if (Date.now() >= deadline) {
      const last = await getSessionStatus(session, perCall).catch(() => current);
      return { status: last.status, ready: last.status === SCAN_READY, alreadyWorking: false };
    }
    await new Promise((r) => setTimeout(r, pollIntervalMs));
    const s = await getSessionStatus(session, perCall);
    if (s.status === SCAN_READY) {
      return { status: SCAN_READY, ready: true, alreadyWorking: false };
    }
    if (TERMINAL_STATES.has(s.status) && s.status === 'WORKING') {
      // Reconectou sozinho durante o restart (sessão voltou) — saudável.
      return { status: 'WORKING', ready: false, alreadyWorking: true };
    }
    // FAILED no meio do poll: o restart pode ainda transitar — continua até deadline.
  }
}
