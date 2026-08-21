/**
 * Guarda estática da migration 082 (agenda_bloqueios). Invariantes: tabela nova,
 * aditiva/idempotente, soft-delete, índices de escopo e sem DROP/DELETE/TRUNCATE
 * nos statements executáveis.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const SQL = readFileSync(
  fileURLToPath(new URL('../../migrations/082_agenda_bloqueios.sql', import.meta.url)),
  'utf8',
);
const SQL_STMTS = SQL.replace(/--[^\n]*/g, '');

describe('migration 082 — agenda_bloqueios', () => {
  it('cria tabela nova com uuid pk e escopo tenant/slot', () => {
    expect(SQL).toMatch(/CREATE TABLE IF NOT EXISTS agenda_bloqueios/i);
    expect(SQL).toMatch(/id\s+UUID\s+PRIMARY KEY DEFAULT gen_random_uuid\(\)/i);
    expect(SQL).toMatch(/tenant_id\s+UUID\s+NOT NULL/i);
    expect(SQL).toMatch(/slot\s+TEXT\s+NOT NULL REFERENCES flow_clones\(slot\)/i);
  });

  it('modela colaborador opcional, evento GCal e soft-delete', () => {
    expect(SQL).toMatch(/colaborador_id\s+BIGINT/i);
    expect(SQL).toMatch(/gcal_event_id\s+TEXT/i);
    expect(SQL).toMatch(/deleted_at\s+TIMESTAMPTZ/i);
    expect(SQL).toMatch(/created_by_role\s+TEXT\s+NOT NULL/i);
  });

  it('valida domínio de tipo/status/role e período positivo', () => {
    expect(SQL).toMatch(/CHECK \(fim_at > inicio_at\)/i);
    expect(SQL).toMatch(/tipo IN \('almoco', 'ausencia', 'ferias', 'indisponivel'\)/i);
    expect(SQL).toMatch(
      /status IN \('creating', 'active', 'gcal_failed', 'gcal_cleanup_failed', 'deleted'\)/i,
    );
    expect(SQL).toMatch(/created_by_role IN \('owner', 'colaborador'\)/i);
  });

  it('amarra colaborador e autor-colaborador ao mesmo slot/tenant via FK composto', () => {
    expect(SQL).toMatch(/ux_colab_slot_tenant_id/i);
    expect(SQL).toMatch(/agenda_bloqueios_colaborador_scope_fk/i);
    expect(SQL).toMatch(
      /FOREIGN KEY \(slot, tenant_id, colaborador_id\)\s+REFERENCES clone_colaboradores \(slot, tenant_id, id\)/i,
    );
    expect(SQL).toMatch(/agenda_bloqueios_created_by_colaborador_scope_fk/i);
    expect(SQL).toMatch(
      /FOREIGN KEY \(slot, tenant_id, created_by_colaborador_id\)\s+REFERENCES clone_colaboradores \(slot, tenant_id, id\)/i,
    );
  });

  it('tem unique parcial do gcal_event_id ativo e índices de escopo/intervalo', () => {
    expect(SQL).toMatch(/ux_agenda_bloqueios_gcal_event_active/i);
    expect(SQL).toMatch(/WHERE gcal_event_id IS NOT NULL AND deleted_at IS NULL/i);
    expect(SQL).toMatch(/ix_agenda_bloqueios_slot_tenant_interval_status/i);
    expect(SQL).toMatch(/ix_agenda_bloqueios_colaborador_interval_status/i);
  });

  it('é transacional e sem comandos destrutivos nos statements executáveis', () => {
    expect(SQL).toMatch(/\bBEGIN\b/);
    expect(SQL).toMatch(/\bCOMMIT\b/);
    expect(SQL_STMTS).not.toMatch(/^\s*DROP\b/im);
    expect(SQL_STMTS).not.toMatch(/^\s*DELETE\b/im);
    expect(SQL_STMTS).not.toMatch(/^\s*TRUNCATE\b/im);
  });
});
