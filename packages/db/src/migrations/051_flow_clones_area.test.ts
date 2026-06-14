/**
 * Guarda estática da migration 051 (Missão 023 W8).
 *
 * Garante por INSPEÇÃO DO SQL duas invariantes que o resto do PR depende:
 *
 *  1. A reescrita do PROMPT atinge SÓ a matriz (`slot = 'teste_barbearia'`) e
 *     NÃO nenhuma linha de bot_prompt de CLONE. Combinado com o fato de que o
 *     bot lê o prompt do PRÓPRIO slot do clone (apps/api render-prompt.ts, sem
 *     cascata clone->matriz), isto prova que Cirilo/Edu/Samuel NÃO são
 *     re-renderizados por este PR — o re-render é passo gated separado.
 *  2. A migration é ADITIVA e REVERSÍVEL: ADD COLUMN IF NOT EXISTS, sem
 *     DROP/DELETE/TRUNCATE (regra de ouro), backfill idempotente (WHERE area IS NULL).
 *
 * É um teste de string proposital: a segurança aqui é o conteúdo do SQL, não o
 * comportamento de runtime (não há DB neste unit).
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const SQL = readFileSync(
  fileURLToPath(new URL('../../migrations/051_flow_clones_area.sql', import.meta.url)),
  'utf8',
);

describe('migration 051 — flow_clones.area + matriz parametrizada', () => {
  it('adiciona a coluna area de forma idempotente (ADD COLUMN IF NOT EXISTS)', () => {
    expect(SQL).toMatch(/ALTER TABLE flow_clones ADD COLUMN IF NOT EXISTS area\b/i);
  });

  it('backfill barbearia nos clones atuais, só onde está NULL (idempotente)', () => {
    expect(SQL).toMatch(
      /UPDATE flow_clones[\s\S]*SET area = 'barbearia'[\s\S]*WHERE area IS NULL/i,
    );
  });

  it('NÃO usa CHECK constraint na coluna area (taxonomia é Zod no app)', () => {
    expect(SQL).not.toMatch(/CHECK\s*\(/i);
  });

  it('a reescrita do prompt atinge SÓ a matriz teste_barbearia (nunca clone)', () => {
    // Todo UPDATE de bot_prompt precisa estar filtrado pela matriz.
    const promptUpdates = SQL.match(/UPDATE bot_prompt[\s\S]*?;/gi) ?? [];
    expect(promptUpdates.length).toBeGreaterThan(0);
    for (const stmt of promptUpdates) {
      expect(stmt).toMatch(/WHERE[\s\S]*slot = 'teste_barbearia'/i);
    }
  });

  it('NÃO toca bot_prompt de clones (sem subselect de flow_clones, sem slot LIKE clone_)', () => {
    const promptUpdates = SQL.match(/UPDATE bot_prompt[\s\S]*?;/gi) ?? [];
    for (const stmt of promptUpdates) {
      expect(stmt).not.toMatch(/SELECT slot FROM flow_clones/i);
      expect(stmt).not.toMatch(/clone_/);
    }
  });

  it('o novo template da matriz usa {{area_artigo}} (parametrização W8)', () => {
    expect(SQL).toMatch(/\{\{area_artigo\}\}/);
  });

  it('é não-destrutiva: nenhum DROP/DELETE/TRUNCATE no corpo executável', () => {
    // Ignora comentários (-- ...) e olha só as linhas de comando.
    const executable = SQL.split('\n')
      .filter((l) => !l.trimStart().startsWith('--'))
      .join('\n');
    expect(executable).not.toMatch(/\bDROP\b/i);
    expect(executable).not.toMatch(/\bDELETE\b/i);
    expect(executable).not.toMatch(/\bTRUNCATE\b/i);
  });
});
