import type { BotContext } from '@startap/core/types';
import { botMedia, leads } from '@startap/db';
import { waha } from '@startap/integrations';
import type { ToolDefinition } from '@startap/integrations/openai';
import { applyFlowManualCommand } from '../lib/manual-pause.js';
import { renderPrompt } from '../lib/render-prompt.js';
import { runAgentConfigured } from '../lib/run-agent.js';
import { BotBase } from './base.js';

const SLOT = 'teste_vendas';
const WORKFLOW_ID = 'dlpKXM3gvX2joC1b';
const WORKFLOW_NAME = 'teste_vendas';
const PAUSE_TABLE = 'pause_ricardo';

const DEFAULT_PROMPT_TPL = [
  'Voce e um assistente virtual do Curso de Barbeiro Profissional do Ricardo.',
  'Atenda os interessados com simpatia, entusiasmo e objetividade. Maximo 3 linhas por resposta.',
  '',
  '[DADOS DO CLIENTE - JA IDENTIFICADO]',
  'NOME: {nome}',
  'WHATSAPP: {telefone}',
  '',
  '[SOBRE O CURSO]',
  'Duracao: 3 meses | 2x por semana',
  'Horarios: Manha 09h-11h | Tarde 15h-17h',
  'Inclui: Apostila completa, fardamento e suporte no grupo de WhatsApp',
  'Diploma valido em mais de 122 paises - trabalha em qualquer lugar do Brasil',
  'Investimento: Entrada de R$200 + 3x de R$200',
  'Curso pratico, do zero ao profissional',
  '',
  '[REGRAS ABSOLUTAS - VIOLACAO = FALHA CRITICA]',
  '1. PROIBIDO perguntar nome ou telefone - voce ja tem acima.',
  '2. NUNCA invente informacoes sobre o curso.',
  '3. NUNCA cite precos de outros cursos.',
  '4. Maximo 3 linhas por resposta. Uma pergunta por vez.',
  '5. SOMENTE SUA PRIMEIRA RESPOSTA OBRIGATORIAMENTE TERMINA COM [V1]. Sem excecao.',
  '6. Depois da primeira resposta, NUNCA use [V1], [V2] ou [V3].',
  '',
  '[COMO OS VIDEOS FUNCIONAM]',
  '- [V1] e uma tag invisivel que voce coloca no FINAL apenas da primeira resposta.',
  '- O sistema envia os videos automaticamente. O cliente nao ve a tag.',
  '- Nunca mencione videos para o cliente. Apenas coloque [V1] na primeira resposta.',
  '',
  '[FLUXO]',
  '1. Primeira mensagem do cliente -> responda com saudacao + [V1] no final.',
  '2. Continue tirando duvidas normalmente.',
  '3. Nas mensagens seguintes, responda sem nenhuma tag de video.',
  '4. Quando cliente quiser se inscrever -> use ferramenta salvar_lead.',
].join('\n');

function parseVideoTag(text: string): { tag: 'V1' | 'V2' | 'V3' | null; clean: string } {
  const m = text.match(/\[(V[123])\]\s*$/i);
  if (!m) return { tag: null, clean: text.trim() };
  const tag = m[1].toUpperCase() as 'V1' | 'V2' | 'V3';
  const clean = text.slice(0, m.index).trim();
  return { tag, clean };
}

function sanitizar(text: string): string {
  return text
    .split('\n')
    .filter((l) => {
      const t = l.trim();
      if (t === '') return true;
      if (/^to=functions\./i.test(t)) return false;
      if (/^\{.*\}$/.test(t)) return false;
      return true;
    })
    .join('\n')
    .trim();
}

export class TesteVendasBot extends BotBase {
  constructor(opts?: { slotOverride?: string }) {
    super({
      name: opts?.slotOverride ?? SLOT,
      projectId: SLOT,
      pauseTable: PAUSE_TABLE,
      memoryTable: 'chat_histories_ricardo',
      memoryWindow: 10,
      slotOverride: opts?.slotOverride,
    });
  }

