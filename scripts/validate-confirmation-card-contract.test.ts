import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { inspectConfirmationCardContract } from './validate-confirmation-card-contract.js';

const bakedPrompt = 'PERSONA\n[CARTAO DE CONFIRMACAO]\nCartão revisado';
const bakedCard = '[CARTAO DE CONFIRMACAO]\nCartão revisado';
const hash = createHash('sha256').update(bakedCard, 'utf8').digest('hex');

const candidate = {
  version: 'confirmation-card-contract/v1',
  baked_card_sha256: hash,
  segments: [
    { kind: 'literal', value: 'a' },
    { kind: 'field', field: 'dia' },
    { kind: 'literal', value: 'b' },
    { kind: 'field', field: 'horario' },
    { kind: 'literal', value: 'c' },
    { kind: 'field', field: 'servico' },
    { kind: 'literal', value: 'd' },
    { kind: 'field', field: 'valor' },
    { kind: 'literal', value: 'e' },
    { kind: 'field', field: 'profissional' },
    { kind: 'literal', value: 'f' },
  ],
};

describe('validate-confirmation-card-contract --dry-run', () => {
  it('retorna somente hashes, contadores e status — nunca texto baked ou literal', () => {
    const report = inspectConfirmationCardContract({ candidate, bakedPrompt });
    expect(report).toEqual({
      contract_valid: true,
      card_found: true,
      card_sha256: hash,
      contract_sha256: hash,
      segment_count: 11,
      literal_char_count: 6,
      field_segment_count: 5,
    });
    expect(JSON.stringify(report)).not.toContain('Cartão revisado');
  });
});
