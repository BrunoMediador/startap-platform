/**
 * Equipe (colaboradores) do DONO de um estabelecimento no portal self-service
 * (Fatia 1 do painel de estabelecimento — design ADR 0023/0024).
 *
 * O dono LISTA e EDITA colaboradores (renomeia, serviços, ativo/inativo, ordem) e
 * vê o uso de vagas (seat_cap). NÃO CRIA nem REMOVE colaborador pelo portal: o
 * preço é por barbeiro e o operador pré-provisiona EXATAMENTE seat_cap vagas, cada
 * uma com agenda Google já conectada (ADR 0024, agenda assistida). Criar pelo portal
 * geraria barbeiro SEM agenda (o portal não conecta calendarId); remover apagaria a
 * agenda pré-provisionada e quebraria o setup + o modelo de custo. Criação/remoção
 * vivem SÓ no GESTÃO (operador, painel-admin + @startap/db). NÃO gerencia
 * agenda/calendarId aqui nem pacotes/plano (fatias posteriores).
 *
 * O dono TAMBÉM gera/regenera a SENHA DE LOGIN de um colaborador dele aqui
 * (POST /portal/equipe/:id/gerar-senha — paridade com o botão do gestão, SCRUM-32
 * follow-up). Gated por COLABORADOR_PORTAL_ENABLED + product_type estabelecimento;
 * reusa a MESMA lógica de credencial do gestão (@startap/db colaboradorAuth).
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
import { ColaboradorRuleError, cloneColaboradores, colaboradorAuth } from '@startap/db';
import bcrypt from 'bcryptjs';
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { config } from '../config.js';
import { genColaboradorPassword } from '../lib/colaborador-credencial.js';
import { requireTenant, withTenant } from '../lib/tenant.js';

const log = logger.child({ service: 'portal-api', module: 'equipe' });

// % de comissão sobre o BRUTO (cenário EMPRESA, ADR 0026). 0–100, 2 casas. Opcional
// no update: ausente => NÃO altera o valor.
const comissaoPctSchema = z.number().min(0).max(100);

// Body de edição: todos os campos opcionais (PATCH parcial). strict() rejeita campos
// extras (ex.: alguém tentando setar gcal_calendar_id/tenant pelo portal — agenda é
// assistida, tenant vem da sessão).
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

interface EstabScope {
  slot: string;
  tenantId: string;
  seatCap: number | null;
}

/**
 * Resolve o escopo do estabelecimento (product_type + seat_cap + tenant_id) escopado
 * pelo slot da SESSÃO (withTenant), SEM checar flag. Retorna o escopo já validado, ou
 * null se a requisição já foi respondida (409) — o caller deve então retornar. Os dois
 * gates abaixo (gateEstabelecimento / gateColaboradorCredencial) reusam isto e só
 * diferem na FLAG que liga cada superfície.
 */