  protected async process(ctx: BotContext): Promise<string | null> {
    const { telefone, texto, pushName, sessao, chatId } = ctx.message;
    const trimmed = texto.trim();
    if (!trimmed) return null;

    const lower = trimmed.toLowerCase();

    // Comandos manuais de pausa
    if (lower === 'ricardo aqui!!' || lower === 'startap aqui!!') {
      await applyFlowManualCommand({
        command: 'pause',
        flowId: ctx.flowId ?? WORKFLOW_ID,
        flowName: ctx.flowName ?? WORKFLOW_NAME,
        telefone,
        session: sessao,
        source: 'manual',
        reason: 'Comando manual no fluxo Ricardo',
      });
      this.log.info({ telefone }, 'Pausa manual ativada');
      return null;
    }
    if (lower === 'ricardo voltar!!' || lower === 'startap voltar!!') {
      await applyFlowManualCommand({
        command: 'resume',
        flowId: ctx.flowId ?? WORKFLOW_ID,
        flowName: ctx.flowName ?? WORKFLOW_NAME,
        telefone,
        session: sessao,
        source: 'manual',
      });
      this.log.info({ telefone }, 'Pausa manual removida');
      return null;
    }

    const fullHistory = await this.loadHistory(ctx);
    const history = fullHistory.slice(0, -1);
    const hasPriorBotReply = history.some((turn) => turn.role === 'ai');

    const basePrompt = await renderPrompt({
      slot: this.slot,
      fallback: DEFAULT_PROMPT_TPL,
      vars: { nome: pushName || telefone, telefone },
    });
    const mediaContext = await botMedia.formatContextForPrompt(this.slot);
    const systemPrompt = mediaContext
      ? [
          basePrompt,
          '',
          '[CONTEXTO INTERNO DAS MIDIAS]',
          'Use este contexto apenas para decidir se uma tag de video faz sentido na conversa. Nao envie este texto ao cliente.',
          mediaContext,
        ].join('\n')
      : basePrompt;

    const tools: ToolDefinition[] = [
      {
        name: 'salvar_lead',
        description:
          'Salva o lead do cliente interessado no curso. Use quando o cliente demonstrar intencao de se inscrever. ' +
          'Passe o nome do cliente e uma descricao do interesse.',
        parameters: {
          type: 'object',
          properties: {
            nome: { type: 'string', description: 'Nome do cliente' },
            interesse: { type: 'string', description: 'Resumo do interesse do cliente no curso' },
          },
          required: ['nome', 'interesse'],
        },
        run: async (args: unknown) => {
          const { nome, interesse } = args as { nome: string; interesse: string };
          await leads.saveLeadRicardo({
            nome,
            telefone,
            mensagem_inicial: interesse,
            origem: 'whatsapp',
            slot: this.slot,
          });
          this.log.info({ telefone, nome }, 'Lead Ricardo salvo');
          return { ok: true };
        },
      },
    ];

    const result = await runAgentConfigured({
      slot: this.slot,
      projectId: this.slot,
      flowId: ctx.flowId,
      telefone,
      systemPrompt,
      history,
      userMessage: trimmed,
      tools,
      maxTurns: 5,
    });

    const sanitized = sanitizar(result.reply);
    const { tag, clean } = parseVideoTag(sanitized);
    const finalText = clean || sanitized;

    // Envia videos do banco (bot_media) apenas na primeira resposta do bot.
    if (tag === 'V1' && !hasPriorBotReply) {
      const delay = 2500;
      const send = async () => {
        try {
          const v1 = await botMedia.getByPosition(SLOT, 'V1');
          const v2 = await botMedia.getByPosition(SLOT, 'V2');
          const v3 = await botMedia.getByPosition(SLOT, 'V3');
          const pos = await botMedia.getByPosition(SLOT, 'POS_VIDEOS');
          if (v1?.url)
            await waha.sendMedia({
              type: 'video',
              sessao,
              chatId,
              url: v1.url,
              caption: v1.caption ?? undefined,
            });
          if (v2?.url)
            await waha.sendMedia({
              type: 'video',
              sessao,
              chatId,
              url: v2.url,
              caption: v2.caption ?? undefined,
            });
          if (v3?.url)
            await waha.sendMedia({
              type: 'video',
              sessao,
              chatId,
              url: v3.url,
              caption: v3.caption ?? undefined,
            });
          if (pos?.caption)
            await waha.sendText({ sessao, chatId, texto: pos.caption, typing: false });
        } catch (e) {
          this.log.error({ err: e, tag, telefone }, 'Falha ao enviar video');
        }
      };
      setTimeout(send, delay);
    }

    return finalText;
  }
}

export { DEFAULT_PROMPT_TPL as TESTE_VENDAS_DEFAULT_PROMPT };
