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
import { projectOperationalState } from '@startap/core/operational-state';
// Importa do subpath /phone (não da raiz @startap/core) para NÃO arrastar crypto.ts,
// que valida GCAL_ENCRYPTION_KEY no load e quebraria o boot/teste sem a env.
import { ensureDddBr } from '@startap/core/phone';
import { clientBilling, flowClones, operationalState } from '@startap/db';
import type { OperationalSnapshot } from '@startap/db';
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

/**
 * Nome da sessão WAHA a criar quando o clone tem waha_sessao NULL (beco sem saída
 * do signup — auditoria 13/07: createWahaSession falhou no cadastro e a sessão
 * nunca foi vinculada). Deriva DETERMINISTICAMENTE do slot, do MESMO jeito que o
 * provisionamento gravaria: slot já-prefixado clone_ usa o próprio slot (o que o
 * signup passa como sessionName — evita duplo prefixo), caso contrário
 * wahaSessionName(slot) (caminho do gestão). Assim o nome reparado é idêntico ao
 * que o signup teria criado, sem depender de estado perdido.
 */
function repairSessionName(slot: string): string {
  return slot.startsWith('clone_') ? slot : provisioning.wahaSessionName(slot);
}

/**
 * Reparo ON-DEMAND do beco sem saída do signup (auditoria 13/07, 3/3): quando o
 * createWahaSession falha no cadastro, o clone fica em 'rascunho' com waha_sessao
 * NULL e ANTES disso TODA ação de conexão respondia 503 pra sempre (cliente sem
 * trial e sem bot). Aqui, na 1ª tentativa de reconectar, criamos a sessão WAHA na
 * hora (config-ouro do provisionamento, mesma do 404-recreate) e vinculamos
 * waha_sessao + status 'aguardando_qr' — igual ao ramo de sucesso do signup. O
 * cliente sai do beco na PRÓPRIA request e segue pro pareamento (poll/QR/código).
 *
 * Guardas:
 *  - só clone em 'rascunho' (sessão nunca vinculada). Qualquer outro estado com
 *    waha_sessao NULL é inesperado -> 503 (NÃO fabrica sessão pra clone que
 *    progrediu; nunca "religa" nada);
 *  - lock Redis por slot (mesma âncora anti-duplo-clique do reconectar): 2 requests
 *    simultâneas NÃO criam 2 sessões — a 2ª cai em 429;
 *  - WAHA criado ANTES de qualquer escrita no banco: falha => NADA de estado
 *    permanente (503 retentável; clone segue rascunho, o cliente tenta de novo);
 *  - persistência CONDICIONAL (bindSessionIfUnset: WHERE waha_sessao IS NULL) como
 *    defesa extra à corrida entre processos/expiração de lock.
 */