async function resolveEstabScope(
  req: FastifyRequest,
  reply: FastifyReply,
): Promise<EstabScope | null> {
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

/**
 * Gate das rotas de EQUIPE (listar/editar). Flag ESTABELECIMENTO_ENABLED (404 se OFF)
 * + product_type do clone (409 se individual). Retorna o escopo ou null (já respondido).
 */
async function gateEstabelecimento(
  req: FastifyRequest,
  reply: FastifyReply,
): Promise<EstabScope | null> {
  if (!config.ESTABELECIMENTO_ENABLED) {
    await reply.code(404).send({ error: 'recurso indisponivel' });
    return null;
  }
  return resolveEstabScope(req, reply);
}

/**
 * Gate da rota de CREDENCIAL do colaborador (gerar/regenerar senha). Gated pela MESMA
 * flag do painel do colaborador (COLABORADOR_PORTAL_ENABLED, 404 se OFF) — sem login de
 * colaborador habilitado a credencial não tem pra que existir. Mais o product_type do
 * clone (409 se individual). Retorna o escopo ou null (já respondido).
 */
async function gateColaboradorCredencial(
  req: FastifyRequest,
  reply: FastifyReply,
): Promise<EstabScope | null> {
  if (!config.COLABORADOR_PORTAL_ENABLED) {
    await reply.code(404).send({ error: 'recurso indisponivel' });
    return null;
  }
  return resolveEstabScope(req, reply);
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

  // Criar (POST) e remover (DELETE) colaborador NÃO existem no portal de propósito:
  // o operador pré-provisiona as vagas (com agenda) no gestão; o dono só personaliza
  // as vagas existentes via PATCH abaixo. POST/DELETE caem no 404 padrão do Fastify.

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

  // POST /portal/equipe/:id/gerar-senha — o DONO gera/REGENERA a senha de login de UM
  // colaborador DELE no portal (paridade com o botão do gestão; o dono não precisa do
  // painel interno). MESMA lógica de credencial do gestão (@startap/db colaboradorAuth):
  // username = slug do nome (único global), senha forte aleatória, grava SÓ o hash bcrypt;
  // a senha em claro aparece UMA vez na resposta. Regenerar INVALIDA a anterior
  // (upsertCredentials, ON CONFLICT DO UPDATE — idempotente). NUNCA loga/persiste a senha.
  //
  // ANTI-IDOR (regra de ouro 5): o slot vem da SESSÃO (withTenant) — nunca de input — e o
  // colaborador é resolvido DENTRO desse slot (listBySlot). Trocar o :id por um colaborador
  // de outro tenant cai no 404 (não está na lista do slot do dono); o id NUNCA seleciona
  // fora do tenant. withTenant ainda barra qualquer sessão de COLABORADOR (só o dono passa).
  app.post('/portal/equipe/:id/gerar-senha', { preHandler: withTenant }, async (req, reply) => {
    const gate = await gateColaboradorCredencial(req, reply);
    if (!gate) return reply;
    const id = await parseId(req, reply);
    if (id === null) return reply;

    // Anti-IDOR: listBySlot é escopado pelo slot da sessão; um id de outro tenant não
    // aparece aqui -> 404. (Resolvido pelo MESMO caminho do gestão: slot+id.)
    // Number(c.id) === id: defesa em profundidade contra o id BIGINT vir como string do
    // pg (a data layer já normaliza, mas o `===` aqui não pode depender disso) — sem
    // isso, '4' === 4 dava false e o colaborador EXISTENTE caía no 404.
    const colaboradores = await cloneColaboradores.listBySlot(gate.slot);
    const colaborador = colaboradores.find((c) => Number(c.id) === id);
    if (!colaborador) {
      return reply.code(404).send({ error: 'colaborador nao encontrado' });
    }

    // username GLOBALMENTE único (slug do nome + sufixo) — MESMA regra do gestão.
    const taken = await colaboradorAuth.listTakenUsernames(id);
    const username = colaboradorAuth.deriveColaboradorUsername(colaborador.nome, taken);

    // Senha forte; só o HASH vai pro banco (cost do config, MESMO esquema de portal_users).
    const plainPassword = genColaboradorPassword();
    const passwordHash = await bcrypt.hash(plainPassword, config.PORTAL_BCRYPT_COST);

    const cred = await colaboradorAuth.upsertCredentials({
      colaboradorId: id,
      slot: gate.slot,
      tenantId: gate.tenantId,
      username,
      passwordHash,
    });

    // Auditoria SEM a senha (só slot + id + username). Nunca o texto puro (LGPD).
    log.info(
      { slot: gate.slot, colaboradorId: id, username: cred.username },
      'credencial de colaborador gerada (portal, pelo dono)',
    );

    // Resposta carrega um SEGREDO -> nunca cacheia. A senha em claro aparece UMA vez.
    reply.header('Cache-Control', 'no-store');
    return reply
      .code(201)
      .send({ ok: true, username: cred.username, generated_password: plainPassword });
  });
};
