/**
 * Regressão histórica do hot path que QUEBROU em prod: dual-write tenant_id (ADR 0018,
 * Fase 2) reusando o MESMO placeholder $1 no alvo do INSERT e no subselect (hotfix #309,
 * 2026-06-14) — "inconsistent types deduced for parameter $1" (bot_prompt.slot varchar(50)
 * vs flow_clones.slot varchar(80)).
 *
 * ORIGEM deste arquivo: o caminho concreto que disparava o bug era updateClone re-renderizando
 * bot_prompt a partir da matriz a cada save de personalizacao no portal ("Meu negócio"), com o
 * INSERT INTO bot_prompt usando o subselect de tenant_id.
 *
 * SUPERADO pelo ADR 0035 §2.1 (30/07): esse re-render foi REMOVIDO por completo — bot_prompt é
 * cópia materializada, updateClone não escreve mais em bot_prompt em NENHUM caminho. O
 * subselect com placeholder compartilhado que este arquivo guardava não existe mais em
 * flow-clones.ts (createClone, que fica, propaga tenant_id às satélites via UPDATE pós-INSERT
 * com params próprios — packages/db/src/queries/flow-clones.ts:363-377 —, nunca via subselect
 * inline). A cobertura GERAL do padrão "dual-write não pode reusar $1" continua viva em
 * dualwrite-param-type.test.ts, que exercita setPrompt (bot-prompt.ts) — a MESMA função/query
 * que o updateClone antigo chamava, então o padrão de regressão real (#309) segue coberto lá.
 *
 * Este arquivo agora prova só a invariante NOVA e mais estrita: updateClone não dispara
 * NENHUM INSERT/UPDATE em bot_prompt, então o bug de #309 é estruturalmente impossível por
 * este caminho (não há mais placeholder pra reusar).
 *
 * `../client.js` é MOCKADO — não toca banco.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { queryMock, connectMock } = vi.hoisted(() => ({
  queryMock: vi.fn(),
  connectMock: vi.fn(),
}));

vi.mock('../client.js', () => ({
  query: queryMock,
  pool: { connect: connectMock },
}));

// invalidateTenantCache toca um cache em processo — inofensivo, mas isolamos.
vi.mock('./tenant.js', () => ({
  invalidateTenantCache: vi.fn(),
}));

import { updateClone } from './flow-clones.js';

const CLONE_ID = 42;
const CLONE_SLOT = 'clone_cirilobarbearia_c8w2f0';

function mockUpdateCloneFlow(): void {
  queryMock.mockImplementation(async (sql: string) => {
    const norm = sql.replace(/\s+/g, ' ');
    // SCRUM-112 envolveu o UPDATE num CTE (`WITH prev AS (...) UPDATE ... RETURNING fc.*, ...`)
    // pra decidir o flip de billing_from_agenda_enabled na mesma statement.
    if (norm.includes('UPDATE flow_clones') && /RETURNING fc\.\*/.test(norm)) {
      return {
        rows: [
          {
            id: String(CLONE_ID),
            slot: CLONE_SLOT,
            waha_sessao: null,
            billing_agenda_ativado: false,
          },
        ],
        rowCount: 1,
      };
    }
    return { rows: [], rowCount: 0 };
  });
}

beforeEach(() => {
  queryMock.mockReset();
  connectMock.mockReset();
});

describe('updateClone — bot_prompt nunca é tocado (ADR 0035 §2.1) → #309 estruturalmente impossível aqui', () => {
  it('mudar personalizacao NÃO dispara INSERT/UPDATE em bot_prompt (sem placeholder pra reusar)', async () => {
    mockUpdateCloneFlow();

    await updateClone(CLONE_ID, { personalizacao: { nome_negocio: 'Barbearia do Cirilo' } });

    const botPromptCalls = queryMock.mock.calls.filter(([sql]) =>
      String(sql).replace(/\s+/g, ' ').includes('bot_prompt'),
    );
    expect(botPromptCalls, 'updateClone não deve tocar bot_prompt em nenhum patch').toHaveLength(0);
  });

  it('nem sequer busca matriz_slot ou o prompt da matriz (a releitura foi removida, não só o write)', async () => {
    mockUpdateCloneFlow();

    await updateClone(CLONE_ID, { personalizacao: { nome_negocio: 'Outra' } });

    const matrizCalls = queryMock.mock.calls.filter(([sql]) =>
      String(sql).includes('SELECT matriz_slot'),
    );
    expect(matrizCalls).toHaveLength(0);
  });

  it('sem patch de personalizacao também não toca bot_prompt (comportamento já esperado, sem mudança)', async () => {
    mockUpdateCloneFlow();

    await updateClone(CLONE_ID, { displayName: 'Nome Novo' });

    const botPromptCalls = queryMock.mock.calls.filter(([sql]) =>
      String(sql).replace(/\s+/g, ' ').includes('bot_prompt'),
    );
    expect(botPromptCalls).toHaveLength(0);
  });
});
