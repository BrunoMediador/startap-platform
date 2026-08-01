/**
 * Router universal — substitui o workflow ROUTER_WAHA (automação visual antiga).
 *
 * Recebe payload da WAHA, extrai telefone (handling LID/PN addressingMode),
 * busca em routing_clientes qual bot atende esse número, e delega.
 *
 * Diferenças do automação visual antiga original:
 *  - Roteamento dinâmico via map de bots (não HTTP forward externo).
 *  - Suporta múltiplas sessões WAHA na mesma instância.
 *  - Antibot + pausa global aplicados aqui (antes de chegar nos bots).
 */
import { isHumanReplyAgendaEnabled } from '@startap/core/human-reply-agenda-gate';
import { logger } from '@startap/core/logger';
import { parseWahaAckPayload } from '@startap/core/message-ack';
import { extractPhone, isGroupChat, phoneLogTag } from '@startap/core/phone';
import { resolveSilenceGate } from '@startap/core/silence-gate';
import type { Bot, BotContext, IncomingMessage, WahaWebhookBody } from '@startap/core/types';
import {
  antibot,
  clientBilling,
  contactNames,
  flowClones,
  flowExecutionLog,
  outboundMessages,
  pausa,
  routing,
} from '@startap/db';
import type { FlowExecutionLogInput, RoutingRow } from '@startap/db';
import { waha, whisper } from '@startap/integrations';
import { isBlockedNumber } from './lib/bot-blocklist.js';
import { HUMAN_REPLY_PAUSE_TTL_MS, isBotEcho, isSelfChat } from './lib/human-reply-pause.js';
import { checkAndMarkDuplicate } from './lib/idempotency.js';
import { resolveFromMeIdentity } from './lib/lid-resolver.js';
import { applyFlowManualCommand, getFlowManualCommandForFlow } from './lib/manual-pause.js';
import { handleSessionStatusEvent } from './lib/trial-pairing.js';
import {
  type BotEntry,
  buildCloneRoute,
  buildFallbackRoute,
  findBotByFlowId,
  findBotBySession,
  registerBotEntry,
} from './registry.js';

/** Tipo de fábrica de bot clone: recebe slotOverride, retorna instância Bot. */
export type CloneBotFactory = (slotOverride: string) => Bot;

/** Map de matrizSlot -> factory. Registrado em server.ts. */
const cloneFactories = new Map<string, CloneBotFactory>();

/** Registra uma factory de clone para uma matriz. Chamado em server.ts. */
export function registerCloneFactory(matrizSlot: string, factory: CloneBotFactory): void {
  cloneFactories.set(matrizSlot, factory);
  log.info({ matrizSlot }, 'Clone factory registrada');
}

/**
 * Resolve um bot clone dinamicamente a partir do workflow_id (slot do clone).
 * Consulta flow_clones para descobrir matriz_slot e instancia o bot com override.
 * Retorna null se não encontrar a factory ou o registro no DB.
 */
async function resolveCloneBot(cloneSlot: string): Promise<Bot | null> {
  const cloneRow = await flowClones.getCloneBySlot(cloneSlot).catch(() => null);
  if (!cloneRow) {
    log.warn({ cloneSlot }, 'Clone não encontrado em flow_clones');
    return null;
  }
  const factory = cloneFactories.get(cloneRow.matriz_slot);
  if (!factory) {
    log.warn(
      { cloneSlot, matrizSlot: cloneRow.matriz_slot },
      'Nenhuma factory registrada para matriz do clone',
    );
    return null;
  }
  return factory(cloneSlot);
}

const log = logger.child({ module: 'router' });

/**
 * GATE ÚNICO de silêncio total por-clone (fix pós-SCRUM-155, decisão do Bruno).
 *
 * Cobre os DOIS ramos de entrada do router (fromMe e cliente-final) com a MESMA função
 * pura (`@startap/core/silence-gate`). Clone suspenso (flow_enabled=false) OU vencido
 * além da carência ⇒ SILÊNCIO TOTAL: nenhum efeito colateral roda — nem o comando manual
 * do dono pelo WhatsApp, nem a pausa por-resposta-humana, nem antibot/log de contato.
 *
 * FLAG DE ROLLOUT: `GATE_SILENCIO_TOTAL_ENABLED` (env, default OFF/ausente). OFF = esta
 * função sempre retorna null (comportamento BYTE-IDÊNTICO ao de antes desta mudança — o
 * gate legado do ramo cliente-final, mais abaixo, continua sendo a única barreira).
 * ON = passa a valer nos dois ramos, mais cedo.
 *
 * Retorna null quando não deve silenciar (segue o fluxo normal) ou o motivo devidamente
 * logado quando silencia (o CALLER decide o `status` de retorno e faz o early-return).
 *
 * source: rótulo do ramo/subramo pra log (`fromMe`, `fromMe:manual-command`, `cliente-final`,
 * ...) — aparece no log como `ignored:suspended:<source>` / `ignored:billing-overdue:<source>`,
 * SEM PII, pra medir em prod que o corte está funcionando por ramo.
 */
async function checkSilenceGate(input: {
  route: RoutingRow | null;
  source: string;
  phoneLog: Pick<FlowExecutionLogInput, 'executionId' | 'session' | 'telefone'>;
  startedAt: number;
}): Promise<{ status: string } | null> {
  if (process.env.GATE_SILENCIO_TOTAL_ENABLED !== 'true') return null;
  const { route, source, phoneLog, startedAt } = input;
  if (!route || !route.workflow_id.startsWith('clone_')) return null;

  const cloneForGate = await flowClones.getCloneBySlot(route.workflow_id).catch(() => null);
  if (!cloneForGate) return null;

  const result = resolveSilenceGate(cloneForGate, {
    graceDays: clientBilling.GRACE_DAYS,
    daysUntilDue: (nextDueDate) => clientBilling.daysUntilDue(nextDueDate),
    billingOverdueSilenceOn: process.env.BILLING_OVERDUE_SILENCE === 'true',
  });
  if (!result.silenced) return null;

  const eventType =
    result.reason === 'flow-suspended' ? 'router.flow-suspended' : 'router.billing-overdue';
  const status =
    result.reason === 'flow-suspended'
      ? `ignored:suspended:${source}`
      : `ignored:billing-overdue:${source}`;

  log.info(
    {
      flowId: route.workflow_id,
      reason: result.reason,
      diasRestantes: result.diasRestantes,
      source,
    },
    'Gate de silêncio total: clone silenciado, ignorando (nenhum efeito colateral)',
  );
  await flowExecutionLog.logFlowEvent({
    ...phoneLog,
    flowId: route.workflow_id,
    flowName: route.workflow_name,
    eventType,
    status: 'ignored',
    message:
      result.reason === 'flow-suspended'
        ? 'Fluxo suspenso, ignorando (gate único — nenhum efeito colateral)'
        : 'Fluxo silenciado por inadimplência, ignorando (gate único — nenhum efeito colateral)',
    metadata: {
      flowId: route.workflow_id,
      reason: result.reason,
      diasRestantes: result.diasRestantes,
      graceDays: clientBilling.GRACE_DAYS,
      source,
    },
    durationMs: Date.now() - startedAt,
  });
  return { status };
}

/**
 * Registra um bot sem sessão própria (lookup via routing_clientes).
 * Bots com sessão própria (ex: Startap) registram-se via registerBotEntry
 * diretamente ao serem importados.
 */
export function registerBot(
  workflowId: string,
  bot: Bot,
  legacyPauseTable: string | null = null,
): void {
  registerBotEntry({
    workflowId,
    workflowName: workflowId,
    ownedSessions: [],
    legacyPauseTable,
    getManualCommand: () => null,
    applyManualCommand: async () => {},
    bot,
  });
  log.info({ workflowId, bot: bot.name }, 'Bot registrado');
}

