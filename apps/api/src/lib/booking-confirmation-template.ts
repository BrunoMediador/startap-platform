import { createHash } from 'node:crypto';
import type { CloneConfirmationCardContract } from '@startap/db';

export interface CanonicalBookingConfirmationFields {
  dia: string;
  horario: string;
  servico: string;
  valor: string;
  profissional: string;
}

const REQUIRED_FIELDS = ['dia', 'horario', 'servico', 'valor', 'profissional'] as const;
type BookingField = (typeof REQUIRED_FIELDS)[number];

export type BookingContractValidation =
  | { valid: true }
  | {
      valid: false;
      reason: 'missing_contract' | 'baked_card_mismatch' | 'segment_count' | 'field_count';
    };

export function hashBakedCard(card: string): string {
  return createHash('sha256').update(card, 'utf8').digest('hex');
}

/**
 * O contrato não faz extração do prompt baked nem interpreta texto livre. Cada segmento é
 * explícito e o SHA recebido da revisão humana prova que a cópia ainda é a revisada.
 */
export function validateConfirmationCardContract(input: {
  contract: CloneConfirmationCardContract | null;
  bakedCardSha256: string;
}): BookingContractValidation {
  const { contract } = input;
  if (!contract) return { valid: false, reason: 'missing_contract' };
  if (contract.baked_card_sha256 !== input.bakedCardSha256)
    return { valid: false, reason: 'baked_card_mismatch' };
  if (contract.segments.length < REQUIRED_FIELDS.length * 2 + 1)
    return { valid: false, reason: 'segment_count' };

  const counts: Record<BookingField, number> = {
    dia: 0,
    horario: 0,
    servico: 0,
    valor: 0,
    profissional: 0,
  };
  for (const segment of contract.segments) {
    if (segment.kind === 'field') counts[segment.field] += 1;
  }
  for (const field of REQUIRED_FIELDS) {
    if (counts[field] !== 1) return { valid: false, reason: 'field_count' };
  }
  return { valid: true };
}

/** Preserva cada segmento literal exatamente como revisado; só os campos fechados variam. */
export function renderConfirmationCardContract(input: {
  contract: CloneConfirmationCardContract | null;
  bakedCardSha256: string;
  fields: CanonicalBookingConfirmationFields;
}): string | null {
  if (!validateConfirmationCardContract(input).valid || !input.contract) return null;
  return input.contract.segments
    .map((segment) => (segment.kind === 'literal' ? segment.value : input.fields[segment.field]))
    .join('');
}
