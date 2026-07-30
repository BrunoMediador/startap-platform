/**
 * bot_prompt como CÓPIA MATERIALIZADA no updateClone (ADR 0035 §2.1, emenda 30/07).
 *
 * HISTÓRICO: até o SCRUM-59/83/122, updateClone re-renderizava o bot_prompt a partir da
 * MATRIZ (ou do template de atendente) toda vez que `personalizacao` mudava, SALVO quando
 * `prompt_custom=true` — um guard condicional que vinha sendo remendado caso a caso porque a
 * causa-raiz (a releitura existir) continuava viva. ADR 0035 §2.1 (decisão do Bruno, 30/07)
 * mata a releitura de vez: bot_prompt é cópia materializada no nascimento (createClone) e
 * NENHUM caminho de edição de perfil volta a tocá-lo, independente de `prompt_custom`.
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
 * 1) WITH prev AS (...) UPDATE flow_clones ... RETURNING fc.*  (CTE do SCRUM-112 decide o
 *    flip de billing_from_agenda_enabled na mesma statement)
 * Não há mais 2), 3), 4) de re-render — bot_prompt nunca é tocado por este caminho.
 * Conta se algo tentou ler a matriz ou escrever bot_prompt (deve ser sempre 0 agora).
 */
function arm(promptCustom: boolean) {
  const seen = { renderInsert: 0, matrizSelect: 0 };
  mockQuery.mockImplementation(async (sql: unknown) => {
    const s = typeof sql === 'string' ? sql : '';
    // SCRUM-112 envolveu o UPDATE num CTE (`WITH prev AS (...) UPDATE flow_clones fc SET ...`)
    // pra decidir o flip de billing_from_agenda_enabled na mesma statement — a statement não
    // começa mais com "UPDATE flow_clones SET" (começa com "WITH prev AS").
    if (s.includes('UPDATE flow_clones') && s.includes('RETURNING fc.*')) {
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

describe('updateClone — bot_prompt é cópia materializada (ADR 0035 §2.1)', () => {
  beforeEach(() => mockQuery.mockReset());

  it('prompt_custom=false: personalizacao muda, bot_prompt NÃO é tocado (releitura da matriz morreu)', async () => {
    const seen = arm(false);
    const row = await updateClone(42, { personalizacao: { agenda_automatica: 'false' } });
    expect(row).not.toBeNull();
    expect(seen.matrizSelect).toBe(0);
    expect(seen.renderInsert).toBe(0);
  });

  it('prompt_custom=true: mesmo resultado — bot_prompt NÃO é tocado', async () => {
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

  it('mudança SEM personalizacao nunca toca bot_prompt (independente de prompt_custom)', async () => {
    const seen = arm(false);
    await updateClone(42, { displayName: 'Novo Nome' });
    expect(seen.renderInsert).toBe(0);
    expect(seen.matrizSelect).toBe(0);
  });

  it('clone flipado pra cartão-runtime (prompt_custom=true) não reintroduz cartão baked no save de perfil', async () => {
    // SCRUM-92 inc.2 (arquiteto 23/07): o flip-on-customize arma prompt_custom=true justamente
    // pra proteger contra reintrodução do cartão baked. Com a releitura morta (ADR 0035), essa
    // proteção passa a valer por CONSTRUÇÃO (não há mais caminho de re-render aqui) — o teste
    // documenta que o resultado observável não mudou, mesmo que o mecanismo tenha.
    const seen = arm(true);
    const row = await updateClone(42, { personalizacao: { agenda_automatica: 'false' } });
    expect(row).not.toBeNull();
    expect(seen.matrizSelect).toBe(0);
    expect(seen.renderInsert).toBe(0); // cartão baked NÃO volta → sem cartão-duplo
  });

  it('personalizacao com modo_atendente_enabled=true também NÃO toca bot_prompt (ramo atendente morreu junto)', async () => {
    // Antes (SCRUM-122): clone atendente self-service reconstruía a persona de pré-venda a
    // partir de ATENDENTE_PROMPT_TPL a cada save. Esse ramo inteiro foi removido junto com a
    // releitura da matriz — não há mais fonte alternativa por modo, só a cópia materializada.
    const seen = arm(false);
    await updateClone(42, { personalizacao: { faq_personalizado: ['pergunta'] } });
    expect(seen.renderInsert).toBe(0);
    expect(seen.matrizSelect).toBe(0);
  });
});