/** Entry point — chamado pela rota /webhooks/waha. */
export async function handleWebhook(
  body: WahaWebhookBody,
  // skipDedup (ADR 0021): no caminho ASSÍNCRONO (WEBHOOK_ASYNC) a rota roda o
  // dedup ANTES do ACK-early — não pode reprocessar retry da WAHA. Para não
  // deduplicar 2x, a rota passa skipDedup=true e o bloco 1b vira no-op. No
  // caminho SÍNCRONO (flag OFF, default) o opts não traz skipDedup → o dedup
  // segue rodando aqui, idêntico ao de hoje.
  opts: { executionId: string; startedAt?: number; skipDedup?: boolean },
): Promise<{ status: string }> {
  const startedAt = opts.startedAt ?? Date.now();
  const baseLog = {
    executionId: opts.executionId,
    session: body.session,
  };

  // 0. Eventos de status de sessão alimentam o hook de trial do pareamento
  // (Missão 020 F1): 1º WORKING de clone em trial consome o trial_ledger e
  // inicia os 7 dias. Clones com trial_status='none' (Cirilo, matrizes,
  // clones manuais) são no-op absoluto — comportamento atual intacto.
  if (body.event === 'session.status') {
    return handleSessionStatusEvent(body, { executionId: opts.executionId, startedAt });
  }

  // 0b. SCRUM-58 — RASTREIO DE ENTREGA: evento `message.ack` do WAHA atualiza o status de entrega
  // do outbound correspondente (PENDING→SERVER→DEVICE→READ, ou ERROR/nack). GATED por
  // MESSAGE_ACK_TRACKING_ENABLED (env, mesmo padrão de IDEMPOTENCY_DEDUP): OFF (default) = este bloco
  // NÃO existe — o `message.ack` cai no filtro NON_INCOMING de sempre e vira `ignored:event`
  // (byte-idêntico). A assinatura de `message.ack` na config das sessões WAHA é passo de deploy
  // separado (sem ela, este ramo nunca é exercido). handleAckEvent é FAIL-SAFE: nunca lança.
  if (body.event === 'message.ack' && process.env.MESSAGE_ACK_TRACKING_ENABLED === 'true') {
    return handleAckEvent(body, { executionId: opts.executionId, startedAt });
  }

  // 1. Aceita qualquer evento de mensagem nova (`message`, `message.any` e
  // variantes que algumas engines WAHA usam para audio/midia tipo
  // `message.media`, `message.audio`). Rejeita ack/revoked/reaction que sao
  // mudancas de estado, nao mensagens novas.
  //
  // Bruno 2026-05-21: cliente reportou que audio "nem disparou" — hipotese
  // de que a engine atual envia audio sob evento diferente de `message`. Em
  // vez de hardcoded whitelist, usamos prefix `message.` com blacklist de
  // sub-eventos que sabemos serem nao-incoming. Para diagnostico, quando
  // dropar, logamos o event + estrutura do payload.
  const NON_INCOMING_EVENT_SUFFIXES = new Set([
    'ack',
    'revoke',
    'revoked',
    'reaction',
    'edited',
    'waiting',
  ]);
  const isMessageEvent =
    body.event === 'message' ||
    body.event === 'message.any' ||
    (typeof body.event === 'string' &&
      body.event.startsWith('message.') &&
      !NON_INCOMING_EVENT_SUFFIXES.has(body.event.slice('message.'.length)));
  if (!isMessageEvent) {
    await flowExecutionLog.logFlowEvent({
      ...baseLog,
      eventType: 'router.ignored',
      status: 'ignored',
      message: 'Evento WAHA ignorado',
      metadata: {
        reason: 'event',
        event: body.event,
        // Diagnostico audio: se evento rejeitado tem cara de audio, mostra
        // estrutura do payload para identificar como aceitar futuramente.
        payloadKeys: body.payload ? Object.keys(body.payload) : [],
        dataMsgKeys: dumpDataMessageKeys(body.payload),
        audioMsgPresent: hasAudioMessageNode(body.payload),
      },
      durationMs: Date.now() - startedAt,
    });
    return { status: 'ignored:event' };
  }

  // 1b. Dedup de evento de mensagem (ADR 0019, passo 2) — FLAG-GATED, FAIL-OPEN.
  // Default OFF: este bloco e no-op e o fluxo segue identico ao de hoje. ON: faz
  // SET NX EX no Redis com chave (sessao, messageId); se o evento ja foi visto
  // (retry/duplicata da WAHA, ou a outra instancia no scale-out) -> PULA o
  // processamento e retorna 200 (WAHA nao retenta). Redis down/timeout/sem id ->
  // fail-open (processa mesmo assim, com warn) — nunca cala o bot por hiccup de
  // Redis. Posicionado ANTES de qualquer efeito (resposta WAHA, GCal, antibot).
  // Le a flag direto do process.env (mesmo padrao do gate BILLING_OVERDUE_SILENCE):
  // permite OFF instantaneo em runtime, sem rebuild. TTL/timeout vem do config
  // (parseados no boot — nao precisam de toggle a quente).
  // skipDedup: o ACK-early do webhook async (ADR 0021) JÁ rodou este dedup na
  // rota, ANTES de aceitar o processamento — aqui seria deduplicar 2x.
  if (process.env.IDEMPOTENCY_DEDUP === 'true' && !opts.skipDedup) {
    const messageId = body.payload?.id ?? '';
    const dedup = await checkAndMarkDuplicate(body.session, messageId);
    if (dedup.duplicate) {
      log.info({ ...baseLog }, 'Evento de mensagem duplicado ignorado (dedup)');
      await flowExecutionLog.logFlowEvent({
        ...baseLog,
        eventType: 'router.ignored',
        status: 'ignored',
        message: 'Evento de mensagem duplicado ignorado (dedup)',
        metadata: { reason: 'dedup', event: body.event },
        durationMs: Date.now() - startedAt,
      });
      return { status: 'ignored:dedup' };
    }
    // dedup.degraded === true -> Redis indisponivel ou sem messageId: ja logado
    // como warn no modulo; seguimos processando (fail-open).
  }

  const fromMe = !!body.payload?.fromMe;
  // Detecta bot por sessão antes de extrair telefone — necessário para comandos
  // manuais de bots com sessão própria (ex: Startap), cujo trigger pode chegar
  // antes de qualquer informação de roteamento.
  const sessionEntry = findBotBySession(body.session);
  const sessionManualCommand =
    fromMe && sessionEntry ? sessionEntry.getManualCommand(body.payload?.body ?? '') : null;

  // 2. Mensagens fromMe com texto podem ser comando manual por fluxo.
  // A decisão final vem depois de extrair o telefone e descobrir o fluxo.
  if (fromMe && !sessionManualCommand && !body.payload?.body) {
    await flowExecutionLog.logFlowEvent({
      ...baseLog,
      eventType: 'router.ignored',
      status: 'ignored',
      message: 'Mensagem enviada pelo próprio bot',
      metadata: { reason: 'fromMe' },
      durationMs: Date.now() - startedAt,
    });
    return { status: 'ignored:fromMe' };
  }

  // 3. Extrai telefone real
  const telefone = extractPhone(body);
  if (!telefone) {
    log.warn(
      {
        // SCRUM-117: NÃO dumpar o payload cru (contém from/remoteJid/texto = PII).
        // Só os campos de diagnóstico da extração, e o chatId mascarado.
        fone: phoneLogTag(body.payload?.from),
        addressingMode: body.payload?._data?.key?.addressingMode ?? null,
        hasRemoteJidAlt: !!body.payload?._data?.key?.remoteJidAlt,
      },
      'Não foi possível extrair telefone',
    );
    await flowExecutionLog.logFlowEvent({
      ...baseLog,
      eventType: 'router.no-phone',
      status: 'ignored',
      message: 'Não foi possível extrair telefone',
      metadata: {
        hasPayload: !!body.payload,
        from: body.payload?.from ? '[present]' : null,
        addressingMode: body.payload?._data?.key?.addressingMode ?? null,
      },
      durationMs: Date.now() - startedAt,
    });
    return { status: 'ignored:no-phone' };
  }

  // 3-pre. Blocklist GLOBAL de números internos (o remetente da sessão ALERTAS,
  // 553598373138). Vale pra TODOS os clones (atuais e futuros): mora aqui, no router
  // compartilhado, ANTES de antibot/routing/IA/GCal. Se o número operacional interno
  // mandar mensagem pra qualquer bot (ex.: o alerta que chega no próprio número da
  // barbearia) -> ignora total (não responde, não chama IA, não toca GCal).
  // Configurável por env BOT_BLOCKLIST_NUMBERS (default já inclui o remetente da
  // ALERTAS). Números do time/teste (Bruno etc.) NÃO entram — ver lib/bot-blocklist.ts.
  if (isBlockedNumber(telefone)) {
    log.info({ ...baseLog }, 'Número da blocklist interna ignorado');
    await flowExecutionLog.logFlowEvent({
      ...baseLog,
      eventType: 'router.ignored',
      status: 'ignored',
      message: 'Número da blocklist interna ignorado',
      metadata: { reason: 'blocklist' },
      durationMs: Date.now() - startedAt,
    });
    return { status: 'ignored:blocklist' };
  }

  // 3a. Filtro de grupo — deve vir ANTES de qualquer log com telefone,
  // antibot ou chamada de bot. Mensagens de grupo são ignoradas em TODOS os
  // clones (Ricardo, Cirilo, Lola, matrizes de teste). Critérios:
  //  - payload.from termina em @g.us (chatId de grupo explícito)
  //  - payload.from começa com 120363 (JID grupo padrão NOWEB/Baileys)
  //  - campo participant presente e não vazio (exclusivo de msgs em grupo)
  // IDs de 22+ dígitos (ex: 5592813522781591200729) são LIDs de participante
  // de grupo — sempre acompanhados de participant, cobertos pelo critério 3.
  if (isGroupChat(body)) {
    const groupFrom = body.payload?.from ?? 'unknown';
    log.info({ ...baseLog, groupFrom }, 'Mensagem de grupo ignorada');
    await flowExecutionLog.logFlowEvent({
      ...baseLog,
      eventType: 'router.ignored',
      status: 'ignored',
      message: 'Mensagem de grupo ignorada',
      metadata: {
        reason: 'group-chat',
        groupFrom,
      },
      durationMs: Date.now() - startedAt,
    });
    return { status: 'ignored:group-chat' };
  }

  const sessao = body.session;
  const chatId = body.payload?.from ?? '';
  const phoneLog = { ...baseLog, telefone };

  // Comando manual de bot com sessão própria (ex: "ola!souicaro..." do Startap).
  // Diferente dos comandos genéricos de fluxo abaixo, este é interpretado pelo
  // próprio bot sem passar por routing_clientes.
  if (sessionManualCommand && sessionEntry) {
    await sessionEntry.applyManualCommand(sessionManualCommand, telefone, {
      session: sessao,
      source: 'fromMe',
    });
    await flowExecutionLog.logFlowEvent({
      ...phoneLog,
      flowId: sessionEntry.workflowId,
      flowName: sessionEntry.workflowName,
      bot: sessionEntry.bot.name,
      eventType:
        sessionManualCommand === 'pause'
          ? `${sessionEntry.bot.name}.manual-pause`
          : `${sessionEntry.bot.name}.manual-resume`,
      status: 'success',
      message:
        sessionManualCommand === 'pause'
          ? 'Atendente assumiu a conversa'
          : 'Atendimento humano finalizado; IA retomada',
      metadata: { pauseTable: sessionEntry.legacyPauseTable, source: 'fromMe' },
      durationMs: Date.now() - startedAt,
    });
    return { status: `ok:${sessionEntry.bot.name}-manual-${sessionManualCommand}` };
  }

  if (fromMe) {
    const route = await findRoute(telefone, sessao, sessionEntry);

    // GATE ÚNICO DE SILÊNCIO TOTAL (topo do ramo fromMe) — clone suspenso/vencido não
    // grava NENHUM efeito colateral, incluindo o comando manual do PRÓPRIO dono
    // (pause/resume por keyword) e a pausa por-resposta-humana abaixo. Flag-gated
    // (GATE_SILENCIO_TOTAL_ENABLED); OFF = sempre null, ramo segue byte-idêntico.
    const gateFromMe = await checkSilenceGate({
      route,
      source: 'fromMe',
      phoneLog,
      startedAt,
    });
    if (gateFromMe) return gateFromMe;

    // === SCRUM-59 — ramo MODO ATENDENTE ("mesmo número IA + atendente"), GATED por-clone. ===
    // Só clones no MODO_ATENDENTE_SLOTS entram aqui; os demais (Cirilo/Samuel/dragon) PULAM
    // este bloco e caem na lógica byte-idêntica de sempre logo abaixo. Flag lida do
    // process.env (mesmo padrão dos gates IDEMPOTENCY_DEDUP/BILLING_OVERDUE_SILENCE no router).
    if (
      route &&
      (await flowClones.resolveModoAtendenteEnabledForSlot(
        route.workflow_id,
        process.env.MODO_ATENDENTE_SLOTS,
      ))
    ) {
      const text = body.payload?.body ?? '';

      // (0) SCRUM-63 — CONTATO MIGRADO (LID): pós-migração LID do WhatsApp, o eco fromMe (e a
      // resposta manual do dono) a um contato migrado chega endereçado por `<lid>@lid`; o
      // pseudo-número do lid NÃO é o telefone e não casa a marca de eco (por E.164) nem a
      // chave de pausa (bug de prod na Meduzza: pausas-fantasma "…3730"/"…9600"). Resolvemos
      // `@lid`→E.164 ANTES de QUALQUER decisão (self-chat, eco, keyword, pausa). FAIL-SAFE:
      // não resolveu → nenhuma pausa (nunca criar linha em flow_pauses com identidade que não
      // é telefone). Não-lid = byte-idêntico (identity.phone === telefone). Envio NÃO muda.
      const identity = await resolveFromMeIdentity(sessao, body, telefone);
      if (identity.wasLid && identity.phone === null) {
        log.warn(
          { ...baseLog, lidVia: identity.via },
          'fromMe de contato migrado (@lid) sem resolução de telefone — fail-safe (sem pausa)',
        );
        await flowExecutionLog.logFlowEvent({
          ...phoneLog,
          flowId: route.workflow_id,
          flowName: route.workflow_name,
          eventType: 'router.ignored',
          status: 'ignored',
          message: 'fromMe de contato migrado (@lid) sem resolução de telefone — fail-safe',
          metadata: { reason: 'fromMe-lid-unresolved', via: identity.via, source: 'fromMe' },
          durationMs: Date.now() - startedAt,
        });
        return { status: 'ignored:fromMe:lid-unresolved' };
      }
      // Identidade resolvida (ou não-lid): usada em TODAS as decisões abaixo no lugar do
      // `telefone` cru (que, num contato migrado, seria o pseudo-número do lid).
      const atendenteTelefone = identity.phone ?? telefone;

      // (1) SELF-CHAT: mensagem fromMe pro PRÓPRIO número da sessão (ex.: eco do alerta de
      // lead no cenário mesmo-número). NUNCA pausa nem comanda — antes do keyword e da
      // auto-pausa. cliente_telefone = número pareado (me.id) do clone; cache TTL 60s.
      const cloneForSelf = await flowClones.getCloneBySlot(route.workflow_id).catch(() => null);
      if (isSelfChat(atendenteTelefone, cloneForSelf?.cliente_telefone)) {
        await flowExecutionLog.logFlowEvent({
          ...phoneLog,
          flowId: route.workflow_id,
          flowName: route.workflow_name,
          eventType: 'router.ignored',
          status: 'ignored',
          message: 'Mensagem fromMe no self-chat ignorada (modo atendente)',
          metadata: { reason: 'fromMe-self-chat', source: 'fromMe' },
          durationMs: Date.now() - startedAt,
        });
        return { status: 'ignored:fromMe:self-chat' };
      }

      // (2) ANTI-ECO: a resposta que o PRÓPRIO bot envia via WAHA volta no webhook como
      // fromMe. Mesma fonte de verdade pro keyword match E pra auto-pausa — evita o bot
      // se auto-pausar/auto-comandar ao ver a própria resposta.
      //   'echo'     = eco confirmado do bot -> pula keyword e NÃO pausa;
      //   'human'    = digitado por humano   -> casa keyword / pode pausar;
      //   'degraded' = Redis indisponível    -> keyword AINDA roda (comando humano
      //                explícito), mas NÃO auto-pausa (fail-safe: nunca auto-pausa na dúvida).
      const echoState = await isBotEcho(sessao, atendenteTelefone, text);
      const confirmedEcho = echoState === 'echo';

      // (3) KEYWORD (frase de pausa/retomada editável do dono) — pulada só em eco confirmado.
      const flowManualCommand = confirmedEcho
        ? null
        : await getFlowManualCommandForFlow(route.workflow_id, text);
      if (flowManualCommand) {
        // SCRUM-144: snapshota o nome do CONTATO (store durável, pushName do INBOUND) — NUNCA
        // o pushName deste evento fromMe (que é o nome do DONO, não do contato). Fail-safe:
        // erro na leitura NUNCA atrasa/derruba a pausa — nome fica NULL nesse caso.
        const contactNameManual = await contactNames
          .getContactName({ session: sessao, telefone: atendenteTelefone })
          .catch(() => null);
        await applyFlowManualCommand({
          command: flowManualCommand,
          flowId: route.workflow_id,
          flowName: route.workflow_name,
          telefone: atendenteTelefone,
          session: sessao,
          source: 'fromMe',
          reason: 'Comando manual no WhatsApp',
          contactName: contactNameManual,
        });
        await flowExecutionLog.logFlowEvent({
          ...phoneLog,
          flowId: route.workflow_id,
          flowName: route.workflow_name,
          eventType: flowManualCommand === 'pause' ? 'router.manual-pause' : 'router.manual-resume',
          status: 'success',
          message:
            flowManualCommand === 'pause'
              ? 'Atendente assumiu a conversa neste fluxo'
              : 'Atendimento humano finalizado; IA do fluxo retomada',
          metadata: { pauseScope: 'flow', source: 'fromMe', modo: 'atendente' },
          durationMs: Date.now() - startedAt,
        });
        return { status: `ok:manual-${flowManualCommand}` };
      }

      // (4) RESPOSTA HUMANA À MÃO (fromMe, texto, não-keyword, não-eco): pausa AQUELE
      // contato por TTL e o bot volta sozinho; cada resposta humana renova o expires_at.
      // Fail-safe: só em 'human' CONFIRMADO — eco/degraded NÃO pausam.
      if (echoState === 'human' && text.trim().length > 0) {
        // Guard defensivo (SCRUM-63, 2ª barreira): uma identidade de contato migrado (@lid)
        // sem resolução NUNCA vira linha em flow_pauses. O fail-safe no topo do ramo já
        // retorna nesse caso; este check protege contra regressão futura (se alguém remover
        // o early-return, a pausa AINDA não nasce com o pseudo-número do lid).
        if (identity.wasLid && identity.phone === null) {
          log.warn(
            { ...baseLog, lidVia: identity.via },
            'human-reply-pause abortada: identidade @lid não resolvida (guard)',
          );
          await flowExecutionLog.logFlowEvent({
            ...phoneLog,
            flowId: route.workflow_id,
            flowName: route.workflow_name,
            eventType: 'router.ignored',
            status: 'ignored',
            message: 'human-reply-pause abortada: identidade @lid não resolvida (guard)',
            metadata: {
              reason: 'fromMe-lid-unresolved-guard',
              via: identity.via,
              source: 'fromMe',
            },
            durationMs: Date.now() - startedAt,
          });
          return { status: 'ignored:fromMe:lid-unresolved' };
        }
        // SCRUM-144: snapshota o nome do CONTATO (do store durável, pelo pushName do INBOUND) —
        // NUNCA o pushName deste evento fromMe (que é o nome do DONO). Fail-safe: sem nome = NULL.
        const contactName = await contactNames
          .getContactName({ session: sessao, telefone: atendenteTelefone })
          .catch(() => null);
        // addHumanReplyPause (não addFlowPause): NUNCA rebaixa uma pausa explícita ativa de
        // outro source (keyword/escalated/antibot/portal) pro TTL — só cria/renova a própria
        // human_reply (review security N1, SCRUM-60).
        await pausa.addHumanReplyPause({
          flowId: route.workflow_id,
          flowName: route.workflow_name,
          telefone: atendenteTelefone,
          session: sessao,
          reason: 'Atendente respondeu à mão — pausa temporária (modo atendente)',
          expiresAt: new Date(Date.now() + HUMAN_REPLY_PAUSE_TTL_MS),
          contactName,
        });
        await flowExecutionLog.logFlowEvent({
          ...phoneLog,
          flowId: route.workflow_id,
          flowName: route.workflow_name,
          eventType: 'router.human-reply-pause',
          status: 'success',
          message: 'Atendente respondeu à mão; bot pausado temporariamente neste contato',
          metadata: {
            pauseScope: 'flow',
            source: 'human_reply',
            ttlMs: HUMAN_REPLY_PAUSE_TTL_MS,
          },
          durationMs: Date.now() - startedAt,
        });
        return { status: 'ok:human-reply-pause' };
      }

      // Eco confirmado / degraded / texto vazio -> sem efeito (como hoje: ignored:fromMe).
      await flowExecutionLog.logFlowEvent({
        ...phoneLog,
        flowId: route.workflow_id,
        flowName: route.workflow_name,
        eventType: 'router.ignored',
        status: 'ignored',
        message: 'Mensagem enviada pelo próprio bot (modo atendente)',
        metadata: { reason: 'fromMe', echoState, source: 'fromMe' },
        durationMs: Date.now() - startedAt,
      });
      return { status: 'ignored:fromMe' };
    }

    const flowManualCommand = route
      ? await getFlowManualCommandForFlow(route.workflow_id, body.payload?.body ?? '')
      : null;
    if (!route) {
      await flowExecutionLog.logFlowEvent({
        ...phoneLog,
        eventType: 'router.manual-pause-no-routing',
        status: 'ignored',
        message: 'Comando manual recebido, mas telefone sem rota ativa',
        metadata: { command: flowManualCommand, source: 'fromMe' },
        durationMs: Date.now() - startedAt,
      });
      return { status: 'ignored:manual-pause-no-routing' };
    }
    if (!flowManualCommand) {
      // === SCRUM-68 Onda 4 — RESPOSTA HUMANA À MÃO no ramo AGENDA, GATED por-clone. ===
      // Keyword NÃO casou (comando manual explícito já foi tratado acima e segue INTACTO).
      // Quando o gate está ON pra este slot, o dono que respondeu À MÃO pelo MESMO número
      // (fromMe, texto livre, NÃO-eco) pausa AQUELE contato por 60min com volta automática —
      // a MESMA pausa human_reply do modo atendente, agora nos formatos de agenda.
      // OFF (env vazia/não-setada = default): NADA disto roda -> cai byte-idêntico no
      // 'ignored:fromMe' de sempre (nenhuma pausa, nenhuma leitura de identidade/eco).
      if (isHumanReplyAgendaEnabled(route.workflow_id, process.env.HUMAN_REPLY_AGENDA_SLOTS)) {
        const text = body.payload?.body ?? '';

        // (0) CONTATO MIGRADO (LID, SCRUM-63): resolve `@lid`→E.164 ANTES de qualquer decisão
        // chaveada por identidade (self-chat / eco / pausa). FAIL-SAFE: não resolveu → nenhuma
        // pausa (nunca criar linha em flow_pauses com pseudo-número de lid). Não-lid = byte-
        // idêntico (identity.phone === telefone). O ENVIO não muda (a engine resolve sozinha).
        const identity = await resolveFromMeIdentity(sessao, body, telefone);
        if (identity.wasLid && identity.phone === null) {
          log.warn(
            { ...baseLog, lidVia: identity.via },
            'fromMe de contato migrado (@lid) sem resolução — fail-safe (sem human-reply-pause, ramo agenda)',
          );
          await flowExecutionLog.logFlowEvent({
            ...phoneLog,
            flowId: route.workflow_id,
            flowName: route.workflow_name,
            eventType: 'router.ignored',
            status: 'ignored',
            message: 'fromMe de contato migrado (@lid) sem resolução de telefone — fail-safe',
            metadata: { reason: 'fromMe-lid-unresolved', via: identity.via, source: 'fromMe' },
            durationMs: Date.now() - startedAt,
          });
          return { status: 'ignored:fromMe:lid-unresolved' };
        }
        const atendenteTelefone = identity.phone ?? telefone;

        // (1) SELF-CHAT: fromMe pro PRÓPRIO número da sessão (ex.: eco de alerta self-send).
        // NUNCA pausa nem comanda. cliente_telefone = número pareado (me.id) do clone.
        const cloneForSelf = await flowClones.getCloneBySlot(route.workflow_id).catch(() => null);
        if (isSelfChat(atendenteTelefone, cloneForSelf?.cliente_telefone)) {
          await flowExecutionLog.logFlowEvent({
            ...phoneLog,
            flowId: route.workflow_id,
            flowName: route.workflow_name,
            eventType: 'router.ignored',
            status: 'ignored',
            message: 'Mensagem fromMe no self-chat ignorada (ramo agenda)',
            metadata: { reason: 'fromMe-self-chat', source: 'fromMe' },
            durationMs: Date.now() - startedAt,
          });
          return { status: 'ignored:fromMe:self-chat' };
        }

        // (2) ANTI-ECO: a resposta que o PRÓPRIO bot envia via WAHA volta como fromMe. Só
        // pausa em 'human' CONFIRMADO — 'echo'/'degraded' NÃO pausam (fail-safe: nunca auto-
        // pausar o próprio bot). Exige que base.ts registre o eco pros slots deste gate.
        const echoState = await isBotEcho(sessao, atendenteTelefone, text);
        if (echoState === 'human' && text.trim().length > 0) {
          // SCRUM-144: snapshota o nome do CONTATO (store durável, pushName do INBOUND) — nunca
          // o pushName do evento fromMe (nome do DONO). Fail-safe: sem nome = NULL.
          const contactName = await contactNames
            .getContactName({ session: sessao, telefone: atendenteTelefone })
            .catch(() => null);
          // addHumanReplyPause (não addFlowPause): NUNCA rebaixa uma pausa explícita ativa de
          // outro source (keyword/portal/antibot) pro TTL — só cria/renova a própria human_reply.
          await pausa.addHumanReplyPause({
            flowId: route.workflow_id,
            flowName: route.workflow_name,
            telefone: atendenteTelefone,
            session: sessao,
            reason: 'Atendente respondeu à mão — pausa temporária (ramo agenda)',
            expiresAt: new Date(Date.now() + HUMAN_REPLY_PAUSE_TTL_MS),
            contactName,
          });
          await flowExecutionLog.logFlowEvent({
            ...phoneLog,
            flowId: route.workflow_id,
            flowName: route.workflow_name,
            eventType: 'router.human-reply-pause',
            status: 'success',
            message: 'Atendente respondeu à mão; bot pausado temporariamente neste contato',
            metadata: {
              pauseScope: 'flow',
              source: 'human_reply',
              ttlMs: HUMAN_REPLY_PAUSE_TTL_MS,
            },
            durationMs: Date.now() - startedAt,
          });
          return { status: 'ok:human-reply-pause' };
        }
        // Eco confirmado / degraded / texto vazio -> segue pro 'ignored:fromMe' de sempre.
      }

      await flowExecutionLog.logFlowEvent({
        ...phoneLog,
        flowId: route.workflow_id,
        flowName: route.workflow_name,
        eventType: 'router.ignored',
        status: 'ignored',
        message: 'Mensagem enviada pelo próprio bot',
        metadata: { reason: 'fromMe', routeId: route.id },
        durationMs: Date.now() - startedAt,
      });
      return { status: 'ignored:fromMe' };
    }

    // SCRUM-144: snapshota o nome do CONTATO (store durável, pushName do INBOUND) — NUNCA o
    // pushName deste evento fromMe (nome do DONO). Este ponto fica FORA do gate de modo
    // atendente/resolução @lid (roda antes dela) — usa `telefone` cru, mesma variável que o
    // resto deste bloco já usa. Fail-safe: erro na leitura não atrasa/derruba a pausa.
    const contactNameManual = await contactNames
      .getContactName({ session: sessao, telefone })
      .catch(() => null);
    await applyFlowManualCommand({
      command: flowManualCommand,
      flowId: route.workflow_id,
      flowName: route.workflow_name,
      telefone,
      session: sessao,
      source: 'fromMe',
      reason: 'Comando manual no WhatsApp',
      contactName: contactNameManual,
    });
    await flowExecutionLog.logFlowEvent({
      ...phoneLog,
      flowId: route.workflow_id,
      flowName: route.workflow_name,
      eventType: flowManualCommand === 'pause' ? 'router.manual-pause' : 'router.manual-resume',
      status: 'success',
      message:
        flowManualCommand === 'pause'
          ? 'Atendente assumiu a conversa neste fluxo'
          : 'Atendimento humano finalizado; IA do fluxo retomada',
      metadata: { pauseScope: 'flow', source: 'fromMe' },
      durationMs: Date.now() - startedAt,
    });
    return { status: `ok:manual-${flowManualCommand}` };
  }

  await flowExecutionLog.logFlowEvent({
    ...phoneLog,
    eventType: 'router.phone-extracted',
    status: 'running',
    message: 'Telefone extraído e mensagem aceita para roteamento',
    metadata: {
      hasText: !!body.payload?.body,
      hasMedia: !!body.payload?.hasMedia,
      mediaType: body.payload?.media?.mimetype ?? null,
      // Diagnostico audio: estrutura completa do payload pra identificar
      // onde a engine WAHA atual coloca o audio. Volatil — remover apos
      // bug resolvido. Bruno 2026-05-21.
      payloadKeys: body.payload ? Object.keys(body.payload) : [],
      dataMsgKeys: dumpDataMessageKeys(body.payload),
      rootMimeType: (body.payload as Record<string, unknown> | null | undefined)?.mimeType ?? null,
      audioMsgPresent: hasAudioMessageNode(body.payload),
    },
  });

  // 4-pre. Busca rota ANTES do log de antibot / upsert de contato — precondição do GATE ÚNICO
  // DE SILÊNCIO TOTAL abaixo (clone suspenso/vencido não deve gravar NENHUM efeito colateral,
  // "não processa nada" fica literal). Reusa a MESMA variável de rota no resto da função — não
  // chama findRoute de novo mais abaixo.
  const route = await findRoute(telefone, sessao, sessionEntry);

  // GATE ÚNICO DE SILÊNCIO TOTAL (ramo cliente-final) — mesma função pura do ramo fromMe.
  // Flag-gated (GATE_SILENCIO_TOTAL_ENABLED); OFF = sempre null, fluxo segue idêntico e o
  // gate legado do passo 6b (mais abaixo) continua sendo a única barreira, na posição de antes.
  const gateClienteFinalCedo = await checkSilenceGate({
    route,
    source: 'cliente-final',
    phoneLog,
    startedAt,
  });
  if (gateClienteFinalCedo) return gateClienteFinalCedo;

  // 4. Log para antibot
  await antibot.logMessage(telefone, sessao).catch((e) => log.warn(e, 'log msg failed'));

  // 4b. SCRUM-144 — store durável do pushName do CONTATO (só INBOUND; o bloco fromMe acima já
  // retornou, então aqui é sempre mensagem do cliente). Fonte de verdade do nome pra
  // snapshotar na pausa fromMe/human_reply, e independente do store do WAHA (pushName vem no
  // payload). Fire-and-forget FAIL-SAFE: NUNCA quebra o webhook nem bloqueia a resposta do bot
  // (não usa await no caminho de resposta). PII: nunca logamos o nome — só a máscara do fone.
  {
    const inboundPush = body.payload?._data?.pushName ?? '';
    if (inboundPush) {
      void contactNames
        .upsertContactName({ session: sessao, telefone, pushName: inboundPush })
        .catch((e) =>
          log.warn({ fone: phoneLogTag(telefone), err: e }, 'contact-name upsert failed'),
        );
    }
  }

  // Bots com sessão própria têm tabela de pausa legada verificada aqui.
  // Isso preserva o comportamento anterior onde pause_startap bloqueava
  // mensagens recebidas na sessão Startap antes do roteamento.
  if (sessionEntry?.legacyPauseTable) {
    const sessionPaused =
      (await pausa
        .isFlowPaused({ flowId: sessionEntry.workflowId, telefone })
        .catch(() => false)) ||
      (await pausa.isPaused(sessionEntry.legacyPauseTable, telefone).catch(() => false));
    if (sessionPaused) {
      log.info(
        { fone: phoneLogTag(telefone), sessao },
        'Número em pausa de sessão própria, ignorando',
      );
      await flowExecutionLog.logFlowEvent({
        ...phoneLog,
        flowId: sessionEntry.workflowId,
        flowName: sessionEntry.workflowName,
        bot: sessionEntry.bot.name,
        eventType: 'router.session-paused',
        status: 'ignored',
        message: 'Número em pausa de sessão própria, ignorando',
        metadata: { pauseTable: sessionEntry.legacyPauseTable },
        durationMs: Date.now() - startedAt,
      });
      return { status: 'ignored:session-paused' };
    }
  }

  // 6. Rota já resolvida acima (pré-condição do gate). Sem roteamento -> ignora.
  if (!route) {
    log.debug({ fone: phoneLogTag(telefone), sessao }, 'Telefone sem roteamento configurado');
    await flowExecutionLog.logFlowEvent({
      ...phoneLog,
      eventType: 'router.no-routing',
      status: 'ignored',
      message: 'Telefone sem roteamento configurado',
      durationMs: Date.now() - startedAt,
    });
    return { status: 'ignored:no-routing' };
  }

  // 6a. Antibot/pausa por fluxo: gate isolado, não afeta outros bots
  const isFlowPaused = await pausa
    .isFlowPaused({ flowId: route.workflow_id, telefone })
    .catch(() => false);
  if (isFlowPaused) {
    log.info(
      { fone: phoneLogTag(telefone), flowId: route.workflow_id },
      'Número em pausa de fluxo, ignorando',
    );
    await flowExecutionLog.logFlowEvent({
      ...phoneLog,
      flowId: route.workflow_id,
      flowName: route.workflow_name,
      eventType: 'router.blocked',
      status: 'ignored',
      message: 'Número em pausa de fluxo, ignorando',
      metadata: { flowId: route.workflow_id },
      durationMs: Date.now() - startedAt,
    });
    return { status: 'ignored:flow-paused' };
  }

  // 6b. Gate de silêncio do bot por PERFIL DE COBRANÇA (ADR 0016) — LEGADO, mesma DECISÃO do
  // gate único (@startap/core/silence-gate), formato de log próprio preservado.
  // Aplica apenas para clones (slot prefixado com "clone_").
  //
  // CORRIGIDO 31/07 (achado do qa-tester + PM): o eixo (a) usava `flow_enabled === false` PURO,
  // sem olhar `suspended_kind` — silenciava TAMBÉM quando o PRÓPRIO DONO pausou o bot
  // (owner_request), o que é bug (mesmo erro corrigido no gate único, ver silence-gate.ts).
  // Como este bloco é a ÚNICA barreira em prod com GATE_SILENCIO_TOTAL_ENABLED OFF (estado
  // atual), o bug afetava PRODUÇÃO — não era regressão da #539, é comportamento legado desde
  // o ADR 0016. Fix: reusa resolveSilenceGate (fonte única, mesma matriz de 2 eixos
  // independentes) em vez de duplicar o cálculo — só a decisão muda; log/status/eventType
  // deste bloco continuam iguais (suspendedReason/suspendedAt aqui, ausentes no gate único).
  //
  // Eixo (b) atrás da flag BILLING_OVERDUE_SILENCE (env), igual antes. getCloneBySlot já traz
  // next_due_date/amount_cents/suspended_kind via SELECT único (cache TTL 60s) — sem query
  // nova no hot path.
  //
  // CONVIVÊNCIA COM O GATE ÚNICO (checkSilenceGate, mais acima): com
  // GATE_SILENCIO_TOTAL_ENABLED=true este bloco NUNCA é alcançado nesse ramo — o gate único
  // já deu early-return antes do antibot/upsert-de-contato. Com a flag OFF (default), o gate
  // único é sempre no-op e ESTE bloco continua sendo a única barreira, na posição de sempre.
  if (route.workflow_id.startsWith('clone_')) {
    const cloneForGate = await flowClones.getCloneBySlot(route.workflow_id).catch(() => null);

    if (cloneForGate) {
      const overdueSilenceOn = process.env.BILLING_OVERDUE_SILENCE === 'true';
      const gate = resolveSilenceGate(cloneForGate, {
        graceDays: clientBilling.GRACE_DAYS,
        daysUntilDue: (nextDueDate) => clientBilling.daysUntilDue(nextDueDate),
        billingOverdueSilenceOn: overdueSilenceOn,
      });

      if (gate.silenced && gate.reason === 'flow-suspended') {
        log.info(
          {
            fone: phoneLogTag(telefone),
            flowId: route.workflow_id,
            suspendedReason: cloneForGate.suspended_reason,
            suspendedAt: cloneForGate.suspended_at,
          },
          'Fluxo suspenso (manual), ignorando',
        );
        await flowExecutionLog.logFlowEvent({
          ...phoneLog,
          flowId: route.workflow_id,
          flowName: route.workflow_name,
          eventType: 'router.flow-suspended',
          status: 'ignored',
          message: 'Fluxo suspenso, ignorando',
          metadata: {
            flowId: route.workflow_id,
            suspendedReason: cloneForGate.suspended_reason,
            suspendedAt: cloneForGate.suspended_at?.toISOString() ?? null,
          },
          durationMs: Date.now() - startedAt,
        });
        return { status: 'ignored:flow-suspended' };
      }

      if (gate.silenced && gate.reason === 'billing-overdue') {
        log.info(
          {
            fone: phoneLogTag(telefone),
            flowId: route.workflow_id,
            nextDueDate: cloneForGate.next_due_date,
            diasRestantes: gate.diasRestantes,
            graceDays: clientBilling.GRACE_DAYS,
          },
          'Fluxo silenciado por inadimplência (vencido além da carência), ignorando',
        );
        await flowExecutionLog.logFlowEvent({
          ...phoneLog,
          flowId: route.workflow_id,
          flowName: route.workflow_name,
          eventType: 'router.billing-overdue',
          status: 'ignored',
          message: 'Fluxo silenciado por inadimplência, ignorando',
          metadata: {
            flowId: route.workflow_id,
            nextDueDate: cloneForGate.next_due_date,
            diasRestantes: gate.diasRestantes,
            graceDays: clientBilling.GRACE_DAYS,
          },
          durationMs: Date.now() - startedAt,
        });
        return { status: 'ignored:billing-overdue' };
      }
    }
  }

  await flowExecutionLog.logFlowEvent({
    ...phoneLog,
    flowId: route.workflow_id,
    flowName: route.workflow_name,
    eventType: 'router.route-found',
    status: 'running',
    message: 'Rota encontrada',
    metadata: { routeId: route.id, active: route.ativo },
  });

  const entry = findBotByFlowId(route.workflow_id);
  // Clones têm slot prefixado com "clone_" e não estão no registry estático.
  // São resolvidos dinamicamente via flow_clones + factory da matriz.
  const bot: Bot | null =
    entry?.bot ??
    (route.workflow_id.startsWith('clone_') ? await resolveCloneBot(route.workflow_id) : null);

  if (!bot) {
    log.warn(
      { workflowId: route.workflow_id, fone: phoneLogTag(telefone) },
      'Bot não encontrado no registry',
    );
    await flowExecutionLog.logFlowEvent({
      ...phoneLog,
      flowId: route.workflow_id,
      flowName: route.workflow_name,
      eventType: 'router.bot-not-registered',
      status: 'error',
      message: 'Bot não encontrado no registry',
      durationMs: Date.now() - startedAt,
    });
    return { status: 'error:bot-not-registered' };
  }

  // 7. Constrói mensagem normalizada
  const message = await buildIncomingMessage({ body, telefone, sessao, chatId });

  // 8. Marca como lida + processa
  await waha.sendSeen(sessao, chatId).catch(() => {});

  const ctx: BotContext = {
    message,
    executionId: opts.executionId,
    flowId: route.workflow_id,
    flowName: route.workflow_name,
  };
  try {
    await flowExecutionLog.logFlowEvent({
      ...phoneLog,
      flowId: route.workflow_id,
      flowName: route.workflow_name,
      bot: bot.name,
      eventType: 'bot.started',
      status: 'running',
      message: 'Bot iniciou processamento',
    });
    await bot.handle(ctx);
    log.info({ bot: bot.name, fone: phoneLogTag(telefone) }, 'Mensagem processada');
    await flowExecutionLog.logFlowEvent({
      ...phoneLog,
      flowId: route.workflow_id,
      flowName: route.workflow_name,
      bot: bot.name,
      eventType: 'bot.finished',
      status: 'success',
      message: 'Mensagem processada',
      durationMs: Date.now() - startedAt,
    });
    return { status: 'ok' };
  } catch (e) {
    log.error({ err: e, bot: bot.name, fone: phoneLogTag(telefone) }, 'Bot falhou');
    await flowExecutionLog.logFlowEvent({
      ...phoneLog,
      flowId: route.workflow_id,
      flowName: route.workflow_name,
      bot: bot.name,
      eventType: 'bot.failed',
      status: 'error',
      message: 'Bot falhou',
      error: e,
      durationMs: Date.now() - startedAt,
    });
    return { status: 'error:bot-failed' };
  }
}