async function repairMissingSession(
  clone: flowClones.CloneRow | null,
  tenant: TenantContext,
  reply: FastifyReply,
): Promise<FastifyReply> {
  // Só o estado pós-signup incompleto ('rascunho') é reparável. Clone ausente ou já
  // progredido sem sessão = estado inesperado; não inventa sessão -> 503 retentável.
  if (!clone || clone.status !== 'rascunho') {
    return reply.code(503).send({ error: 'waha_indisponivel' });
  }
  const wahaCfg = recreateWahaConfig();
  if (!wahaCfg) {
    log.error({ slot: tenant.slot }, 'reparo indisponível: TS_WEBHOOK_URL não provisionada');
    return reply.code(503).send({ error: 'waha_indisponivel' });
  }

  // Lock ANTES de criar (uma só criação por janela; anti-corrida = anti-2-sessões).
  const got = await acquireReconnectLock(tenant.slot);
  if (!got) {
    const retry = await reconnectCooldownSeconds(tenant.slot);
    reply.header('Retry-After', String(retry));
    return reply.code(429).send({ error: 'aguarde', retry_after_seconds: retry });
  }

  const sessionName = repairSessionName(tenant.slot);
  const created = await provisioning.createWahaSession(wahaCfg, sessionName);
  if (!created.ok) {
    log.warn(
      { slot: tenant.slot, error: created.error },
      'reparo: falha ao criar sessão WAHA (retentável — clone segue rascunho)',
    );
    return reply.code(503).send({ error: 'waha_indisponivel' });
  }

  // Persiste SÓ após o WAHA aceitar (nada de estado permanente em falha). Condicional
  // (waha_sessao IS NULL): se outra request venceu a corrida, seguimos mesmo assim —
  // o nome é o mesmo (determinístico), então o pareamento converge.
  const bound = await flowClones.bindSessionIfUnset(clone.id, sessionName);
  log.info(
    { slot: tenant.slot, sessionName, bound },
    'sessão WAHA reparada (era NULL pós-signup) — cliente segue pro pareamento',
  );
  // Sessão nasce com start:true rumo a SCAN_QR_CODE — poll/QR/código cobrem a transição.
  return reply.code(202).send({ session: sessionName, state: 'restarting', poll_after_ms: 2000 });
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

/** Resolve o clone do tenant e seus campos derivados (sessão + número mascarado).
 *
 * O número de flow_clones.cliente_telefone tem formatos inconsistentes (alguns sem o
 * DDI 55). ensureDddBr garante o DDI de forma CONSERVADORA (prefixa 55 em nacional sem
 * DDI; NÃO toca no 9º dígito — preserva pagantes) ANTES de virar destino do request-code
 * do WAHA. Se o número não for normalizável (lixo/ambíguo) → phoneDigits null e o
 * has_registered_phone reflete isso; o codigo retorna 422 telefone_invalido. */
async function resolveClone(tenant: TenantContext) {
  const clone = await flowClones.getCloneBySlot(tenant.slot);
  const session = clone?.waha_sessao ?? null;
  const rawPhone = clone?.cliente_telefone ?? null;
  // Normaliza o DDI antes de qualquer uso (request-code + flags do GET).
  const phoneDigits = rawPhone ? ensureDddBr(rawPhone) : null;
  return {
    clone,
    session,
    phoneDigits,
    phoneMasked: phoneDigits ? maskPhone(phoneDigits) : null,
    // Diferencia "nunca cadastrou" de "cadastrou número que não normaliza" — o
    // codigo escolhe 422 telefone_nao_cadastrado vs telefone_invalido.
    hasRawPhone: Boolean(rawPhone && rawPhone.replace(/\D/g, '').length >= 8),
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
function derivePauseState(
  clone: Pick<OperationalSnapshot, 'flow_enabled' | 'suspended_kind'> | null,
): {
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

function composedState(snapshot: OperationalSnapshot | null, wahaStatus: string) {
  return projectOperationalState(
    {
      atendimentoConfigured: snapshot?.atendimento_configured ?? false,
      wahaStatus,
      flow_enabled: snapshot?.flow_enabled ?? true,
      suspended_kind: snapshot?.suspended_kind ?? null,
      next_due_date: snapshot?.next_due_date ?? null,
      billing_amount_cents: snapshot?.billing_amount_cents ?? null,
    },
    {
      graceDays: clientBilling.GRACE_DAYS,
      daysUntilDue: (nextDueDate) => clientBilling.daysUntilDue(nextDueDate),
      billingOverdueSilenceOn: process.env.BILLING_OVERDUE_SILENCE === 'true',
    },
  );
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
      const operational = await operationalState.getOperationalSnapshotBySlot(tenant.slot);

      const status = await readWahaStatus(session, tenant.slot);
      const connected = status === 'WORKING';
      const cooldown = await reconnectCooldownSeconds(tenant.slot);

      // Estado da pausa do bot (só exposto com a flag PORTAL_BOT_PAUSE ON; OFF -> campos
      // omitidos e o front esconde a UI — produção byte-a-byte como antes da feature).
      const pause = config.PORTAL_BOT_PAUSE ? derivePauseState(operational) : {};

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
        // true = a sessão já conectou ao menos 1 vez (first_connected_at carimbado,
        // migration 062). Ativa a copy de "1ª conexão" no front (SCRUM-95); ausente/
        // undefined -> o front cai na copy de reconexão (byte-idêntico). A DATA nunca
        // sai da API — só o booleano (LGPD).
        ever_connected: clone?.first_connected_at != null,
        // Só pode reconectar se não está conectado e não há lock vigente.
        can_reconnect: !connected && cooldown === 0,
        reconnect_cooldown_seconds: cooldown,
        operational_state: composedState(operational, status),
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
      const { clone, session } = await resolveClone(tenant);
      if (!session) {
        // waha_sessao NULL = beco sem saída do signup (createWahaSession falhou no
        // cadastro; a sessão nunca foi vinculada). Repara ON-DEMAND: cria a sessão
        // agora e vincula — tira o cliente do beco na própria request (ou 503/429
        // retentável). Só age em clone 'rascunho'.
        return repairMissingSession(clone, tenant, reply);
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
      const { session, phoneDigits, phoneMasked, hasRawPhone } = await resolveClone(tenant);

      // Número vem SEMPRE de flow_clones.cliente_telefone (nunca de input). Após
      // ensureDddBr, null pode ser "nunca cadastrou" OU "cadastrou número inválido"
      // (sem DDI recuperável / DDD inexistente). Não tenta parear com lixo.
      if (!phoneDigits || !phoneMasked) {
        return reply
          .code(422)
          .send({ error: hasRawPhone ? 'telefone_invalido' : 'telefone_nao_cadastrado' });
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
      const operational = await operationalState.getOperationalSnapshotBySlot(tenant.slot);
      const status = await readWahaStatus(session, tenant.slot);
      return reply.code(200).send({
        session,
        status,
        connected: status === 'WORKING',
        // terminal: o front pode parar o polling (sucesso ou falha definitiva).
        terminal: status === 'WORKING' || status === 'FAILED',
        operational_state: composedState(operational, status),
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
      if (res.outcome === 'not_found') {
        return reply.code(404).send({ error: 'fluxo_nao_encontrado' });
      }
      const status = await readWahaStatus(res.operational?.waha_sessao ?? null, tenant.slot);
      const state = composedState(res.operational, status);
      if (res.changed) {
        log.info({ slot: tenant.slot }, 'bot retomado pelo cliente no portal');
        return reply.code(200).send({ bot_paused: false, operational_state: state });
      }
      if (res.outcome === 'billing_overdue') {
        return reply.code(409).send({
          error: 'billing_overdue',
          message: 'Sua mensalidade está vencida. Regularize o pagamento para retomar.',
          bot_paused: !res.flow_enabled,
          operational_state: state,
        });
      }
      if (res.outcome === 'startap_suspension') {
        return reply.code(409).send({
          error: 'suspensao_startap',
          message:
            res.startap_kind === 'billing'
              ? 'Seu atendimento está pausado por cobrança. Regularize o pagamento para retomar.'
              : 'Seu atendimento foi pausado pela Startap. Fale com o suporte.',
          suspension_kind: res.startap_kind,
          denied_reason: state.actions.resume_owner.denied_reason,
          bot_paused: !res.flow_enabled,
          operational_state: state,
        });
      }
      return reply.code(200).send({ bot_paused: !res.flow_enabled, operational_state: state });
    },
  );
};
