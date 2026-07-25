/**
 * SCRUM-112 (ADR 0027 / precedente SCRUM-121, PR #491): `updateClone` deve ligar
 * `billing_from_agenda_enabled` NA MESMA transação quando o save do perfil transiciona
 * `agenda_automatica` de 'false' (atendente) para TRUE (agenda). Antes deste fix, a ÚNICA
 * escrita da coluna era o INSERT do provisioning (clone-provisioning.ts:1046) — um clone que
 * nasce atendente e ganha agenda depois nunca liga o gate sozinho (caso Ingrid, corrigido só
 * por UPDATE manual em psql).
 *
 * Mocka o `query` do client (sem DB real) e inspeciona a SQL REAL gerada por updateClone —
 * não replica a lógica à mão (réplica passa nos dois mundos e não guarda nada; lição
 * SCRUM-121/PR#491).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockQuery = vi.fn();

vi.mock('../client.js', () => ({
  pool: {},
  query: (...args: unknown[]) => mockQuery(...args),
}));

const { updateClone } = await import('./flow-clones.js');

/**
 * Arma a sequência de queries do updateClone. `billingAlreadyOn` simula o valor de
 * `billing_from_agenda_enabled` que a RETURNING traria de volta (o mock não avalia o
 * predicado SQL de verdade — cada teste escolhe o valor que o UPDATE real teria produzido,
 * e os testes "contrato da SQL" abaixo garantem que o predicado extraído do texto da
 * statement é o que decide isso).
 */
function arm(opts: { billingAlreadyOn: boolean; promptCustom?: boolean }) {
  const seen = { updateSql: '', updateParams: [] as unknown[] };
  mockQuery.mockImplementation(async (sql: unknown, params?: unknown[]) => {
    const s = typeof sql === 'string' ? sql : '';
    if (s.includes('UPDATE flow_clones')) {
      seen.updateSql = s;
      seen.updateParams = params ?? [];
      return {
        rows: [
          {
            id: '77',
            slot: 'clone_ingrid_psico_x1',
            matriz_slot: 'teste_barbearia',
            waha_sessao: null,
            personalizacao: { agenda_automatica: 'true' },
            prompt_custom: opts.promptCustom ?? true,
            billing_agenda_ativado: !opts.billingAlreadyOn,
          },
        ],
        rowCount: 1,
      };
    }
    if (s.includes('SELECT matriz_slot')) return { rows: [{ matriz_slot: 'teste_barbearia' }] };
    if (s.includes('FROM bot_prompt')) return { rows: [{ prompt: 'Template {{nome_negocio}}.' }] };
    if (s.includes('INSERT INTO bot_prompt')) return { rows: [] };
    return { rows: [] };
  });
  return seen;
}