/**
 * SCRUM-58 — processa um evento `message.ack` do WAHA: atualiza o status de entrega do outbound
 * correspondente (por message_id). FAIL-SAFE por construção — NUNCA lança (o webhook não pode
 * quebrar por causa disso) e é INÓCUO pra acks que não conhecemos:
 *  - payload não-parseável (sem id / sem ack)          → ignored:ack-unparseable
 *  - ack que não é do NOSSO envio (fromMe === false)   → ignored:ack-not-outbound
 *  - mensagem desconhecida OU ack fora de ordem (no-op)→ ignored:ack-unknown
 *  - erro inesperado                                    → ignored:ack-error (logado como warn)
 * LGPD: loga só sessão/slot/status/ack — NUNCA telefone em claro nem conteúdo da mensagem.
 */
async function handleAckEvent(
  body: WahaWebhookBody,
  opts: { executionId: string; startedAt: number },
): Promise<{ status: string }> {
  const baseLog = { executionId: opts.executionId, session: body.session };
  try {
    const parsed = parseWahaAckPayload(body.payload);
    if (!parsed) {
      return { status: 'ignored:ack-unparseable' };
    }
    // Só rastreamos NOSSOS envios (fromMe). Quando o payload traz fromMe=false é ack de mensagem
    // recebida (não é outbound nosso) — ignora. fromMe ausente (null) segue: o match por message_id
    // no applyAck já filtra (devolve null se não for um outbound registrado).
    if (parsed.fromMe === false) {
      return { status: 'ignored:ack-not-outbound' };
    }
    const updated = await outboundMessages.applyAck({
      messageId: parsed.messageId,
      ackCode: parsed.ackCode,
      ackName: parsed.ackName,
    });
    if (!updated) {
      return { status: 'ignored:ack-unknown' };
    }
    log.info(
      { ...baseLog, slot: updated.slot, ackStatus: updated.ack_status, ackCode: updated.ack_code },
      'Ack de entrega de outbound atualizado',
    );
    await flowExecutionLog.logFlowEvent({
      ...baseLog,
      flowId: updated.slot,
      eventType: 'router.ack-updated',
      status: 'success',
      message: 'Ack de entrega de outbound atualizado',
      metadata: {
        ackStatus: updated.ack_status,
        ackCode: updated.ack_code,
        slot: updated.slot,
      },
      durationMs: Date.now() - opts.startedAt,
    });
    return { status: `ok:ack-${updated.ack_status.toLowerCase()}` };
  } catch (e) {
    // Fail-safe: erro no processamento do ack JAMAIS quebra o webhook.
    log.warn({ ...baseLog, err: e }, 'Falha ao processar message.ack (ignorado)');
    return { status: 'ignored:ack-error' };
  }
}

