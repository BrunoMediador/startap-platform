/**
 * Guard prompt_custom no updateClone (SCRUM-59, migration 070).
 *
 * BUG (piloto Meduzza): updateClone re-renderizava o bot_prompt da MATRIZ em QUALQUER mudança
 * de personalizacao — salvar o perfil (inclusive o toggle agenda_automatica) apagava a persona
 * custom. Fix: só re-renderiza quando prompt_custom=false (default). prompt_custom=true protege.
 *
 * Mocka o `query` do client (sem DB real).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockQuery = vi.fn();

vi.mock('../client.js', () => ({
  pool: {},
  query: (...args: unknown[]) => mockQuery(...args),
}));

const { updateClone } = await import('./flow-clones.js');

/**
 * Arma a sequência de queries do updateClone:
 * 1) WITH prev AS (...) UPDATE flow_clones ... RETURNING fc.*  (traz prompt_custom; CTE do
 *    SCRUM-112 decide o flip de billing_from_agenda_enabled na mesma statement)
 * 2) SELECT matriz_slot                  (só no caminho de re-render)
 * 3) SELECT prompt FROM bot_prompt       (só no re-render)
 * 4) INSERT INTO bot_prompt              (só no re-render)
 * Conta quantas vezes o INSERT do bot_prompt foi disparado.
 */
function arm(promptCustom: boolean) {
  const seen = { renderInsert: 0, matrizSelect: 0 };
  mockQuery.mockImplementation(async (sql: unknown) => {
    const s = typeof sql === 'string' ? sql : '';
    // SCRUM-112 envolveu o UPDATE num CTE (`WITH prev AS (...) UPDATE flow_clones fc SET ...`)
    // pra decidir o flip de billing_from_agenda_enabled na mesma statement — a statement não
    // começa mais com "UPDATE flow_clones SET" (começa com "WITH prev AS").
    if (s.includes('UPDATE flow_clones') && s.includes('RETURNING fc.*')) {
      // RETURNING do updateClone — personalizacao fixa (o re-render usa o patch de ENTRADA,
      // não o valor da row; só precisa ser um objeto válido pro normalizeCloneRow).
      return {
        rows: [
          {
            id: '42',
            slot: 'clone_meduzza_barbearia_q23psc',
            matriz_slot: 'teste_barbearia',
            waha_sessao: null,
            personalizacao: {},
            prompt_custom: promptCustom,
            billing_agenda_ativado: false,
          },
        ],
        rowCount: 1,
      };
    }
    if (s.includes('SELECT matriz_slot')) {
      seen.matrizSelect++;
      return { rows: [{ matriz_slot: 'teste_barbearia' }] };
    }
    if (s.includes('FROM bot_prompt')) {
      return { rows: [{ prompt: 'Template generico {{nome_negocio}}.' }] };
    }
    if (s.includes('INSERT INTO bot_prompt')) {
      seen.renderInsert++;
      return { rows: [] };
    }
    return { rows: [] };
  });
  return seen;
}

describe('updateClone — guard prompt_custom (SCRUM-59)', () => {
  beforeEach(() => mockQuery.mockReset());

  it('prompt_custom=false (default): re-renderiza o bot_prompt (Cirilo/Samuel byte-a-byte)', async () => {
    const seen = arm(false);
    const row = await updateClone(42, { personalizacao: { agenda_automatica: 'false' } });
    expect(row).not.toBeNull();
    expect(seen.matrizSelect).toBe(1);
    expect(seen.renderInsert).toBe(1); // re-renderizou (comportamento de hoje)
  });

  it('prompt_custom=true: NÃO re-renderiza (protege a persona custom do piloto)', async () => {
    const seen = arm(true);
    // Mesmo salvando personalizacao (ex.: o toggle agenda_automatica da seção nova)...
    const row = await updateClone(42, { personalizacao: { agenda_automatica: 'false' } });
    expect(row).not.toBeNull();
    // ...NÃO toca o bot_prompt: nem busca a matriz, nem faz o INSERT do template.
    expect(seen.matrizSelect).toBe(0);
    expect(seen.renderInsert).toBe(0);
    // e o UPDATE de flow_clones em si aconteceu (personalizacao foi gravada).
    const updateCalls = mockQuery.mock.calls.filter(
      ([sql]) =>
        String(sql).includes('UPDATE flow_clones') && String(sql).includes('RETURNING fc.*'),
    );
    expect(updateCalls).toHaveLength(1);
  });

  it('mudança SEM personalizacao nunca re-renderiza (independente de prompt_custom)', async () => {
    const seen = arm(false);
    await updateClone(42, { displayName: 'Novo Nome' });
    expect(seen.renderInsert).toBe(0);
  });

  it('clone flipado pra cartão-runtime (prompt_custom=true) não reintroduz cartão baked no save de perfil', async () => {
    // SCRUM-92 inc.2 (arquiteto 23/07): o flip-on-customize arma prompt_custom=true justamente
    // pra que este guard segure — se re-renderizasse da matriz, o cartão baked voltaria ao
    // bot_prompt e somaria com o cartão injetado em runtime (CARTÃO-DUPLO). Aqui provamos que o
    // save de perfil NÃO reintroduz o cartão baked (nem toca o bot_prompt) num clone flipado.
    const seen = arm(true);
    const row = await updateClone(42, { personalizacao: { agenda_automatica: 'false' } });
    expect(row).not.toBeNull();
    expect(seen.matrizSelect).toBe(0);
    expect(seen.renderInsert).toBe(0); // cartão baked NÃO volta → sem cartão-duplo
  });
});
