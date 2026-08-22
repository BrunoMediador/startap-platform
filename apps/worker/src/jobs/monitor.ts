/**
 * Job monitor — Sistema de Alertas Interno (Missão 021, Fase 1).
 *
 * Spec: docs/missoes/021-sistema-alertas-interno.md.
 *
 * Varre, a cada 2 min (atrás da flag ALERTS_ENABLED + do toggle quente
 * alert_config.enabled), os checks da Fase 1:
 *   - waha:<sessao>  — 1 por cliente real conectado + a Lola (1 GET /api/sessions);
 *   - api:health     — /health do startap-api (HTTP 200 E db/redis saudáveis: 'up'/'ok');
 *   - pg:main        — SELECT 1 direto (redundância barata do worker).
 * host:disk (fast-follow SCRUM-134, atrás de alert_config.check_host — default FALSE): o worker
 * NÃO mede disco (containerizado, enxergaria cgroup/overlay, não o host físico — spec §1). Quem
 * mede é `/opt/automacoes/disco-alerta.sh` (cron 6/6h no HOST); o worker só LÊ o fato gravado em
 * alert_states.host_reported_pct via observeHostDisk() e aplica a MESMA máquina de estado abaixo.
 * RAM segue fase 2 (não coberta por este card).
 *
 * Para cada check aplica a máquina de estado anti-spam (spec §4):
 *   up→down   => alerta DOWN, grava down_since/last_alert_at, alert_count=1;
 *   down→down => silêncio (a queda já foi alertada neste episódio);
 *   down→up   => alerta RECUPERADO, limpa down_since/last_alert_at;
 *   up→up     => silêncio.
 *   Debounce (api:health E waha:<sessao>): exige 2 observações down seguidas
 *   (~4 min de carência) pra transicionar up→down. Mata o falso CAIU/RECUPERADO
 *   de flap transitório do Baileys (reconecta sozinho em segundos). pg:main NÃO
 *   debouncia (limiar 1) — SELECT 1 falhar é sinal forte. Limiar por observação
 *   (CheckObservation.debounceThreshold; 1 = sem debounce).
 *
 * Hard cap global (spec §4): teto de N msgs/janela somando todos os checks
 * (ALERTS_MAX_PER_WINDOW / ALERTS_WINDOW_MIN). Protege o número da Lola.
 *
 * Entrega via Lola (sendText, sessão resolvida de bot_config.waha_sessao do
 * sender_slot — spec §3): typing:false, sem mídia, texto curto. Se a Lola estiver
 * caída ou sendText lançar, LOGA erro alto e segue — NÃO derruba o job, NÃO
 * re-tenta em loop (próximo ciclo cobre). Degradação graciosa.
 *
 * IDEMPOTENTE / retry-friendly: o estado vive no Postgres (alert_states); rodar de
 * novo o mesmo ciclo não duplica alerta (a decisão de enviar deriva da transição
 * persistida). Com ALERTS_ENABLED OFF o cron nem registra; com o toggle de banco
 * OFF o job é NO-OP barato (não chama WAHA, não lê destinatários).
 *
 * ISOLAMENTO: o monitor NUNCA envia pela sessão de um cliente (só pela Lola); um
 * cliente caído nunca derruba o job dos outros. Sem `slot` de tenant — config é
 * global do time.
 */
import { logger } from '@startap/core/logger';
import { alerts } from '@startap/db';
import { pool } from '@startap/db';
import { waha } from '@startap/integrations';
import { config } from '../config.js';
import { notifyClientDisconnect } from './client-disconnect-notify.js';
import { isDefinitiveNonDelivery, sendWithSettleTimeout } from './waha-send-failure.js';

const log = logger.child({ job: 'monitor' });

/** check_key do health da API. */
const HEALTH_KEY = 'api:health';
/** check_key do Postgres direto. */
const PG_KEY = 'pg:main';
/** check_key do disco do HOST (SCRUM-134). */
const HOST_DISK_KEY = alerts.HOST_DISK_STATE_KEY;
/** Limiar de debounce do api:health: 2 observações down seguidas pra transicionar. */
const HEALTH_DEBOUNCE = 2;
/** Limiar de debounce do waha:<sessao>: 2 polls down seguidos (~4 min) pra
 *  transicionar — absorve flap transitório do Baileys (reconecta sozinho). */
