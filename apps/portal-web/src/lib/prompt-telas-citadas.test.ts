/**
 * DERIVA PROMPT × TELA — o prompt do builder cita nomes de tela; a tela pode ser renomeada.
 *
 * Os system prompts VIVOS do meta-entrevistador (`v11.md` = criação, `v12.md` = melhoria) dizem ao
 * dono ONDE configurar cada dado operacional. Esses nomes são uma dependência NÃO-TIPADA do
 * front: se alguém renomear uma tela e esquecer o prompt, ele passa a mandar o cliente para uma
 * tela que não existe — ele procura, não acha e chama o suporte.
 *
 * Já aconteceu DUAS vezes:
 *  1. a v5 citava "Horário de atendimento" e "catálogo de serviços", que nunca existiram;
 *  2. a #538 corrigiu isso só na v6 e a **v4 ficou para trás** — e a v4 era o prompt do cliente
 *     NOVO, justamente quem mais precisa de orientação. A SCRUM-159 matou a duplicação (os
 *     caminhos passaram a vir de `ONDE_SE_CONFIGURA`, fonte única no pacote de integrations) e
 *     este teste passou a cobrir as DUAS versões vivas.
 *
 * Por que o teste mora AQUI (apps/portal-web) e não junto do prompt (packages/integrations):
 * `apps/portal-web` NÃO depende de `@startap/core` nem de `@startap/integrations` (é um bundle
 * Next, sem workspace deps), e `packages/integrations` não pode importar do app. Aqui o teste
 * importa os rótulos NORMALMENTE (mesmo pacote) e lê o `.md` do prompt do disco, sem tocar no
 * grafo de dependências. A checagem passa a existir de UM lado, que é o que importa: renomear a
 * tela QUEBRA a suíte em vez de degradar em silêncio.
 *
 * ⚠️ Este teste é sensível à FONTE REAL dos rótulos, diferente do de `meta-entrevistador.test.ts`,
 * que trava o prompt contra a fonte única do lado do backend. Os dois se complementam: aquele
 * pega "o prompt citou tela fora do mapa"; ESTE pega "o mapa e a tela real divergiram".
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { NAV_SPEC } from './nav';

/** Corpo de um prompt versionado (tudo depois do separador `---` isolado). */
function readPrompt(versao: 'v11' | 'v12'): string {
  const path = fileURLToPath(
    new URL(
      `../../../../packages/integrations/ai/prompts/meta-entrevistador/${versao}.md`,
      import.meta.url,
    ),
  );
  const md = readFileSync(path, 'utf8');
  const parts = md.split(/\n---\n/);
  return parts[parts.length - 1];
}

/**
 * Fonte ÚNICA dos caminhos, lida como TEXTO do disco.
 *
 * Desde a SCRUM-159 os caminhos NÃO estão mais no `.md` — o prompt traz só o placeholder
 * `{onde_se_configura}` e o texto real é renderizado em runtime a partir de
 * `packages/integrations/src/ai/onde-se-configura.ts`. É exatamente o ponto da mudança: existe
 * UM lugar com os nomes de tela. Como `apps/portal-web` não pode IMPORTAR aquele pacote (não há
 * dependência de workspace), o teste lê o arquivo como texto — é o mesmo recurso que ele já usa
 * para o `.md`, e continua quebrando quando os nomes divergirem da tela real.
 */
function readFonteUnica(): string {
  const path = fileURLToPath(
    new URL('../../../../packages/integrations/src/ai/onde-se-configura.ts', import.meta.url),
  );
  return readFileSync(path, 'utf8');
}

/**
 * Caminhos como aparecem no prompt RENDERIZADO. O `.md` guarda o placeholder; o mapa guarda
 * `tela` e `aba` separados. Aqui reconstruímos o par para conferir contra a estrutura esperada.
 */
function caminhosDaFonteUnica(): string[] {
  const src = readFonteUnica();
  // Casa os literais `tela: 'X', aba: 'Y'` do mapa (e de TELA_DO_BUILDER).
  return [...src.matchAll(/tela:\s*'([^']+)',\s*aba:\s*'([^']+)'/g)].map(
    (m) => `"${m[1]}" › "${m[2]}"`,
  );
}

