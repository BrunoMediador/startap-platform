/**
 * Mascaramento de telefone para logs (regra de ouro 6 — LGPD by design).
 * Logs NUNCA imprimem telefone em claro. Ex: 5519998883246 -> 5519****3246.
 */
export function maskPhone(raw: string): string {
  const d = (raw ?? '').replace(/\D/g, '');
  if (d.length < 8) return '***';
  return `${d.slice(0, 4)}****${d.slice(-4)}`;
}
