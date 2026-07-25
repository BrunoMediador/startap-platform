/**
 * contact-names — store durável do pushName por contato, por sessão WAHA (SCRUM-144).
 *
 * Fonte da verdade do NOME de um contato para o snapshot em flow_pauses. Populada pelo
 * INBOUND (cliente→bot) no webhook: o pushName vem no payload do evento, então NÃO depende
 * do store do WAHA (NOWEB OFF) nem da janela de recentes. A pausa fromMe/human_reply lê daqui
 * o nome do CONTATO (o pushName do evento fromMe é o nome do DONO, não serve).
 *
 * Chave = (session, phone_key), phone_key = canonicalE164(telefone): forma E.164 canônica
 * INVARIANTE ao 9º dígito móvel BR (WAHA/Baileys ora entrega COM o 9, ora SEM — SCRUM-82).
 * Assim o inbound e o snapshot batem no mesmo contato independente da forma do número.
 *
 * LGPD: push_name é PII (nome do cliente do cliente). NUNCA logar em claro aqui — o caller
 * loga só phoneLogTag/máscara. Query 100% parametrizada.
 */
import { canonicalE164 } from '@startap/core/phone';
import { query } from '../client.js';

/** Deriva a chave canônica (invariante ao 9º dígito). Fallback: dígitos crus (>=8). */
function phoneKey(telefone: string): string | null {
  const canon = canonicalE164(telefone);
  if (canon) return canon;
  const digits = (telefone ?? '').replace(/\D/g, '');
  return digits.length >= 8 ? digits : null;
}

/**
 * Upsert do pushName de um contato (INBOUND). No-op silencioso e SEGURO se pushName vazio ou
 * telefone irrecuperável — o caller já chama isto fail-safe (try/catch) no hot-path do webhook.
 * ON CONFLICT preserva o nome antigo se o novo vier vazio (COALESCE/NULLIF), mas atualiza
 * quando há nome novo (contato pode trocar o nome de exibição).
 */
export async function upsertContactName(input: {
  session: string;
  telefone: string;
  pushName: string | null | undefined;
}): Promise<void> {
  const name = (input.pushName ?? '').trim();
  if (name.length === 0) return; // sem nome = nada a gravar
  const key = phoneKey(input.telefone);
  if (!key || !input.session) return; // identidade irrecuperável = não grava lixo
  const digits = (input.telefone ?? '').replace(/\D/g, '') || null;

  await query(
    `INSERT INTO contact_names (session, phone_key, push_name, phone, updated_at)
     VALUES ($1, $2, $3, $4, NOW())
     ON CONFLICT (session, phone_key) DO UPDATE
       SET push_name = COALESCE(NULLIF(EXCLUDED.push_name, ''), contact_names.push_name),
           phone     = COALESCE(EXCLUDED.phone, contact_names.phone),
           updated_at = NOW()`,
    [input.session, key, name, digits],
  );
}

/**
 * Lê o pushName durável de um contato (por session + telefone, invariante ao 9º dígito).
 * Retorna null se não houver — o caller usa isso pra snapshotar em flow_pauses.contact_name.
 */
export async function getContactName(input: {
  session: string;
  telefone: string;
}): Promise<string | null> {
  const key = phoneKey(input.telefone);
  if (!key || !input.session) return null;
  const r = await query<{ push_name: string }>(
    'SELECT push_name FROM contact_names WHERE session = $1 AND phone_key = $2 LIMIT 1',
    [input.session, key],
  );
  const name = r.rows[0]?.push_name?.trim();
  return name && name.length > 0 ? name : null;
}
