/**
 * Atendimentos + relatórios de faturamento e comissão do NEGÓCIO do cliente no portal
 * self-service (ADR 0026, Fase 1 MVP). FONTE DA VERDADE do dinheiro do cliente.
 *
 * ⚠️ DOMÍNIO SEPARADO (ADR 0026 §2): isto é o faturamento DELE. NUNCA tem a ver com
 * client_billing/AbacatePay (mensalidade B2B que ele paga PRA NÓS — outras rotas).
 *
 * DOIS CENÁRIOS:
 *   - SOLO (individual, ex: Cirilo/Samuel): atendimento com colaborador_id NULL ->
 *     só FATURAMENTO (sem split de comissão; o dono fica com tudo).
 *   - EMPRESA (estabelecimento, ex: barber_dragon): colaborador_id = profissional ->
 *     FATURAMENTO + COMISSÃO (% snapshot de clone_colaboradores).
 *
 * ISOLAMENTO (regra de ouro 5, ADR 0012 Decisão 4): o slot vem SEMPRE de
 * request.tenant.slot (withTenant) — NUNCA de body/query/params. O tenant_id é resolvido
 * do clone (getScopeBySlot), nunca de input. Anti-IDOR: colaborador_id do body é validado
 * pertencer ao slot antes de gravar (getColaboradorComissao -> belongs).
 *
 * GATING: flag ATENDIMENTOS_ENABLED OFF -> TODAS as rotas respondem 404 (feature dormente;
 * não vaza). Aplica aos dois cenários. Flag OFF = produção idêntica a hoje.
 */
import { logger } from '@startap/core/logger';
import { atendimentos, cloneColaboradores } from '@startap/db';
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { config } from '../config.js';
import { requireTenant, withTenant } from '../lib/tenant.js';

const log = logger.child({ service: 'portal-api', module: 'atendimentos' });

// Formas de pagamento aceitas (validadas no app — sem CHECK no banco). 'pacote' tem
// tratamento especial: zera o valor (a receita vive na venda do pacote, ADR 0026 §risco 1).
const FORMAS = ['dinheiro', 'pix', 'credito', 'debito', 'pacote', 'outro'] as const;

// Body do registro de atendimento. strict() rejeita campos extras (ex.: alguém tentando
// setar slot/tenant_id/comissao_cents pelo portal — esses vêm da sessão/cálculo, nunca do body).
const createSchema = z
  .object({
    servico_nome: z.string().trim().min(1).max(160).optional(),
    valor_cents: z.number().int().min(0).max(100_000_000), // teto sanidade R$1M
    desconto_cents: z.number().int().min(0).max(100_000_000).optional(),
    // clone_colaboradores.id é BIGSERIAL — o driver pg o serializa como STRING ("4")
    // na rede; qualquer caller (front, integração) pode reenviar esse id como string.
    // coerce aceita "4" e 4, coage pra Number, e ainda rejeita lixo ("abc"). Mantém
    // opcional: SOLO omite colaborador_id (sem split de comissão). Ver fix do 400.
    colaborador_id: z.coerce.number().int().positive().optional(),
    forma_pagamento: z.enum(FORMAS).optional(),
    cliente_nome: z.string().trim().max(160).optional(),
    cliente_contato: z.string().trim().max(64).optional(),
    gcal_event_id: z.string().trim().max(256).optional(),
    data: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/, 'data deve ser YYYY-MM-DD')
      .optional(),
  })
  .strict();

// Query dos relatórios: período obrigatório [de, ate], ambos YYYY-MM-DD.
const periodoSchema = z.object({
  de: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'de deve ser YYYY-MM-DD'),
  ate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'ate deve ser YYYY-MM-DD'),
});

/**
 * Gate: flag + resolução de tenant_id do slot da sessão. Responde 404 (flag OFF) ou 409
 * (clone sem tenant_id — dado inconsistente) e devolve null; senão devolve o escopo.
 */
