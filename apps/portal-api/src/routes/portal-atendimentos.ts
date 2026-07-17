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
 *
 * ADR 0027 (billing derivado da agenda) — endpoints ADITIVOS:
 *   - GET    /portal/atendimentos?balde=previsao|faturado&de=&ate=  — lista por balde.
 *   - PATCH  /portal/atendimentos/:id                                — edição manual STICKY
 *            (cada campo enviado é pinado em dirty_fields; não volta pro catálogo).
 *   - DELETE /portal/atendimentos/:id                                — soft-delete (some).
 * Os relatórios contam SÓ linhas FATURADAS (passado) e NÃO deletadas; comissão idem.
 * A env ATEND_FROM_AGENDA_SLOTS (gate POR-CLONE) gateia o GANCHO de criar-no-agendamento
 * (Fase B2, fora deste arquivo); estes endpoints existem sob ATENDIMENTOS_ENABLED e o
 * front gateia as abas por atend_from_agenda (exposto no /auth/me, já resolvido por slot).
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

// Query do relatório de COMISSÃO: período + balde OPCIONAL (default 'faturado' =
// comportamento histórico). 'previsao' = comissão projetada dos agendamentos futuros (ADR 0027).
const comissaoQuerySchema = periodoSchema.extend({
  balde: z.enum(['previsao', 'faturado']).default('faturado'),
});

// Query da LISTAGEM por balde (ADR 0027): balde + período obrigatórios.
const listSchema = z.object({
  balde: z.enum(['previsao', 'faturado']),
  de: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'de deve ser YYYY-MM-DD'),
  ate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'ate deve ser YYYY-MM-DD'),
});

// Body do PATCH (edição manual STICKY): só os campos editáveis pelo dono. Cada um enviado
// é PINADO em dirty_fields (não volta pro catálogo). strict() rejeita forjar slot/tenant/
// comissao/dirty_fields/origem. .partial() — mas exige ≥1 campo via .refine() na rota.
const patchSchema = z
  .object({
    valor_cents: z.number().int().min(0).max(100_000_000),
    desconto_cents: z.number().int().min(0).max(100_000_000),
    forma_pagamento: z.enum(FORMAS),
    servico_nome: z.string().trim().min(1).max(160),
    cliente_nome: z.string().trim().max(160),
  })
  .partial()
  .strict();

// :id do path — o id é BIGSERIAL e o pg serializa como STRING ("4"); coerce aceita "4"/4,
// coage pra Number e rejeita lixo. positivo (sem id 0/negativo).
const idParamSchema = z.object({
  id: z.coerce.number().int().positive(),
});

