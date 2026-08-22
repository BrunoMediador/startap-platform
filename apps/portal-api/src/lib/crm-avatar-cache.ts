import { createHash } from 'node:crypto';
import type { Redis } from 'ioredis';

const TTL_SECONDS = 86_400;
const NONE = 'none';

export interface CachedAvatar {
  mime: 'image/jpeg' | 'image/png' | 'image/webp';
  bytes: Uint8Array;
}

function key(tenantId: string, clienteId: string): string {
  const scopeHash = createHash('sha256').update(`${tenantId}:${clienteId}`).digest('hex');
  return `portal:crm-avatar:v1:${scopeHash}`;
}

export async function getCachedAvatar(
  redis: Redis,
  tenantId: string,
  clienteId: string,
): Promise<CachedAvatar | 'none' | null> {
  const raw = await redis.get(key(tenantId, clienteId));
  if (!raw) return null;
  if (raw === NONE) return NONE;
  try {
    const decoded = JSON.parse(raw) as { mime?: unknown; base64?: unknown };
    if (
      (decoded.mime !== 'image/jpeg' &&
        decoded.mime !== 'image/png' &&
        decoded.mime !== 'image/webp') ||
      typeof decoded.base64 !== 'string'
    )
      return null;
    const bytes = new Uint8Array(Buffer.from(decoded.base64, 'base64'));
    return bytes.byteLength > 0 && bytes.byteLength <= 1_000_000
      ? { mime: decoded.mime, bytes }
      : null;
  } catch {
    return null;
  }
}

export async function cacheAvatar(
  redis: Redis,
  tenantId: string,
  clienteId: string,
  avatar: CachedAvatar | 'none',
): Promise<void> {
  const value =
    avatar === NONE
      ? NONE
      : JSON.stringify({ mime: avatar.mime, base64: Buffer.from(avatar.bytes).toString('base64') });
  await redis.set(key(tenantId, clienteId), value, 'EX', TTL_SECONDS);
}
