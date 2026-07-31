/**
 * Persona de pré-venda do modo atendente sobrevive ao save de perfil — histórico SCRUM-122,
 * SUPERADO pelo ADR 0035 §2.1 (emenda 30/07, decisão do Bruno).
 *
 * BUG ORIGINAL (SCRUM-122): updateClone reimplementava o re-render de bot_prompt do zero e
 * nunca herdou o fix do SCRUM-79 (regerarPromptClone, clone-provisioning.ts) — clone com
 * modo_atendente_enabled=true e prompt_custom=false (o caso normal) tinha a persona de
 * pré-venda SOBRESCRITA pelo template de AGENDA da matriz no 1º save de QUALQUER campo de
 * personalizacao no portal — em silêncio (caso clone_mvs_barbearia). O fix do SCRUM-122
 * (29/07) unificou a fonte do template por modo; durou 1 dia.
 *
 * ADR 0035 §2.1 (30/07): bot_prompt é CÓPIA MATERIALIZADA no nascimento — updateClone não
 * regenera prompt por NENHUM caminho (nem matriz de agenda, nem template de atendente,
 * independente de prompt_custom). A causa-raiz do SCRUM-122 (o bloco de re-render existir)
 * foi removida, não remendada de novo. Este arquivo prova a invariante nova: save de perfil
 * NUNCA toca bot_prompt, em nenhuma combinação de modo_atendente_enabled/prompt_custom.
 *
 * Mocka o `query` do client (sem DB real) — mesmo padrão de flow-clones-prompt-custom.test.ts.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockQuery = vi.fn();

vi.mock('../client.js', () => ({
  pool: {},
  query: (...args: unknown[]) => mockQuery(...args),
}));

const { updateClone } = await import('./flow-clones.js');

/**
 * Arma a sequência de queries do updateClone pra um clone MODO ATENDENTE.
 * Registra: se o SELECT da matriz (bot_prompt de AGENDA) foi disparado, e se algo tentou
 * escrever em bot_prompt — ambos devem ser 0/null sempre, em qualquer combinação.
 */
function armAtendente(opts: { modoAtendente: boolean; promptCustom: boolean }) {
  const seen = { matrizSelect: 0, insertedPrompt: null as string | null };
  mockQuery.mockImplementation(async (sql: unknown, params?: unknown[]) => {
    const s = typeof sql === 'string' ? sql : '';
    if (s.includes('UPDATE flow_clones') && s.includes('RETURNING fc.*')) {
      return {
        rows: [
          {
            id: '99',
            slot: 'clone_mvs_barbearia_qc9qff',
            matriz_slot: 'teste_barbearia',
            display_name: 'MVS Barbearia',
            waha_sessao: null,
            personalizacao: {},
            prompt_custom: opts.promptCustom,
            modo_atendente_enabled: opts.modoAtendente,
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
    // Template de AGENDA da matriz — NUNCA deveria ser lido/gravado por updateClone agora.
    if (s.includes('FROM bot_prompt')) {
      return {
        rows: [{ prompt: 'Voce DEVE chamar inserir_agendamento quando o cliente confirmar.' }],
      };
    }
    if (s.includes('INSERT INTO bot_prompt')) {
      seen.insertedPrompt = (params?.[1] as string) ?? null;
      return { rows: [] };
    }
    return { rows: [] };
  });
  return seen;
}

describe('updateClone — bot_prompt NUNCA regenera por save de perfil (ADR 0035 §2.1, ex-SCRUM-122)', () => {
  beforeEach(() => mockQuery.mockReset());

  it('modo_atendente_enabled=true, prompt_custom=false: bot_prompt intocado (persona de pré-venda preservada por construção)', async () => {
    const seen = armAtendente({ modoAtendente: true, promptCustom: false });
    const row = await updateClone(99, {
      personalizacao: { endereco: 'Rua X, 123' }, // qualquer save de perfil, sem tocar no prompt
    });
    expect(row).not.toBeNull();
    expect(seen.matrizSelect).toBe(0);
    expect(seen.insertedPrompt).toBeNull();
  });

  it('modo_atendente_enabled=false (agenda normal): bot_prompt igualmente intocado (comportamento uniforme, não mais condicional a modo)', async () => {
    const seen = armAtendente({ modoAtendente: false, promptCustom: false });
    const row = await updateClone(99, { personalizacao: { endereco: 'Rua X, 123' } });
    expect(row).not.toBeNull();
    expect(seen.matrizSelect).toBe(0);
    expect(seen.insertedPrompt).toBeNull();
  });

  it('modo_atendente_enabled=true, prompt_custom=true (persona editada à mão): idêntico aos demais casos', async () => {
    const seen = armAtendente({ modoAtendente: true, promptCustom: true });
    const row = await updateClone(99, { personalizacao: { endereco: 'Rua X, 123' } });
    expect(row).not.toBeNull();
    expect(seen.matrizSelect).toBe(0);
    expect(seen.insertedPrompt).toBeNull();
  });
});
