import type { BotContext } from '@startap/core/types';
import type { ToolDefinition } from '@startap/integrations/openai';
import { config } from '../config.js';
import { applyFlowManualCommand } from '../lib/manual-pause.js';
import { renderPrompt } from '../lib/render-prompt.js';
import { runAgentConfigured } from '../lib/run-agent.js';
import { registerBotEntry } from '../registry.js';
import { BotBase } from './base.js';

const SLOT = 'startap';
const PAUSE_TABLE = 'pause_startap';
const STARTAP_WORKFLOW_ID = 'uUS3Ux1cU2DquKxo';
// Corrigido de 'STARTTAP_AI' (typo com duplo T) — migration 022 corrigiu registros históricos
const STARTAP_WORKFLOW_NAME = 'STARTAP_AI';
const STARTAP_SESSION_NAMES = config.STARTAP_WAHA_SESSIONS.split(',')
  .map((s) => s.trim().toLowerCase())
  .filter(Boolean);

const DEFAULT_PROMPT_TPL = [
  'Voce e a Lola, consultora de tecnologia da Startap.',
  'Seu unico objetivo e entender o negocio do cliente, mostrar como a Startap pode ajudar e capturar os dados de contato para o time humano fechar.',
  '',
  '[DADOS DO CLIENTE - JA IDENTIFICADO]',
  'NOME: {nome}',
  'WHATSAPP: {telefone}',
  '',
  '[SOBRE A STARTAP]',
  'A Startap cria automacoes minimalistas e escalaveis para pequenos e medios negocios.',
  'Conectamos WhatsApp, IA, agendamentos e sistemas para eliminar tarefas manuais.',
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
  '2. DESCOBERTA: identifique o maior gargalo operacional.',
  '3. CONEXAO DE VALOR: cite UM exemplo pratico do que a Startap ja fez no setor dele.',
  '4. COLETA DE LEAD: quando houver interesse, colete:',
  '   - Nome completo',
  '   - Segmento / tipo de negocio',
  '   - Principal problema que quer resolver',
  '5. ENCERRAMENTO OBRIGATORIO: apos coletar os dados acima, SEMPRE encerre com:',
  '   "Perfeito, [Nome]! Vou registrar seu caso aqui. O Bruno e nossa equipe de engenharia entram em contato em ate 2 horas."',
  '',
  '[CAPACIDADES DA STARTAP - use como repertorio, nunca liste tudo de uma vez]',
  '- Assistentes de WhatsApp com IA',
  '- Automacoes via TypeScript',
  '- Integracao com Google Calendar, ERPs e sistemas customizados',
  '- Bancos de dados em PostgreSQL',
  '- Notificacoes e alertas automaticos',
  '',
  '[PROIBIDO]',
  '- Citar precos, valores ou prazos de entrega',
  '- Inventar capacidades fora da lista acima',
  '- Continuar respondendo indefinidamente apos coletar nome + problema',
  '- Fazer mais de uma pergunta por mensagem',
].join('\n');

function normalizeLolaCommand(s: string): string {
  return s.toLowerCase().normalize('NFD').replace(/\p{M}/gu, '').replace(/\s+/g, '');
}

function getStartapManualCommand(text: string): 'pause' | 'resume' | null {
  const normalized = normalizeLolaCommand(text);
  if (normalized.includes('ola!souicaro,atendenteaquidastartap.')) return 'pause';
  if (normalized.includes('chathumanofinalizado!!')) return 'resume';
  return null;
}

async function applyStartapManualCommand(
  command: 'pause' | 'resume',
  telefone: string,
  opts: { session?: string | null; source?: string | null } = {},
): Promise<void> {
  await applyFlowManualCommand({
    command,
    flowId: STARTAP_WORKFLOW_ID,
    flowName: STARTAP_WORKFLOW_NAME,
    telefone,
    session: opts.session,
    source: opts.source ?? 'manual',
    reason: 'Intervencao humana Startap',
  });
}

export class StartapBot extends BotBase {
  constructor() {
    super({
      name: SLOT,
      projectId: SLOT,
      pauseTable: null, // gerenciado manualmente
      memoryTable: 'chat_histories_startap',
      memoryWindow: 15,
    });
  }

  protected async process(ctx: BotContext): Promise<string | null> {
    const { telefone, texto, pushName } = ctx.message;
    const trimmed = texto.trim();
    if (!trimmed) return null;

    const command = getStartapManualCommand(trimmed);

    // Pausa manual: humano assume / volta
    if (command === 'pause') {
      await applyStartapManualCommand(command, telefone);
      this.log.info({ telefone }, 'Startap pausado (intervencao humana)');
      return null;
    }
    if (command === 'resume') {
      await applyStartapManualCommand(command, telefone);
      this.log.info({ telefone }, 'Startap retomado apos chat humano');
      return null;
    }

    const fullHistory = await this.loadHistory(ctx);
    const history = fullHistory.slice(0, -1);

    const systemPrompt = await renderPrompt({
      slot: SLOT,
      fallback: DEFAULT_PROMPT_TPL,
      vars: { nome: pushName || telefone, telefone },
    });

    const tools: ToolDefinition[] = [];

    const result = await runAgentConfigured({
      slot: SLOT,
      projectId: SLOT,
      flowId: ctx.flowId,
      telefone,
      systemPrompt,
      history,
      userMessage: trimmed,
      tools,
      maxTurns: 3,
    });

    return result.reply.trim();
  }
}

export { DEFAULT_PROMPT_TPL as STARTAP_DEFAULT_PROMPT };

export const startapBotInstance = new StartapBot();

registerBotEntry({
  workflowId: STARTAP_WORKFLOW_ID,
  workflowName: STARTAP_WORKFLOW_NAME,
  ownedSessions: STARTAP_SESSION_NAMES,
  legacyPauseTable: PAUSE_TABLE,
  getManualCommand: getStartapManualCommand,
  applyManualCommand: (command, telefone, opts) =>
    applyStartapManualCommand(command, telefone, opts),
  bot: startapBotInstance,
});