/**
 * Estrutura de telas ESPERADA pelos prompts, no formato `"Tela" › "Aba"`.
 *
 * ⚠️ FOLLOW-UP declarado: quando `apps/portal-web/src/lib/abas.ts` (spec das sub-abas, SCRUM-157,
 * escrita em paralelo) estiver na main, estes literais devem passar a ser DERIVADOS de
 * `NEGOCIO_ABAS`/`ATENDENTE_ABAS` — do mesmo jeito que `labelDaRota` deriva de `NAV_SPEC` abaixo.
 * Enquanto isso, ficam explícitos aqui para não criar dependência de um arquivo que ainda não
 * existe neste checkout.
 */
const CAMINHOS_ESPERADOS = {
  horarios: '"Meu negócio" › "Horários"',
  servicos: '"Meu negócio" › "Serviços"',
  dados: '"Meu negócio" › "Dados"',
  builder: '"Meu atendente" › "Personalidade"',
} as const;

/**
 * ⚠️ `faq: '"Meu atendente" › "Mensagens"'` SAIU desta lista em 31/07 — e a remoção é o ponto,
 * não um efeito colateral. O campo "Perguntas frequentes" está sendo removido do portal e o
 * conteúdo passa a viver dentro do texto da persona, escrito com o builder (v9/v10). Se o
 * caminho continuasse declarado na fonte única, os prompts seguiriam mandando o dono para uma
 * tela que deixou de existir — a mesma classe de bug que este teste nasceu para pegar, só que
 * com destino morto em vez de nome errado. O teste abaixo garante os dois lados: o caminho não
 * pode estar declarado E nenhum prompt vivo pode citar a aba.
 *
 * ⚠️ 01/08 — mesma história com os PLANOS, e por isso a lista acima NÃO mudou: a entrada `planos`
 * apontava para `"Meu negócio" › "Dados"`, o MESMO caminho de `dados-negocio`, que continua
 * existindo. Ou seja, remover `planos` da fonte única é invisível para `CAMINHOS_ESPERADOS` — o
 * que este arquivo cobre é a deriva PROMPT × TELA, e a deriva de conteúdo (o mapa parou de
 * declarar planos, e os prompts passaram a acolhê-los) está travada do lado do backend, em
 * `packages/integrations/src/ai/meta-entrevistador.test.ts`. Aqui só as versões VIVAS avançam.
 */
const VIVOS = ['v11', 'v12'] as const;