/**
 * Prioridade de roteamento:
 *  1. Sessão própria (bot com ownedSessions, ex: Startap/Lola) → RoutingRow sintética via buildFallbackRoute.
 *  2. Sessão de clone (waha_sessao em flow_clones) → RoutingRow sintética via buildCloneRoute.
 *  3. Router por telefone via routing_clientes (matrizes de teste).
 */
async function findRoute(
  telefone: string,
  sessao: string,
  sessionEntry: BotEntry | null,
): Promise<RoutingRow | null> {
  if (sessionEntry) {
    return buildFallbackRoute(sessionEntry, telefone);
  }

  const clone = await flowClones.getCloneBySession(sessao).catch((e) => {
    log.warn({ err: e, sessao }, 'Erro ao buscar clone por sessao');
    return null;
  });
  if (clone) {
    return buildCloneRoute(clone, telefone);
  }

  return routing.findRouting(telefone);
}

async function buildIncomingMessage(input: {
  body: WahaWebhookBody;
  telefone: string;
  sessao: string;
  chatId: string;
}): Promise<IncomingMessage> {
  const { body, telefone, sessao, chatId } = input;
  const payload = body.payload;
  const pushName = payload?._data?.pushName ?? '';
  const messageId = payload?.id ?? '';
  const timestampRaw = payload?._data?.messageTimestamp;
  const timestamp =
    typeof timestampRaw === 'string'
      ? Number(timestampRaw)
      : (timestampRaw ?? Math.floor(Date.now() / 1000));
  const fromMe = !!payload?.fromMe;

  // Texto ou transcrição de áudio
  let texto = payload?.body ?? '';
  let wasAudio = false;

  // WAHA tem 3 engines (WEBJS, NOWEB, GOWS) e cada uma coloca audio em
  // lugar diferente do payload. Tentamos descobrir mime+url andando por
  // varios caminhos conhecidos. Bug previo (PR #167): so checava
  // payload.media.mimetype, perdia messages com payload em _data.message.*.
  const audioInfo = detectAudio(payload);
  if (audioInfo.isAudio) {
    if (!audioInfo.url) {
      log.warn(
        {
          fone: phoneLogTag(telefone),
          hasMedia: payload?.hasMedia,
          mimetype: audioInfo.mimetype,
          payloadKeys: payload ? Object.keys(payload) : [],
          dataMsgKeys: getDataMessageKeys(payload),
        },
        'Audio detectado mas sem URL para baixar — verificar payload do WAHA',
      );
      texto = '[audio recebido mas sem url para baixar]';
      wasAudio = true;
    } else {
      try {
        const audio = await waha.downloadMedia(audioInfo.url);
        const transcribed = await whisper.transcribe(audio, audioInfo.mimetype ?? 'audio/ogg');
        const cleaned = transcribed.trim();
        if (cleaned.length > 0) {
          texto = cleaned;
          wasAudio = true;
          log.info(
            { fone: phoneLogTag(telefone), len: cleaned.length, source: audioInfo.source },
            'Áudio transcrito',
          );
        } else {
          log.warn(
            { fone: phoneLogTag(telefone), source: audioInfo.source },
            'Whisper devolveu texto vazio para audio',
          );
          texto = '[audio sem fala identificada]';
          wasAudio = true;
        }
      } catch (e) {
        log.error(
          {
            err: e,
            fone: phoneLogTag(telefone),
            source: audioInfo.source,
            url: audioInfo.url.slice(0, 80),
          },
          'Falha ao transcrever áudio',
        );
        texto = '[áudio não transcrito]';
        wasAudio = true;
      }
    }
  } else if (payload?.hasMedia) {
    // hasMedia=true mas nao detectamos audio — pode ser imagem/video (ok)
    // ou audio em campo novo que ainda nao conhecemos. Loga estrutura.
    log.info(
      {
        fone: phoneLogTag(telefone),
        mediaMime: payload?.media?.mimetype,
        dataMsgKeys: getDataMessageKeys(payload),
        payloadKeys: payload ? Object.keys(payload) : [],
      },
      'hasMedia=true mas nao classificado como audio',
    );
  }

  return {
    sessao,
    telefone,
    chatId,
    pushName,
    texto,
    fromMe,
    messageId,
    timestamp,
    wasAudio,
    raw: body,
  };
}

