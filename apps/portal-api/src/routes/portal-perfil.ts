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
import { isFaqPersonalizadoEnabled } from '@startap/core/faq-personalizado-gate';
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
    // features.faq_personalizado (SCRUM-65): gate POR-CLONE. Só o(s) clone(s) no
    // FAQ_PERSONALIZADO_SLOTS veem a seção de FAQ personalizado. Mesmo padrão do modo_atendente;
    // o front usa esse boolean como `enabled` da query (clone fora do gate = zero request).
    const faqPersonalizado = isFaqPersonalizadoEnabled(slot, config.FAQ_PERSONALIZADO_SLOTS);
    const features = { modo_atendente: modoAtendente, faq_personalizado: faqPersonalizado };
    // recepcao_telefone (SCRUM-59 → Onda 1 de-gate, SCRUM-68 / ADR 0030): destino dos avisos de
    // lead/escalação/desconexão ao dono (= flow_clones.alert_owner_phone RAW). UNIVERSAL: exposto
    // pra TODO formato (individual/estabelecimento, agenda/atendente). O alert_owner_phone já é
    // usado por todos os kinds de alerta — só o EDITOR estava preso ao modo atendente por acidente
    // de rollout. null quando não setado -> o bot cai no fallback "número da própria sessão"
    // (SCRUM-62, intacto). O dono edita pelo campo do portal.
    const payload: Record<string, unknown> = { perfil, timezone, features };
    payload.recepcao_telefone = await flowClones.getAlertOwnerPhoneBySlot(slot);
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
    // FAQ personalizado (SCRUM-65): a chave só é aceita com o gate ON pro clone (defesa em
    // profundidade — o front só mostra a seção então). Checa presença RAW no perfil ANTES de
    // qualquer escrita (o schema strict aceitaria a chave; o gate é a autorização). Fora do gate
    // e chave presente => 404 indisponivel (coerente com recepcao_telefone). Ausente = byte-a-byte.
    const rawPerfil = (body.perfil ?? {}) as Record<string, unknown>;
    if (
      rawPerfil.faq_personalizado !== undefined &&
      !isFaqPersonalizadoEnabled(slot, config.FAQ_PERSONALIZADO_SLOTS)
    ) {
      return reply.code(404).send({ error: 'faq_personalizado_indisponivel' });
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
    // recepcao_telefone (SCRUM-59/62 → Onda 1 de-gate, SCRUM-68 / ADR 0030): destino dos avisos ao
    // dono (= flow_clones.alert_owner_phone, COLUNA top-level, fora do perfilSchema). UNIVERSAL:
    // editável por TODO formato (o gate modo-atendente era acidente de rollout; alert_owner_phone
    // já serve todos os kinds de alerta). Validação mantida INTACTA. Tri-estado:
    //   - AUSENTE (undefined)       -> não toca a coluna (byte-a-byte).
    //   - VAZIO/null                -> CLEAR: grava NULL (dono optou por não ter destino
    //                                  dedicado; o alerta cai no fallback da PRÓPRIA sessão via
    //                                  getCloneAlertOwner -> cliente_telefone). Vazio NÃO é erro.
    //   - NÃO-VAZIO que casa E.164 BR -> SET (12-13 dígitos começando com 55).
    //   - NÃO-VAZIO que NÃO casa      -> 400 telefone_invalido (erro real de digitação).
    // Toda validação ANTES de qualquer escrita (sem write parcial).
    let recepcaoAction: { kind: 'clear' } | { kind: 'set'; digits: string } | undefined;
    if (body.recepcao_telefone !== undefined) {
      const raw = body.recepcao_telefone == null ? '' : String(body.recepcao_telefone);
      const digits = raw.replace(/\D/g, '');
      if (digits.length === 0) {
        recepcaoAction = { kind: 'clear' };
      } else if (!/^55\d{10,11}$/.test(digits)) {
        return reply.code(400).send({ error: 'telefone_invalido' });
      } else {
        recepcaoAction = { kind: 'set', digits };
      }
    }
    const ok = await portalConfig.updatePerfilBySlot(slot, parsed.data);
    if (!ok) return reply.code(404).send({ error: 'fluxo nao encontrado' });
    // Escrita do fuso escopada ao slot da SESSÃO (withTenant) — nunca outro tenant.
    if (timezoneToSet !== undefined) {
      await flowClones.updateTimezoneBySlot(slot, timezoneToSet);
    }
    // Escrita do destino dos avisos, escopada ao slot da SESSÃO (anti-IDOR: slot nunca do body).
    if (recepcaoAction !== undefined) {
      if (recepcaoAction.kind === 'clear') {
        await flowClones.clearAlertOwnerPhoneBySlot(slot);
      } else {
        await flowClones.updateAlertOwnerPhoneBySlot(slot, recepcaoAction.digits);
      }
    }
    // Devolve o perfil canonico (ja MERGE-ado/normalizado) + o fuso vigente pro front sincronizar.
    const perfil = await portalConfig.getPerfilBySlot(slot);
    const timezone = await flowClones.getTimezoneBySlot(slot);
    const out: Record<string, unknown> = { ok: true, perfil, timezone };
    // recepcao_telefone universal (Onda 1 de-gate): devolvido pra TODO formato (front sincroniza).
    out.recepcao_telefone = await flowClones.getAlertOwnerPhoneBySlot(slot);
    return reply.code(200).send(out);
  });
};
