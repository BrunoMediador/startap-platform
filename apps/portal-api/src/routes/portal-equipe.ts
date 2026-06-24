/**
 * Equipe (colaboradores) do DONO de um estabelecimento no portal self-service
 * (Fatia 1 do painel de estabelecimento — design ADR 0023/0024).
 *
 * O dono LISTA / ADICIONA / EDITA / REMOVE colaboradores (nome, serviços, ativo,
 * ordem) e vê o uso de vagas (seat_cap). NÃO gerencia agenda/calendarId aqui (fica
 * assistido pelo operador, ADR 0024) nem pacotes/plano (fatias posteriores).
 *
 * ISOLAMENTO (regra de ouro 5, ADR 0012 Decisão 4): o slot vem SEMPRE de
 * request.tenant.slot (withTenant) — NUNCA de body/query/params. Não existe rota
 * por cloneId aqui (isso é do gestão, onde o operador escolhe o cliente). O dono
 * só alcança o PRÓPRIO estabelecimento.
 *
 * GATING em PROFUNDIDADE (duas barreiras, além do gating de UI):
 *   1. flag ESTABELECIMENTO_ENABLED OFF -> todas as rotas respondem 404 (feature
 *      dormente; o portal nem mostra o item de menu).
 *   2. product_type do clone != 'estabelecimento' -> 409 (um individual não
 *      alcança escrita de colaborador nem por chamada direta — mesmo contrato do
 *      gestão, server.js:6032).
 *
 * Regras de negócio (seat_cap, homônimo 23505) vivem em @startap/db
 * (cloneColaboradores) — UMA fonte de verdade compartilhada com o gestão.
 */
import { logger } from '@startap/core/logger';
import { ColaboradorRuleError, cloneColaboradores } from '@startap/db';
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { config } from '../config.js';
import { requireTenant, withTenant } from '../lib/tenant.js';

const log = logger.child({ service: 'portal-api', module: 'equipe' });

// % de comissão sobre o BRUTO (cenário EMPRESA, ADR 0026). 0–100, 2 casas. Opcional:
// no create ausente => 0 (default da coluna); no update ausente => NÃO altera o valor.
const comissaoPctSchema = z.number().min(0).max(100);

// Body de criação. strict() rejeita campos extras (ex.: alguém tentando setar
// gcal_calendar_id/tenant pelo portal — agenda é assistida, tenant vem da sessão).
const createSchema = z
  .object({
    nome: z.string().trim().min(1).max(160),
    servicos: z.array(z.string()).max(50).optional(),
    ativo: z.boolean().optional(),
    ordem: z.number().int().optional(),
    comissao_pct: comissaoPctSchema.optional(),
  })
  .strict();

// Body de edição: todos os campos opcionais (PATCH parcial). strict() idem.
const updateSchema = z
  .object({
    nome: z.string().trim().min(1).max(160).optional(),
    servicos: z.array(z.string()).max(50).optional(),
    ativo: z.boolean().optional(),
    ordem: z.number().int().optional(),
    comissao_pct: comissaoPctSchema.optional(),
  })
  .strict();

/**
 * Mapeia ColaboradorRuleError -> resposta HTTP. `unknown_servico` é input inválido
 * do dono (serviço fora do catálogo) -> 400; os demais (seat_cap, homônimo) são
 * conflito de estado/regra -> 409. Mensagem amigável em ambos.
 */
function sendRuleError(reply: FastifyReply, e: ColaboradorRuleError): FastifyReply {
  const status = e.code === 'unknown_servico' ? 400 : 409;
  return reply.code(status).send({ error: e.message, code: e.code });
}

/**
 * Resolve o escopo do estabelecimento (product_type + seat_cap + tenant_id) e
 * aplica as DUAS barreiras de gating. Retorna o escopo já validado, ou null se
 * a requisição já foi respondida (404/409) — o caller deve então retornar.
 */
