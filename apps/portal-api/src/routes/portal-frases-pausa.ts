import { logger } from '@startap/core/logger';
/**
 * Frases de pausa/retomada editáveis pelo cliente no portal (SCRUM-59 → Onda 1 de-gate,
 * SCRUM-68 / ADR 0030). O dono cadastra as frases que, digitadas À MÃO no WhatsApp da própria
 * barbearia, pausam ("atendente assumiu") ou retomam o bot naquele contato.
 *
 * UNIVERSAL (Onda 1): serve TODO formato (individual/estabelecimento, agenda/atendente). O bot
 * já honra a keyword em todos os ramos do router (getFlowManualCommandForFlow) — só o EDITOR
 * estava preso ao modo atendente por acidente de rollout, sem requisito de domínio. Decisão do
 * Bruno (09/07): as frases ficam no PERFIL do cliente e é ELE quem define quais quiser
 * ("tirar a responsabilidade nossa do que der") — self-service total, sem passo do time.
 *
 * Escopado por request.tenant.slot (withTenant) — flow_id = slot; o slot NUNCA vem do
 * input (anti-IDOR, regra de ouro 5).
 *
 * Validação (o match do bot é por SUBSTRING de keyword_norm — manual-pause.ts): frase curta
 * ou substring de outra é perigosa (casa demais), por isso o mínimo de 4 chars normalizados
 * e a rejeição de substring/duplicata. keyword_norm é a normalização CANÔNICA compartilhada
 * (@startap/core/normalizePauseKeyword) — a MESMA que o bot usa pra casar.
 */
import { normalizePauseKeyword } from '@startap/core/pause-keyword';
import { pausa } from '@startap/db';
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { requireTenant, withTenant } from '../lib/tenant.js';

const log = logger.child({ service: 'portal-api', module: 'frases-pausa' });

const MAX_FRASES = 10;
const MIN_NORM_LEN = 4;

const fraseSchema = z
  .object({
    command: z.enum(['pause', 'resume']),
    keyword: z.string().trim().min(2, 'frase_muito_curta').max(80, 'frase_muito_longa'),
    enabled: z.boolean().optional().default(true),
  })
  .strict();

const putSchema = z
  .object({
    frases: z.array(fraseSchema).max(MAX_FRASES, 'frases_demais'),
  })
  .strict();

interface OutFrase {
  command: 'pause' | 'resume';
  keyword: string;
  enabled: boolean;
}

export const portalFrasesPausaRoutes: FastifyPluginAsync = async (app) => {
  // GET: lista as frases atuais do fluxo do dono. Universal (Onda 1): serve todo formato.
  app.get(
    '/portal/frases-pausa',
    { preHandler: withTenant },
    async (req: FastifyRequest, reply) => {
      const { slot } = requireTenant(req);

      const rows = await pausa.listFlowPauseKeywords(slot);
      const frases: OutFrase[] = rows.map((r) => ({
        command: r.command,
        keyword: r.keyword,
        enabled: r.enabled,
      }));
      return reply.code(200).send({ frases });
    },
  );

  // PUT: replace-set completo das frases do fluxo do dono.
  app.put(
    '/portal/frases-pausa',
    { preHandler: withTenant },
    async (req: FastifyRequest, reply) => {
      const { slot, userId } = requireTenant(req);

      const parsed = putSchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        return reply
          .code(400)
          .send({ error: parsed.error.issues[0]?.message ?? 'payload_invalido' });
      }

      // Normaliza + valida regras cruzadas (dedup + substring). O match do bot é por
      // substring, então frase curta/genérica ou substring de outra casaria demais.
      const rows: Array<{
        command: 'pause' | 'resume';
        keyword: string;
        keyword_norm: string;
        enabled: boolean;
      }> = [];
      for (const f of parsed.data.frases) {
        const keyword_norm = normalizePauseKeyword(f.keyword);
        if (keyword_norm.length < MIN_NORM_LEN) {
          return reply.code(400).send({ error: 'frase_muito_curta' });
        }
        // Duplicata exata por (command, keyword_norm).
        if (rows.some((r) => r.command === f.command && r.keyword_norm === keyword_norm)) {
          return reply.code(400).send({ error: 'frase_duplicada' });
        }
        rows.push({ command: f.command, keyword: f.keyword, keyword_norm, enabled: f.enabled });
      }
      // Substring: nenhuma keyword_norm pode conter/estar contida em outra (ambiguidade no
      // match por substring). Cobre também duplicata cross-command (A == B).
      for (let i = 0; i < rows.length; i++) {
        for (let j = 0; j < rows.length; j++) {
          if (i === j) continue;
          const a = rows[i]?.keyword_norm ?? '';
          const b = rows[j]?.keyword_norm ?? '';
          if (a.includes(b)) {
            return reply.code(400).send({ error: 'frase_ambigua' });
          }
        }
      }

      await pausa.replaceFlowPauseKeywords(slot, rows);
      log.info({ slot, userId, count: rows.length }, 'frases de pausa atualizadas via portal');

      const frases: OutFrase[] = rows.map((r) => ({
        command: r.command,
        keyword: r.keyword,
        enabled: r.enabled,
      }));
      return reply.code(200).send({ ok: true, frases });
    },
  );
};