// :eventId do path (GET by-evento) — gcal_event_id (alfanumérico base32hex). Sanidade leve;
// o escopo real (slot+tenant) é aplicado na data layer (anti-IDOR). Mesmo regex do agendamento.
const eventIdParamSchema = z.object({
  eventId: z
    .string()
    .trim()
    .min(1)
    .max(1024)
    .regex(/^[a-z0-9_-]+$/i, 'eventId invalido'),
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

  // GET /portal/atendimentos?balde=previsao|faturado&de=&ate= — lista por balde (ADR 0027).
  // previsao = futuro/aberto (fim_at > now()); faturado = passado ou walk-in manual.
  // total_cents = SUM(valor - desconto) das linhas listadas. Escopo slot+tenant da sessão.
  app.get('/portal/atendimentos', { preHandler: withTenant }, async (req, reply) => {
    const gate = await gateAtendimentos(req, reply);
    if (!gate) return reply;
    const parsed = listSchema.safeParse(req.query ?? {});
    if (!parsed.success) {
      return reply.code(400).send({
        error: 'parametros invalidos',
        issues: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      });
    }
    const { atendimentos: rows, total_cents } = await atendimentos.listAtendimentos(
      gate.slot,
      gate.tenantId,
      parsed.data.balde,
      parsed.data.de,
      parsed.data.ate,
    );
    return reply.code(200).send({ atendimentos: rows, total_cents });
  });

  // GET /portal/atendimentos/by-evento/:eventId — resolve a linha de atendimento ATIVA de um
  // evento da agenda pelo gcal_event_id (pré-req do front: o card da agenda só tem o eventId;
  // pra editar valor/desconto na /billing precisa do id numérico da linha). Devolve a MESMA
  // AtendimentoListRow do GET list. Escopado por slot+tenant da SESSÃO (anti-IDOR): eventId de
  // outro tenant -> 404 (não vaza existência). Gated por ATENDIMENTOS_ENABLED (flag OFF -> 404).
  app.get(
    '/portal/atendimentos/by-evento/:eventId',
    { preHandler: withTenant },
    async (req, reply) => {
      const gate = await gateAtendimentos(req, reply);
      if (!gate) return reply;

      const parsed = eventIdParamSchema.safeParse(req.params ?? {});
      if (!parsed.success) {
        return reply.code(400).send({ error: 'eventId invalido' });
      }
      const row = await atendimentos.getAtendimentoByEvent(
        gate.slot,
        gate.tenantId,
        parsed.data.eventId,
      );
      if (!row) {
        // Não existe atendimento ativo desse evento NO ESCOPO (ou eventId alheio) -> 404 (anti-IDOR).
        return reply.code(404).send({ error: 'atendimento nao encontrado' });
      }
      // CONTRATO: o front consome a AtendimentoListRow DIRETO (sem envelope) — 200 | 404.
      return reply.code(200).send(row);
    },
  );

  // PATCH /portal/atendimentos/:id — edição manual STICKY. Cada campo enviado é gravado E
  // PINADO em dirty_fields (não volta pro catálogo num upsert futuro do evento). Escopado
  // por slot+tenant (anti-IDOR): id de outro cliente -> 404 (não vaza existência).
  app.patch('/portal/atendimentos/:id', { preHandler: withTenant }, async (req, reply) => {
    const gate = await gateAtendimentos(req, reply);
    if (!gate) return reply;

    const idParsed = idParamSchema.safeParse(req.params ?? {});
    if (!idParsed.success) {
      return reply.code(400).send({ error: 'id invalido' });
    }
    const bodyParsed = patchSchema.safeParse(req.body ?? {});
    if (!bodyParsed.success) {
      return reply.code(400).send({
        error: 'dados invalidos',
        issues: bodyParsed.error.issues.map((i) => ({
          path: i.path.join('.'),
          message: i.message,
        })),
      });
    }
    const b = bodyParsed.data;
    if (Object.keys(b).length === 0) {
      return reply.code(400).send({ error: 'envie ao menos um campo para alterar' });
    }

    const row = await atendimentos.patchAtendimento(gate.slot, gate.tenantId, idParsed.data.id, {
      valorCents: b.valor_cents,
      descontoCents: b.desconto_cents,
      formaPagamento: b.forma_pagamento,
      servicoNome: b.servico_nome,
      clienteNome: b.cliente_nome,
    });
    if (!row) {
      // Não existe NO ESCOPO (ou deletado) — 404 (anti-IDOR: não distingue alheio de ausente).
      return reply.code(404).send({ error: 'atendimento nao encontrado' });
    }

    log.info(
      { slot: gate.slot, atendimentoId: row.id, dirtyFields: row.dirty_fields },
      'atendimento editado (portal, sticky)',
    );
    return reply.code(200).send({ ok: true, atendimento: row });
  });

  // DELETE /portal/atendimentos/:id — soft-delete ("some de tudo"; sem estorno/trilha).
  // Escopado por slot+tenant (anti-IDOR). Idempotente: já deletado/ausente -> 404.
  app.delete('/portal/atendimentos/:id', { preHandler: withTenant }, async (req, reply) => {
    const gate = await gateAtendimentos(req, reply);
    if (!gate) return reply;

    const idParsed = idParamSchema.safeParse(req.params ?? {});
    if (!idParsed.success) {
      return reply.code(400).send({ error: 'id invalido' });
    }
    // SCRUM-90: carimba a origem da deleção (DELETE do operador no portal) na trilha durável.
    const ok = await atendimentos.softDeleteAtendimentoById(
      gate.slot,
      gate.tenantId,
      idParsed.data.id,
      { reason: 'portal_delete', by: 'portal' },
    );
    if (!ok) {
      return reply.code(404).send({ error: 'atendimento nao encontrado' });
    }
    log.info(
      { slot: gate.slot, atendimentoId: idParsed.data.id },
      'atendimento removido (portal, soft-delete)',
    );
    return reply.code(200).send({ ok: true });
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

  // GET /portal/relatorios/comissao?de=&ate=&balde=previsao|faturado — comissão por profissional.
  // balde=faturado (DEFAULT) = comissão sobre o REALIZADO (snapshot congelado, comportamento
  // histórico). balde=previsao = comissão PROJETADA dos agendamentos futuros (ADR 0027), com o
  // pct CORRENTE do colaborador. SOLO -> lista vazia/0 nos dois. Escopo slot+tenant da sessão.
  app.get('/portal/relatorios/comissao', { preHandler: withTenant }, async (req, reply) => {
    const gate = await gateAtendimentos(req, reply);
    if (!gate) return reply;
    const parsed = comissaoQuerySchema.safeParse(req.query ?? {});
    if (!parsed.success) {
      return reply.code(400).send({
        error: 'parametros invalidos',
        issues: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      });
    }
    const report = await atendimentos.getComissao(
      gate.slot,
      gate.tenantId,
      parsed.data.de,
      parsed.data.ate,
      parsed.data.balde,
    );
    return reply.code(200).send(report);
  });
};
