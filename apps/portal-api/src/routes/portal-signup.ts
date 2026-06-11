/**
 * Signup self-service do Portal do Cliente (Missão 020 F1, doc
 * docs/missoes/020-onboarding-self-service.md).
 *
 * POST /auth/signup — rota PÚBLICA de escrita (a primeira do portal):
 *   1. Feature flag PORTAL_SIGNUP (default OFF) -> 404 quando OFF.
 *   2. Zod: nome do negócio + WhatsApp + senha (3 campos — spec de UX A3.1).
 *   3. Normaliza o número (canonicalE164) — o NÚMERO é o login do cliente novo
 *      (decisão Bruno 2026-06-11; login dos clientes atuais NÃO muda).
 *   4. SOFT CHECK no trial_ledger (cortesia de UX): número que já consumiu o
 *      teste -> 409 trial_ja_usado (front mostra o TrialJaUsadoCard). O check
 *      AUTORITATIVO (hard check) acontece no pareamento (apps/api trial-pairing).
 *   5. Provisiona clone automaticamente (módulo compartilhado — MESMO caminho do
 *      gestão) a partir da matriz PORTAL_SIGNUP_MATRIZ_SLOT. Modelo de IA vem do
 *      banco da matriz (gpt-5.4) — zero default hardcoded.
 *   6. Cria portal_users (login = número, must_change_password=false) +
 *      client_billing (amount_cents default R$99,99; next_due_date = NULL — o
 *      trial SÓ começa no pareamento) + flow_clones.trial_status='awaiting'.
 *   7. Auto-login (cookie httpOnly, igual /auth/login) -> front redireciona /comecar.
 *
 * SEGURANÇA:
 *   - Rate-limit próprio: PORTAL_SIGNUP_RATE_MAX/dia/IP (default 3 — doc 020).
 *   - A rota JAMAIS aceita ou expõe slot (anti-IDOR; isolamento por construção).
 *   - LGPD: telefone nunca em log claro — só phone_hint (DDD + 2 últimos).
 *   - Envs novas (TRIAL_PHONE_PEPPER, TS_WEBHOOK_URL) validadas LAZY no ponto de
 *     uso -> 503; o boot NUNCA crasha sem elas (lição #247).
 */
import { logger } from '@startap/core/logger';
import { canonicalE164, phoneHint } from '@startap/core/phone';
import { isTrialPepperConfigured, trialPhoneHmac } from '@startap/core/trial';
import { clientBilling, pool, portalUsers, trialLedger } from '@startap/db';
import { provisioning } from '@startap/integrations';
import bcrypt from 'bcryptjs';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { config } from '../config.js';
import { createSession } from '../lib/session.js';
import { SESSION_COOKIE } from '../lib/tenant.js';
import { cookieSecure } from './auth.js';

const log = logger.child({ service: 'portal-api', module: 'signup' });

export const signupSchema = z.object({
  nome_negocio: z.string().trim().min(2).max(100),
  whatsapp: z.string().trim().min(8).max(25),
  // Mesmos limites do change-password (8-72 — teto real do bcrypt).
  senha: z.string().min(8).max(72),
});

/** Adapter pg.Pool -> SqlPool do módulo de provisionamento (DI, sem casts). */
function dbAdapter(): provisioning.SqlPool {
  return {
    query: async (text, values) => pool.query(text, values as unknown[]),
    connect: async () => {
      const client = await pool.connect();
      return {
        query: async (text, values) => client.query(text, values as unknown[]),
        release: () => client.release(),
      };
    },
  };
}

