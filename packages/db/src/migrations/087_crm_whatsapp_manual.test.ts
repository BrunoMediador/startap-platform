import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const SQL = readFileSync(
  fileURLToPath(new URL('../../migrations/087_crm_whatsapp_manual.sql', import.meta.url)),
  'utf8',
);
const SQL_STMTS = SQL.replace(/--[^\n]*/g, '');

describe('migration 086 — CRM WhatsApp manual', () => {
  it('cria guarda atomica por slot, tenant, cliente e operador', () => {
    expect(SQL).toMatch(/CREATE TABLE IF NOT EXISTS crm_whatsapp_manual_send_guards/i);
    expect(SQL).toMatch(/PRIMARY KEY \(slot, tenant_id, cliente_id, operator_user_id\)/i);
    expect(SQL).toMatch(/cooldown_until TIMESTAMPTZ NOT NULL/i);
    expect(SQL).toMatch(/last_send_id UUID NOT NULL/i);
  });

  it('cria auditoria minima sem corpo ou telefone e indexa no escopo do tenant', () => {
    expect(SQL).toMatch(/CREATE TABLE IF NOT EXISTS crm_whatsapp_manual_send_audit/i);
    expect(SQL).toMatch(/outcome TEXT NOT NULL CHECK/i);
    expect(SQL).toMatch(/failure_code TEXT/i);
    expect(SQL).toMatch(/ix_crm_whatsapp_manual_audit_scope_created/i);
    expect(SQL_STMTS).not.toMatch(/\btexto\b/i);
    expect(SQL_STMTS).not.toMatch(/\btelefone\b/i);
  });

  it('permanece aditiva e sem comandos destrutivos executaveis', () => {
    expect(SQL).toMatch(/\bBEGIN\b/);
    expect(SQL).toMatch(/\bCOMMIT\b/);
    expect(SQL_STMTS).not.toMatch(/^\s*DROP\b/im);
    expect(SQL_STMTS).not.toMatch(/^\s*DELETE\b/im);
    expect(SQL_STMTS).not.toMatch(/^\s*TRUNCATE\b/im);
  });
});