const WAHA_DEBOUNCE = 2;
/** Limiar de checks sem debounce (transiciona já na 1ª observação down). */
const NO_DEBOUNCE = 1;
/** Timeout do GET /health (a API e o PG estão na rede interna; deve responder rápido). */
const HEALTH_TIMEOUT_MS = 5_000;
const PG_TIMEOUT_MS = 3_000;
const WAHA_LIST_TIMEOUT_MS = 8_000;
/** Timeout do envio — sendText não tem timeout próprio (client.ts). Embrulha o
 *  sendText INTEIRO, incluindo o delay humanizador (cabe com folga: 1.5s << 10s). */
const SEND_TIMEOUT_MS = 10_000;
/** Janela de graça pós-deadline (SCRUM-126): quando o deadline bate sem resposta, espera MAIS um
 *  pouco pra uma resposta de ERRO do WAHA que pousa colada no deadline (o 422 que chegava ~20ms
 *  tarde e virava "timeout" ambíguo, mascarando não-entrega DEFINITIVA — incidente Cirilo). Curta e
 *  limitada: só captura o erro tardio; rede genuinamente muda nunca assenta e segue ambígua.
 *  1s (SCRUM-140, era 3s): ainda ~50x a latência observada do 422 (~20ms), e reduz o pior caso de
 *  soma de graça sob queda TOTAL do WAHA (todo broadcast × destinatário bate a graça) — evita que o
 *  ciclo do monitor estoure o limiar de liveness do heartbeat (~3min) e dispare falso alarme. */
const SEND_ERROR_GRACE_MS = 1_000;

/** Humanização do envio de alerta — reduz risco de derrubar a sessão remetente
 *  (ALERTAS) por padrão de bot. "Digitando…" + delay antes de cada mensagem, e
 *  pausa ENTRE destinatários (e entre broadcasts do mesmo ciclo) em vez de rajada
 *  colada. SEQUENCIAL sempre (nunca Promise.all — paralelizar estressa a sessão). */
const ALERT_TYPING_DELAY_MS = 1_500;
const ALERT_BETWEEN_RECIPIENTS_MS = 1_200;
/** Pausa entre dois broadcasts que SAÍRAM no mesmo ciclo (ex.: WAHA + PG caem
 *  juntos → várias mensagens). Espaça pra não despejar tudo colado. */
const ALERT_BETWEEN_BROADCASTS_MS = 1_500;

/** Pausa não-bloqueante (humanização do envio). */
function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export interface MonitorResult extends Record<string, unknown> {
  /** true quando a flag de env ou o toggle de banco estavam OFF (NO-OP). */
  skipped: boolean;
  /** quantos checks foram avaliados neste ciclo. */
  checked: number;
  /** quantos checks estão DOWN no fim do ciclo. */
  down: number;
  /** mensagens efetivamente enviadas (DOWN + RECUPERADO). */
  sent: number;
  /** mensagens suprimidas pelo hard cap global. */
  suppressed: number;
  /** falhas de envio (Lola caída etc.) — não derrubam o job. */
  sendErrors: number;
  /** auto-avisos de desconexão ENVIADOS ao dono do clone (CLIENT_DISCONNECT_ALERT_ENABLED). */
  clientNotified: number;
}

const EMPTY_RESULT: MonitorResult = {
  skipped: false,
  checked: 0,
  down: 0,
  sent: 0,
  suppressed: 0,
  sendErrors: 0,
  clientNotified: 0,
};