describe('prompts vivos × telas reais do portal (anti-deriva)', () => {
  it('a FONTE ÚNICA declara exatamente os caminhos que as telas reais oferecem', () => {
    // Este é o teste que pega a DERIVA: se alguém renomear uma aba no portal e esquecer o mapa
    // (ou vice-versa), os caminhos divergem do esperado e isto cai com mensagem acionável.
    const declarados = caminhosDaFonteUnica();
    for (const caminho of Object.values(CAMINHOS_ESPERADOS)) {
      expect(
        declarados,
        `a fonte única não declara ${caminho} — renomeou a tela e esqueceu o mapa?`,
      ).toContain(caminho);
    }
    // E nenhum caminho declarado pode estar fora da estrutura conhecida.
    const esperados = new Set<string>(Object.values(CAMINHOS_ESPERADOS));
    for (const caminho of declarados) {
      expect(esperados.has(caminho), `a fonte única declara caminho desconhecido: ${caminho}`).toBe(
        true,
      );
    }
  });

  it.each(VIVOS)('%s: interpola o bloco da fonte única (não reescreve à mão)', (versao) => {
    // Se alguém voltar a escrever o bloco à mão numa versão, o placeholder some e o bug de
    // "corrigiram uma cópia e esqueceram a outra" volta a ser possível.
    const prompt = readPrompt(versao);
    expect(prompt, `${versao}.md deixou de interpolar {onde_se_configura}`).toContain(
      '{onde_se_configura}',
    );
    expect(prompt).toContain('{tela_do_builder}');
    expect(prompt).toContain('{caminho_dados_negocio}');
  });

  it.each(VIVOS)('%s: NÃO ressuscita nomes de tela que nunca existiram', (versao) => {
    const prompt = readPrompt(versao);
    // Nomes que a v4/v5 usavam e que não existem em lugar nenhum do portal.
    for (const fantasma of ['Horário de atendimento', 'catálogo de serviços']) {
      expect(prompt, `${versao}.md ressuscitou a tela inexistente "${fantasma}"`).not.toContain(
        fantasma,
      );
    }
  });

  it.each(VIVOS)('%s: NÃO usa navegação relativa (apodrece quando a tela move)', (versao) => {
    const prompt = readPrompt(versao);
    // A v6 dizia "aqui mesmo nesta página" / "logo abaixo" / "no menu lateral" — verdade quando
    // o builder morava em "Meu negócio", falso depois que ele virou "Meu atendente".
    for (const relativo of ['aqui mesmo nesta página', 'logo abaixo', 'no menu lateral']) {
      expect(prompt, `${versao}.md usa navegação relativa: "${relativo}"`).not.toContain(relativo);
    }
  });

  it('as telas de primeiro nível citadas existem no NAV_SPEC (fonte real do menu)', () => {
    // "Meu negócio" tem que continuar existindo como item de menu; se for renomeado, os
    // caminhos dos prompts (e este teste) precisam ser revistos juntos.
    const labels = new Set(NAV_SPEC.map((i) => i.label));
    expect(labels.has('Meu negócio'), '"Meu negócio" sumiu do NAV_SPEC — revise os prompts').toBe(
      true,
    );
  });

  it('a fonte única NÃO declara mais a tela de FAQ (o campo saiu do portal)', () => {
    // Contrapartida do que foi removido de CAMINHOS_ESPERADOS: se alguém reintroduzir a linha
    // do FAQ no mapa, os prompts voltam a mandar o dono para uma aba que não existe mais.
    const declarados = caminhosDaFonteUnica();
    expect(
      declarados,
      'a fonte única voltou a declarar a tela de FAQ — o campo foi removido do portal',
    ).not.toContain('"Meu atendente" › "Mensagens"');
    const src = readFonteUnica();
    expect(src, 'a entrada `faq` voltou ao mapa ONDE_SE_CONFIGURA').not.toMatch(/^\s*faq:\s*\{/m);
  });

  it('a fonte única NÃO declara mais os PLANOS (o campo saiu do portal em 01/08)', () => {
    // Diferente do FAQ, os planos apontavam para "Meu negócio" › "Dados" — um caminho que
    // CONTINUA existindo. Então o teste de caminhos acima não pega esta remoção; é preciso
    // checar a ENTRADA do mapa. Se ela voltar, a IA recusa o assunto e manda a dona para uma
    // seção que deixou de existir dentro de uma tela que ainda existe: pior de detectar.
    const src = readFonteUnica();
    expect(src, 'a entrada `planos` voltou ao mapa ONDE_SE_CONFIGURA').not.toMatch(
      /^\s*planos:\s*\{/m,
    );
  });

  it.each(VIVOS)('%s: não manda configurar plano em tela e ACOLHE o assunto', (versao) => {
    const prompt = readPrompt(versao);
    // A metade positiva, lida do `.md` canônico: é a lição da PR #555 — em prompt de lista
    // fechada, remover a proibição não faz o modelo aceitar.
    expect(prompt).toContain('PLANOS E ASSINATURAS (isto SIM entra na persona)');
    // E o limite que NÃO afrouxou junto: preço de serviço avulso continua vindo do catálogo.
    expect(prompt).toContain('preço de SERVIÇO AVULSO segue proibido');
  });

  it.each(VIVOS)('%s: não cita a aba "Mensagens" nem manda configurar FAQ em tela', (versao) => {
    // O prompt vivo lido do disco (o `.md` canônico, que é a fonte do que o modelo recebe).
    const prompt = readPrompt(versao);
    expect(prompt, `${versao}.md cita a aba "Mensagens", que deixou de hospedar o FAQ`).not.toMatch(
      /Mensagens/,
    );
    // E acolhe o assunto, em vez de apenas silenciar sobre ele.
    expect(prompt).toContain('PERGUNTAS FREQUENTES (isto SIM entra na persona)');
  });

  it('a regra anti-invenção de tela vive na fonte única (acompanha TODA versão)', () => {
    // Ela nasceu órfã na v6 e por isso a v4 nunca a teve. Agora mora junto do mapa, então
    // qualquer versão que interpole o bloco a recebe por construção.
    const src = readFonteUnica();
    expect(src).toContain('Nunca invente outro nome de tela');
    expect(src).toContain('Nome errado de tela é pior do que não indicar');
  });
});
