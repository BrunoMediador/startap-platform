/**
 * Guarda estática da migration 085 (CRM ranking sem retorno). Invariantes:
 * índices aditivos por tenant/slot/cliente, separados por agenda/manual e com
 * variante de colaborador para manter o caminho de RBAC barato no SQL.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const SQL = readFileSync(
  fileURLToPath(new URL('../../migrations/085_crm_ranking_sem_retorno.sql', import.meta.url)),
  'utf8',
);
const SQL_STMTS = SQL.replace(/--[^\n]*/g, '');

describe('migration 085 — crm ranking sem retorno', () => {
  it('cria índices específicos para agenda/manual no ranking owner', () => {
    expect(SQL).toMatch(/ix_atendimentos_cliente_sem_retorno_agenda/i);
    expect(SQL).toMatch(/COALESCE\(fim_at, inicio_at\) DESC/i);
    expect(SQL).toMatch(/origem = 'agenda'/i);
    expect(SQL).toMatch(/ix_atendimentos_cliente_sem_retorno_manual/i);
    expect(SQL).toMatch(/data DESC/i);
    expect(SQL).toMatch(/origem = 'manual'/i);
  });

  it('cria variantes com colaborador_id para o ranking isolado do colaborador', () => {
    expect(SQL).toMatch(/ix_atendimentos_colab_cliente_sem_retorno_agenda/i);
    expect(SQL).toMatch(/ix_atendimentos_colab_cliente_sem_retorno_manual/i);
    expect(SQL).toMatch(/colaborador_id/i);
    expect(SQL).toMatch(/status <> 'cancelado'/i);
    expect(SQL).toMatch(/cliente_telefone_canonico IS NOT NULL/i);
  });

  it('permanece aditiva e sem comandos destrutivos executáveis', () => {
    expect(SQL).toMatch(/\bBEGIN\b/);
    expect(SQL).toMatch(/\bCOMMIT\b/);
    expect(SQL_STMTS).not.toMatch(/^\s*DROP\b/im);
    expect(SQL_STMTS).not.toMatch(/^\s*DELETE\b/im);
    expect(SQL_STMTS).not.toMatch(/^\s*TRUNCATE\b/im);
  });
});