/** Observação de um check num ciclo. */
interface CheckObservation {
  /** chave estável do estado. */
  key: string;
  /** rótulo amigável pra mensagem (ex.: "Barbearia do Cirilo"). */
  label: string;
  /** estado observado AGORA. */
  obs: 'up' | 'down';
  /** detalhe curto pra mensagem DOWN (ex.: "status FAILED", "HTTP 503"). */
  detail: string;
  /** quantas observações `down` seguidas exige pra transicionar up→down.
   *  1 = sem debounce (pg:main); 2 = debounce de ~4 min (api:health, waha). */
  debounceThreshold: number;
  /**
   * slot do CLONE dono deste check (só checks waha:<sessao> de cliente). null pra checks de
   * infra (api:health, pg:main) e pra sessão remetente ALERTAS — esses NUNCA disparam aviso ao
   * "dono". Usado pra avisar o cliente quando a sessão DELE cai (up→down).
   */
  slot: string | null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Coletores de observação (cada um NUNCA lança — falha de leitura = DOWN observado)
// ─────────────────────────────────────────────────────────────────────────────

/** GET /api/sessions uma vez e cruza com as sessões a monitorar. */
async function observeWaha(senderSlot: string): Promise<CheckObservation[]> {
  const statusByName = new Map<string, string>();
  let listFailed = false;
  try {
    const url = `${config.WAHA_URL}/api/sessions`;
    const res = await fetch(url, {
      headers: config.WAHA_API_KEY ? { 'X-Api-Key': config.WAHA_API_KEY } : {},
      signal: AbortSignal.timeout(WAHA_LIST_TIMEOUT_MS),
    });
    if (!res.ok) {
      listFailed = true;
    } else {
      const list = (await res.json()) as Array<{ name?: unknown; status?: unknown }>;
      for (const s of Array.isArray(list) ? list : []) {
        if (typeof s.name === 'string') {
          statusByName.set(s.name, typeof s.status === 'string' ? s.status : 'UNKNOWN');
        }
      }
    }
  } catch {
    listFailed = true;
  }

  const monitored = await alerts.listMonitoredSessions(senderSlot);
  return monitored.map((m) => {
    if (listFailed) {
      // WAHA inacessível: não dá pra afirmar que UMA sessão caiu — mas o WAHA todo
      // está down. Reporta cada sessão como down com detalhe claro (o operador vê
      // o padrão "tudo waha:* caiu junto" = WAHA fora, não cliente individual).
      return {
        key: `waha:${m.sessao}`,
        label: m.label,
        obs: 'down' as const,
        detail: 'WAHA inacessível (GET /api/sessions falhou)',
        debounceThreshold: WAHA_DEBOUNCE,
        slot: m.slot,
      };
    }
    const status = statusByName.get(m.sessao);
    const up = status === 'WORKING';
    return {
      key: `waha:${m.sessao}`,
      label: m.label,
      obs: up ? ('up' as const) : ('down' as const),
      detail: status ? `status ${status}` : 'sessão ausente na lista (404)',
      debounceThreshold: WAHA_DEBOUNCE,
      slot: m.slot,
    };
  });
}

/**
 * Componente do /health está saudável? Aceita 'up' (SCRUM-131) e 'ok' (legado)
 * como saudável; qualquer outra coisa ('down'/'degraded'/ausente) = falha.
 * Tolerar os dois vocabulários evita falso alarme na janela de rolling deploy.
 */
function healthComponentUp(v: unknown): boolean {
  return v === 'up' || v === 'ok';
}

/** GET /health: DOWN se HTTP != 200 OU db/redis reportam falha (down/degraded/ausente). */
async function observeHealth(): Promise<CheckObservation> {
  try {
    const res = await fetch(config.ALERTS_API_HEALTH_URL, {
      signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS),
    });
    if (res.status !== 200) {
      return {
        key: HEALTH_KEY,
        label: 'API (startap-api)',
        obs: 'down',
        detail: `HTTP ${res.status}`,
        debounceThreshold: HEALTH_DEBOUNCE,
        slot: null,
      };
    }
    const body = (await res.json()) as { checks?: { db?: unknown; redis?: unknown } };
    const db = body.checks?.db;
    const redis = body.checks?.redis;
    if (!healthComponentUp(db) || !healthComponentUp(redis)) {
      return {
        key: HEALTH_KEY,
        label: 'API (startap-api)',
        obs: 'down',
        detail: `checks db=${String(db)} redis=${String(redis)}`,
        debounceThreshold: HEALTH_DEBOUNCE,
        slot: null,
      };
    }
    return {
      key: HEALTH_KEY,
      label: 'API (startap-api)',
      obs: 'up',
      detail: 'ok',
      debounceThreshold: HEALTH_DEBOUNCE,
      slot: null,
    };
  } catch (e) {
    return {
      key: HEALTH_KEY,
      label: 'API (startap-api)',
      obs: 'down',
      detail: e instanceof Error && e.name === 'TimeoutError' ? 'timeout' : 'inacessível',
      debounceThreshold: HEALTH_DEBOUNCE,
      slot: null,
    };
  }
}

