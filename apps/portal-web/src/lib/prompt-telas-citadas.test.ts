/**
 * DERIVA PROMPT × TELA — o prompt do builder cita nomes de tela; a tela pode ser renomeada.
 *
 * O system prompt do meta-entrevistador (modo melhoria, `v6.md`) diz ao dono ONDE configurar
 * cada dado operacional ("Horários", no menu lateral; seção "Dados do negócio"...). Esses nomes
 * são uma dependência NÃO-TIPADA do front: se alguém renomear `label` em `nav.ts` ou `titulo`
 * em `perfil-grupos.ts`, o prompt passa a mandar o cliente para uma tela que não existe — ele
 * procura, não acha e chama o suporte. Foi exatamente o bug que a v6 veio corrigir (a v5 citava
 * "Horário de atendimento" e "catálogo de serviços", que nunca existiram com esse nome).
 *
 * Por que o teste mora AQUI (apps/portal-web) e não junto do prompt (packages/integrations):
 * `apps/portal-web` NÃO depende de `@startap/core` nem de `@startap/integrations` (é um bundle
 * Next, sem workspace deps), e `packages/integrations` não pode importar do app. Fazer a fonte
 * única de rótulos exigiria criar essa dependência — invasivo para o tamanho do problema. Aqui
 * o teste importa `nav.ts`/`perfil-grupos.ts` NORMALMENTE (mesmo pacote) e lê o `.md` do prompt
 * do disco, sem tocar no grafo de dependências. A checagem passa a existir de UM lado, que é o
 * que importa: renomear a tela QUEBRA a suíte em vez de degradar em silêncio.
 *
 * ⚠️ Este teste é sensível à FONTE REAL (NAV_SPEC / PERFIL_GRUPOS), diferente do teste de
 * `meta-entrevistador.test.ts`, que compara o prompt contra strings hardcoded — aquele pega
 * regressão do texto do prompt; ESTE pega a deriva da tela.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { NAV_SPEC } from './nav';
import { PERFIL_GRUPOS } from './perfil-grupos';

/** Corpo do prompt v6 (tudo depois do separador `---` isolado). */
function readPromptV6(): string {
  const path = fileURLToPath(
    new URL(
      '../../../../packages/integrations/ai/prompts/meta-entrevistador/v6.md',
      import.meta.url,
    ),
  );
  const md = readFileSync(path, 'utf8');
  const parts = md.split(/\n---\n/);
  return parts[parts.length - 1];
}

/** Rótulo REAL de um item do menu lateral, pela rota (fonte: NAV_SPEC). */
function labelDaRota(href: string): string {
  const item = NAV_SPEC.find((i) => i.href === href);
  if (!item) throw new Error(`rota ${href} sumiu do NAV_SPEC — o prompt v6 cita essa tela`);
  return item.label;
}

/** Título REAL de um grupo da página "Meu negócio" (fonte: PERFIL_GRUPOS). */
function tituloDoGrupo(key: 'dados' | 'personalidade' | 'agenda'): string {
  const g = PERFIL_GRUPOS.find((x) => x.key === key);
  if (!g) throw new Error(`grupo ${key} sumiu de PERFIL_GRUPOS — o prompt v6 cita essa seção`);
  return g.titulo;
}

describe('prompt v6 × telas reais do portal (anti-deriva)', () => {
  const prompt = readPromptV6();

  it('cita as telas do MENU LATERAL com o label REAL de NAV_SPEC', () => {
    // Se o label mudar em nav.ts, estas assertivas caem e o prompt tem que ser atualizado junto.
    for (const href of ['/horarios', '/servicos']) {
      const label = labelDaRota(href);
      expect(
        prompt,
        `o prompt v6 não cita "${label}" (label real de ${href}) — renomeou a tela e esqueceu o prompt?`,
      ).toContain(`"${label}", no menu lateral`);
    }
  });

  it('cita a seção de dados de "Meu negócio" com o título REAL de PERFIL_GRUPOS', () => {
    const titulo = tituloDoGrupo('dados'); // "Dados do negócio"
    expect(prompt).toContain(`seção "${titulo}", aqui mesmo nesta página`);
    // O nome do negócio também é apontado pra essa seção (bloco NOME DO ASSISTENTE vs NEGÓCIO).
    expect(prompt).toContain(`seção "${titulo}", em "Meu negócio"`);
  });

  it('a página que hospeda o builder ("Meu negócio") é a do item /perfil do menu', () => {
    // O prompt afirma "Você está conversando com o dono DENTRO da página X" — X tem que ser o
    // label real da rota que renderiza o builder.
    const label = labelDaRota('/perfil');
    expect(prompt).toContain(`DENTRO da página "${label}"`);
  });

  it('NÃO cita nomes de tela que não existem em lugar nenhum (regressão da v5)', () => {
    const labelsReais = new Set<string>([
      ...NAV_SPEC.map((i) => i.label),
      ...PERFIL_GRUPOS.map((g) => g.titulo),
      // Seções nomeadas dentro de "Meu negócio" que o prompt pode citar legitimamente.
      'Planos e assinaturas',
      'Perguntas frequentes',
    ]);
    // Nomes que a v5 usava e que NUNCA existiram — não podem voltar.
    for (const fantasma of ['Horário de atendimento', 'catálogo de serviços']) {
      expect(labelsReais.has(fantasma), `"${fantasma}" virou tela real? revise este teste`).toBe(
        false,
      );
      expect(prompt, `o prompt v6 ressuscitou a tela inexistente "${fantasma}"`).not.toContain(
        fantasma,
      );
    }
  });

  it('toda tela citada entre aspas no bloco de redirecionamento existe de verdade', () => {
    // Varre o bloco ONDE CADA COISA SE CONFIGURA e confere cada nome entre aspas contra as
    // fontes reais — pega nome inventado que passe pelas assertivas pontuais acima.
    const bloco = prompt
      .split('ONDE CADA COISA SE CONFIGURA')[1]
      .split('FECHO (depende do formato)')[0];
    const citados = [...bloco.matchAll(/"([^"]+)"/g)].map((m) => m[1]);
    expect(citados.length).toBeGreaterThan(3); // achou o bloco de verdade

    const conhecidos = new Set<string>([
      ...NAV_SPEC.map((i) => i.label),
      ...PERFIL_GRUPOS.map((g) => g.titulo),
      'Planos e assinaturas', // seção de "Meu negócio" (planos-section)
      'Perguntas frequentes', // seção de "Meu negócio" (faq-section, gated por clone)
      'procurar nas configurações', // frase da instrução anti-invenção, não é nome de tela
    ]);
    for (const nome of citados) {
      expect(conhecidos.has(nome), `prompt v6 cita tela desconhecida: "${nome}"`).toBe(true);
    }
  });
});
