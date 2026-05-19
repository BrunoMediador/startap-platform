/**
 * encrypt-existing-gcal — migração one-shot de gcal_credentials_json para AES-256-GCM.
 *
 * Problema: linhas salvas antes da Missão 012-A2 têm gcal_credentials_json em texto claro.
 * Este script lê cada linha sem prefixo "enc:v1:", criptografa e faz UPDATE parametrizado.
 * É idempotente: pula linhas já cifradas (que começam com "enc:v1:").
 *
 * Pré-requisito:
 *   GCAL_ENCRYPTION_KEY deve estar no ambiente (mesma chave configurada no painel/api).
 *
 * Uso (uma única vez, após deploy com a variável configurada):
 *   npx tsx scripts/encrypt-existing-gcal.ts
 *
 * Validação pós-execução:
 *   SELECT id, LEFT(gcal_credentials_json, 20) FROM flow_clones WHERE gcal_credentials_json IS NOT NULL;
 *   SELECT slot, LEFT(gcal_credentials_json, 20) FROM bot_config WHERE gcal_credentials_json IS NOT NULL;
 *   -- Todas as linhas devem começar com "enc:v1:"
 */

import { createCipheriv, randomBytes } from 'node:crypto';
import { query, closePool } from '@startap/db';

const PREFIX = 'enc:v1:';

function getKey(): Buffer {
  const hex = process.env.GCAL_ENCRYPTION_KEY;
  if (!hex || hex.trim() === '') {
    throw new Error('GCAL_ENCRYPTION_KEY ausente — defina antes de rodar o script');
  }
  const buf = Buffer.from(hex.trim(), 'hex');
  if (buf.length !== 32) {
    throw new Error(`GCAL_ENCRYPTION_KEY deve ter 32 bytes (64 chars hex); recebido ${buf.length}`);
  }
  return buf;
}

function encrypt(plain: string): string {
  const key = getKey();
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return (
    PREFIX +
    iv.toString('base64') +
    ':' +
    authTag.toString('base64') +
    ':' +
    encrypted.toString('base64')
  );
}

interface LegacyRow {
  id?: number;
  slot?: string;
  gcal_credentials_json: string;
}

async function migrateTable(
  table: 'flow_clones' | 'bot_config',
  pkCol: 'id' | 'slot',
): Promise<void> {
  const rows = await query<LegacyRow>(
    `SELECT ${pkCol}, gcal_credentials_json
       FROM ${table}
      WHERE gcal_credentials_json IS NOT NULL
        AND gcal_credentials_json NOT LIKE 'enc:v1:%'`,
    [],
  );

  if (rows.rows.length === 0) {
    console.log(`[${table}] nenhuma linha legada encontrada — ok`);
    return;
  }

  console.log(`[${table}] ${rows.rows.length} linha(s) a criptografar...`);

  for (const row of rows.rows) {
    const pk = row[pkCol as keyof LegacyRow] as string | number;
    const encrypted = encrypt(row.gcal_credentials_json);
    await query(
      `UPDATE ${table} SET gcal_credentials_json = $1 WHERE ${pkCol} = $2`,
      [encrypted, pk],
    );
    console.log(`  [${table}] ${pkCol}=${pk} — criptografado`);
  }

  console.log(`[${table}] migração concluída`);
}

async function main(): Promise<void> {
  // Valida a chave antes de conectar
  getKey();

  console.log('Iniciando migração gcal_credentials_json → AES-256-GCM...');
  await migrateTable('flow_clones', 'id');
  await migrateTable('bot_config', 'slot');

  // Registra na tabela de log operacional
  await query(
    `INSERT INTO operational_migration_log (name, notes)
     VALUES ($1, $2)
     ON CONFLICT (name) DO UPDATE SET ran_at = NOW(), notes = $2`,
    [
      '024_encrypt_gcal_credentials',
      `Script executado em ${new Date().toISOString()} — linhas migradas com sucesso`,
    ],
  );

  console.log('Migração concluída. Registrado em operational_migration_log.');
}

main()
  .catch((err) => {
    console.error('Erro durante migração:', err);
    process.exit(1);
  })
  .finally(() => closePool());