/** SELECT 1 direto no pool — redundância barata do worker (spec §1). */
async function observePg(): Promise<CheckObservation> {
  try {
    const client = await Promise.race([
      pool.connect(),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('pg connect timeout')), PG_TIMEOUT_MS),
      ),
    ]);
    try {
      await client.query('SELECT 1');
      return {
        key: PG_KEY,
        label: 'Postgres',
        obs: 'up',
        detail: 'ok',
        debounceThreshold: NO_DEBOUNCE,
        slot: null,
      };
    } finally {
      client.release();
    }
  } catch {
    return {
      key: PG_KEY,
      label: 'Postgres',
      obs: 'down',
      detail: 'SELECT 1 falhou/timeout',
      debounceThreshold: NO_DEBOUNCE,
      slot: null,
    };
  }
}

/**
 * Disco do HOST (SCRUM-134): o worker NÃO mede — LÊ o fato bruto que o script
 * `/opt/automacoes/disco-alerta.sh` (cron 6/6h no HOST) grava em
 * alert_states.host_reported_pct/host_reported_at (migration 078). Isolamento
 * deliberado: medir aqui via node:fs/os enxergaria o cgroup/overlay do
 * CONTAINER, não o disco físico do host (spec 021 §1) — dado errado seria pior
 * que dado nenhum. `debounceThreshold=1`: um script que já roda a cada 6h e só
 * grava um fato (sem flap) não precisa de carência extra — se reportou ≥limiar,
 * é real. Nunca lança: fato ausente ou frio vira 'up' silencioso (loga warning),
 * não fabrica alerta DOWN a partir de silêncio de coleta (causa diferente de
 * disco cheio — não confundir na mensagem ao Bruno).
 */
