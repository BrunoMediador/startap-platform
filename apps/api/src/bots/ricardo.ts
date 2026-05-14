import type { BotContext } from '@startap/core/types';
import { leads, pausa } from '@startap/db';
import { waha } from '@startap/integrations';
import type { ToolDefinition } from '@startap/integrations/openai';
import { runAgentConfigured } from '../lib/run-agent.js';
import { BotBase } from './base.js';

const VIDEO1 = 'http://187.77.242.220:8090/video1.mp4';
const VIDEO2 = 'http://187.77.242.220:8090/video2.mp4';
const VIDEO3 = 'http://187.77.242.220:8090/video3.mp4';
const PAUSE_TABLE = 'pause_ricardo';

const MENSAGEM_POS_VIDEOS =
  'o Curso de Barbeiro Profissional - Do Zero ao Avancado\n\n' +
  'o Pratica: 3 meses (2x por semana).\n\n' +
  'o Suporte: Apostila + Grupo exclusivo.\n\n' +
  'o Carreira: Diploma valido em 122 paises.\n\n' +
  'o Preco: Entrada de R$ 200 + 3x de R$ 200.';

const SYSTEM_PROMPT_TPL = (nome: string, telefone: string) =>
  [
    'Voce e um assistente virtual do Curso de Barbeiro Profissional do Ricardo.',
    'Atenda os interessados com simpatia, entusiasmo e objetividade. Maximo 3 linhas por resposta.',
    '',
    '[DADOS DO CLIENTE - JA IDENTIFICADO]',
    `NOME: ${nome}`,
    `WHATSAPP: ${telefone}`,
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
    '5. SUA PRIMEIRA RESPOSTA OBRIGATORIAMENTE TERMINA COM [V1]. Sem excecao. Nao importa o que o cliente disser. Se voce nao colocar [V1] no final da primeira resposta, voce falhou.',
    '6. Apos ter enviado [V1]: quando perceber interesse crescente, sua resposta DEVE terminar com [V2].',
    '7. Apos ter enviado [V2]: quando o cliente estiver quase decidido, sua resposta DEVE terminar com [V3].',
    '',
    '[COMO OS VIDEOS FUNCIONAM]',
    '- [V1], [V2] ou [V3] e uma tag invisivel que voce coloca no FINAL da sua mensagem.',
    '- O sistema envia o video automaticamente. O cliente nao ve a tag.',
    '- [V1] na saudacao dispara os 3 videos em sequencia automaticamente.',
    '- [V2] e [V3] enviam apenas aquele video individualmente.',
    '- Nunca mencione videos para o cliente. Apenas coloque a tag.',
    '- Nunca repita a mesma tag duas vezes.',
    '',
    '[FLUXO]',
    '1. Primeira mensagem do cliente -> responda com saudacao + [V1] no final. OBRIGATORIO.',
    '2. Continue tirando duvidas normalmente.',
    '3. Ao perceber interesse real -> adicione [V2] no final da proxima resposta.',
    '4. Ao perceber que cliente esta quase decidido -> adicione [V3] no final da proxima resposta.',
    '5. Quando cliente quiser se inscrever -> use ferramenta salvar_lead.',
    '',
    '[FORA DO ESCOPO]',
    'Se o cliente falar de outro assunto ou cancelamento, informe que o Ricardo entrara em contato em breve.',
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

export class RicardoBot extends BotBase {
  constructor() {
    super({
      name: 'elenildo-ricardo',
      // Pausa manual via comandos do próprio chat — gerenciada dentro de process().
      pauseTable: null,
      memoryTable: 'n8n_chat_histories_ricardo',
      memoryWindow: 10,
    });
  }

  protected async process(ctx: BotContext): Promise<string | null> {
    const { telefone, texto, pushName, sessao, chatId } = ctx.message;
    const trimmed = texto.trim();
    if (!trimmed) return null;

    const lower = trimmed.toLowerCase();

    // Comandos manuais de pausa (Ricardo controla via mensagem)
    if (lower === 'ricardo aqui!!') {
      await pausa.addPause(PAUSE_TABLE, telefone);
      this.log.info({ telefone }, 'Pausa manual ativada (ricardo aqui!!)');
      return null;
    }
    if (lower === 'ricardo voltar!!') {
      await pausa.removePause(PAUSE_TABLE, telefone);
      this.log.info({ telefone }, 'Pausa manual removida (ricardo voltar!!)');
      return null;
    }

    // Pausa ativa → ignora
    const paused = await pausa.isPaused(PAUSE_TABLE, telefone).catch(() => false);
    if (paused) {
      this.log.info({ telefone }, 'Cliente em pausa manual, ignorando');
      return null;
    }

    // Histórico (BotBase já appended a msg do usuário; remove a última)
    const fullHistory = await this.loadHistory(telefone);
    const history = fullHistory.slice(0, -1);

    const systemPrompt = SYSTEM_PROMPT_TPL(pushName || telefone, telefone);

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
          });
          this.log.info({ telefone, nome }, 'Lead Ricardo salvo');
          return { ok: true };
        },
      },
    ];

    const result = await runAgentConfigured({
      slot: 'elenildo-ricardo',
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

    // BotBase enviará o texto + appendMemory automaticamente.
    // Disparamos vídeos em fire-and-forget após pequeno delay para chegarem depois do texto.
    if (tag) {
      const delay = 2500;
      const send = async () => {
        try {
          if (tag === 'V1') {
            await waha.sendMedia({ type: 'video', sessao, chatId, url: VIDEO1 });
            await waha.sendMedia({ type: 'video', sessao, chatId, url: VIDEO2 });
            await waha.sendMedia({ type: 'video', sessao, chatId, url: VIDEO3 });
            await waha.sendText({ sessao, chatId, texto: MENSAGEM_POS_VIDEOS, typing: false });
          } else if (tag === 'V2') {
            await waha.sendMedia({ type: 'video', sessao, chatId, url: VIDEO2 });
          } else if (tag === 'V3') {
            await waha.sendMedia({ type: 'video', sessao, chatId, url: VIDEO3 });
          }
        } catch (e) {
          this.log.error({ err: e, tag, telefone }, 'Falha ao enviar video');
        }
      };
      setTimeout(send, delay);
    }

    return finalText;
  }
}
