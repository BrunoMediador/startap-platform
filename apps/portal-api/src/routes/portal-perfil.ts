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
    const modoAtendente = await flowClones.resolveModoAtendenteEnabledForSlot(
      slot,
      config.MODO_ATENDENTE_SLOTS,
    );
    // features.faq_personalizado (SCRUM-65): gate POR-CLONE. Só o(s) clone(s) no
    // FAQ_PERSONALIZADO_SLOTS veem a seção de FAQ personalizado. Mesmo padrão do modo_atendente;
    // o front usa esse boolean como `enabled` da query (clone fora do gate = zero request).
    const faqPersonalizado = await flowClones.resolveFaqPersonalizadoEnabledForSlot(
      slot,
      config.FAQ_PERSONALIZADO_SLOTS,
    );
    // features.agenda_configurada (SCRUM-74): o clone tem Google Calendar utilizável, conectado
    // pelo TIME no gestão (ADR 0024). Contrato pro front: o toggle "agendamento automático" só
    // pode ser LIGADO quando isto é true; desligado, o front mostra "fale com o suporte pra
    // habilitar". Escopado pelo slot da SESSÃO (withTenant) — nunca do input.
    const agendaConfigurada = await flowClones.isAgendaConfiguradaBySlot(slot);
    const features = {
      modo_atendente: modoAtendente,
      faq_personalizado: faqPersonalizado,
      agenda_configurada: agendaConfigurada,
    };
    // recepcao_telefone (SCRUM-59 → Onda 1 de-gate, SCRUM-68 / ADR 0030): destino dos avisos de
    // lead/escalação/desconexão ao dono (= flow_clones.alert_owner_phone RAW). UNIVERSAL: exposto
    // pra TODO formato (individual/estabelecimento, agenda/atendente). O alert_owner_phone já é
    // usado por todos os kinds de alerta — só o EDITOR estava preso ao modo atendente por acidente
    // de rollout. null quando não setado -> o bot cai no fallback "número da própria sessão"
    // (SCRUM-62, intacto). O dono edita pelo campo do portal.
    const payload: Record<string, unknown> = { perfil, timezone, features };
    payload.recepcao_telefone = await flowClones.getAlertOwnerPhoneBySlot(slot);
    // aguardando_agenda (ADR 0030 D3): clone que escolheu AGENDA e cuja Service Account
    // do Google ainda não foi conectada pelo time. O front usa isto pra mostrar o card
    // "nossa equipe está conectando sua agenda (até 24h úteis)" no Início/agenda.
    // Derivado de runtime, escopado pelo slot da SESSÃO (withTenant) — nunca do input.
    payload.aguardando_agenda = await flowClones.isAwaitingAgendaConnection(slot);
    return reply.code(200).send(payload);
  });

  app.put('/portal/perfil', { preHandler: withTenant }, async (req, reply) => {
    const { slot } = requireTenant(req);
    const body = (req.body ?? {}) as {
      perfil?: unknown;
      timezone?: unknown;
      recepcao_telefone?: unknown;
    };
    // FIX (SCRUM-68 Onda 1 / ADR 0030): o save "recepcao-only" do portal (useSaveRecepcao) manda
    // { recepcao_telefone } SEM o envelope `perfil`. Antes, perfilSchema.safeParse(undefined) dava
    // success:false -> 400 'perfil invalido' em TODO save recepcao-only, e REGREDIA Meduzza/dragon
    // (que editavam a recepção pela AgendamentoSection, mandando `perfil: {}` junto e funcionando).
    // Fix: quando `perfil` vem AUSENTE mas há um campo top-level processável (recepcao_telefone /
    // timezone), trata `perfil` como {} (patch vazio = no-op no merge) em vez de 400 — o MESMO
    // objeto vazio que a AgendamentoSection já enviava. Body sem NADA processável (ex.: {} puro)
    // segue 400 'perfil invalido' (byte-a-byte, não afrouxa demais). A semântica de quem MANDA
    // `perfil` (inclusive `{}` explícito, `null` ou objeto inválido) é INTOCADA: a tolerância cobre
    // SÓ a ausência da chave (body.perfil === undefined).
    const hasProcessableTopLevel =
      body.recepcao_telefone !== undefined || body.timezone !== undefined;
    const perfilInput = body.perfil === undefined && hasProcessableTopLevel ? {} : body.perfil;
    const parsed = perfilSchema.safeParse(perfilInput);
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
      !(await flowClones.resolveFaqPersonalizadoEnabledForSlot(
        slot,
        config.FAQ_PERSONALIZADO_SLOTS,
      ))
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
    // SCRUM-74: religar o agendamento automático NÃO é self-service. Habilitar é comercial
    // (preço novo) + o time conecta a agenda no gestão (ADR 0024). Recusamos APENAS a TRANSIÇÃO
    // agenda_automatica false→true quando a agenda ainda não está configurada:
    //   - input agenda_automatica != true (ausente/false) -> nunca barra (desligar / salvar
    //     link/telefone/o resto do payload segue igual);
    //   - já estava LIGADO (true→true, no-op)             -> passa (é o estado atual; não reexige config);
    //   - false→true E agenda configurada                 -> passa (o time já conectou);
    //   - false→true E !agenda configurada                -> 409 agenda_nao_configurada.
    // Checagem ANTES de qualquer escrita (sem write parcial). agendaConfigurada é derivada do
    // slot da SESSÃO (anti-IDOR: nunca de input) e fail-closed (na dúvida, não religa).
    // SCRUM-112: se ESTE PUT é a transição agenda_automatica false→true (o clone acabou de virar
    // um clone de agenda), liga também o gate billing-da-agenda (billing_from_agenda_enabled=true)
    // DEPOIS da escrita do perfil — senão a tela Faturamento nasce morta (bug do MVS: individual
    // +agenda mas o billing nunca ligava). Só na TRANSIÇÃO (estavaDesligado): true→true no-op não
    // reativa billing de quem o desligou de propósito. A checagem só roda quando o payload pede
    // agenda_automatica=true e passou pelo gate 409 (agenda já configurada).
    let ligarBillingAgenda = false;
    if (parsed.data.agenda_automatica === true) {
      const perfilAtual = await portalConfig.getPerfilBySlot(slot);
      if (perfilAtual === null) return reply.code(404).send({ error: 'fluxo nao encontrado' });
      const estavaDesligado = perfilAtual.agenda_automatica === false;
      if (estavaDesligado && !(await flowClones.isAgendaConfiguradaBySlot(slot))) {
        return reply.code(409).send({ error: 'agenda_nao_configurada' });
      }
      ligarBillingAgenda = estavaDesligado;
    }
    const ok = await portalConfig.updatePerfilBySlot(slot, parsed.data);
    if (!ok) return reply.code(404).send({ error: 'fluxo nao encontrado' });
    // Liga o billing-da-agenda na transição (idempotente/só-liga no data layer — anti-IDOR: slot
    // da sessão). Depois da escrita do perfil pra o clone já valer como "de agenda".
    if (ligarBillingAgenda) {
      await flowClones.enableBillingFromAgendaBySlot(slot);
    }
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