async function gateAtendimentos(
  req: FastifyRequest,
  reply: FastifyReply,
): Promise<{ slot: string; tenantId: string } | null> {
  if (!config.ATENDIMENTOS_ENABLED) {
    await reply.code(404).send({ error: 'recurso indisponivel' });
    return null;
  }
  const { slot } = requireTenant(req);
  const scope = await cloneColaboradores.getScopeBySlot(slot);
  if (!scope.tenant_id) {
    // Sem tenant_id não há como carimbar a linha (regra de ouro 5). Não grava.
    await reply.code(409).send({ error: 'cliente sem tenant_id (dado inconsistente)' });
    return null;
  }
  return { slot, tenantId: scope.tenant_id };
}

export const portalAtendimentosRoutes: FastifyPluginAsync = async (app) => {
  // POST /portal/atendimentos — registra/conclui um atendimento (faturamento + comissão).
  app.post('/portal/atendimentos', { preHandler: withTenant }, async (req, reply) => {
    const gate = await gateAtendimentos(req, reply);
    if (!gate) return reply;

    const parsed = createSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({
        error: 'dados invalidos',
        issues: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      });
    }
    const b = parsed.data;

    // Anti-IDOR: se veio colaborador_id, ele PRECISA pertencer a este slot. Senão 400
    // (não vaza existência cross-tenant; trata como input inválido do próprio cliente).
    if (b.colaborador_id != null) {
      const { belongs } = await atendimentos.getColaboradorComissao(gate.slot, b.colaborador_id);
      if (!belongs) {
        return reply.code(400).send({ error: 'colaborador_id invalido para este cliente' });
      }
    }

    const row = await atendimentos.createAtendimento({
      slot: gate.slot,
      tenantId: gate.tenantId,
      servicoNome: b.servico_nome ?? null,
      valorCents: b.valor_cents,
      descontoCents: b.desconto_cents ?? 0,
      colaboradorId: b.colaborador_id ?? null,
      formaPagamento: b.forma_pagamento ?? null,
      clienteNome: b.cliente_nome ?? null,
      clienteContato: b.cliente_contato ?? null,
      gcalEventId: b.gcal_event_id ?? null,
      data: b.data ?? null,
    });

    // LGPD: não logar cliente_contato/cliente_nome em claro (regra de ouro 6).
    log.info(
      {
        slot: gate.slot,
        atendimentoId: row.id,
        colaboradorId: row.colaborador_id,
        comissaoCents: row.comissao_cents,
      },
      'atendimento registrado (portal)',
    );
    return reply.code(201).send({ ok: true, atendimento: row });
  });

  // GET /portal/relatorios/faturamento?de=&ate= — total, por forma, por profissional.
  app.get('/portal/relatorios/faturamento', { preHandler: withTenant }, async (req, reply) => {
    const gate = await gateAtendimentos(req, reply);
    if (!gate) return reply;
    const parsed = periodoSchema.safeParse(req.query ?? {});
    if (!parsed.success) {
      return reply.code(400).send({
        error: 'periodo invalido',
        issues: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      });
    }
    const report = await atendimentos.getFaturamento(
      gate.slot,
      gate.tenantId,
      parsed.data.de,
      parsed.data.ate,
    );
    return reply.code(200).send(report);
  });

  // GET /portal/relatorios/comissao?de=&ate= — comissão a pagar por profissional.
  app.get('/portal/relatorios/comissao', { preHandler: withTenant }, async (req, reply) => {
    const gate = await gateAtendimentos(req, reply);
    if (!gate) return reply;
    const parsed = periodoSchema.safeParse(req.query ?? {});
    if (!parsed.success) {
      return reply.code(400).send({
        error: 'periodo invalido',
        issues: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      });
    }
    const report = await atendimentos.getComissao(
      gate.slot,
      gate.tenantId,
      parsed.data.de,
      parsed.data.ate,
    );
    return reply.code(200).send(report);
  });
};
