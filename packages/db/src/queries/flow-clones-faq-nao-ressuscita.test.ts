/**
 * P0 da review de security da PR #552 (01/08): `faq_personalizado` NÃO pode ser reintroduzido
 * no JSONB `personalizacao` por um caller que faz merge a partir de uma leitura STALE (cache de
 * 60s em getCloneBySlot, caminho apps/portal-api/src/routes/prompt-builder.ts:721) depois que o
 * FAQ já foi migrado pro bot_prompt (scripts/migrate-faq-para-prompt.ts).
 *
 * IMPORTANTE: updateClone tem a invariante testada em flow-clones-dualwrite.test.ts (ADR 0035
 * §2.1) de NUNCA referenciar `bot_prompt`, nem em leitura — este fix NÃO pode violar isso (1ª
 * versão desta correção violava, via LEFT JOIN bot_prompt, e quebrou aquele arquivo; corrigido).
 * O sinal de "migrado" usado aqui é só `flow_clones.personalizacao` (a PRÓPRIA linha, lida
 * dentro da MESMA statement de UPDATE): se ela JÁ NÃO TEM a chave `faq_personalizado`, nenhum
 * patch pode reintroduzi-la — não importa se a ausência veio de nunca ter existido ou de ter
 * sido migrada, o tratamento (ignorar o patch pra essa chave) é o mesmo nos dois casos.
 *
 * Este teste NÃO confia em regex sobre o texto da query (o `flow-clones-billing-from-agenda-
 * flip.test.ts` já cobre o contrato textual da CTE `prev`). Em vez disso, o mock IMPLEMENTA a
 * semântica JSONB da expressão SQL de verdade (->  IS NULL, jsonb_build_object, ||, -) em JS,
 * simulando fielmente o que o Postgres faria. Prova os 3 ramos:
 *   1. banco JÁ NÃO TEM a chave (nunca teve OU já migrada) + patch reintroduzindo -> IGNORADA;
 *   2. banco TEM a chave + patch com a chave -> valor do patch prevalece (edição normal);
 *   3. banco TEM a chave + patch SEM a chave -> preserva o valor já no banco (merge parcial).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockQuery = vi.fn();

vi.mock('../client.js', () => ({
  pool: {},
  query: (...args: unknown[]) => mockQuery(...args),
}));

const { updateClone } = await import('./flow-clones.js');

interface DbState {
  personalizacao: Record<string, unknown>;
}

/** Reimplementa em JS a MESMA semântica da expressão SQL gerada por updateClone — só pra
 *  simular o efeito de rodar contra um Postgres real, sem precisar de um. */
function simulateUpdate(
  db: DbState,
  patchPersonalizacao: Record<string, unknown> | undefined,
): Record<string, unknown> {
  if (patchPersonalizacao === undefined) return db.personalizacao;

  const withoutFaqKey = { ...patchPersonalizacao };
  // Simula o operador SQL `- 'chave'`, que REMOVE a chave de fato (não deixa null/undefined) —
  // `= undefined` mudaria a semântica do mock e faria o teste divergir do Postgres que reproduz.
  // biome-ignore lint/performance/noDelete: ver comentário acima.
  delete withoutFaqKey.faq_personalizado;

  const dbHasKey = db.personalizacao.faq_personalizado !== undefined;
  let faqPart: Record<string, unknown> = {};
  if (!dbHasKey) {
    faqPart = {}; // ramo 1: banco já não tem -> SEMPRE ausente, ignora o patch.
  } else if (patchPersonalizacao.faq_personalizado !== undefined) {
    faqPart = { faq_personalizado: patchPersonalizacao.faq_personalizado }; // ramo 2.
  } else {
    faqPart = { faq_personalizado: db.personalizacao.faq_personalizado }; // ramo 3.
  }
  return { ...withoutFaqKey, ...faqPart };
}

/** Arma o mock pra devolver, no RETURNING, o resultado da simulação acima — o teste prova a
 *  LÓGICA (via simulateUpdate, espelho fiel do SQL); a query real roda contra staging/prod
 *  pelo PM antes do --apply, fora do escopo deste unit (sem Postgres local disponível). */
function arm(db: DbState) {
  mockQuery.mockImplementation(async (sql: unknown, params?: unknown[]) => {
    const s = typeof sql === 'string' ? sql : '';
    if (s.includes('WITH prev AS') && s.includes('UPDATE flow_clones')) {
      const patchJson = (params as unknown[])?.find(
        (p) => typeof p === 'string' && p.startsWith('{'),
      ) as string | undefined;
      const patch = patchJson ? (JSON.parse(patchJson) as Record<string, unknown>) : undefined;
      const finalPersonalizacao = simulateUpdate(db, patch);
      return {
        rows: [
          {
            id: '77',
            slot: 'clone_x',
            matriz_slot: 'teste_barbearia',
            waha_sessao: null,
            personalizacao: finalPersonalizacao,
            prompt_custom: true,
            billing_agenda_ativado: false,
          },
        ],
        rowCount: 1,
      };
    }
    return { rows: [] };
  });
}

