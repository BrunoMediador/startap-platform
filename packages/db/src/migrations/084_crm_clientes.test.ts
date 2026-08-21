/**
 * Guarda estática da migration 084 (CRM Clientes). Invariantes: tabela canônica por
 * tenant+telefone, campos opcionais owner-only, índice de histórico e sem backfill global
 * destrutivo em atendimentos.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const SQL = readFileSync(
  fileURLToPath(new URL('../../migrations/084_crm_clientes.sql', import.meta.url)),
  'utf8',
);
const SQL_STMTS = SQL.replace(/--[^\n]*/g, '');

describe('migration 084 — crm clientes', () => {
  it('cria tabela clientes com identidade canônica por tenant+telefone', () => {
    expect(SQL).toMatch(/CREATE TABLE IF NOT EXISTS clientes/i);
    expect(SQL).toMatch(/id UUID PRIMARY KEY DEFAULT gen_random_uuid\(\)/i);
    expect(SQL).toMatch(/tenant_id UUID NOT NULL/i);
    expect(SQL).toMatch(/telefone_canonico TEXT NOT NULL/i);
    expect(SQL).toMatch(/CONSTRAINT ux_clientes_tenant_phone UNIQUE \(tenant_id, telefone_canonico\)/i);
  });

  it('modela telefone de exibição, aniversário, cidade e nota interna com checks', () => {
    expect(SQL).toMatch(/telefone_raw TEXT NOT NULL/i);
    expect(SQL).toMatch(/aniversario_mmdd TEXT/i);
    expect(SQL).toMatch(/cidade TEXT/i);
    expect(SQL).toMatch(/nota_interna TEXT/i);
    expect(SQL).toMatch(/clientes_aniversario_mmdd_chk/i);
    expect(SQL).toMatch(/clientes_cidade_chk/i);
    expect(SQL).toMatch(/clientes_nota_interna_chk/i);
  });

  it('adiciona telefone canônico em atendimentos e índices de histórico', () => {
    expect(SQL).toMatch(/ADD COLUMN IF NOT EXISTS cliente_telefone_canonico TEXT/i);
    expect(SQL).toMatch(/atendimentos_cliente_telefone_canonico_chk/i);
    expect(SQL).toMatch(/ix_atendimentos_cliente_hist/i);
    expect(SQL).toMatch(/ix_atendimentos_colab_cliente_hist/i);
  });

  it('é aditiva e sem comandos destrutivos executáveis', () => {
    expect(SQL).toMatch(/\bBEGIN\b/);
    expect(SQL).toMatch(/\bCOMMIT\b/);
    expect(SQL_STMTS).not.toMatch(/^\s*DROP\b/im);
    expect(SQL_STMTS).not.toMatch(/^\s*DELETE\b/im);
    expect(SQL_STMTS).not.toMatch(/^\s*TRUNCATE\b/im);
  });
});
