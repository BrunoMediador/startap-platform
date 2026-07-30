/**
 * Persona de pré-venda do modo atendente sobrevive ao save de perfil (SCRUM-122).
 *
 * BUG: updateClone reimplementava o re-render de bot_prompt do zero e nunca herdou o fix
 * do SCRUM-79 (regerarPromptClone, clone-provisioning.ts) — clone com modo_atendente_enabled
 * true e prompt_custom=false (o caso normal: a flag só vira true se o dono editar o prompt
 * bruto à mão) tinha a persona de pré-venda SOBRESCRITA pelo template de AGENDA da matriz no
 * 1º save de QUALQUER campo de personalizacao no portal — em silêncio (caso clone_mvs_barbearia).
 *
 * Fix: updateClone usa a MESMA fonte (ATENDENTE_PROMPT_TPL de @startap/core/atendente-prompt,
 * a fonte única que regerarPromptClone também consome) quando modo_atendente_enabled=true, e
 * resolve {{nome_negocio}}/{{area_artigo}} (que applyPersonalizacao sozinha não resolve).
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
 * Registra: se o SELECT da matriz (bot_prompt de AGENDA) foi disparado, e o prompt
 * efetivamente gravado no INSERT de bot_prompt.
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
    // Template de AGENDA da matriz — NUNCA deveria ser lido/gravado pra clone atendente.
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

describe('updateClone — persona do modo atendente sobrevive ao save de perfil (SCRUM-122)', () => {
  beforeEach(() => mockQuery.mockReset());

  it('modo_atendente_enabled=true, prompt_custom=false: re-render usa a persona de pré-venda, NÃO a matriz de agenda', async () => {
    const seen = armAtendente({ modoAtendente: true, promptCustom: false });
    const row = await updateClone(99, {
      personalizacao: { endereco: 'Rua X, 123' }, // qualquer save de perfil, sem tocar no prompt
    });
    expect(row).not.toBeNull();
    // NUNCA busca o template de agenda da matriz pra clone atendente.
    expect(seen.matrizSelect).toBe(0);
    expect(seen.insertedPrompt).not.toBeNull();
    expect(seen.insertedPrompt).toContain('atendente virtual de');
    expect(seen.insertedPrompt).not.toContain('inserir_agendamento');
    // Placeholders de identidade resolvidos (nunca literal no bot_prompt persistido).
    expect(seen.insertedPrompt).not.toContain('{{nome_negocio}}');
    expect(seen.insertedPrompt).not.toContain('{{area_artigo}}');
  });

  it('modo_atendente_enabled=false (agenda normal): comportamento histórico intocado', async () => {
    const seen = armAtendente({ modoAtendente: false, promptCustom: false });
    const row = await updateClone(99, { personalizacao: { endereco: 'Rua X, 123' } });
    expect(row).not.toBeNull();
    expect(seen.matrizSelect).toBe(1);
    expect(seen.insertedPrompt).toContain('inserir_agendamento');
  });

  it('modo_atendente_enabled=true MAS prompt_custom=true (persona editada à mão): não re-renderiza', async () => {
    const seen = armAtendente({ modoAtendente: true, promptCustom: true });
    const row = await updateClone(99, { personalizacao: { endereco: 'Rua X, 123' } });
    expect(row).not.toBeNull();
    expect(seen.matrizSelect).toBe(0);
    expect(seen.insertedPrompt).toBeNull();
  });
});