beforeEach(() => mockQuery.mockReset());

describe('updateClone — faq_personalizado NÃO ressuscita pós-migração (P0 PR #552)', () => {
  it('ramo 1: banco JÁ NÃO TEM a chave (migrado) — patch reintroduzindo (spread stale) é IGNORADO', async () => {
    arm({ personalizacao: {} }); // já migrado: o JSONB no banco não tem mais a chave.
    // Simula o bug relatado: prompt-builder.ts fez spread de um cloneFull.personalizacao
    // STALE (lido 60s atrás, ainda com a chave) + nome_assistente.
    const row = await updateClone(77, {
      personalizacao: {
        faq_personalizado: [{ pergunta: 'stale', resposta: 'stale' }],
        nome_assistente: 'Rafa',
      },
    });
    expect(row?.personalizacao).toEqual({ nome_assistente: 'Rafa' });
    expect(row?.personalizacao).not.toHaveProperty('faq_personalizado');
  });

  it('ramo 2: banco TEM a chave — edição normal do FAQ pela tela do portal continua funcionando', async () => {
    arm({ personalizacao: { faq_personalizado: [] } });
    const novoFaq = [{ pergunta: 'Tem estacionamento?', resposta: 'Sim' }];
    const row = await updateClone(77, { personalizacao: { faq_personalizado: novoFaq } });
    expect(row?.personalizacao.faq_personalizado).toEqual(novoFaq);
  });

  it('ramo 2b: banco TEM a chave — [] LIMPA o FAQ (continua funcionando)', async () => {
    arm({ personalizacao: { faq_personalizado: [{ pergunta: 'antiga', resposta: 'r' }] } });
    const row = await updateClone(77, { personalizacao: { faq_personalizado: [] } });
    expect(row?.personalizacao.faq_personalizado).toEqual([]);
  });

  it('ramo 3: banco TEM a chave — patch sem a chave PRESERVA o valor já no banco (merge parcial)', async () => {
    const faqExistente = [{ pergunta: 'antiga', resposta: 'resposta' }];
    arm({ personalizacao: { faq_personalizado: faqExistente } });
    const row = await updateClone(77, { personalizacao: { nome_negocio: 'Novo nome' } });
    expect(row?.personalizacao.faq_personalizado).toEqual(faqExistente);
    expect(row?.personalizacao.nome_negocio).toBe('Novo nome');
  });

  it('⚠️ LIMITAÇÃO CONHECIDA (documentada, não corrigida nesta PR): clone que NUNCA teve FAQ ' +
    'não consegue CADASTRAR pela 1ª vez — indistinguível de "já migrado" sem sinal extra', async () => {
    arm({ personalizacao: {} }); // nunca teve a chave — banco igual ao de um clone MIGRADO.
    // Este é o motivo de eu ter parado e devolvido ao PM em vez de aplicar sozinho: sem um
    // sinal EXPLÍCITO de "migrado" (ex.: coluna nova, que exigiria migration — fora do escopo
    // que o PM pediu pra esta correção), "banco sem a chave" é AMBÍGUO entre "nunca teve FAQ"
    // e "já migrado pro bot_prompt". A correção atual escolhe o lado seguro (nunca reintroduzir
    // — prioriza o P0 de duplicação sobre a regressão de cadastro), então este teste registra a
    // consequência: 1º cadastro de FAQ num clone que nunca teve um vira NO-OP silencioso.
    const primeiroFaq = [{ pergunta: 'Nova pergunta', resposta: 'Nova resposta' }];
    const row = await updateClone(77, { personalizacao: { faq_personalizado: primeiroFaq } });
    expect(row?.personalizacao.faq_personalizado).toBeUndefined();
  });
});

describe('updateClone — contrato textual da query (P0 PR #552)', () => {
  it('SQL NÃO referencia bot_prompt (invariante ADR 0035 §2.1) e usa só fc.personalizacao', async () => {
    arm({ personalizacao: {} });
    await updateClone(77, { personalizacao: { faq_personalizado: [] } });
    const call = mockQuery.mock.calls.find(([s]) => String(s).includes('WITH prev AS'));
    const sql = call?.[0] as string;
    expect(sql).not.toMatch(/bot_prompt/);
    expect(sql).toMatch(/fc\.personalizacao\s*->\s*'faq_personalizado'\)\s*IS NULL/);
    expect(sql).toMatch(/jsonb_build_object\('faq_personalizado'/);
  });

  it('save SEM personalizacao (ex.: só displayName) não monta o SET de personalizacao', async () => {
    arm({ personalizacao: {} });
    await updateClone(77, { displayName: 'Nova Barbearia' });
    const call = mockQuery.mock.calls.find(([s]) => String(s).includes('WITH prev AS'));
    const sql = call?.[0] as string;
    expect(sql).not.toMatch(/SET[^,]*personalizacao\s*=/);
  });
});
