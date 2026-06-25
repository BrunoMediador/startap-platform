/**
 * Reconexão self-service da sessão WAHA no Portal do Cliente (ADR 0015).
 *
 * TODAS as rotas passam por withTenant e usam SO requireTenant(req).slot. A sessão
 * WAHA vem de flow_clones.waha_sessao (derivada do slot da sessão) e o número de
 * flow_clones.cliente_telefone — NUNCA de body/query/params. O cliente não consegue
 * nem nomear outra sessão/número (anti-IDOR; regra de ouro 5). Telefone SEMPRE
 * mascarado em log/resposta (regra de ouro 6 — LGPD).
 *
 * Feature flag PORTAL_RECONEXAO_WAHA (default OFF):
 *   - OFF: GET /portal/conexao -> { enabled:false } e nada mais; rotas de ação -> 404.
 *     O front esconde toda a UI. O boot NÃO crasha sem a flag (feature dormente).
 *   - ON: fluxo completo status -> restart -> poll -> request-code/qr server-side.
 *
 * Guards (ADR 0015 — máquina de estados):
 *   - WORKING: reconectar/codigo/qr -> 409 (protege a sessão pagante; nunca reinicia).
 *   - lock Redis por slot (anti-duplo-clique) + rate-limit por user.
 *   - TODA chamada WAHA com timeout (config.PORTAL_WAHA_TIMEOUT_MS).
 *
 * Rotas:
 *   GET  /portal/conexao            — snapshot de estado para a home/banner.
 *   POST /portal/conexao/reconectar — adquire lock, restart async, retorna rápido.
 *   POST /portal/conexao/codigo     — gera o código de pareamento (re-emite).
 *   GET  /portal/conexao/qr         — QR fallback (só em SCAN_QR_CODE).
 *   GET  /portal/conexao/status     — polling leve do estado.
 */
import rateLimit from '@fastify/rate-limit';
import { logger } from '@startap/core/logger';
import { flowClones } from '@startap/db';
import { provisioning, waha } from '@startap/integrations';
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { config } from '../config.js';
import { maskPhone } from '../lib/mask.js';
import { getRedis } from '../lib/session.js';
import { SESSION_COOKIE } from '../lib/tenant.js';
import { type TenantContext, requireTenant, withTenant } from '../lib/tenant.js';

const log = logger.child({ service: 'portal-api', module: 'conexao' });

/**
 * Chave de rate-limit POR USER. O withTenant (que injeta req.tenant) roda no
 * preHandler — DEPOIS do onRequest em que o rate-limit calcula a chave — então
 * aqui usamos o cookie de sessão assinado (opaco, único por sessão/user) como
 * chave estável. Fallback no IP se não houver cookie (rota ainda exige sessão).
 */
function userRateKey(req: FastifyRequest): string {
  const raw = req.cookies?.[SESSION_COOKIE];
  if (raw) {
    const unsigned = req.unsignCookie(raw);
    if (unsigned.valid && unsigned.value) return `u:${unsigned.value}`;
  }
  return `ip:${req.ip}`;
}

const { WahaTimeoutError, WahaWrongStateError, WahaSessionNotFoundError } = waha.sessions;

/** Timeout por chamada WAHA (ms) — vem do config (default 8s). */
function wahaOpts() {
  return { timeoutMs: config.PORTAL_WAHA_TIMEOUT_MS };
}

/**
 * Status sintético quando o GET /api/sessions/{name} volta 404 (sessão descartada
 * pelo WAHA — ex.: deploy/restart entre cadastro e pareamento, o bug sistêmico de
 * onboarding). DISTINTO de 'unknown' (WAHA fora/instável): só este gatilha a
 * recriação da sessão. Nunca colide com um status real do WAHA
 * (WORKING/FAILED/SCAN_QR_CODE/STARTING/STOPPED).
 */
const STATUS_NOT_FOUND = 'not_found';

