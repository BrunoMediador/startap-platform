import { DEFAULT_WAHA_SHARD_ID, resolveWahaUrl } from './shard.js';

const WAHA_API_KEY = process.env.WAHA_API_KEY ?? '';
const MAX_AVATAR_BYTES = 1_000_000;

function isAllowedRemoteHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return (
    host === 'whatsapp.net' ||
    host.endsWith('.whatsapp.net') ||
    host === 'fbcdn.net' ||
    host.endsWith('.fbcdn.net')
  );
}

function isAllowedImage(bytes: Uint8Array, mime: string): boolean {
  const jpeg = bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  const png =
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47;
  const webp =
    bytes.length >= 12 &&
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50;
  return (
    (mime === 'image/jpeg' && jpeg) ||
    (mime === 'image/png' && png) ||
    (mime === 'image/webp' && webp)
  );
}

function parseProfilePictureUrl(payload: unknown): URL | null {
  if (!payload || typeof payload !== 'object') return null;
  const object = payload as Record<string, unknown>;
  const value = object.url ?? object.profilePictureUrl ?? object.profilePictureURL;
  if (typeof value !== 'string') return null;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && isAllowedRemoteHost(url.hostname) ? url : null;
  } catch {
    return null;
  }
}

export interface WahaProfilePicture {
  mime: 'image/jpeg' | 'image/png' | 'image/webp';
  bytes: Uint8Array;
}

/**
 * Busca uma foto somente sob demanda. WAHA devolve referência remota; ela jamais
 * é repassada ao browser: é validada, baixada e convertida em bytes pelo proxy.
 */
export async function getProfilePicture(input: {
  sessao: string;
  telefoneCanonico: string;
  shardId?: number;
  timeoutMs: number;
}): Promise<WahaProfilePicture | null> {
  const params = new URLSearchParams({
    session: input.sessao,
    contactId: `${input.telefoneCanonico}@c.us`,
    refresh: 'false',
  });
  const signal = AbortSignal.timeout(input.timeoutMs);
  const headers: Record<string, string> = {};
  if (WAHA_API_KEY) headers['X-Api-Key'] = WAHA_API_KEY;
  const base = resolveWahaUrl(input.shardId ?? DEFAULT_WAHA_SHARD_ID);
  const lookup = await fetch(`${base}/api/contacts/profile-picture?${params.toString()}`, {
    headers,
    signal,
  });
  if (!lookup.ok) return null;
  const remote = parseProfilePictureUrl(await lookup.json().catch(() => null));
  if (!remote) return null;

  const response = await fetch(remote, { signal, redirect: 'error' });
  const mime = response.headers.get('content-type')?.split(';', 1)[0]?.toLowerCase();
  const declaredSize = Number(response.headers.get('content-length') ?? '0');
  if (!response.ok || !mime || !Number.isFinite(declaredSize) || declaredSize > MAX_AVATAR_BYTES)
    return null;
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_AVATAR_BYTES || !isAllowedImage(bytes, mime))
    return null;
  return { mime: mime as WahaProfilePicture['mime'], bytes };
}
