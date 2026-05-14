import type { BotContext } from '@startap/core/types';
import { pausa, query } from '@startap/db';
import type { ToolDefinition } from '@startap/integrations/openai';
import { runAgentConfigured } from '../lib/run-agent.js';
import { BotBase } from './base.js';

const SAMUEL_PHONE = '553591746797';
const PAUSE_LOLA_TABLE = 'pause_startap';
const PAUSE_SAMUEL_TABLE = 'pausa_samuel';

const DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY ?? '';

const LOLA_PROMPT = [
  'Voce e a Lola, consultora de tecnologia da Startap.',
  'Seu unico objetivo e entender o negocio do cliente, mostrar como a Startap pode ajudar e capturar os dados de contato para o time humano fechar.',
  '',
  '[SOBRE A STARTAP]',
  'A Startap cria automacoes minimalistas e escalaveis para pequenos e medios negocios. Conectamos WhatsApp, IA, agendamentos e sistemas para eliminar tarefas manuais e dar escala ao negocio do cliente - sem precisar contratar mais pessoas.',
  '',
  '[PERSONA E TOM]',
  '- Simpatica, direta, tecnologica - mas acessivel.',
  '- Fala como uma consultora experiente, nao como um robo de FAQ.',
  '- Nunca use girias ou linguagem infantil.',
  '',
  '[REGRA DE OURO - NUNCA QUEBRE]',
  '- Maximo 3 linhas curtas por mensagem. Menos e mais.',
  '- Uma pergunta por vez. Nunca duas.',
  '- Nao despeje informacoes. Conduza a conversa no ritmo do cliente.',
  '',
  '[FLUXO OBRIGATORIO - SIGA ESTA ORDEM]',
  '1. ACOLHIMENTO: receba com simpatia e pergunte qual o segmento do negocio dele.',
  '2. DESCOBERTA: identifique o maior gargalo operacional (perda de tempo, atendimento manual, desorganizacao).',
  '3. CONEXAO DE VALOR: cite UM exemplo pratico do que a Startap ja fez no setor dele (ex: barbearia com agendamento automatico pelo WhatsApp, loja com notificacoes de pedido via IA).',
  '4. COLETA DE LEAD: quando houver interesse, colete em perguntas separadas:',
  '   - Nome completo',
  '   - Segmento / tipo de negocio',
  '   - Principal problema que quer resolver',
  '5. ENCERRAMENTO OBRIGATORIO: apos coletar os dados acima, SEMPRE encerre com:',
  '   "Perfeito, [Nome]! Vou registrar seu caso aqui. O Bruno e nossa equipe de engenharia entram em contato em ate 2 horas. Qual o melhor horario para te chamar?"',
  '',
  '[GATILHO DE REPASSE - CRITICO]',
  'Se o cliente comecar a fazer perguntas tecnicas detalhadas (valores, prazo, como funciona por dentro, integracoes especificas) ANTES de voce coletar os dados, responda brevemente e direcione:',
  '"Essa parte o Bruno explica melhor! Me passa seu nome antes para eu ja deixar registrado?"',
  '',
  '[CAPACIDADES DA STARTAP - use como repertorio, nunca liste tudo de uma vez]',
  '- Assistentes de WhatsApp com IA para atendimento e agendamento automatico',
  '- Automacoes via n8n com integracoes de API',
  '- Integracao com Google Calendar, ERPs e sistemas customizados',
  '- Bancos de dados em PostgreSQL para organizacao e historico',
  '- Notificacoes e alertas automaticos por WhatsApp',
  '',
  '[PROIBIDO]',
  '- Citar precos, valores ou prazos de entrega',
  '- Inventar capacidades fora da lista acima',
  '- Continuar respondendo indefinidamente apos coletar nome + problema - SEMPRE acione o passo 5',
  '- Fazer mais de uma pergunta por mensagem',
].join('\n');

function samuelPrompt(relatorioPausas: string): string {
  return [
    'Voce e o assistente de sistema interno do Samuel, criado para ajuda-lo a gerenciar o status de clientes pausados na Barbearia.',
    '',
    'Sua principal funcao e remover usuarios da lista de pausa quando solicitado, mas voce deve operar sob regras rigidas de seguranca.',
    '',
    'REGRAS ESTRITAS DE FUNCIONAMENTO:',
    '',
    '1. CARTAO DE CONFIRMACAO (OBRIGATORIO):',
    'Voce NUNCA deve acionar a ferramenta de remover sem antes confirmar. Quando o Samuel pedir para excluir/remover alguem da lista, voce deve obrigatoriamente enviar o cartao abaixo e aguardar a resposta positiva:',
    '',
    'Voce deve ser capaz de remover o pause de varios contatos de uma so vez!',
    '',
    'Confirmacao para remover pausa do chat!',
    'Nome: [Nome]',
    'Numero: [Numero]',
    'Samuel, voce confirma a remocao do pause para este cliente?',
    '',
    '2. USO DA FERRAMENTA:',
    'Apenas apos o Samuel responder "Sim" ao cartao de confirmacao, voce deve executar a ferramenta remover_numero passando o numero exato do cliente.',
    '',
    '3. PROIBICAO DE INSERCAO:',
    'Voce NAO tem permissao para inserir numeros na lista de pausa. Se o Samuel pedir para pausar alguem, responda:',
    '"Eu nao posso pausar clientes por aqui. Para pausar o robo de um cliente, envie a mensagem samuel aqui!! diretamente no chat do WhatsApp dele."',
    '',
    '4. TOM DE VOZ:',
    'Responda sempre de forma curta, direta, profissional e sem o uso de girias.',
    '',
    '5. FORMATO:',
    'O numero esta salvo com o 55 antes do numero. Use o tool verificar_pause para confirmar como o numero esta no banco antes de excluir.',
    '',
    '6. Para o usuario nao envie com o 55, use o 55 apenas para execucao de query.',
    '',
    '7. Caso tenha varios numeros pausados, ordene a lista de forma que seja facil entendimento ao ler!',
    '',
    'RELATORIO ATUAL DE CLIENTES PAUSADOS:',
    relatorioPausas,
  ].join('\n');
}

