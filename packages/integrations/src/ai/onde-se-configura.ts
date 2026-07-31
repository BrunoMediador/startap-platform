/**
 * ONDE CADA COISA SE CONFIGURA — FONTE ÚNICA dos caminhos de tela citados pelos prompts do
 * meta-entrevistador (SCRUM-159).
 *
 * ## O bug que este módulo existe para não deixar voltar
 *
 * O bloco "ONDE CADA COISA SE CONFIGURA" era uma STRING SOLTA, repetida e reescrita à mão em
 * cada versão do prompt. Em 31/07 a v6 corrigiu os nomes de tela ("Horário de atendimento" →
 * "Horários", "catálogo de serviços" → "Serviços") e a **v4 ficou para trás** — só que a v4 é
 * o prompt do modo CRIAÇÃO, isto é, o que atende o cliente NOVO, justamente quem mais precisa
 * de orientação. Resultado em produção: o dono recém-chegado era mandado para uma tela que não
 * existe com aquele nome. A duplicação não foi um detalhe de estilo; foi a CAUSA do bug.
 *
 * Agora existe UM mapa. Corrigir um caminho aqui conserta todas as versões que interpolam o
 * bloco de uma vez — a classe do bug morre, não só o caso (norte do produto, ordem do Bruno
 * 24/07: eliminar a CLASSE do bug).
 *
 * ## Por que os caminhos são estes
 *
 * O portal está virando telas separadas com sub-abas reais (SCRUM-157): "Serviços"/"Horários"
 * saem do menu lateral e viram sub-abas de "Meu negócio"; a personalização da IA vira o item
 * próprio "Meu atendente". Consequência direta nos prompts: TODO "aqui mesmo nesta página" da
 * v6 deixou de ser verdade — o builder passa a viver em "Meu atendente › Personalidade",
 * enquanto Dados e Planos ficam em "Meu negócio › Dados" e o FAQ em "Meu atendente › Mensagens",
 * que é OUTRA aba. Por isso o formato de caminho agora é sempre `"Tela › Aba"`, absoluto e
 * navegável de qualquer lugar do portal, em vez de relativo ("nesta mesma página") — instrução
 * relativa é a que apodrece primeiro quando a tela se move.
 *
 * ## Alinhamento com a fonte real dos rótulos (follow-up conhecido)
 *
 * Os rótulos aqui espelham `apps/portal-web/src/lib/abas.ts` (`NEGOCIO_ABAS`/`ATENDENTE_ABAS`,
 * SCRUM-157) e `apps/portal-web/src/lib/nav.ts` (`NAV_SPEC`). Eles NÃO são importados de lá:
 * `apps/portal-web` não tem dependência de workspace (nem `@startap/core` nem
 * `@startap/integrations`), e criar uma só para isto inverteria o grafo de pacotes por um mapa
 * de 6 linhas. A checagem contra a fonte real vive do lado do front, em
 * `apps/portal-web/src/lib/prompt-telas-citadas.test.ts`, que lê ESTE arquivo do disco como
 * texto e importa a nav normalmente — renomear uma tela QUEBRA a suíte em vez de degradar em
 * silêncio (provado por mutação: renomear a aba "Horários" derruba 6 testes nos dois pacotes).
 * Quando `abas.ts` entrar na main, aquele teste deve passar a DERIVAR os rótulos de
 * `NEGOCIO_ABAS`/`ATENDENTE_ABAS` em vez de repetir os literais — follow-up declarado no PR.
 */

/** Telas de primeiro nível do portal que os prompts podem citar. */
export type TelaRaiz = 'Meu negócio' | 'Meu atendente';

/** Um destino navegável: tela de primeiro nível + sub-aba dentro dela. */
export interface CaminhoTela {
  /** Tela de primeiro nível (item do menu). */
  readonly tela: TelaRaiz;
  /** Rótulo da sub-aba dentro da tela. */
  readonly aba: string;
}

/**
 * Chave de cada linha do bloco de redirecionamento. Nomeadas pelo DADO que o dono cita
 * ("falei do meu horário"), não pela tela — é assim que o modelo faz o casamento.
 */
export type DadoOperacional = 'horarios' | 'servicos' | 'dados-negocio' | 'planos' | 'faq';

