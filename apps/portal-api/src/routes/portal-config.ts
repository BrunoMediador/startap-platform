/**
 * Rotas de configuracao do fluxo editavel pelo cliente: servicos e horarios.
 * TODAS escopadas por request.tenant.slot (withTenant). O slot NUNCA vem do input.
 *
 * Validacao via schemas Zod compartilhados (@startap/core/schemas) — fonte unica
 * de verdade (ADR 0012, Decisao 6). Apos escrita, invalidateCloneCache (em
 * packages/db) garante que o webhook pegue a versao nova em ~0s.
 *
 * PUT /portal/servicos roda a validação cruzada serviço↔persona (ADR 0035) entre o safeParse e
 * o updateServicosBySlot: gate determinístico (diff + prompt_custom + indício de moeda na
 * persona) e, só se sobrar algo, 1 chamada de LLM. Kill-switch `SERVICO_VALIDACAO_CRUZADA_ENABLED`
 * — OFF (default) preserva o comportamento de hoje byte-a-byte, sem nenhuma chamada extra.
 */
import { logger } from '@startap/core/logger';
import { horariosSchema, servicosSchema } from '@startap/core/schemas';
import { botPrompt, cloneColaboradores, portalConfig } from '@startap/db';
import type { FastifyPluginAsync } from 'fastify';
import { config } from '../config.js';
import { validarConflitoServicoPersona } from '../lib/servico-persona-validator.js';
import { requireTenant, withTenant } from '../lib/tenant.js';

const log = logger.child({ service: 'portal-api', module: 'portal-config' });

export const portalConfigRoutes: FastifyPluginAsync = async (app) => {
  // ── Servicos ────────────────────────────────────────────────────────────
  app.get('/portal/servicos', { preHandler: withTenant }, async (req, reply) => {
    const { slot } = requireTenant(req);
    const servicos = await portalConfig.getServicosBySlot(slot);
    if (servicos === null) return reply.code(404).send({ error: 'fluxo nao encontrado' });
    return reply.code(200).send({ servicos });
  });

  app.put('/portal/servicos', { preHandler: withTenant }, async (req, reply) => {
    const { slot } = requireTenant(req);
    const body = (req.body ?? {}) as { servicos?: unknown };
    const parsed = servicosSchema.safeParse(body.servicos);
    if (!parsed.success) {
      return reply.code(400).send({
        error: 'servicos invalidos',
        issues: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      });
    }

    // ── Validação cruzada serviço↔persona (ADR 0035) ─────────────────────────────
    if (config.SERVICO_VALIDACAO_CRUZADA_ENABLED && config.OPENAI_API_KEY) {
      const servicosAtuais = await portalConfig.getServicosBySlot(slot);
      if (servicosAtuais === null) return reply.code(404).send({ error: 'fluxo nao encontrado' });

      // promptCustom via getAreaPromptCustomCartao (fail-OPEN — read informativo, default do
      // reader): erro transitório de DB aqui NÃO deve travar o save; cai em promptCustom=false,
      // que o validador já trata como "nada a checar" (degrau 2 do gate, ADR §D1.2).
      const { promptCustom } = await cloneColaboradores.getAreaPromptCustomCartao(slot);
      const personaAtual = promptCustom ? await botPrompt.getPrompt(slot) : null;

      const resultado = await validarConflitoServicoPersona({
        servicosAtuais,
        servicosNovos: parsed.data,
        promptCustom,
        personaAtual,
        opts: {
          model: config.SERVICO_VALIDATOR_MODEL,
          temperature: config.SERVICO_VALIDATOR_TEMPERATURE,
          timeoutMs: config.SERVICO_VALIDATOR_TIMEOUT_MS,
          apiKey: config.OPENAI_API_KEY,
        },
      });

      if (resultado.status === 'conflito') {
        log.info(
          { slot, servico: resultado.servico },
          'PUT /portal/servicos: conflito com persona',
        );
        return reply.code(409).send({
          error: 'conflito_persona',
          reason: 'preco_duplicado',
          servico: resultado.servico,
          trecho: resultado.trecho,
          mensagem: resultado.motivo,
        });
      }
      if (resultado.status === 'indisponivel') {
        log.warn(
          { slot, motivo: resultado.motivo },
          'PUT /portal/servicos: validador indisponível',
        );
        // 503, retriable — NUNCA acusa o dado (ADR §D2: o dono não pode ser levado a editar um
        // campo correto por causa de uma falha nossa).
        return reply.code(503).send({
          error: 'validacao_indisponivel',
          mensagem: 'Não consegui validar agora. Tente de novo em instantes.',
        });
      }
      // status 'ok': segue pro save normal.
    }

    const ok = await portalConfig.updateServicosBySlot(slot, parsed.data);
    if (!ok) return reply.code(404).send({ error: 'fluxo nao encontrado' });
    return reply.code(200).send({ ok: true, servicos: parsed.data });
  });

  // ── Horarios de funcionamento ─────────────────────────────────────────────
  app.get('/portal/horarios', { preHandler: withTenant }, async (req, reply) => {
    const { slot } = requireTenant(req);
    const horarios = await portalConfig.getHorariosBySlot(slot);
    if (horarios === null) return reply.code(404).send({ error: 'fluxo nao encontrado' });
    return reply.code(200).send({ horarios });
  });

  app.put('/portal/horarios', { preHandler: withTenant }, async (req, reply) => {
    const { slot } = requireTenant(req);
    const body = (req.body ?? {}) as { horarios?: unknown };
    const parsed = horariosSchema.safeParse(body.horarios);
    if (!parsed.success) {
      return reply.code(400).send({
        error: 'horarios invalidos',
        issues: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      });
    }
    const ok = await portalConfig.updateHorariosBySlot(slot, parsed.data);
    if (!ok) return reply.code(404).send({ error: 'fluxo nao encontrado' });
    return reply.code(200).send({ ok: true, horarios: parsed.data });
  });
};
