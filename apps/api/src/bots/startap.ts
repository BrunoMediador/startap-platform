import type { BotContext } from '@startap/core/types';
import { pausa } from '@startap/db';
import type { ToolDefinition } from '@startap/integrations/openai';
import { renderPrompt } from '../lib/render-prompt.js';
import { runAgentConfigured } from '../lib/run-agent.js';
import { BotBase } from './base.js';

const SLOT = 'startap';
const PAUSE_TABLE = 'pause_startap';
export const STARTAP_WORKFLOW_ID = 'uUS3Ux1cU2DquKxo';
export const STARTAP_WORKFLOW_NAME = 'STARTTAP_AI';
const STARTAP_SESSION_NAMES = (
  process.env.STARTAP_WAHA_SESSIONS || 'startap,STARTAP_AI,STARTAP_AI_PROD'
)
  .split(',')
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

export function isStartapSession(session: string): boolean {
  // A Lola/Startap deve responder somente na sessao WAHA oficial.
  // Sessoes de teste passam pelo router normal e podem atender qualquer fluxo cadastrado.
  return STARTAP_SESSION_NAMES.includes(session.toLowerCase());
}

export function normalizeLolaCommand(s: string): string {
  return s.toLowerCase().normalize('NFD').replace(/\p{M}/gu, '').replace(/\s+/g, '');
}

export function getStartapManualCommand(text: string): 'pause' | 'resume' | null {
  const normalized = normalizeLolaCommand(text);
  if (normalized.includes('ola!souicaro,atendenteaquidastartap.')) return 'pause';
  if (normalized.includes('chathumanofinalizado!!')) return 'resume';
  return null;
}

export async function applyStartapManualCommand(
  command: 'pause' | 'resume',
  telefone: string,
): Promise<void> {
  if (command === 'pause') await pausa.addPause(PAUSE_TABLE, telefone);
  else await pausa.removePause(PAUSE_TABLE, telefone);
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

    const paused = await pausa.isPaused(PAUSE_TABLE, telefone).catch(() => false);
    if (paused) {
      this.log.info({ telefone }, 'Startap em pausa, ignorando');
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
