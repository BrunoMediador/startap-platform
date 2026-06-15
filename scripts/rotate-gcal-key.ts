/**
 * rotate-gcal-key — re-cifra gcal_credentials_json de enc:v1 (chave antiga) para
 * enc:v2 (chave atual). Parte do mecanismo de rotação da GCAL_ENCRYPTION_KEY
 * (ADR 0024, AC5 do gate de segurança).
 *
 * ⚠️ Esta chave protege as credenciais Google dos PAGANTES (Cirilo, Samuel).
 * NÃO roda sozinho em prod — é passo gated do Bruno, executado pelo runbook
 * docs/runbooks/rotacao-gcal-encryption-key.md, com janela de coexistência
 * (GCAL_ENCRYPTION_KEY = K_new, GCAL_ENCRYPTION_KEY_OLD = K_old) ANTES do deploy.
 *
 * Comportamento:
 *   - Lê linhas com gcal_credentials_json começando com 'enc:v1:' em
 *     flow_clones e bot_config.
 *   - Decifra com a chave que enc:v1 exige (OLD se definida, senão a atual —
 *     a seleção de chave é responsabilidade de decryptSecret no core).
 *   - Re-cifra como enc:v2 com a chave atual e faz UPDATE parametrizado.
 *   - IDEMPOTENTE: re-rodar é no-op; só toca o que ainda é enc:v1. Linhas já
 *     em enc:v2 (ou texto claro) são puladas pelo filtro do SELECT.
 *
 * Modos:
 *   --dry-run  (DEFAULT) — só conta e relata o que mudaria. NÃO escreve.
 *   --apply             — executa os UPDATEs.
 *
 * Uso (via runbook, após provisionar as duas chaves):
 *   npx tsx --tsconfig scripts/tsconfig.scripts.json scripts/rotate-gcal-key.ts            # dry-run
 *   npx tsx --tsconfig scripts/tsconfig.scripts.json scripts/rotate-gcal-key.ts --apply    # aplica
 *
 * Validação pós-execução (no runbook):
 *   SELECT COUNT(*) FROM flow_clones WHERE gcal_credentials_json LIKE 'enc:v1:%';  -- deve dar 0
 *   SELECT COUNT(*) FROM bot_config  WHERE gcal_credentials_json LIKE 'enc:v1:%';  -- deve dar 0
 */

import { CURRENT_PREFIX } from '@startap/core';
import { closePool, query } from '@startap/db';
import { reencryptV1ToV2 } from './gcal-key-rotation.js';

interface Row {
  pk: string | number;
  gcal_credentials_json: string;
}

interface TableSpec {
  table: 'flow_clones' | 'bot_config';
  pkCol: 'id' | 'slot';
}

const TABLES: TableSpec[] = [
  { table: 'flow_clones', pkCol: 'id' },
  { table: 'bot_config', pkCol: 'slot' },
];

async function countV1(spec: TableSpec): Promise<number> {
  const res = await query<{ n: string }>(
    `SELECT COUNT(*)::text AS n FROM ${spec.table} WHERE gcal_credentials_json LIKE 'enc:v1:%'`,
    [],
  );
  return Number(res.rows[0]?.n ?? '0');
}

async function rotateTable(spec: TableSpec, apply: boolean): Promise<number> {
  const before = await countV1(spec);
  if (before === 0) {
    console.log(`[${spec.table}] 0 linha(s) enc:v1 — nada a re-cifrar`);
    return 0;
  }

  const rows = await query<Row>(
    `SELECT ${spec.pkCol} AS pk, gcal_credentials_json
       FROM ${spec.table}
      WHERE gcal_credentials_json LIKE 'enc:v1:%'`,
    [],
  );

  console.log(`[${spec.table}] ${before} linha(s) enc:v1 a re-cifrar para ${CURRENT_PREFIX}...`);

  let touched = 0;
  for (const row of rows.rows) {
    const result = reencryptV1ToV2(row.gcal_credentials_json);
    if (!result.changed || result.reciphered === null) {
      continue; // idempotência: pular
    }
    if (apply) {
      await query(`UPDATE ${spec.table} SET gcal_credentials_json = $1 WHERE ${spec.pkCol} = $2`, [
        result.reciphered,
        row.pk,
      ]);
      console.log(`  [${spec.table}] ${spec.pkCol}=${row.pk} — re-cifrado (enc:v2)`);
    } else {
      console.log(`  [${spec.table}] ${spec.pkCol}=${row.pk} — re-cifraria (dry-run)`);
    }
    touched += 1;
  }

  if (apply) {
    const after = await countV1(spec);
    console.log(`[${spec.table}] re-cifradas: ${touched}; enc:v1 restantes: ${after}`);
    if (after !== 0) {
      throw new Error(
        `[${spec.table}] ainda há ${after} linha(s) enc:v1 após --apply — investigar antes de remover OLD`,
      );
    }
  } else {
    console.log(`[${spec.table}] dry-run — re-cifraria ${touched} linha(s); nada escrito`);
  }

  return touched;
}

async function main(): Promise<void> {
  const apply = process.argv.includes('--apply');
  const mode = apply ? 'APPLY (escreve no banco)' : 'DRY-RUN (default, não escreve)';
  console.log(`rotate-gcal-key — modo: ${mode}`);

  // Sanidade: a chave atual precisa existir (encryptSecret falha sem ela).
  // GCAL_ENCRYPTION_KEY_OLD é opcional; se enc:v1 foi cifrado com a chave atual
  // (estado de hoje), a re-cifragem funciona mesmo sem OLD.
  if (!process.env.GCAL_ENCRYPTION_KEY) {
    throw new Error('GCAL_ENCRYPTION_KEY ausente — defina antes de rodar (ver runbook)');
  }

  let total = 0;
  for (const spec of TABLES) {
    total += await rotateTable(spec, apply);
  }

  if (apply) {
    console.log(`Concluído. ${total} linha(s) re-cifrada(s) para ${CURRENT_PREFIX}.`);
  } else {
    console.log(
      `Dry-run concluído. ${total} linha(s) seriam re-cifradas. Rode com --apply para aplicar (gated — ver runbook).`,
    );
  }
}

// Só executa quando rodado como script (não em import de teste).
const invokedDirectly =
  typeof process !== 'undefined' &&
  Array.isArray(process.argv) &&
  /rotate-gcal-key\.ts$/.test(process.argv[1] ?? '');

if (invokedDirectly) {
  main()
    .catch((err) => {
      console.error('Erro durante rotação:', err);
      process.exit(1);
    })
    .finally(() => closePool());
}