/** Uma linha do bloco: o que o dono citou → onde aquilo se configura. */
export interface DestinoConfiguracao {
  /** Descrição do dado, do jeito que o dono fala dele. */
  readonly dado: string;
  readonly caminho: CaminhoTela;
  /**
   * Item GATED por clone: pode não existir para aquele cliente, então só é citado quando o
   * próprio dono traz o assunto. Hoje só o FAQ (`features.faq_personalizado`).
   */
  readonly gated?: boolean;
}

/**
 * 🔴 FONTE ÚNICA. Editar AQUI conserta todas as versões do prompt que interpolam o bloco.
 * Ordem = ordem de exibição no prompt (do dado mais citado pelo dono para o menos).
 */
export const ONDE_SE_CONFIGURA: Readonly<Record<DadoOperacional, DestinoConfiguracao>> = {
  horarios: {
    dado: 'Horário de funcionamento / dias abertos',
    caminho: { tela: 'Meu negócio', aba: 'Horários' },
  },
  servicos: {
    dado: 'Serviços, preços e duração',
    caminho: { tela: 'Meu negócio', aba: 'Serviços' },
  },
  'dados-negocio': {
    dado: 'Endereço, nome do negócio, telefone, formas de pagamento',
    caminho: { tela: 'Meu negócio', aba: 'Dados' },
  },
  planos: {
    dado: 'Planos, pacotes e assinaturas',
    caminho: { tela: 'Meu negócio', aba: 'Dados' },
  },
  faq: {
    dado: 'Perguntas frequentes e suas respostas',
    caminho: { tela: 'Meu atendente', aba: 'Mensagens' },
    gated: true,
  },
} as const;

/**
 * Onde o BUILDER (esta conversa) roda depois da reorganização: "Meu atendente › Personalidade".
 * Antes o prompt dizia "você está dentro da página Meu negócio" e mandava configurar coisas
 * "aqui mesmo nesta página" — as duas afirmações morrem com as abas novas.
 */
export const TELA_DO_BUILDER: CaminhoTela = {
  tela: 'Meu atendente',
  aba: 'Personalidade',
} as const;

/** Renderiza um caminho no formato canônico citado pelos prompts: `"Meu negócio" › "Horários"`. */
export function formatCaminho(c: CaminhoTela): string {
  return `"${c.tela}" › "${c.aba}"`;
}

/**
 * Todos os nomes de tela/aba que os prompts têm PERMISSÃO de citar. Usado pelo teste de
 * varredura: qualquer nome entre aspas no bloco que não esteja aqui é nome inventado.
 */
export const TELAS_CONHECIDAS: readonly string[] = [
  ...new Set([
    TELA_DO_BUILDER.tela,
    TELA_DO_BUILDER.aba,
    ...Object.values(ONDE_SE_CONFIGURA).flatMap((d) => [d.caminho.tela, d.caminho.aba]),
  ]),
];

/**
 * Corpo do bloco "ONDE CADA COISA SE CONFIGURA" — as linhas `dado → caminho` + a regra
 * anti-invenção de tela. É o texto interpolado no placeholder `{onde_se_configura}` das
 * versões VIVAS do prompt (V7 criação / V8 melhoria), do mesmo jeito que `{nome_negocio}`.
 *
 * A regra final ("Nunca invente outro nome de tela… Nome errado de tela é pior do que não
 * indicar") nasceu na v6 e vive AQUI de propósito: assim ela acompanha o bloco para toda versão
 * que o interpola, em vez de ficar órfã em uma só — foi exatamente o que aconteceu com a v4.
 */
export function renderOndeSeConfigura(): string {
  const linhas = Object.values(ONDE_SE_CONFIGURA).map(
    (d) => `- ${d.dado} → ${formatCaminho(d.caminho)}.`,
  );
  return [
    ...linhas,
    'Diga sempre o caminho completo, no formato Tela › Aba (por exemplo: abra "Meu negócio" e vá na aba "Horários").',
    'Nunca invente outro nome de tela nem mande o dono "procurar nas configurações": se não souber onde fica, diga que esse dado é configurado fora da persona e ofereça avisar o suporte. Nome errado de tela é pior do que não indicar.',
  ].join('\n');
}