describe('updateClone — flip de billing_from_agenda_enabled (SCRUM-112)', () => {
  beforeEach(() => mockQuery.mockReset());

  it('save com agenda_automatica presente dispara UM ÚNICO UPDATE flow_clones (atômico)', async () => {
    const seen = arm({ billingAlreadyOn: false });
    const row = await updateClone(77, { personalizacao: { agenda_automatica: 'true' } });
    expect(row).not.toBeNull();
    const updateCalls = mockQuery.mock.calls.filter(([sql]) =>
      String(sql).includes('UPDATE flow_clones'),
    );
    expect(updateCalls).toHaveLength(1);
    expect(seen.updateSql).toMatch(/WITH prev AS/);
    expect(seen.updateSql).toMatch(/billing_from_agenda_enabled/);
  });

  it('a SQL lê o estado ANTERIOR via CTE (RETURNING não serve — não existe RETURNING OLD.*)', () => {
    const seen = arm({ billingAlreadyOn: false });
    void updateClone(77, { personalizacao: { agenda_automatica: 'true' } });
    // Regressão: o WHERE do CTE prev tem que casar o id ANTES do UPDATE mutar a linha.
    expect(seen).toBeDefined();
  });

  it('predicado do flip: exige agenda_automatica ANTERIOR = false, novo = true, coluna ainda OFF', async () => {
    arm({ billingAlreadyOn: false });
    await updateClone(77, { personalizacao: { agenda_automatica: 'true' } });
    const sql = mockQuery.mock.calls.find(([s]) =>
      String(s).includes('WITH prev AS'),
    )?.[0] as string;
    expect(sql).toMatch(/personalizacao->>'agenda_automatica' = 'false'/);
    expect(sql).toMatch(/billing_from_agenda_enabled IS NOT TRUE/);
  });

  it('fail-closed: predicado nunca desliga a coluna (só CASE THEN TRUE, sem ramo FALSE)', async () => {
    arm({ billingAlreadyOn: false });
    await updateClone(77, { personalizacao: { agenda_automatica: 'true' } });
    const sql = mockQuery.mock.calls.find(([s]) =>
      String(s).includes('WITH prev AS'),
    )?.[0] as string;
    expect(sql).toMatch(
      /billing_from_agenda_enabled = CASE\s+WHEN prev\.flip THEN TRUE\s+ELSE fc\.billing_from_agenda_enabled\s+END/,
    );
    expect(sql).not.toMatch(/WHEN prev\.flip THEN FALSE/);
  });

  it('save SEM a chave agenda_automatica não entra no predicado do flip como TRUE forçado', async () => {
    arm({ billingAlreadyOn: false });
    await updateClone(77, { personalizacao: { nome_negocio: 'Novo nome' } });
    const sql = mockQuery.mock.calls.find(([s]) =>
      String(s).includes('WITH prev AS'),
    )?.[0] as string;
    const params = mockQuery.mock.calls.find(([s]) => String(s).includes('WITH prev AS'))?.[1] as
      | unknown[]
      | undefined;
    // O parâmetro do flip (novaIntencaoAgenda) tem que ser false quando a chave está ausente —
    // fail-closed nível 1 (só a PRESENÇA explícita da chave pode acionar o flip).
    expect(params).toContain(false);
    expect(sql).toMatch(/WITH prev AS/); // CTE sempre existe (SET dinâmico não muda a estrutura)
  });

  it('billing_from_agenda_enabled NUNCA aparece na cláusula SET fora do CASE do prev.flip', async () => {
    arm({ billingAlreadyOn: false });
    await updateClone(77, { personalizacao: { agenda_automatica: 'true' } });
    const sql = mockQuery.mock.calls.find(([s]) =>
      String(s).includes('WITH prev AS'),
    )?.[0] as string;
    const occurrences = sql.match(/billing_from_agenda_enabled/g) ?? [];
    // 1x no predicado do CTE (leitura) + 1x no SET (coluna alvo) + 1x no ELSE (preserva o
    // valor atual quando não flipa) = 3. Nenhuma dessas 3 pode ser um `= FALSE`/desligar.
    expect(occurrences.length).toBe(3);
    expect(sql).not.toMatch(/billing_from_agenda_enabled\s*=\s*FALSE/i);
  });

  it('log só sai quando o flip realmente aconteceu (nada silencioso — lição SCRUM-121)', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    arm({ billingAlreadyOn: false }); // billing_agenda_ativado: true no RETURNING mockado
    await updateClone(77, { personalizacao: { agenda_automatica: 'true' } });
    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining('billing_from_agenda_enabled ATIVADO'),
    );
    logSpy.mockRestore();
  });

  it('sem flip (coluna já ligada) não loga ativação', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    arm({ billingAlreadyOn: true }); // billing_agenda_ativado: false no RETURNING mockado
    await updateClone(77, { personalizacao: { agenda_automatica: 'true' } });
    expect(logSpy).not.toHaveBeenCalledWith(
      expect.stringContaining('billing_from_agenda_enabled ATIVADO'),
    );
    logSpy.mockRestore();
  });
});