async function gateEstabelecimento(
  req: FastifyRequest,
  reply: FastifyReply,
): Promise<{ slot: string; tenantId: string; seatCap: number | null } | null> {
  if (!config.ESTABELECIMENTO_ENABLED) {
    await reply.code(404).send({ error: 'recurso indisponivel' });
    return null;
  }
  const { slot } = requireTenant(req);
  const scope = await cloneColaboradores.getScopeBySlot(slot);
  if (scope.product_type !== 'estabelecimento') {
    await reply
      .code(409)
      .send({ error: 'colaboradores so existem em clientes do tipo estabelecimento' });
    return null;
  }
  if (!scope.tenant_id) {
    // Dado inconsistente (clone sem tenant_id) — não cria colaborador sem tenant.
    await reply.code(409).send({ error: 'estabelecimento sem tenant_id (dado inconsistente)' });
    return null;
  }
  return { slot, tenantId: scope.tenant_id, seatCap: scope.seat_cap };
}

/** Valida e devolve o :id da rota como inteiro positivo, ou responde 400 e devolve null. */
async function parseId(req: FastifyRequest, reply: FastifyReply): Promise<number | null> {
  const id = Number((req.params as { id?: string }).id);
  if (!Number.isInteger(id) || id <= 0) {
    await reply.code(400).send({ error: 'id invalido' });
    return null;
  }
  return id;
}

export const portalEquipeRoutes: FastifyPluginAsync = async (app) => {
  // GET /portal/equipe — lista colaboradores + uso de vagas (seat_cap).
  app.get('/portal/equipe', { preHandler: withTenant }, async (req, reply) => {
    const gate = await gateEstabelecimento(req, reply);
    if (!gate) return reply;
    const colaboradores = await cloneColaboradores.listBySlot(gate.slot);
    const usados = colaboradores.filter((c) => c.ativo === true).length;
    return reply.code(200).send({ seat_cap: gate.seatCap, usados, colaboradores });
  });

  // POST /portal/equipe — cria colaborador (respeita seat_cap p/ ATIVOS).
  app.post('/portal/equipe', { preHandler: withTenant }, async (req, reply) => {
    const gate = await gateEstabelecimento(req, reply);
    if (!gate) return reply;
    const parsed = createSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({
        error: 'dados invalidos',
        issues: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      });
    }
    try {
      const colaborador = await cloneColaboradores.create(
        { slot: gate.slot, tenantId: gate.tenantId, ...parsed.data },
        gate.seatCap,
      );
      log.info({ slot: gate.slot, colaboradorId: colaborador.id }, 'colaborador criado (portal)');
      return reply.code(201).send({ ok: true, colaborador });
    } catch (e) {
      if (e instanceof ColaboradorRuleError) return sendRuleError(reply, e);
      throw e;
    }
  });

  // PATCH /portal/equipe/:id — edita nome/serviços/ativo/ordem (revalida seat_cap ao ATIVAR).
  app.patch('/portal/equipe/:id', { preHandler: withTenant }, async (req, reply) => {
    const gate = await gateEstabelecimento(req, reply);
    if (!gate) return reply;
    const id = await parseId(req, reply);
    if (id === null) return reply;
    const parsed = updateSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({
        error: 'dados invalidos',
        issues: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      });
    }
    if (Object.keys(parsed.data).length === 0) {
      return reply.code(400).send({ error: 'nada a atualizar' });
    }
    try {
      const colaborador = await cloneColaboradores.update(gate.slot, id, parsed.data, gate.seatCap);
      if (!colaborador) {
        return reply.code(404).send({ error: 'colaborador nao encontrado' });
      }
      log.info({ slot: gate.slot, colaboradorId: id }, 'colaborador atualizado (portal)');
      return reply.code(200).send({ ok: true, colaborador });
    } catch (e) {
      if (e instanceof ColaboradorRuleError) return sendRuleError(reply, e);
      throw e;
    }
  });

  // DELETE /portal/equipe/:id — remove colaborador (escopado por slot).
  app.delete('/portal/equipe/:id', { preHandler: withTenant }, async (req, reply) => {
    const gate = await gateEstabelecimento(req, reply);
    if (!gate) return reply;
    const id = await parseId(req, reply);
    if (id === null) return reply;
    const ok = await cloneColaboradores.remove(gate.slot, id);
    if (!ok) return reply.code(404).send({ error: 'colaborador nao encontrado' });
    log.info({ slot: gate.slot, colaboradorId: id }, 'colaborador removido (portal)');
    return reply.code(200).send({ ok: true });
  });
};