/**
 * Config WAHA para (re)criar a sessão pelo MESMO caminho do provisionamento/signup
 * — não duplica defaults. createWahaSession aplica a config-ouro da sessão nova
 * (events ['message.any','session.status'], ignore status/grupos/canais/broadcast,
 * retries 15×3s, hmac.key + X-Webhook-Secret quando configurados). Os segredos vêm
 * do config tipado do boot (env), NUNCA extraídos de container. Ausentes = sessão
 * sem auth (mesmo contrato lazy do signup; boot nunca crasha). NUNCA logar valores.
 */
function recreateWahaConfig(): provisioning.WahaConfig | null {
  if (!config.TS_WEBHOOK_URL) return null;
  return {
    url: config.WAHA_URL,
    apiKey: config.WAHA_API_KEY,
    webhookUrl: config.TS_WEBHOOK_URL,
    webhookHmacKey: config.WAHA_WEBHOOK_HMAC_KEY,
    webhookSecret: config.WAHA_WEBHOOK_SECRET,
  };
}

/**
 * Recria a sessão WAHA inexistente (404) reusando o helper de provisionamento
 * (config-ouro idêntica à do signup/gestão — anti resposta-dupla). NÃO recria
 * registros do clone (eles já existem no banco); só a sessão WAHA com o MESMO nome
 * já persistido em flow_clones.waha_sessao. Best-effort: nunca lança — devolve o
 * resultado pro caller decidir entre seguir (ok) ou 503 (falha).
 */
async function recreateSession(
  session: string,
  slot: string,
): Promise<provisioning.WahaSessionResult> {
  const wahaCfg = recreateWahaConfig();
  if (!wahaCfg) {
    log.error({ slot }, 'recriar sessão indisponível: TS_WEBHOOK_URL não provisionada');
    return { ok: false, status: 'failed', error: 'webhook_url_ausente' };
  }
  const res = await provisioning.createWahaSession(wahaCfg, session);
  if (res.ok) {
    log.info({ slot, session, wahaStatus: res.status }, 'sessão WAHA recriada (era 404)');
  } else {
    log.warn({ slot, session, error: res.error }, 'falha ao recriar sessão WAHA (404)');
  }
  return res;
}

// ── Lock Redis (anti-duplo-clique no reconectar) ────────────────────────────────
// SET NX EX por slot. O TTL é a "janela" em que um 2º restart é proibido (invalida o
// código — ADR 0015). O cooldown exposto no GET /conexao vem deste mesmo TTL.
const LOCK_PREFIX = 'portal:waha:reconnect:';
const LOCK_TTL_SECONDS = 35;

function lockKey(slot: string): string {
  return LOCK_PREFIX + slot;
}

/** Tenta adquirir o lock. Retorna true se conseguiu, false se já travado. */
async function acquireReconnectLock(slot: string): Promise<boolean> {
  const r = getRedis();
  const res = await r.set(lockKey(slot), '1', 'EX', LOCK_TTL_SECONDS, 'NX');
  return res === 'OK';
}

/** TTL restante do lock em segundos (0 se não há lock). Alimenta o cooldown do GET. */
async function reconnectCooldownSeconds(slot: string): Promise<number> {
  const ttl = await getRedis().ttl(lockKey(slot));
  return ttl > 0 ? ttl : 0;
}

/**
 * Lê o status WAHA da sessão de forma graceful. Distingue 3 saídas:
 *  - status real do WAHA (WORKING/FAILED/SCAN_QR_CODE/STARTING/...);
 *  - STATUS_NOT_FOUND ('not_found'): sessão NÃO existe (404) — gatilho de recriação;
 *  - 'unknown': WAHA fora/instável (timeout/rede) — NÃO recria, degrada graceful.
 */
async function readWahaStatus(session: string | null, slot: string): Promise<string> {
  if (!session) return 'unknown';
  try {
    const s = await waha.sessions.getSessionStatus(session, wahaOpts());
    return s.status ?? 'unknown';
  } catch (err) {
    if (err instanceof WahaSessionNotFoundError) {
      // 404 = sessão descartada (deploy/restart entre cadastro e pareamento).
      log.info({ slot }, 'sessão WAHA inexistente (404) — elegível a recriação');
      return STATUS_NOT_FOUND;
    }
    log.info(
      { slot, err: err instanceof Error ? err.message : 'erro' },
      'WAHA status indisponível (graceful)',
    );
    return 'unknown';
  }
}

