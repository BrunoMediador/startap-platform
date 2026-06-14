/**
 * Testa o data layer do perfil do negocio (Missao 023 W13).
 *
 * Invariante CRITICA: updatePerfilBySlot faz MERGE das 6 chaves no
 * personalizacao existente — NUNCA sobrescreve o objeto inteiro (preserva
 * observacoes/promocoes/etc que o cliente/gestao ja tenham cadastrado).
 *
 * DB mockado (../client.js). O re-render do prompt e a invalidacao de cache
 * passam pelo updateClone REAL (mesmo modulo), entao mockamos as queries que
 * ele dispara. O foco do teste e o objeto persistido em flow_clones.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockQuery = vi.fn();

vi.mock('../client.js', () => ({
  pool: {},
  query: (...args: unknown[]) => mockQuery(...args),
}));

const { getPerfilBySlot, updatePerfilBySlot } = await import('./portal-config.js');

const SLOT = 'clone_edu_a1b2c3';

beforeEach(() => {
  mockQuery.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('getPerfilBySlot', () => {
  it('le as 6 chaves do personalizacao; ausentes viram ""', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{ personalizacao: { nome_negocio: 'Barbearia Edu', instagram: 'edubarber' } }],
    });

    const perfil = await getPerfilBySlot(SLOT);

    expect(perfil).toEqual({
      nome_negocio: 'Barbearia Edu',
      nome_prestador: '',
      telefone_contato: '',
      endereco: '',
      instagram: 'edubarber',
      formas_pagamento: '',
    });
    // slot vai parametrizado ($1), nunca interpolado.
    expect(mockQuery).toHaveBeenCalledWith(expect.stringContaining('WHERE slot = $1'), [SLOT]);
  });

  it('retorna null quando o slot nao existe', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    expect(await getPerfilBySlot(SLOT)).toBeNull();
  });
});

describe('updatePerfilBySlot', () => {
  /**
   * Prepara a sequencia de mocks que updatePerfilBySlot + updateClone disparam:
   * 1) SELECT id, personalizacao (updatePerfilBySlot)
   * 2) UPDATE flow_clones ... RETURNING * (updateClone)
   * 3) SELECT matriz_slot (updateClone, re-render)
   * 4) SELECT prompt FROM bot_prompt (matriz)
   * 5) INSERT bot_prompt ... ON CONFLICT (re-render)
   * Captura o JSON gravado em flow_clones (call #2, param $1) para inspecao.
   */
  function armMocks(personalizacaoAtual: Record<string, string>) {
    const captured: { mergedJson?: string } = {};
    mockQuery.mockImplementation(async (sql: string, params: unknown[] = []) => {
      if (sql.includes('SELECT id, personalizacao')) {
        return { rows: [{ id: 42, personalizacao: personalizacaoAtual }] };
      }
      if (sql.startsWith('UPDATE flow_clones SET')) {
        // updateClone: personalizacao = $1::jsonb (primeiro/unico SET dinamico aqui)
        captured.mergedJson = params[0] as string;
        return {
          rows: [
            {
              id: '42',
              slot: SLOT,
              matriz_slot: 'teste_barbearia',
              waha_sessao: null,
              personalizacao: JSON.parse(params[0] as string),
            },
          ],
        };
      }
      if (sql.includes('SELECT matriz_slot')) {
        return { rows: [{ matriz_slot: 'teste_barbearia' }] };
      }
      if (sql.includes('FROM bot_prompt')) {
        return { rows: [{ prompt: 'Ola, voce fala com {{nome_negocio}}.' }] };
      }
      if (sql.includes('INSERT INTO bot_prompt')) {
        return { rows: [] };
      }
      return { rows: [] };
    });
    return captured;
  }

  it('MERGE preserva outras chaves do personalizacao (NAO sobrescreve o objeto)', async () => {
    const captured = armMocks({
      nome_negocio: 'Nome Antigo',
      observacoes_gerais: 'Estacionamento na frente',
      promocao_atual: '2 cortes por R$50',
    });

    const ok = await updatePerfilBySlot(SLOT, {
      nome_negocio: 'Barbearia do Edu',
      nome_prestador: 'Edu',
    });

    expect(ok).toBe(true);
    const merged = JSON.parse(captured.mergedJson ?? '{}');
    // Chaves do perfil enviadas foram atualizadas...
    expect(merged.nome_negocio).toBe('Barbearia do Edu');
    expect(merged.nome_prestador).toBe('Edu');
    // ...e as chaves NAO-perfil sobreviveram intactas.
    expect(merged.observacoes_gerais).toBe('Estacionamento na frente');
    expect(merged.promocao_atual).toBe('2 cortes por R$50');
  });

  it('campos ausentes no payload nao tocam as chaves correspondentes', async () => {
    const captured = armMocks({ telefone_contato: '11999990000', endereco: 'Rua X, 1' });

    await updatePerfilBySlot(SLOT, { nome_negocio: 'Novo' });

    const merged = JSON.parse(captured.mergedJson ?? '{}');
    expect(merged.nome_negocio).toBe('Novo');
    // nao enviados: preservados
    expect(merged.telefone_contato).toBe('11999990000');
    expect(merged.endereco).toBe('Rua X, 1');
  });

  it('campo "" (string vazia) grava como limpar', async () => {
    const captured = armMocks({ formas_pagamento: 'Pix' });

    await updatePerfilBySlot(SLOT, { formas_pagamento: '' });

    const merged = JSON.parse(captured.mergedJson ?? '{}');
    expect(merged.formas_pagamento).toBe('');
  });

  it('retorna false quando o slot nao existe', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] }); // SELECT id, personalizacao -> vazio
    const ok = await updatePerfilBySlot(SLOT, { nome_negocio: 'X' });
    expect(ok).toBe(false);
  });
});