// --- Detecção de audio em payloads WAHA (multi-engine) ----------------------

interface AudioInfo {
  isAudio: boolean;
  mimetype?: string;
  url?: string;
  /** Caminho do payload onde foi encontrado (para log/debug). */
  source?: string;
}

/**
 * Anda pelos caminhos conhecidos onde WAHA coloca info de audio, dependendo da
 * engine (WEBJS/NOWEB/GOWS) e versao. Retorna a primeira combinacao valida de
 * mimetype audio/* + URL para download.
 */
function detectAudio(payload: unknown): AudioInfo {
  if (!payload || typeof payload !== 'object') return { isAudio: false };
  const p = payload as Record<string, unknown>;

  // Candidatos: objetos do payload que podem conter audio.
  const _data = (p._data ?? {}) as Record<string, unknown>;
  const _msg = (_data.message ?? {}) as Record<string, unknown>;

  type Cand = { node: Record<string, unknown> | undefined; source: string };
  const cands: Cand[] = [
    { node: p.media as Record<string, unknown> | undefined, source: 'payload.media' },
    {
      node: _msg.audioMessage as Record<string, unknown> | undefined,
      source: '_data.message.audioMessage',
    },
    {
      node: _msg.pttMessage as Record<string, unknown> | undefined,
      source: '_data.message.pttMessage',
    },
    // Algumas versoes serializam direto na raiz do payload
    { node: p, source: 'payload (raiz)' },
  ];

  for (const c of cands) {
    if (!c.node || typeof c.node !== 'object') continue;
    const node = c.node;
    const mime = pickString(node.mimetype) ?? pickString(node.mime) ?? pickString(node.mimeType);
    if (!mime || !mime.startsWith('audio/')) continue;
    const url =
      pickString(node.url) ??
      pickString(node.fileUrl) ??
      pickString(node.directPath) ??
      pickString(node.mediaUrl) ??
      pickString((p.media as Record<string, unknown> | undefined)?.url) ??
      '';
    return { isAudio: true, mimetype: mime, url, source: c.source };
  }

  // Sinal indireto: pttMessage / audioMessage existe (mesmo sem mimetype legivel).
  if (_msg.audioMessage || _msg.pttMessage) {
    const node = (_msg.audioMessage ?? _msg.pttMessage) as Record<string, unknown>;
    const url = pickString(node.url) ?? pickString(node.mediaUrl) ?? '';
    return {
      isAudio: true,
      mimetype: pickString(node.mimetype) ?? 'audio/ogg',
      url,
      source: _msg.audioMessage
        ? '_data.message.audioMessage (sem mime)'
        : '_data.message.pttMessage (sem mime)',
    };
  }

  return { isAudio: false };
}