/** Resolve o clone do tenant e seus campos derivados (sessão + número mascarado). */
async function resolveClone(tenant: TenantContext) {
  const clone = await flowClones.getCloneBySlot(tenant.slot);
  const session = clone?.waha_sessao ?? null;
  const rawPhone = clone?.cliente_telefone ?? null;
  const phoneDigits = rawPhone ? rawPhone.replace(/\D/g, '') : '';
  const hasPhone = phoneDigits.length >= 8;
  return {
    clone,
    session,
    phoneDigits: hasPhone ? phoneDigits : null,
    phoneMasked: hasPhone ? maskPhone(phoneDigits) : null,
  };
}

/**
 * Estado da pausa do bot derivado de flow_enabled + suspended_kind (contrato BE↔FE):
 *  - bot_paused  = flow_enabled === false (bot mudo; WAHA segue conectada).
 *  - pause_self  = pausado E suspended_kind === 'owner_request' (o PRÓPRIO cliente pausou
 *                  pelo portal -> ele pode retomar).
 *  - pause_locked = pausado E NÃO é pause_self (suspenso pela Startap: billing/
 *                  manual_other/abuse) -> o cliente NÃO retoma (UI mostra "fale com suporte").
 */
function derivePauseState(clone: flowClones.CloneRow | null): {
  bot_paused: boolean;
  pause_self: boolean;
  pause_locked: boolean;
} {
  const botPaused = clone?.flow_enabled === false;
  const pauseSelf = botPaused && clone?.suspended_kind === flowClones.OWNER_PAUSE_KIND;
  return {
    bot_paused: botPaused,
    pause_self: pauseSelf,
    pause_locked: botPaused && !pauseSelf,
  };
}

/** Quando a flag está OFF, rotas de ação respondem 404 (front esconde tudo). */
function featureDisabled(reply: FastifyReply): FastifyReply {
  return reply.code(404).send({ error: 'recurso_indisponivel' });
}

