import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const SQL = readFileSync(
  fileURLToPath(
    new URL('../../migrations/093_booking_confirmation_proposals.sql', import.meta.url),
  ),
  'utf8',
);
const statements = SQL.replace(/--[^\n]*/g, '');

describe('migration 093 — booking confirmation proposals', () => {
  it('é aditiva, tenant-scoped e não persiste PII/conteúdo de conversa', () => {
    expect(SQL).toMatch(/tenant_id UUID NOT NULL/i);
    expect(SQL).toMatch(/slot TEXT NOT NULL REFERENCES flow_clones\(slot\)/i);
    expect(SQL).toMatch(/contact_hmac TEXT NOT NULL/i);
    expect(SQL).toMatch(/PRIMARY KEY \(tenant_id, id\)/i);
    expect(SQL).toMatch(/uq_booking_confirmation_pending_contact/i);
    expect(statements).not.toMatch(
      /\b(telefone|phone|summary|mensagem|message|card_text|cliente_nome)\b/i,
    );
    expect(statements).not.toMatch(/^\s*(DROP|DELETE|TRUNCATE)\b/im);
  });
});