function pickString(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

/**
 * Diagnostico audio (volatil — remover quando bug resolvido): dump das
 * chaves de payload._data.message com tipos basicos. Util para identificar
 * em que engine do WAHA estamos e onde audio esta no payload.
 */
function dumpDataMessageKeys(payload: unknown): Record<string, string> {
  if (!payload || typeof payload !== 'object') return {};
  const _data = (payload as Record<string, unknown>)._data;
  if (!_data || typeof _data !== 'object') return {};
  const msg = (_data as Record<string, unknown>).message;
  if (!msg || typeof msg !== 'object') return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(msg as Record<string, unknown>)) {
    if (v === null) out[k] = 'null';
    else if (typeof v === 'object') {
      const subKeys = Object.keys(v as Record<string, unknown>).slice(0, 8);
      out[k] = `object{${subKeys.join(',')}}`;
    } else out[k] = typeof v;
  }
  return out;
}

function hasAudioMessageNode(payload: unknown): boolean {
  if (!payload || typeof payload !== 'object') return false;
  const _data = (payload as Record<string, unknown>)._data;
  if (!_data || typeof _data !== 'object') return false;
  const msg = (_data as Record<string, unknown>).message;
  if (!msg || typeof msg !== 'object') return false;
  const m = msg as Record<string, unknown>;
  return !!(m.audioMessage || m.pttMessage);
}

/** Lista chaves de payload._data.message — util para diagnostico. */
function getDataMessageKeys(payload: unknown): string[] {
  if (!payload || typeof payload !== 'object') return [];
  const _data = (payload as Record<string, unknown>)._data;
  if (!_data || typeof _data !== 'object') return [];
  const msg = (_data as Record<string, unknown>).message;
  if (!msg || typeof msg !== 'object') return [];
  return Object.keys(msg);
}
