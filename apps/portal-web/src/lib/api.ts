/**
 * Cliente HTTP do portal-web (browser).
 *
 * Chama o portal-api atraves do proxy same-origin do Next (/auth/*, /portal/*),
 * entao o cookie httpOnly de sessao viaja sozinho — `credentials: 'include'`
 * garante isso mesmo em fetch. Nenhuma URL absoluta no client: tudo relativo.
 *
 * Erros viram ApiError com status + corpo parseado (quando JSON), pra UI tratar
 * 401 (sessao expirada), 429 (lockout), 400 (validacao), etc.
 */

export class ApiError extends Error {
  readonly status: number;
  readonly body: unknown;

  constructor(status: number, message: string, body: unknown) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.body = body;
  }
}

async function parseBody(res: Response): Promise<unknown> {
  const text = await res.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function messageFromBody(body: unknown, fallback: string): string {
  if (body && typeof body === 'object' && 'error' in body) {
    const err = (body as { error?: unknown }).error;
    if (typeof err === 'string') return err;
  }
  return fallback;
}

interface RequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  body?: unknown;
  signal?: AbortSignal;
}

export async function apiFetch<T>(path: string, opts: RequestOptions = {}): Promise<T> {
  const { method = 'GET', body, signal } = opts;
  const init: RequestInit = {
    method,
    credentials: 'include',
    headers: { Accept: 'application/json' },
    signal,
    cache: 'no-store',
  };
  if (body !== undefined) {
    init.headers = { ...init.headers, 'Content-Type': 'application/json' };
    init.body = JSON.stringify(body);
  }

  let res: Response;
  try {
    res = await fetch(path, init);
  } catch (cause) {
    // Falha de rede (offline, DNS, proxy fora) — sem status HTTP.
    throw new ApiError(0, 'sem conexao', cause);
  }

  const parsed = await parseBody(res);
  if (!res.ok) {
    throw new ApiError(res.status, messageFromBody(parsed, `HTTP ${res.status}`), parsed);
  }
  return parsed as T;
}

export function isUnauthorized(err: unknown): boolean {
  return err instanceof ApiError && err.status === 401;
}
