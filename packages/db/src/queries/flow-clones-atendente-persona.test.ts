/**
 * SCRUM-122 (regressão do SCRUM-79): o re-render do updateClone tem de HONRAR
 * modo_atendente_enabled.
 *
 * BUG: quando personalizacao muda e prompt_custom=false, updateClone re-renderizava
 * SEMPRE a partir da MATRIZ (agenda) — ignorando modo_atendente_enabled. Resultado:
 * o 1º save de perfil de um clone ATENDENTE reescrevia o bot_prompt com a persona de
 * AGENDA (cartão de confirmação + inserir_agendamento + regra do SIM), matando a
 * persona de pré-venda. O caminho correto já existia em regerarPromptClone (usa
 * ATENDENTE_PROMPT_TPL quando modo_atendente_enabled). Este teste FALHA sem o fix.
 *
 * Mocka o `query` do client (sem DB real), mesmo padrão de flow-clones-prompt-custom.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockQuery = vi.fn();

vi.mock('../client.js', () => ({
  pool: {},
  query: (...args: unknown[]) => mockQuery(...args),
}));

const { updateClone } = await import('./flow-clones.js');

/**
 * Arma a sequência de queries do updateClone e captura o prompt persistido.
 * @param opts.modoAtendente valor de flow_clones.modo_atendente_enabled no RETURNING *.
 * Retorna contadores (matrizSelect / renderInsert) e o último prompt inserido.
 */
function arm(opts: { modoAtendente: boolean }) {
  const seen = { matrizSelect: 0, renderInsert: 0, insertedPrompt: '' as string };
  mockQuery.mockImplementation(async (sql: unknown, params?: unknown[]) => {
    const s = typeof sql === 'string' ? sql : '';
    if (s.startsWith('UPDATE flow_clones SET')) {
      return {
        rows: [
          {
            id: '77',
            slot: 'clone_atendente_selfservice',
            matriz_slot: 'teste_barbearia',
            waha_sessao: null,
            personalizacao: {},
            prompt_custom: false,
            modo_atendente_enabled: opts.modoAtendente,
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
      // Matriz de AGENDA: contém as marcas que NÃO podem vazar pro clone atendente.
      return {
        rows: [
          {
            prompt:
              'Voce agenda em {{nome_negocio}}. [CARTAO DE CONFIRMACAO] DEVE chamar inserir_agendamento. So confirme com SIM.',
          },
        ],
      };
    }
    if (s.startsWith('INSERT INTO bot_prompt')) {
      seen.renderInsert++;
      seen.insertedPrompt = String(params?.[1] ?? '');
      return { rows: [] };
    }
    return { rows: [] };
  });
  return seen;
}

describe('updateClone — re-render HONRA modo_atendente_enabled (SCRUM-122)', () => {
  beforeEach(() => mockQuery.mockReset());

  it('clone ATENDENTE: semeia a persona de pré-venda, NÃO a matriz de agenda', async () => {
    const seen = arm({ modoAtendente: true });
    const row = await updateClone(77, {
      personalizacao: { nome_negocio: 'Studio Corte', area: 'barbearia' },
    });
    expect(row).not.toBeNull();

    // NÃO leu a matriz de agenda...
    expect(seen.matrizSelect).toBe(0);
    // ...mas re-renderizou (persistiu o bot_prompt do clone).
    expect(seen.renderInsert).toBe(1);

    // O prompt persistido é a persona de pré-venda, SEM os artefatos de agenda.
    expect(seen.insertedPrompt).toContain('atendente virtual de Studio Corte');
    expect(seen.insertedPrompt).not.toContain('[CARTAO DE CONFIRMACAO]');
    expect(seen.insertedPrompt).not.toContain('inserir_agendamento');
    expect(seen.insertedPrompt).not.toMatch(/confirme com SIM/i);

    // {{area_artigo}} foi resolvido (barbearia -> "a barbearia"), sem placeholder cru.
    expect(seen.insertedPrompt).toContain('a barbearia');
    expect(seen.insertedPrompt).not.toContain('{{');
  });

  it('clone de AGENDA (modo_atendente_enabled=false): segue lendo a matriz (byte-a-byte intacto)', async () => {
    const seen = arm({ modoAtendente: false });
    const row = await updateClone(77, {
      personalizacao: { nome_negocio: 'Barbearia Z' },
    });
    expect(row).not.toBeNull();

    // Caminho histórico preservado: lê a matriz e re-renderiza dela.
    expect(seen.matrizSelect).toBe(1);
    expect(seen.renderInsert).toBe(1);
    // A persona de agenda foi mantida (nome aplicado sobre o template da matriz).
    expect(seen.insertedPrompt).toContain('[CARTAO DE CONFIRMACAO]');
    expect(seen.insertedPrompt).toContain('Barbearia Z');
  });
});