async function observeHostDisk(alertPct: number, staleHours: number): Promise<CheckObservation> {
  const base = {
    key: HOST_DISK_KEY,
    label: 'Disco do host (VPS)',
    debounceThreshold: NO_DEBOUNCE,
    slot: null,
  };
  try {
    const report = await alerts.getHostDiskReport();
    if (report.pct === null || report.reportedAt === null) {
      log.warn(
        { checkKey: HOST_DISK_KEY },
        'monitor: host:disk sem coleta ainda (script não rodou)',
      );
      return { ...base, obs: 'up', detail: 'sem coleta ainda' };
    }
    const ageHours = (Date.now() - report.reportedAt.getTime()) / 3_600_000;
    if (ageHours > staleHours) {
      // Dado FRIO (script travou/cron caiu) — visibilidade via log, sem fabricar alerta de disco.
      log.warn(
        { checkKey: HOST_DISK_KEY, ageHours: Math.round(ageHours), pct: report.pct },
        'monitor: host:disk com coleta ANTIGA (script pode ter parado de rodar)',
      );
      return { ...base, obs: 'up', detail: `coleta com ${Math.round(ageHours)}h (frio)` };
    }
    const up = report.pct < alertPct;
    return {
      ...base,
      obs: up ? 'up' : 'down',
      detail: up ? `${report.pct}% (< ${alertPct}%)` : `${report.pct}% (>= ${alertPct}%)`,
    };
  } catch (e) {
    // Falha de leitura no Postgres (mesmo pool que observePg já testa) — trata como sem
    // dado, não como disco cheio.
    log.warn(
      { checkKey: HOST_DISK_KEY, err: e instanceof Error ? e.message : String(e) },
      'monitor: falha ao ler host:disk — tratado como sem coleta',
    );
    return { ...base, obs: 'up', detail: 'falha ao ler estado' };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Envio via Lola (degradação graciosa)
// ─────────────────────────────────────────────────────────────────────────────

/** Normaliza E.164 (só dígitos) -> chatId WhatsApp '<digits>@c.us'. */
function toChatId(phone: string): string {
  return `${phone.replace(/\D/g, '')}@c.us`;
}

/**
 * Resultado de um disparo:
 *  - `delivered`         = ao menos 1 destinatário recebeu;
 *  - `noop`              = nada a fazer OU suprimido pelo hard cap (decisão deliberada, não é falha);
 *  - `failed-definitive` = tentou e NENHUM recebeu, e TODA falha é definitiva (sessão FAILED/404/
 *                          conexão recusada) — temos certeza de que não saiu;
 *  - `failed-ambiguous`  = tentou e nenhum recebeu, mas ao menos uma falha é AMBÍGUA (timeout/5xx/
 *                          desconhecido) — pode ter entregue.
 *  - `suppressed-channel-unavailable` = o remetente já estava indisponível na observação do ciclo;
 *                          a ocorrência fica terminalmente suprimida, sem retry após reconexão.
 * SÓ `failed-definitive` dispara a compensação do carimbo (SCRUM-53 + P2 do security). `noop` e
 * `failed-ambiguous` e `suppressed-channel-unavailable` MANTÊM o carimbo.
 */
export type SendOutcome =
  | 'delivered'
  | 'noop'
  | 'failed-definitive'
  | 'failed-ambiguous'
  | 'suppressed-channel-unavailable';

/**
 * Envia `texto` a todos os destinatários habilitados pela Lola. Consome 1 unidade
 * do hard cap global por DISPARO (não por destinatário — 1 evento = 1 reserva).
 * Retorna o desfecho (ver SendOutcome). Como todos os destinatários usam a MESMA sessão
 * remetente, a natureza da falha é uniforme na prática (sessão FAILED = 422 pra todos).
 */
async function broadcast(
  sessao: string,
  texto: string,
  recipients: alerts.AlertRecipientRow[],
  result: MonitorResult,
): Promise<SendOutcome> {
  if (recipients.length === 0) return 'noop';

  const reservation = await alerts.reserveGlobalSend({
    maxPerWindow: config.ALERTS_MAX_PER_WINDOW,
    windowMin: config.ALERTS_WINDOW_MIN,
  });
  if (!reservation.allowed) {
    result.suppressed += 1;
    log.warn(
      { sentInWindow: reservation.sentInWindow, max: config.ALERTS_MAX_PER_WINDOW },
      'monitor: hard cap global atingido — mensagem suprimida (anti-flood)',
    );
    return 'noop';
  }

  // Espaça broadcasts que saem no MESMO ciclo (ex.: WAHA + PG caem juntos): se já
  // houve um envio bem-sucedido neste run, pausa antes de despejar o próximo.
  if (result.sent > 0) await sleep(ALERT_BETWEEN_BROADCASTS_MS);

  let anyOk = false;
  let sawAmbiguous = false; // alguma falha "possivelmente entregue" (timeout/5xx/desconhecido)?
  // SEQUENCIAL e espaçado (anti-rajada — nunca Promise.all): "digitando…" + delay
  // humanizador antes de cada envio; pausa ENTRE destinatários.
  for (let i = 0; i < recipients.length; i++) {
    const r = recipients[i];
    try {
      // Deadline COM classificação por status (SCRUM-126): se o WAHA responder um erro DEFINITIVO
      // (422) colado no deadline, o helper deixa ESSE erro subir pra taxonomia (rollback do carimbo
      // + reenvia) em vez de o timeout cortar antes e rotular como ambíguo. Só resposta-nenhuma
      // (rede caiu) vira "sendText timeout" (ambíguo → mantém o carimbo → não duplica).
      await sendWithSettleTimeout(
        () =>
          waha.sendText({
            sessao,
            chatId: toChatId(r.phone),
            texto,
            typing: true,
            delayMs: ALERT_TYPING_DELAY_MS,
          }),
        { deadlineMs: SEND_TIMEOUT_MS, settleGraceMs: SEND_ERROR_GRACE_MS },
      );
      anyOk = true;
    } catch (e) {
      result.sendErrors += 1;
      if (!isDefinitiveNonDelivery(e)) sawAmbiguous = true;
      // NÃO loga o número (LGPD) — só o id do destinatário e o erro.
      log.error(
        { recipientId: r.id, err: e instanceof Error ? e.message : String(e) },
        'monitor: falha ao enviar alerta pela Lola (próximo ciclo re-tenta)',
      );
    }
    // Pausa antes do próximo destinatário (não depois do último).
    if (i < recipients.length - 1) await sleep(ALERT_BETWEEN_RECIPIENTS_MS);
  }
  if (anyOk) {
    result.sent += 1;
    return 'delivered';
  }
  // Nenhum recebeu: só compensa o carimbo se TODA falha foi definitiva (certeza de não-entrega).
  return sawAmbiguous ? 'failed-ambiguous' : 'failed-definitive';
}

// ─────────────────────────────────────────────────────────────────────────────
// Máquina de estado por check
// ─────────────────────────────────────────────────────────────────────────────

function minutesSince(d: Date | null): number {
  if (!d) return 0;
  return Math.round((Date.now() - d.getTime()) / 60_000);
}

/**
 * Aplica a transição de UM check e (talvez) enfileira uma mensagem. Toda a
 * persistência de estado acontece aqui (upsertState); o envio é delegado ao
 * `send` callback (que aplica o hard cap). Retorna se ficou DOWN no fim e se ESTE
 * ciclo foi a transição up→down CONFIRMADA (`justWentDown`) — gatilho EXATO (1 vez
 * por episódio) do auto-aviso ao dono do clone. Checks que seguem down ficam em silêncio.
 */
async function applyTransition(
  obsItem: CheckObservation,
  prev: alerts.AlertStateRow | null,
  send: (texto: string) => Promise<SendOutcome>,
): Promise<{ isDown: boolean; justWentDown: boolean }> {
  const prevState: alerts.AlertState = prev?.state ?? 'up';
  const prevPending = prev?.pending_down_count ?? 0;

  /**
   * Compensação SCRUM-53: desfaz o carimbo de alerta (que foi gravado ANTES do envio, como lock
   * otimista contra ciclos concorrentes) quando o envio FALHOU — restaurando o snapshot anterior
   * pra o próximo ciclo re-tentar. CONDICIONAL ao valor que ESTE ciclo gravou (state='down' +
   * expectCount + stampedAt): se outro ciclo já regravou, NÃO pisa (preserva o anti-duplicata).
   */
  const rollbackStamp = async (stampedAt: Date, expectCount: number): Promise<void> => {
    // Best-effort e simétrico ao releaseCooldown do client-disconnect: engole o próprio erro. Se o
    // restore falhar (DB blip), o pior caso é 1 alerta suprimido até o cooldown — NÃO deixa o erro
    // subir pro try/catch por-check do runMonitor (que contaria sendErrors+1 espúrio).
    try {
      await alerts.restoreStateIfUnchanged({
        checkKey: obsItem.key,
        expect: { state: 'down', lastAlertAt: stampedAt, alertCount: expectCount },
        restore: {
          state: prevState,
          downSince: prev?.down_since ?? null,
          lastAlertAt: prev?.last_alert_at ?? null,
          alertCount: prev?.alert_count ?? 0,
          // Preserva o pending anterior: um check debounçado re-confirma a queda no ciclo seguinte.
          pendingDownCount: prev?.pending_down_count ?? 0,
        },
      });
    } catch (e) {
      log.warn(
        { checkKey: obsItem.key, err: e instanceof Error ? e.message : String(e) },
        'monitor: falha ao desfazer carimbo de alerta (rollback) — ciclo segue',
      );
    }
  };

  if (obsItem.obs === 'up') {
    if (prevState === 'down') {
      // down → up: RECUPERADO. Episódio cujo remetente estava indisponível fica
      // com alert_count=0/last_alert_at=NULL; ele é auditável no log de supressão,
      // mas não gera uma recuperação tardia ao ALERTAS voltar.
      const wasSuppressedForUnavailableChannel =
        (prev?.alert_count ?? 0) === 0 && prev?.last_alert_at === null;
      const mins = minutesSince(prev?.down_since ?? null);
      await alerts.upsertState({
        checkKey: obsItem.key,
        state: 'up',
        downSince: null,
        lastAlertAt: null,
        alertCount: 0,
        pendingDownCount: 0,
      });
      if (wasSuppressedForUnavailableChannel) {
        return { isDown: false, justWentDown: false };
      }
      await send(`🟢 RECUPERADO: ${obsItem.label} voltou após ${mins} min.`);
      return { isDown: false, justWentDown: false };
    }
    // up → up: silêncio. Zera qualquer debounce pendente.
    if (prevPending !== 0 || !prev) {
      await alerts.upsertState({
        checkKey: obsItem.key,
        state: 'up',
        downSince: null,
        lastAlertAt: null,
        alertCount: prev?.alert_count ?? 0,
        pendingDownCount: 0,
      });
    }
    return { isDown: false, justWentDown: false };
  }

  // obs === 'down'
  if (prevState === 'up') {
    // Debounce por observação: precisa de `debounceThreshold` downs seguidos pra
    // transicionar (api:health=2, waha=2, pg=1). Limiar 1 já transiciona na 1ª.
    if (obsItem.debounceThreshold > 1) {
      const pending = prevPending + 1;
      if (pending < obsItem.debounceThreshold) {
        // Ainda em observação — não alerta, só acumula (estado segue 'up').
        await alerts.upsertState({
          checkKey: obsItem.key,
          state: 'up',
          downSince: null,
          lastAlertAt: null,
          alertCount: prev?.alert_count ?? 0,
          pendingDownCount: pending,
        });
        return { isDown: false, justWentDown: false };
      }
    }
    // up → down (confirmado): alerta DOWN. Carimba ANTES do envio (lock otimista contra ciclo
    // concorrente); se o envio falhar, desfaz o carimbo (SCRUM-53) pra re-tentar no próximo ciclo.
    const stampedAt = new Date();
    await alerts.upsertState({
      checkKey: obsItem.key,
      state: 'down',
      downSince: stampedAt,
      lastAlertAt: stampedAt,
      alertCount: 1,
      pendingDownCount: 0,
    });
    const outcome = await send(`🔴 CAIU: ${obsItem.label} — ${obsItem.detail}.`);
    if (outcome === 'failed-definitive') {
      // Certeza de não-entrega (sessão FAILED/404/conexão recusada): desfaz o carimbo (SCRUM-53) e
      // NÃO marca a transição como avisada — o aviso ao dono sairia pela mesma sessão morta e também
      // falharia. O ciclo seguinte re-tenta. Falha AMBÍGUA (timeout/5xx) NÃO reverte (P2 do security):
      // mantém o carimbo (pode ter entregue) e segue como transição avisada.
      await rollbackStamp(stampedAt, 1);
      return { isDown: true, justWentDown: false };
    }
    if (outcome === 'suppressed-channel-unavailable') {
      // Registra que a queda foi OBSERVADA, mas não entregue: `down` preserva a
      // telemetria, enquanto count=0/last_alert_at=NULL distingue este episódio de
      // um alerta enviado e impede uma recuperação histórica após a reconexão.
      await alerts.upsertState({
        checkKey: obsItem.key,
        state: 'down',
        downSince: stampedAt,
        lastAlertAt: null,
        alertCount: 0,
        pendingDownCount: 0,
      });
      log.warn(
        { checkKey: obsItem.key, alertDisposition: 'suppressed_channel_unavailable' },
        'monitor: alerta suprimido porque o remetente estava indisponível neste episódio',
      );
      return { isDown: true, justWentDown: false };
    }
    // Transição CONFIRMADA up→down (entregue OU ambígua = possivelmente avisada): instante do aviso
    // ao dono do clone (o notify tem cooldown+taxonomia próprios que evitam duplicar).
    return { isDown: true, justWentDown: true };
  }

  // down → down: a mensagem de queda já saiu neste episódio. O monitor continua
  // observando a sessão e preserva o estado para emitir RECUPERADO, mas não reenvia.
  return { isDown: true, justWentDown: false };
}

// ─────────────────────────────────────────────────────────────────────────────
// Ciclo principal
// ─────────────────────────────────────────────────────────────────────────────

export async function runMonitor(): Promise<MonitorResult> {
  const result: MonitorResult = { ...EMPTY_RESULT };

  // Camada 2 do rollout (kill-switch quente): lê o toggle de banco. OFF => NO-OP
  // barato — não chama WAHA, não lê destinatários, não toca estado. Ainda assim loga o tick
  // (heartbeat de liveness, SCRUM-54): "desligado" nunca fica indistinguível de "travado".
  const cfg = await alerts.getConfig();
  if (!cfg.enabled) {
    log.info({ skipped: true }, 'monitor cycle (skipped: toggle off)');
    return { ...result, skipped: true };
  }

  const recipients = await alerts.listEnabledRecipients();
  const senderSession = await alerts.getSenderSession(cfg.sender_slot);

  // Coleta as observações dos checks habilitados (cada coletor é fail-safe).
  const observations: CheckObservation[] = [];
  if (cfg.check_waha) observations.push(...(await observeWaha(cfg.sender_slot)));
  if (cfg.check_health) observations.push(await observeHealth());
  observations.push(await observePg()); // PG é redundância barata — sempre observa.
  // check_host (SCRUM-134): default FALSE desde a migration 046 — decisão do Bruno ligar
  // (UPDATE alert_config SET check_host=true), sem deploy.
  if (cfg.check_host) {
    observations.push(
      await observeHostDisk(config.HOST_DISK_ALERT_PCT, config.HOST_DISK_STALE_HOURS),
    );
  }

  // Uma queda observada do próprio remetente significa que não há canal para entregar
  // este ciclo. Carimbamos o episódio como DOWN, mas o suprimimos terminalmente: reconectar
  // ALERTAS não pode drenar alertas históricos em rajada. Se o check WAHA estiver desligado,
  // só o remetente ausente é conhecido como indisponível; não inferimos estado da rede.
  const senderUnavailable =
    !senderSession ||
    observations.some(
      (obsItem) => obsItem.key === `waha:${senderSession}` && obsItem.obs === 'down',
    );

  result.checked = observations.length;

  // Estados persistidos (1 query, vira Map por chave).
  const states = await alerts.listStates();
  const stateByKey = new Map(states.map((s) => [s.check_key, s]));

  for (const obsItem of observations) {
    try {
      const send = async (texto: string): Promise<SendOutcome> => {
        if (!senderSession || senderUnavailable) {
          return 'suppressed-channel-unavailable';
        }
        // Sem backlog: só uma transição observada com remetente disponível chega ao transporte.
        return broadcast(senderSession, texto, recipients, result);
      };
      const { isDown, justWentDown } = await applyTransition(
        obsItem,
        stateByKey.get(obsItem.key) ?? null,
        send,
      );
      if (isDown) result.down += 1;

      // Auto-aviso de DESCONEXÃO ao DONO do clone (B2B) — ADICIONAL ao alerta interno acima
      // (que NÃO é tocado). Dispara EXATAMENTE na transição up→down confirmada (justWentDown =
      // 1 vez por episódio) e SÓ pra checks de CLONE (obsItem.slot != null — infra/remetente
      // ficam de fora). Gate macro: CLIENT_DISCONNECT_ALERT_ENABLED. Opt-in por-clone, cooldown
      // anti-flap e fail-safe vivem dentro de notifyClientDisconnect. Fire-and-forget: NUNCA
      // derruba o monitor (já tem try/catch interno + este catch externo de rede).
      if (justWentDown && obsItem.slot && config.CLIENT_DISCONNECT_ALERT_ENABLED) {
        const r = await notifyClientDisconnect(obsItem.slot);
        if (r.ok && r.sent) result.clientNotified += 1;
      }
    } catch (e) {
      // Falha no processamento de UM check nunca derruba os demais.
      result.sendErrors += 1;
      log.error(
        { checkKey: obsItem.key, err: e instanceof Error ? e.message : String(e) },
        'monitor: falha ao processar check (demais seguem)',
      );
    }
  }

  // Heartbeat de liveness (SCRUM-54): SEMPRE loga o ciclo (mesmo down=0/sem atividade) e carimba
  // last_cycle_at na __global__. Antes o log só saía quando havia atividade -> com tudo saudável o
  // worker ficava mudo e "quieto" era indistinguível de "travado" (causou restart desnecessário em
  // 02/07). Agora a prova de vida é verificável por log E por SELECT (alert_states.__global__).
  try {
    await alerts.recordCycleHeartbeat();
  } catch (e) {
    // Fail-safe: uma falha no heartbeat NUNCA derruba o ciclo (o log abaixo ainda dá a prova de vida).
    log.warn(
      { err: e instanceof Error ? e.message : String(e) },
      'monitor: falha ao carimbar last_cycle_at (heartbeat) — ciclo segue',
    );
  }

  // Contador VIGIADO de sendErrors (SCRUM-135, item 7): antes só virava log.error (grep-only);
  // agora acumula em alert_states.__heartbeat__.alert_count pra dar SELECT direto (getMonitorSendErrorsTotal).
  // Fail-safe simétrico ao heartbeat acima — falha aqui NUNCA derruba o ciclo.
  if (result.sendErrors > 0) {
    try {
      await alerts.bumpMonitorSendErrors(result.sendErrors);
    } catch (e) {
      log.warn(
        { err: e instanceof Error ? e.message : String(e) },
        'monitor: falha ao acumular contador de sendErrors — ciclo segue',
      );
    }
  }

  log.info({ ...result }, 'monitor cycle');
  return result;
}
