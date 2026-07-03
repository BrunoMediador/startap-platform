/**
 * Perfil do negocio editavel pelo cliente no portal (Missao 023 W13).
 *
 * O cliente edita nome_negocio, nome_prestador, telefone_contato, endereco,
 * instagram e formas_pagamento sem depender do gestao. Tudo vai no JSONB
 * flow_clones.personalizacao — MESMA fonte que o gestao grava (sem migration).
 *
 * Escopado por request.tenant.slot (withTenant). O slot NUNCA vem do input.
 * Validacao via perfilSchema compartilhado (@startap/core/schemas). Apos a
 * escrita, o data layer reusa updateClone -> re-renderiza o bot_prompt e
 * invalida o cache de clone (webhook pega a versao nova em ~0s).
 */
import { isModoAtendenteEnabled } from '@startap/core/modo-atendente-gate';
import { perfilSchema } from '@startap/core/schemas';
import { isValidIanaTimezone } from '@startap/core/timezones';
import { flowClones, portalConfig } from '@startap/db';
import type { FastifyPluginAsync } from 'fastify';
import { config } from '../config.js';
import { requireTenant, withTenant } from '../lib/tenant.js';

export const portalPerfilRoutes: FastifyPluginAsync = async (app) => {
  app.get('/portal/perfil', { preHandler: withTenant }, async (req, reply) => {
    const { slot } = requireTenant(req);
    const perfil = await portalConfig.getPerfilBySlot(slot);
    if (perfil === null) return reply.code(404).send({ error: 'fluxo nao encontrado' });
    // timezone (migration 068) é COLUNA top-level (fora do personalizacao) — devolvida
    // aqui pro front pré-selecionar o seletor. Nunca null (default SP no data layer).
    const timezone = await flowClones.getTimezoneBySlot(slot);
    // features: gate POR-CLONE do modo atendente (SCRUM-59). Contrato pro front (PR-D):
    // só o(s) clone(s) no MODO_ATENDENTE_SLOTS veem a seção "agenda automática / link".
    // Escopado pelo slot da SESSÃO (withTenant) — nunca do input.
    const modoAtendente = isModoAtendenteEnabled(slot, config.MODO_ATENDENTE_SLOTS);
    const features = { modo_atendente: modoAtendente };
    // recepcao_telefone (SCRUM-59): destino dos avisos de lead/escalação ao dono
    // (= flow_clones.alert_owner_phone RAW). Exposto SÓ quando o modo atendente está ON pro
    // clone (mesmo gate da seção). null quando não setado; o dono edita pelo campo do portal.
    const payload: Record<string, unknown> = { perfil, timezone, features };
    if (modoAtendente) {
      payload.recepcao_telefone = await flowClones.getAlertOwnerPhoneBySlot(slot);
    }
    return reply.code(200).send(payload);
  });

  app.put('/portal/perfil', { preHandler: withTenant }, async (req, reply) => {
    const { slot } = requireTenant(req);
    const body = (req.body ?? {}) as {
      perfil?: unknown;
      timezone?: unknown;
      recepcao_telefone?: unknown;
    };
    const parsed = perfilSchema.safeParse(body.perfil);
    if (!parsed.success) {
      return reply.code(400).send({
        error: 'perfil invalido',
        issues: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      });
    }
    // timezone é COLUNA top-level (NÃO entra no personalizacao/perfilSchema): validada
    // e gravada por caminho SEPARADO. Opcional — só toca a coluna se enviado; ausente
    // = byte-idêntico ao de hoje (mantém o fuso atual do clone). Inválido => 400 claro.
    let timezoneToSet: string | undefined;
    if (body.timezone !== undefined) {
      if (!isValidIanaTimezone(body.timezone)) {
        return reply.code(400).send({ error: 'timezone_invalido' });
      }
      timezoneToSet = body.timezone;
    }
    // recepcao_telefone (SCRUM-59): destino dos avisos ao dono (= flow_clones.alert_owner_phone,
    // COLUNA top-level, fora do perfilSchema). Só editável com o modo atendente ON pro clone
    // (defesa em profundidade — o front só mostra o campo então). Normaliza pra dígitos e exige
    // E.164 BR (12-13 dígitos começando com 55). Vazio/formato inválido => 400 (NÃO zera). Toda
    // validação ANTES de qualquer escrita (sem write parcial).
    let recepcaoToSet: string | undefined;
    if (body.recepcao_telefone !== undefined) {
      if (!isModoAtendenteEnabled(slot, config.MODO_ATENDENTE_SLOTS)) {
        return reply.code(404).send({ error: 'recepcao_telefone_indisponivel' });
      }
      const digits = (
        typeof body.recepcao_telefone === 'string' ? body.recepcao_telefone : ''
      ).replace(/\D/g, '');
      if (!/^55\d{10,11}$/.test(digits)) {
        return reply.code(400).send({ error: 'telefone_invalido' });
      }
      recepcaoToSet = digits;
    }
    const ok = await portalConfig.updatePerfilBySlot(slot, parsed.data);
    if (!ok) return reply.code(404).send({ error: 'fluxo nao encontrado' });
    // Escrita do fuso escopada ao slot da SESSÃO (withTenant) — nunca outro tenant.
    if (timezoneToSet !== undefined) {
      await flowClones.updateTimezoneBySlot(slot, timezoneToSet);
    }
    // Escrita do destino dos avisos, escopada ao slot da SESSÃO (anti-IDOR: slot nunca do body).
    if (recepcaoToSet !== undefined) {
      await flowClones.updateAlertOwnerPhoneBySlot(slot, recepcaoToSet);
    }
    // Devolve o perfil canonico (ja MERGE-ado/normalizado) + o fuso vigente pro front sincronizar.
    const perfil = await portalConfig.getPerfilBySlot(slot);
    const timezone = await flowClones.getTimezoneBySlot(slot);
    const out: Record<string, unknown> = { ok: true, perfil, timezone };
    if (isModoAtendenteEnabled(slot, config.MODO_ATENDENTE_SLOTS)) {
      out.recepcao_telefone = await flowClones.getAlertOwnerPhoneBySlot(slot);
    }
    return reply.code(200).send(out);
  });
};
