/**
 * Gerenciamento de sessões WAHA — criar, iniciar, parar, QR, status, logout.
 *
 * Reutiliza WAHA_URL e WAHA_API_KEY do ambiente (mesmos do client.ts).
 */

const WAHA_URL = process.env.WAHA_URL ?? 'http://waha:3000';
const WAHA_API_KEY = process.env.WAHA_API_KEY ?? '';

function headers(): Record<string, string> {
  const h: Record<string, string> = { 'Content-Type': 'application/json' };
  if (WAHA_API_KEY) h['X-Api-Key'] = WAHA_API_KEY;
  return h;
}

async function wahaReq<T = unknown>(
  method: 'GET' | 'POST',
  path: string,
  body?: unknown,
): Promise<T> {
  const res = await fetch(`${WAHA_URL}${path}`, {
    method,
    headers: headers(),
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
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
export async function createSession(name: string): Promise<SessionStatusResponse> {
  return wahaReq<SessionStatusResponse>('POST', '/api/sessions', { name, start: true });
}

/**
 * Inicia uma sessão já existente (útil se foi criada sem start:true).
 */
export async function startSession(name: string): Promise<SessionStatusResponse> {
  return wahaReq<SessionStatusResponse>('POST', `/api/sessions/${name}/start`, {});
}

/**
 * Para uma sessão sem fazer logout (mantém autenticação).
 */
export async function stopSession(name: string): Promise<void> {
  await wahaReq('POST', `/api/sessions/${name}/stop`, {});
}

/**
 * Retorna QR code como string base64 PNG ("data:image/png;base64,...").
 * Se sessão já está WORKING, retorna null e {connected:true}.
 */
export async function getSessionQR(
  name: string,
): Promise<{ qr: string } | { connected: true; qr: null }> {
  const status = await getSessionStatus(name);
  if (status.status === 'WORKING') return { connected: true, qr: null };

  // WAHA pode retornar PNG binário ou JSON {value: "data:image/png;base64,..."}
  const res = await fetch(`${WAHA_URL}/api/${name}/auth/qr`, {
    headers: WAHA_API_KEY ? { 'X-Api-Key': WAHA_API_KEY } : {},
  });

  if (!res.ok) {
    // Tenta endpoint alternativo
    const res2 = await fetch(`${WAHA_URL}/api/sessions/${name}/auth/qr`, {
      headers: WAHA_API_KEY ? { 'X-Api-Key': WAHA_API_KEY } : {},
    });
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
  const raw =
    (json['value'] as string | undefined) ?? (json['imageBase64'] as string | undefined) ?? '';

  const qr = raw.startsWith('data:') ? raw : `data:image/png;base64,${raw}`;
  return { qr };
}

/**
 * Retorna o status atual da sessão.
 */
export async function getSessionStatus(name: string): Promise<SessionStatusResponse> {
  return wahaReq<SessionStatusResponse>('GET', `/api/sessions/${name}`);
}

/**
 * Faz logout da sessão (desautentica o WhatsApp vinculado).
 */
export async function logoutSession(name: string): Promise<void> {
  await wahaReq('POST', `/api/sessions/${name}/logout`, {});
}