export const portalSignupRoutes: FastifyPluginAsync = async (app) => {
  app.post('/auth/signup', async (req, reply) => {
    // Flag OFF -> 404 (mesmo padrão da 019: front esconde tudo).
    if (!config.PORTAL_SIGNUP) {
      return reply.code(404).send({ error: 'recurso_indisponivel' });
    }

    const parsed = signupSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'dados_invalidos' });
    }
    const { nome_negocio, whatsapp, senha } = parsed.data;

    const canonical = canonicalE164(whatsapp);
    if (!canonical) {
      return reply.code(400).send({ error: 'telefone_invalido' });
    }
    const hint = phoneHint(canonical);

    // Envs da feature: validação LAZY (boot nunca crasha; rota degrada em 503).
    if (!isTrialPepperConfigured() || !config.TS_WEBHOOK_URL) {
      log.error(
        {
          pepperOk: isTrialPepperConfigured(),
          webhookOk: !!config.TS_WEBHOOK_URL,
        },
        'signup chamado sem TRIAL_PHONE_PEPPER/TS_WEBHOOK_URL provisionados',
      );
      return reply.code(503).send({ error: 'signup_indisponivel' });
    }

    // ── Soft check do trial (anti farm, cortesia de UX) ─────────────────────────
    const hmac = trialPhoneHmac(canonical);
    const ledger = await trialLedger.findByPhoneHmac(hmac);
    if (ledger?.status === 'consumed') {
      log.info({ phone: hint }, 'signup negado — número já consumiu trial (soft check)');
      return reply.code(409).send({ error: 'trial_ja_usado' });
    }
    // exempt (whitelist interna) segue normal.

    // ── Conta já existe? (login = número) ───────────────────────────────────────
    if (await portalUsers.usernameExists(canonical)) {
      return reply.code(409).send({ error: 'conta_ja_existe' });
    }

    // ── Provisionamento automático (módulo compartilhado com o gestão) ─────────
    const slot = provisioning.generateCloneSlot(nome_negocio);
    let provisioned: provisioning.ProvisionResult;
    try {
      provisioned = await provisioning.provisionCloneWithWaha(
        {
          db: dbAdapter(),
          waha: {
            url: config.WAHA_URL,
            apiKey: config.WAHA_API_KEY,
            webhookUrl: config.TS_WEBHOOK_URL,
          },
        },
        {
          matrizSlot: config.PORTAL_SIGNUP_MATRIZ_SLOT,
          novoSlot: slot,
          displayName: nome_negocio,
          telefoneContato: canonical,
          // SEM overrides de provider/model: o clone herda da matriz (banco).
          personalizacao: { nome_negocio },
          // Slot já nasce prefixado clone_ — usa o próprio slot como sessão WAHA
          // (evita duplo prefixo do wahaSessionName, pensado pro gestão).
          sessionName: slot,
        },
      );
    } catch (e) {
      log.error(
        { err: e instanceof Error ? e.message : String(e) },
        'signup: provisionamento falhou',
      );
      return reply.code(500).send({ error: 'erro_ao_criar_conta' });
    }

    if (provisioned.wahaStatus === 'failed') {
      // Clone criado, sessão WAHA pendente — NÃO bloqueia o cadastro (o wizard/
      // gestão retenta). Trial não começa sem pareamento de qualquer forma.
      log.warn(
        { wahaError: provisioned.wahaError },
        'signup: clone criado mas sessão WAHA falhou (retry posterior)',
      );
    }

    // ── Usuário do portal + billing + estado de trial ───────────────────────────
    try {
      const passwordHash = await bcrypt.hash(senha, config.PORTAL_BCRYPT_COST);
      await portalUsers.createPortalUser({
        slot,
        username: canonical,
        passwordHash,
        displayName: nome_negocio,
        mustChangePassword: false, // o cliente escolheu a própria senha
      });

      // Preço de tabela nasce aqui; next_due_date = NULL (trial AINDA não começou
      // — sem data o gate ADR-0016 não silencia e o clone fica em rascunho).
      await clientBilling.upsertBilling({
        slot,
        amountCents: config.PORTAL_SIGNUP_AMOUNT_CENTS,
        notes: 'signup self-service — trial inicia no pareamento (Missão 020 F1)',
      });

      await trialLedger.setTrialAwaiting(slot);
    } catch (e) {
      const err = e as { code?: string };
      if (err.code === '23505') {
        // Corrida entre o check e o INSERT (username único) — falha limpa.
        return reply.code(409).send({ error: 'conta_ja_existe' });
      }
      // Clone provisionado mas conta incompleta: loga o slot pra limpeza manual.
      log.error(
        { slot, err: e instanceof Error ? e.message : String(e) },
        'signup: clone provisionado mas criação de conta/billing falhou — revisar manual',
      );
      return reply.code(500).send({ error: 'erro_ao_criar_conta' });
    }

    // ── Auto-login (mesmo cookie/sessão do /auth/login) ─────────────────────────
    const authUser = await portalUsers.findPortalUserForAuth(canonical);
    if (authUser) {
      await portalUsers.recordSuccessfulLogin(authUser.id);
      const sid = await createSession({
        userId: authUser.id,
        username: authUser.username,
        slot,
        createdAt: Date.now(),
      });
      reply.setCookie(SESSION_COOKIE, sid, {
        httpOnly: true,
        secure: cookieSecure(),
        sameSite: 'lax',
        signed: true,
        path: '/',
        maxAge: config.PORTAL_SESSION_TTL_SECONDS,
      });
    }

    log.info({ phone: hint }, 'signup ok — conta + clone provisionados');
    return reply.code(201).send({
      ok: true,
      user: {
        username: canonical,
        display_name: nome_negocio,
        must_change_password: false,
      },
      // O trial NÃO começou: só conta a partir do pareamento (prova de posse).
      trial_started: false,
    });
  });
};
