/**
 * Validates a future baked confirmation-card contract without changing state.
 *
 * Usage (dry-run only):
 *   npx tsx --tsconfig scripts/tsconfig.scripts.json scripts/validate-confirmation-card-contract.ts \
 *     --dry-run --tenant <tenant_uuid> --slot <slot> --contract <contract.json>
 *
 * It deliberately emits only status, hashes and counters. The baked prompt/card and the
 * configured literals are never printed or logged.
 */
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { logger } from '@startap/core/logger';
import { closePool, parseConfirmationCardContract, query } from '@startap/db';
import { extractBakedCartao } from '@startap/integrations/prompt-builder';
import {
  hashBakedCard,
  validateConfirmationCardContract,
} from '../apps/api/src/lib/booking-confirmation-template.js';

const log = logger.child({ script: 'validate-confirmation-card-contract' });

interface PromptRow {
  prompt: string | null;
}

function readOption(args: string[], name: string): string | null {
  const index = args.indexOf(name);
  const value = index >= 0 ? args[index + 1] : null;
  return value && !value.startsWith('--') ? value : null;
}

export function inspectConfirmationCardContract(input: {
  candidate: unknown;
  bakedPrompt: string | null;
}): {
  contract_valid: boolean;
  card_found: boolean;
  card_sha256: string | null;
  contract_sha256: string | null;
  segment_count: number;
  literal_char_count: number;
  field_segment_count: number;
} {
  const contract = parseConfirmationCardContract(input.candidate);
  const extracted = extractBakedCartao(input.bakedPrompt ?? '');
  const card = extracted.found ? extracted.cartao : null;
  const cardSha256 = card ? hashBakedCard(card) : null;
  const validation = validateConfirmationCardContract({
    contract,
    bakedCardSha256: cardSha256 ?? '',
  });
  const segments = contract?.segments ?? [];
  return {
    contract_valid: validation.valid,
    card_found: card !== null,
    card_sha256: cardSha256,
    contract_sha256: contract?.baked_card_sha256 ?? null,
    segment_count: segments.length,
    literal_char_count: segments.reduce(
      (total, segment) => total + (segment.kind === 'literal' ? segment.value.length : 0),
      0,
    ),
    field_segment_count: segments.filter((segment) => segment.kind === 'field').length,
  };
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const tenantId = readOption(args, '--tenant');
  const slot = readOption(args, '--slot');
  const contractPath = readOption(args, '--contract');
  if (
    !args.includes('--dry-run') ||
    args.includes('--apply') ||
    !tenantId ||
    !slot ||
    !contractPath
  ) {
    throw new Error('uso: --dry-run --tenant <uuid> --slot <slot> --contract <arquivo.json>');
  }

  const candidate: unknown = JSON.parse(await readFile(contractPath, 'utf8'));
  const result = await query<PromptRow>(
    `SELECT bp.prompt
       FROM flow_clones fc
       LEFT JOIN bot_prompt bp ON bp.slot = fc.slot
      WHERE fc.tenant_id = $1 AND fc.slot = $2
      LIMIT 1`,
    [tenantId, slot],
  );
  const inspected = inspectConfirmationCardContract({
    candidate,
    bakedPrompt: result.rows[0]?.prompt ?? null,
  });
  log.info(
    { tenant_id: tenantId, slot, dry_run: true, ...inspected },
    'confirmation card contract inspected',
  );
  if (!inspected.contract_valid) process.exitCode = 2;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main()
    .catch((error: unknown) => {
      log.error(
        { err: error instanceof Error ? error.message : String(error), dry_run: true },
        'confirmation card contract validation failed',
      );
      process.exitCode = 1;
    })
    .finally(async () => closePool());
}