function normalizeLolaCommand(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .replace(/\s+/g, '');
}

async function buildRelatorioPausas(): Promise<string> {
  const r = await query<{ numero: string; nome: string | null }>(
    'SELECT numero, nome FROM pausa_samuel ORDER BY numero',
  );
  if (r.rows.length === 0) {
    return 'Relatorio de Pausas\n\nNenhum numero em pausa no momento.';
  }
  const linhas = r.rows
    .map(
      (row) => `Nome: ${row.nome ?? 'Sem nome'}\nNumero: ${String(row.numero).replace(/^55/, '')}`,
    )
    .join('\n\n');
  return `Relatorio de Pausas - Barbearia Samuel\n\n${linhas}`;
}

export class StartapAiBot extends BotBase {
  constructor() {
    super({
      name: 'startap-ai',
      pauseTable: null, // gerenciado internamente
      memoryTable: 'n8n_chat_histories_startap', // default; Samuel usa outra
      memoryWindow: 15,
    });
  }

  protected async process(ctx: BotContext): Promise<string | null> {
    const { telefone } = ctx.message;
    if (telefone === SAMUEL_PHONE) return this.processSamuel(ctx);
    return this.processLola(ctx);
  }

  private async processLola(ctx: BotContext): Promise<string | null> {
    const { telefone, texto } = ctx.message;
    const trimmed = texto.trim();
    if (!trimmed) return null;

    const normalized = normalizeLolaCommand(trimmed);

    // Comandos de pausa manual (Bruno/Icaro intervindo)
    if (normalized.includes('ola!souicaro,atendenteaquidastartap.')) {
      await pausa.addPause(PAUSE_LOLA_TABLE, telefone);
      this.log.info({ telefone }, 'Lola pausada (intervencao humana)');
      return null;
    }
    if (normalized.includes('chathumanofinalizado!!')) {
      await pausa.removePause(PAUSE_LOLA_TABLE, telefone);
      this.log.info({ telefone }, 'Lola retomada apos chat humano');
      return null;
    }

    const paused = await pausa.isPaused(PAUSE_LOLA_TABLE, telefone).catch(() => false);
    if (paused) {
      this.log.info({ telefone }, 'Lola em pausa, ignorando');
      return null;
    }

    const fullHistory = await this.loadHistory(telefone);
    const history = fullHistory.slice(0, -1);

    if (!DEEPSEEK_API_KEY) {
      this.log.error({}, 'DEEPSEEK_API_KEY ausente — Lola nao pode responder');
      return 'Desculpe, estamos com instabilidade no momento. Tente novamente em alguns minutos.';
    }

    const result = await runAgentConfigured({
      slot: 'startap-ai-lola',
      telefone,
      systemPrompt: LOLA_PROMPT,
      history,
      userMessage: trimmed,
      maxTurns: 3,
    });

    return result.reply.trim();
  }

  private async processSamuel(ctx: BotContext): Promise<string | null> {
    const { telefone, texto } = ctx.message;
    const trimmed = texto.trim();
    if (!trimmed) return null;

    // Samuel usa tabela de memória diferente — load manual
    const SAMUEL_MEMORY = 'n8n_chat_histories_controle_de_pauseee';
    const { chatMemory } = await import('@startap/db');
    const fullHistory = await chatMemory.loadHistory(SAMUEL_MEMORY, telefone, 10);
    // BotBase já appended em n8n_chat_histories_startap; aqui carregamos de outra tabela
    // Histórico próprio do Samuel: appendamos manualmente
    await chatMemory.appendMessage(SAMUEL_MEMORY, telefone, 'human', trimmed);

    const relatorio = await buildRelatorioPausas();
    const systemPrompt = samuelPrompt(relatorio);

    const tools: ToolDefinition[] = [
      {
        name: 'verificar_pause',
        description: 'Consulta a lista atual de numeros pausados na pausa_samuel.',
        parameters: { type: 'object', properties: {}, required: [] },
        run: async () => {
          const r = await query<{ numero: string; nome: string | null }>(
            'SELECT numero, nome FROM pausa_samuel ORDER BY numero',
          );
          return { rows: r.rows };
        },
      },
      {
        name: 'remover_numero',
        description: 'Remove um numero da lista de pausa_samuel. Numero deve incluir o 55 (DDI).',
        parameters: {
          type: 'object',
          properties: {
            numero: {
              type: 'string',
              description:
                'Numero do whatsapp a remover da pausa, apenas digitos ex: 5535999887766',
            },
          },
          required: ['numero'],
        },
        run: async (args: unknown) => {
          const { numero } = args as { numero: string };
          await pausa.removePause(PAUSE_SAMUEL_TABLE, numero);
          this.log.info({ numero }, 'Numero removido da pausa_samuel');
          return { ok: true, removido: numero };
        },
      },
    ];

    const result = await runAgentConfigured({
      slot: 'startap-ai-samuel',
      telefone,
      systemPrompt,
      history: fullHistory,
      userMessage: trimmed,
      tools,
      maxTurns: 5,
    });

    const reply = result.reply.trim();
    if (reply) {
      await chatMemory.appendMessage(SAMUEL_MEMORY, telefone, 'ai', reply);
    }
    return reply;
  }
}
