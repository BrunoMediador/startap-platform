import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  renderConfirmationCardContract,
  validateConfirmationCardContract,
} from './booking-confirmation-template.js';

const reviewedBakedCard = 'cartão baked sintético revisado';
const reviewedHash = createHash('sha256').update(reviewedBakedCard, 'utf8').digest('hex');

const doctorBarberRedacted = {
  version: 'confirmation-card-contract/v1' as const,
  baked_card_sha256: reviewedHash,
  segments: [
    { kind: 'literal' as const, value: '*Doctor Barber* 💈\n\n📅 *Data:* ' },
    { kind: 'field' as const, field: 'dia' as const },
    { kind: 'literal' as const, value: '\n🕐 *Horário:* ' },
    { kind: 'field' as const, field: 'horario' as const },
    { kind: 'literal' as const, value: '\n✂️ *Serviço:* ' },
    { kind: 'field' as const, field: 'servico' as const },
    { kind: 'literal' as const, value: '\n💰 *Valor:* ' },
    { kind: 'field' as const, field: 'valor' as const },
    { kind: 'literal' as const, value: '\n👤 *Profissional:* ' },
    { kind: 'field' as const, field: 'profissional' as const },
    { kind: 'literal' as const, value: '\n\nResponda *SIM* para confirmar seu horário.' },
  ],
};

describe('confirmation card contract v1', () => {
  it('golden redigido Doctor Barber preserva a cópia literal e só preenche campos canônicos', () => {
    expect(
      renderConfirmationCardContract({
        contract: doctorBarberRedacted,
        bakedCardSha256: reviewedHash,
        fields: {
          dia: 'quarta-feira, 27/08/2026',
          horario: '17:00',
          servico: 'Corte',
          valor: 'R$ 50,00',
          profissional: 'Profissional A',
        },
      }),
    ).toBe(
      '*Doctor Barber* 💈\n\n' +
        '📅 *Data:* quarta-feira, 27/08/2026\n' +
        '🕐 *Horário:* 17:00\n' +
        '✂️ *Serviço:* Corte\n' +
        '💰 *Valor:* R$ 50,00\n' +
        '👤 *Profissional:* Profissional A\n\n' +
        'Responda *SIM* para confirmar seu horário.',
    );
  });

  it('mantém os literais de um contrato da área outro; a área não troca copy customizada', () => {
    const outro = {
      ...doctorBarberRedacted,
      segments: [
        { kind: 'literal' as const, value: 'Studio Outro — ' },
        { kind: 'field' as const, field: 'dia' as const },
        { kind: 'literal' as const, value: ' / ' },
        { kind: 'field' as const, field: 'horario' as const },
        { kind: 'literal' as const, value: ' / ' },
        { kind: 'field' as const, field: 'servico' as const },
        { kind: 'literal' as const, value: ' / ' },
        { kind: 'field' as const, field: 'valor' as const },
        { kind: 'literal' as const, value: ' / ' },
        { kind: 'field' as const, field: 'profissional' as const },
        { kind: 'literal' as const, value: '. SIM confirma.' },
      ],
    };
    expect(
      renderConfirmationCardContract({
        contract: outro,
        bakedCardSha256: reviewedHash,
        fields: { dia: 'd', horario: 'h', servico: 's', valor: 'v', profissional: 'p' },
      }),
    ).toBe('Studio Outro — d / h / s / v / p. SIM confirma.');
  });

  it('falha fechada para hash divergente, campo ausente ou campo repetido', () => {
    expect(
      validateConfirmationCardContract({
        contract: doctorBarberRedacted,
        bakedCardSha256: '0'.repeat(64),
      }),
    ).toEqual({ valid: false, reason: 'baked_card_mismatch' });
    expect(
      validateConfirmationCardContract({
        contract: { ...doctorBarberRedacted, segments: doctorBarberRedacted.segments.slice(0, -2) },
        bakedCardSha256: reviewedHash,
      }),
    ).toEqual({ valid: false, reason: 'segment_count' });
    expect(
      validateConfirmationCardContract({
        contract: {
          ...doctorBarberRedacted,
          segments: [...doctorBarberRedacted.segments, { kind: 'field', field: 'dia' }],
        },
        bakedCardSha256: reviewedHash,
      }),
    ).toEqual({ valid: false, reason: 'field_count' });
  });
});