export const portalConexaoRoutes: FastifyPluginAsync = async (app) => {
  // Rate-limit POR USER neste escopo encapsulado (chave = cookie de sessão). Os
  // limites finos por rota vêm de `config.rateLimit` em cada handler abaixo. Reusa o
  // @fastify/rate-limit já carregado globalmente; aqui apenas trocamos o keyGenerator
  // para isolar por user (não por IP) — vários clientes atrás do mesmo NAT/NPM.
  await app.register(rateLimit, {
    global: false,
    keyGenerator: userRateKey,
  });

  // ── GET /portal/conexao — snapshot para home/banner ──────────────────────────
  // Sempre 200. Flag OFF -> { enabled:false } e NADA MAIS (o front esconde a UI).
  app.get(
    '/portal/conexao',
    { preHandler: withTenant, config: { rateLimit: { max: 20, timeWindow: '1 minute' } } },
    async (req, reply) => {
      if (!config.PORTAL_RECONEXAO_WAHA) {
        return reply.code(200).send({ enabled: false });
      }
      const tenant = requireTenant(req);
      const { clone, session, phoneDigits, phoneMasked } = await resolveClone(tenant);

      const status = await readWahaStatus(session, tenant.slot);
      const connected = status === 'WORKING';
      const cooldown = await reconnectCooldownSeconds(tenant.slot);

      // Estado da pausa do bot (só exposto com a flag PORTAL_BOT_PAUSE ON; OFF -> campos
      // omitidos e o front esconde a UI — produção byte-a-byte como antes da feature).
      const pause = config.PORTAL_BOT_PAUSE ? derivePauseState(clone) : {};

      return reply.code(200).send({
        enabled: true,
        session,
        status,
        connected,
        // Precisa de ação quando NÃO está conectado e o estado é conhecido (não 'unknown'
        // genérico se WAHA caiu — banner aparece mesmo assim para o cliente agir).
        needs_action: !connected,
        has_registered_phone: phoneDigits != null,
        registered_phone_masked: phoneMasked,
        // Só pode reconectar se não está conectado e não há lock vigente.
        can_reconnect: !connected && cooldown === 0,
        reconnect_cooldown_seconds: cooldown,
        ...pause,
      });
    },
  );

  // ── POST /portal/conexao/reconectar — restart async com lock ─────────────────
  app.post(
    '/portal/conexao/reconectar',
    { preHandler: withTenant, config: { rateLimit: { max: 1, timeWindow: '30 seconds' } } },
    async (req, reply) => {
      if (!config.PORTAL_RECONEXAO_WAHA) return featureDisabled(reply);
      const tenant = requireTenant(req);
      const { session } = await resolveClone(tenant);
      if (!session) {
        return reply.code(503).send({ error: 'waha_indisponivel' });
      }

      // Guard: NUNCA reinicia uma sessão WORKING (protege a sessão pagante — ADR 0015).
      const status = await readWahaStatus(session, tenant.slot);
      if (status === 'WORKING') {
        return reply.code(409).send({ error: 'ja_conectado' });
      }
      if (status === 'unknown') {
        // WAHA fora/instável: não dá pra garantir o guard != WORKING — não reinicia.
        return reply.code(503).send({ error: 'waha_indisponivel' });
      }

      // Lock anti-duplo-clique: 2 cliques rápidos -> o 2º cai em 429 (sem 2º restart
      // nem 2ª recriação, que invalidaria o código já gerado). Adquirido ANTES da
      // recriação 404 também (uma só recriação por janela).
      const got = await acquireReconnectLock(tenant.slot);
      if (!got) {
        const retry = await reconnectCooldownSeconds(tenant.slot);
        reply.header('Retry-After', String(retry));
        return reply.code(429).send({ error: 'aguarde', retry_after_seconds: retry });
      }

      // 404 = sessão descartada (deploy/restart entre cadastro e pareamento — bug
      // sistêmico de onboarding). RECRIA com a config-ouro do provisionamento (mesmo
      // helper do signup; anti resposta-dupla) e segue pro pareamento. A sessão
      // recém-criada já nasce com start:true rumo a SCAN_QR_CODE — o poll/QR/código
      // cobrem a transição. Falha ao recriar -> 503 (não trava o cliente em beco).
      if (status === STATUS_NOT_FOUND) {
        const created = await recreateSession(session, tenant.slot);
        if (!created.ok) {
          return reply.code(503).send({ error: 'waha_indisponivel' });
        }
        return reply.code(202).send({ session, state: 'restarting', poll_after_ms: 2000 });
      }

      // Dispara o restart+poll em background — não pendura o hot path. O front faz
      // poll via GET /conexao/status. Erros do background só são logados (mascarado).
      void waha.sessions
        .restartAndWaitForScan(session, {
          timeoutMs: config.PORTAL_WAHA_TIMEOUT_MS,
          totalTimeoutMs: 30_000,
          pollIntervalMs: 2_000,
          // Kill-switch (default ON): se a sessão NOWEB ficar FAILED-presa após o restart,
          // escala logout+start pra descartar o auth-state quebrado e chegar a SCAN_QR_CODE.
          logoutFallback: config.PORTAL_RECONEXAO_LOGOUT_FALLBACK,
        })
        .then((res) => {
          // Log HONESTO: só conta como sucesso se chegou em SCAN_QR_CODE (pronto pro QR/
          // código) ou já estava WORKING. Qualquer outro finalStatus (ex.: FAILED preso) é
          // um P1 visível — sai como warn pra aparecer no futuro. Sem dado sensível no log.
          if (res.ready || res.alreadyWorking) {
            log.info({ slot: tenant.slot, finalStatus: res.status }, 'reconexão concluída');
          } else {
            log.warn(
              { slot: tenant.slot, finalStatus: res.status },
              'reconexão não atingiu SCAN_QR_CODE',
            );
          }
        })
        .catch((err) => {
          log.warn(
            { slot: tenant.slot, err: err instanceof Error ? err.message : 'erro' },
            'reconexão em background falhou',
          );
        });

      return reply.code(202).send({ session, state: 'restarting', poll_after_ms: 2000 });
    },
  );

  // ── POST /portal/conexao/codigo — gera/re-emite o código de pareamento ───────
  app.post(
    '/portal/conexao/codigo',
    { preHandler: withTenant, config: { rateLimit: { max: 3, timeWindow: '5 minutes' } } },
    async (req, reply) => {
      if (!config.PORTAL_RECONEXAO_WAHA) return featureDisabled(reply);
      const tenant = requireTenant(req);
      const { session, phoneDigits, phoneMasked } = await resolveClone(tenant);

      // Número vem SEMPRE de flow_clones.cliente_telefone (nunca de input). Null -> 422.
      if (!phoneDigits || !phoneMasked) {
        return reply.code(422).send({ error: 'telefone_nao_cadastrado' });
      }
      if (!session) {
        return reply.code(503).send({ error: 'waha_indisponivel' });
      }

      const status = await readWahaStatus(session, tenant.slot);
      if (status === 'WORKING') {
        return reply.code(409).send({ error: 'ja_conectado' });
      }
      // 404 = sessão descartada. RECRIA com a config-ouro do provisionamento (não
      // emite código aqui: a sessão recém-criada ainda está STARTING, não
      // SCAN_QR_CODE). Instrui o cliente a reconectar/aguardar o estado de scan — o
      // GET /status confirma a transição. Tira o cliente do beco sem fim do bug.
      if (status === STATUS_NOT_FOUND) {
        const created = await recreateSession(session, tenant.slot);
        if (!created.ok) {
          return reply.code(503).send({ error: 'waha_indisponivel' });
        }
        return reply
          .code(422)
          .send({ error: 'sessao_nao_pronta', next: 'POST /portal/conexao/reconectar' });
      }
      // request-code só funciona em SCAN_QR_CODE. Em qualquer outro estado, instrui o
      // cliente a reconectar antes (sem novo restart aqui — re-emitir não reinicia).
      if (status !== 'SCAN_QR_CODE') {
        return reply
          .code(422)
          .send({ error: 'sessao_nao_pronta', next: 'POST /portal/conexao/reconectar' });
      }

      try {
        const { code } = await waha.sessions.requestPairingCode(session, phoneDigits, wahaOpts());
        log.info({ slot: tenant.slot, phone: phoneMasked }, 'código de pareamento emitido');
        return reply
          .code(200)
          .send({ pairing_code: code, expires_in_seconds: 60, phone_masked: phoneMasked });
      } catch (err) {
        if (err instanceof WahaTimeoutError) {
          return reply.code(503).send({ error: 'waha_indisponivel' });
        }
        log.warn(
          { slot: tenant.slot, err: err instanceof Error ? err.message : 'erro' },
          'falha ao emitir código',
        );
        return reply.code(503).send({ error: 'waha_indisponivel' });
      }
    },
  );

  // ── GET /portal/conexao/qr — QR fallback (só em SCAN_QR_CODE) ─────────────────
  app.get(
    '/portal/conexao/qr',
    { preHandler: withTenant, config: { rateLimit: { max: 20, timeWindow: '1 minute' } } },
    async (req, reply) => {
      if (!config.PORTAL_RECONEXAO_WAHA) return featureDisabled(reply);
      const tenant = requireTenant(req);
      const { session } = await resolveClone(tenant);
      if (!session) {
        return reply.code(503).send({ error: 'waha_indisponivel' });
      }

      try {
        const result = await waha.sessions.getSessionQR(session, wahaOpts());
        if ('connected' in result) {
          return reply.code(200).send({ connected: true, qr: null });
        }
        return reply.code(200).send({ qr: result.qr });
      } catch (err) {
        if (err instanceof WahaWrongStateError) {
          // QR só existe em SCAN_QR_CODE — 409 com o status atual (front pede reconectar).
          return reply.code(409).send({ error: 'sessao_nao_pronta', status: err.status });
        }
        if (err instanceof WahaTimeoutError) {
          return reply.code(503).send({ error: 'waha_indisponivel' });
        }
        log.warn(
          { slot: tenant.slot, err: err instanceof Error ? err.message : 'erro' },
          'falha ao obter QR',
        );
        return reply.code(503).send({ error: 'waha_indisponivel' });
      }
    },
  );

  // ── GET /portal/conexao/status — polling leve ────────────────────────────────
  app.get(
    '/portal/conexao/status',
    { preHandler: withTenant, config: { rateLimit: { max: 60, timeWindow: '1 minute' } } },
    async (req, reply) => {
      if (!config.PORTAL_RECONEXAO_WAHA) return featureDisabled(reply);
      const tenant = requireTenant(req);
      const { session } = await resolveClone(tenant);
      const status = await readWahaStatus(session, tenant.slot);
      return reply.code(200).send({
        session,
        status,
        connected: status === 'WORKING',
        // terminal: o front pode parar o polling (sucesso ou falha definitiva).
        terminal: status === 'WORKING' || status === 'FAILED',
      });
    },
  );

  // ── POST /portal/bot/pause — pausa self-service do bot pelo DONO ──────────────
  // Gated por PORTAL_BOT_PAUSE (404 se OFF). Seta suspended_kind='owner_request' (NUNCA
  // 'billing' — senão o PIX reativaria a pausa do dono). NÃO sobrescreve suspensão da
  // Startap: se já suspenso (flow_enabled=false), a query não casa o WHERE e devolve o
  // estado atual (bot_paused:true) sem mexer no kind. slot SEMPRE da sessão (anti-IDOR).
  app.post(
    '/portal/bot/pause',
    { preHandler: withTenant, config: { rateLimit: { max: 10, timeWindow: '1 minute' } } },
    async (req, reply) => {
      if (!config.PORTAL_BOT_PAUSE) return featureDisabled(reply);
      const tenant = requireTenant(req);
      const actor = `portal:${tenant.userId}`;
      const res = await flowClones.pauseBotByOwner(tenant.slot, actor);
      if (res.changed) {
        log.info({ slot: tenant.slot }, 'bot pausado pelo cliente no portal');
      }
      // bot_paused é o ESTADO após a operação (true se pausou agora OU já estava suspenso).
      return reply.code(200).send({ bot_paused: !res.flow_enabled });
    },
  );

  // ── POST /portal/bot/resume — retoma self-service (só a própria pausa) ────────
  // Gated por PORTAL_BOT_PAUSE (404 se OFF). SÓ destrava suspended_kind='owner_request'.
  // Se suspenso pela Startap (billing/manual_other/abuse) -> 409 suspensao_startap (o
  // cliente NÃO levanta suspensão da Startap). slot SEMPRE da sessão (anti-IDOR).
  app.post(
    '/portal/bot/resume',
    { preHandler: withTenant, config: { rateLimit: { max: 10, timeWindow: '1 minute' } } },
    async (req, reply) => {
      if (!config.PORTAL_BOT_PAUSE) return featureDisabled(reply);
      const tenant = requireTenant(req);
      const actor = `portal:${tenant.userId}`;
      const res = await flowClones.resumeBotByOwner(tenant.slot, actor);
      if (res.changed) {
        log.info({ slot: tenant.slot }, 'bot retomado pelo cliente no portal');
        return reply.code(200).send({ bot_paused: false });
      }
      // Não destravou. Distingue 2 casos lendo o estado atual:
      //  - suspenso pela Startap (flow_enabled=false, kind != owner_request) -> 409.
      //  - já ativo (nada a fazer) -> 200 bot_paused:false (idempotente).
      const { clone } = await resolveClone(tenant);
      const { bot_paused, pause_locked } = derivePauseState(clone);
      if (pause_locked) {
        return reply.code(409).send({
          error: 'suspensao_startap',
          message: 'Seu atendimento foi pausado pela Startap. Fale com o suporte.',
        });
      }
      return reply.code(200).send({ bot_paused });
    },
  );
};
