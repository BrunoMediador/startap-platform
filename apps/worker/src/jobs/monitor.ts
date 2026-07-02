/**
 * Job monitor — Sistema de Alertas Interno (Missão 021, Fase 1).
 *
 * Spec: docs/missoes/021-sistema-alertas-interno.md.
 *
 * Varre, a cada 2 min (atrás da flag ALERTS_ENABLED + do toggle quente
 * alert_config.enabled), os checks da Fase 1:
 *   - waha:<sessao>  — 1 por cliente real conectado + a Lola (1 GET /api/sessions);
 *   - api:health     — /health do startap-api (HTTP 200 E checks.db=ok E checks.redis=ok);
 *   - pg:main        — SELECT 1 direto (redundância barata do worker).
 * Disco/RAM (host) ficam pra fase 2 (worker enxerga cgroup, não o host — spec §1).
 *
 * Para cada check aplica a máquina de estado anti-spam (spec §4):
 *   up→down   => alerta DOWN, grava down_since/last_alert_at, alert_count=1;
 *   down→down => re-alerta SÓ se passou COOLDOWN (default 30 min);
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
import { isDefinitiveNonDelivery } from './waha-send-failure.js';

const log = logger.child({ job: 'monitor' });

/** check_key do health da API. */
const HEALTH_KEY = 'api:health';
/** check_key do Postgres direto. */
const PG_KEY = 'pg:main';
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
  /** mensagens efetivamente enviadas (DOWN + re-alerta + RECUPERADO). */
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

/** GET /health: DOWN se HTTP != 200 OU checks.db != ok OU checks.redis != ok. */
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
    if (db !== 'ok' || redis !== 'ok') {
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
 * SÓ `failed-definitive` dispara a compensação do carimbo (SCRUM-53 + P2 do security). `noop` e
 * `failed-ambiguous` MANTÊM o carimbo (anti-flood/anti-duplicata; comportamento pré-PR pra ambíguo).
 */
export type SendOutcome = 'delivered' | 'noop' | 'failed-definitive' | 'failed-ambiguous';

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
      await Promise.race([
        waha.sendText({
          sessao,
          chatId: toChatId(r.phone),
          texto,
          typing: true,
          delayMs: ALERT_TYPING_DELAY_MS,
        }),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('sendText timeout')), SEND_TIMEOUT_MS),
        ),
      ]);
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
 * por episódio) do auto-aviso ao dono do clone. Re-alertas down→down NÃO marcam
 * justWentDown (o cooldown por-clone do aviso já protege, mas o sinal fica preciso).
 */
async function applyTransition(
  obsItem: CheckObservation,
  prev: alerts.AlertStateRow | null,
  cooldownMin: number,
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
      // down → up: RECUPERADO.
      const mins = minutesSince(prev?.down_since ?? null);
      await alerts.upsertState({
        checkKey: obsItem.key,
        state: 'up',
        downSince: null,
        lastAlertAt: null,
        alertCount: 0,
        pendingDownCount: 0,
      });
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
    // Transição CONFIRMADA up→down (entregue OU ambígua = possivelmente avisada): instante do aviso
    // ao dono do clone (o notify tem cooldown+taxonomia próprios que evitam duplicar).
    return { isDown: true, justWentDown: true };
  }

  // down → down: re-alerta só se passou o cooldown.
  const sinceLast = minutesSince(prev?.last_alert_at ?? prev?.down_since ?? null);
  if (sinceLast >= cooldownMin) {
    const downMins = minutesSince(prev?.down_since ?? null);
    const stampedAt = new Date();
    const expectCount = (prev?.alert_count ?? 0) + 1;
    await alerts.upsertState({
      checkKey: obsItem.key,
      state: 'down',
      downSince: prev?.down_since ?? stampedAt,
      lastAlertAt: stampedAt,
      alertCount: expectCount,
      pendingDownCount: 0,
    });
    const outcome = await send(
      `🔴 AINDA CAÍDO: ${obsItem.label} há ${downMins} min — ${obsItem.detail}.`,
    );
    if (outcome === 'failed-definitive') {
      // Só em falha DEFINITIVA restaura o last_alert_at anterior: o re-alerta que comprovadamente
      // não saiu NÃO reinicia o relógio do cooldown, então o próximo ciclo (ainda ≥ cooldown)
      // re-tenta (SCRUM-53). Ambíguo (timeout/5xx) mantém o carimbo (P2 do security — pode ter saído).
      await rollbackStamp(stampedAt, expectCount);
    }
    return { isDown: true, justWentDown: false };
  }
  // Dentro do cooldown: silêncio (estado já é down; nada a gravar).
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

  result.checked = observations.length;

  // Estados persistidos (1 query, vira Map por chave).
  const states = await alerts.listStates();
  const stateByKey = new Map(states.map((s) => [s.check_key, s]));

  for (const obsItem of observations) {
    try {
      const send = async (texto: string): Promise<SendOutcome> => {
        if (!senderSession) {
          // sender_slot sem waha_sessao mapeado — degradação graciosa (spec §3). Sem remetente a
          // mensagem DEFINITIVAMENTE não saiu -> 'failed-definitive' aciona a compensação (SCRUM-53):
          // quando o remetente for configurado, o alerta re-sai.
          log.error(
            { senderSlot: cfg.sender_slot },
            'monitor: sender_slot sem waha_sessao — alerta NÃO enviado (configurar remetente)',
          );
          return 'failed-definitive';
        }
        return broadcast(senderSession, texto, recipients, result);
      };
      const { isDown, justWentDown } = await applyTransition(
        obsItem,
        stateByKey.get(obsItem.key) ?? null,
        cfg.cooldown_min,
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
  log.info({ ...result }, 'monitor cycle');
  return result;
}
