/**
 * /portal/cartao-config — customização do CARTÃO DE CONFIRMAÇÃO montado em RUNTIME
 * (SCRUM-92 inc.2 / ADR 0032). O dono escolhe TEMPLATE + EMOJIS do cartão que o bot manda
 * antes de marcar. Grava flow_clones.cartao_config (JSONB { template, emojis }).
 *
 * ── ABORDAGEM "UI PARA TODOS" (refinamento Bruno 23/07, SCRUM-92 inc.2) ──────────────────
 * A tela aparece pra TODO cliente, já preenchida com o cartão ATUAL dele (seed). NINGUÉM é
 * force-migrado: quem NÃO salvar segue baked, byte-a-byte igual; quem SALVAR uma mudança tem
 * SÓ o clone dele FLIPADO pra runtime, com a escolha dele — flip-on-customize.
 *
 * GATE GLOBAL: kill-switch CARTAO_RUNTIME_ENABLED. OFF (default prod) → o endpoint responde 404
 * ANTES de qualquer leitura (feature dormente, nada muda). ON → o endpoint serve a UI pra todos.
 *
 * ESTADOS por clone (GET decide editable/locked; PUT aplica a mesma regra):
 *   1. cartao_mode='runtime' (já migrado / builder-runtime — ex.: dragon, Ingrid): editable, o
 *      dono ajusta a config livremente (setCartaoConfigBySlot) — NÃO re-flipa.
 *   2. baked + prompt_custom=true (persona gerenciada à mão): LOCKED — editable:false +
 *      locked_reason='prompt_custom'. GET mostra read-only; PUT → 409 (nunca flipa uma persona
 *      editada à mão sem revisão; invariante do arquiteto — a extração de um cartão feito à mão
 *      não é confiável o bastante pra mutar sem supervisão).
 *   3. baked + prompt_custom=false + cartão flip-SAFE (isCartaoFlipSafe: 'bloco' OU 'template',
 *      trailing, persona não-vazia, cartão removido por completo): editable. PUT FLIPA aquele clone
 *      pra runtime (migrateCloneToCartaoRuntime — snapshot do bot_prompt pra reversão + persona-only
 *      + cartao_mode='runtime') aplicando a config do dono. Cobre TAMBÉM o formato LEGADO
 *      [CARTAO DE CONFIRMACAO] dos template Cirilo/Samuel/mvs (fix "editável pra todos" 23/07):
 *      antes travavam em requer_revisao; agora, como a extração separa persona↔cartão byte-a-byte
 *      (verificado nos bot_prompt reais), o dono edita direto — fim do "fale com o suporte".
 *   4. baked + prompt_custom=false + extração NÃO-confiável (sem cartão reconhecível, não-trailing,
 *      estabelecimento code-injected): editable:false + locked_reason='requer_revisao'. GET mostra
 *      read-only (preview verbatim quando dá); PUT → 422 requer_revisao + log (NÃO flipa com
 *      resultado duvidoso — mantém baked em vez de mutilar o prompt). Caminho supervisionado =
 *      script migrate-cartao-runtime (--allow-template / revisão do arquiteto).
 *
 * REVERSÃO: o flip via PUT usa migrateCloneToCartaoRuntime, que grava o snapshot do bot_prompt
 * baked em bot_prompt_versions (comment=CARTAO_MIGRATION_SNAPSHOT_COMMENT). Logo o flip do portal
 * é revertível pelo MESMO caminho do script: `migrate-cartao-runtime.ts --revert <slot>`.
 *
 * SEGURANÇA (decisão do security): emoji = ALLOWLIST FECHADA de code points por chave
 * (validateCartaoEmojis: NFC + sequência inteira contra o catálogo — rejeita tag chars/fora do
 * set). `template` = enum fechado. slot SEMPRE da SESSÃO (withTenant) — nunca do body (anti-IDOR).
 *
 * Contrato (casa com apps/portal-web/src/lib/cartao-config.ts):
 *   GET  -> { mode, editable, locked_reason, config:{template,emojis}|null,
 *            defaults:{template,emojis}, canDisable:false, preview:string|null }
 *   PUT { template, emojis } -> mesmo shape (após flip/update). Erros: 400 (input/emoji), 409
 *            (prompt_custom), 422 (requer_revisao), 404 (flag OFF / sem clone).
 */
import { logger } from '@startap/core/logger';
import { botPrompt, cloneColaboradores } from '@startap/db';
// Subpath (não o barrel @startap/integrations): puxa SÓ o módulo puro do cartão, sem instanciar
// o cliente OpenAI (que o barrel carrega no import). Mesmo padrão do apps/api/bots/teste_barbearia.
import * as promptBuilder from '@startap/integrations/prompt-builder';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { config } from '../config.js';
import { requireTenant, withTenant } from '../lib/tenant.js';

const log = logger.child({ service: 'portal-api', module: 'cartao-config' });

// Quem edita, no snapshot de reversão. Alinha com o script (script:migrate-cartao-runtime) — o
// comment do snapshot é fixo dentro de migrateCloneToCartaoRuntime, então o --revert acha os dois.
const EDITED_BY = 'portal:cartao-config';

// Body do PUT: template obrigatório (enum fechado) + emojis parcial (validado contra a allowlist
// FECHADA no handler, NÃO por regex/grapheme). .strict() → chave desconhecida = 400 (anti
// mass-assignment). emojis é `record` cru aqui; a allowlist real é validateCartaoEmojis.
const putSchema = z
  .object({
    template: z.enum(['padrao', 'compacto', 'detalhado']),
    emojis: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();

type Modo = 'agenda' | 'estabelecimento';
type EmojiKey = (typeof promptBuilder.CARTAO_EMOJI_KEYS)[number];
type CartaoConfigLike = {
  template?: 'padrao' | 'compacto' | 'detalhado';
  emojis?: Record<string, string>;
  verbatim?: string;
};

/** Resolve o modo do cartão a partir do product_type do clone (individual → agenda). */
async function resolveModo(slot: string): Promise<Modo> {
  const productType = await cloneColaboradores.getProductType(slot);
  return productType === 'estabelecimento' ? 'estabelecimento' : 'agenda';
}

/** Extrai o cartão BAKED atual do clone (via bot_prompt). Puro sobre o texto; nunca lança. */
async function extractCurrentCartao(slot: string) {
  const prompt = await botPrompt.getPrompt(slot);
  return promptBuilder.extractBakedCartao(prompt ?? '');
}

/** Igualdade das 7 chaves de emoji já resolvidas (defaults ∪ override). */
function emojisEqual(a: Record<EmojiKey, string>, b: Record<EmojiKey, string>): boolean {
  for (const k of promptBuilder.CARTAO_EMOJI_KEYS) {
    if (a[k] !== b[k]) return false;
  }
  return true;
}

interface ResponseArgs {
  effectiveMode: 'baked' | 'runtime';
  editable: boolean;
  lockedReason: 'prompt_custom' | 'requer_revisao' | null;
  modo: Modo;
  area: string | null;
  nomeNegocio: string | null;
  /** Config que semeia o picker (config) E renderiza o preview. `verbatim` presente → o preview é
   *  o cartão legado literal e o picker é semeado com os emojis extraídos dele. */
  seedConfig: CartaoConfigLike | null;
}

/**
 * Monta o payload do contrato (GET e PUT compartilham). `config` (seed do picker) só é exposto
 * quando editable — clone locked/requer_revisao devolve config=null (read-only). `preview` mostra
 * o cartão ATUAL (verbatim) ou o que o runtime emitiria; null só quando não dá pra mostrar o
 * cartão real com segurança (locked sem cartão extraível).
 */
function buildResponse(args: ResponseArgs): Record<string, unknown> {
  const { effectiveMode, editable, lockedReason, modo, area, nomeNegocio, seedConfig } = args;
  const defaultsEmojis = promptBuilder.resolveDefaultCartaoEmojis(modo, area);
  const defaults = { template: 'padrao' as const, emojis: defaultsEmojis };

  // config (seed do picker): só quando editable e há uma base. Clone migrado (verbatim) → SEED os
  // emojis do cartão legado; senão os emojis do config. Locked/requer_revisao → null (sem picker).
  let configOut: { template: string; emojis: Record<string, string> } | null = null;
  if (editable && seedConfig) {
    const template = seedConfig.template ?? 'padrao';
    const seed =
      typeof seedConfig.verbatim === 'string' && seedConfig.verbatim.trim() !== ''
        ? promptBuilder.extractSeedEmojis(seedConfig.verbatim)
        : (seedConfig.emojis ?? {});
    configOut = { template, emojis: { ...defaultsEmojis, ...seed } };
  }

  // preview = o cartão que este clone emite/emitiria (verbatim vence; senão montado; sem seed mas
  // editable → defaults). Locked SEM cartão extraível → null (honesto: não fabrica um cartão que
  // não é o do cliente).
  const preview =
    seedConfig || editable
      ? promptBuilder.buildCartaoRuntimeBlock({
          modo,
          area,
          config: seedConfig,
          nomeNegocio: nomeNegocio ?? undefined,
        })
      : null;

  return {
    mode: effectiveMode,
    editable,
    locked_reason: lockedReason,
    config: configOut,
    defaults,
    canDisable: false,
    preview,
  };
}

export const portalCartaoConfigRoutes: FastifyPluginAsync = async (app) => {
  app.get('/portal/cartao-config', { preHandler: withTenant }, async (req, reply) => {
    // Gate GLOBAL ANTES de tudo: flag OFF → 404, feature dormente (nem lê o banco).
    if (!config.CARTAO_RUNTIME_ENABLED) {
      return reply.code(404).send({ error: 'recurso indisponivel' });
    }
    const { slot } = requireTenant(req);
    const { area, promptCustom, cartaoMode, cartaoConfig, nomeNegocio } =
      await cloneColaboradores.getAreaPromptCustomCartao(slot);
    const modo = await resolveModo(slot);

    // 1. Já runtime → editable (o dono ajusta a config livremente; não re-flipa).
    if (cartaoMode === 'runtime') {
      return reply.code(200).send(
        buildResponse({
          effectiveMode: 'runtime',
          editable: true,
          lockedReason: null,
          modo,
          area,
          nomeNegocio,
          seedConfig: cartaoConfig,
        }),
      );
    }

    // 2. Baked + persona à mão (prompt_custom) → LOCKED. Preview best-effort do cartão atual.
    if (promptCustom) {
      const ex = await extractCurrentCartao(slot);
      return reply.code(200).send(
        buildResponse({
          effectiveMode: 'baked',
          editable: false,
          lockedReason: 'prompt_custom',
          modo,
          area,
          nomeNegocio,
          seedConfig: ex.found ? { verbatim: ex.cartao } : null,
        }),
      );
    }

    // 3/4. Baked + template-tracking (prompt_custom=false): extrai o cartão atual. Flip-safe
    // (isCartaoFlipSafe: 'bloco' OU 'template' legado, trailing, persona não-vazia, cartão
    // 100% removido) → editable; senão → requer_revisao (fallback seguro, não muta).
    const ex = await extractCurrentCartao(slot);
    const cleanFlip = promptBuilder.isCartaoFlipSafe(ex);
    return reply.code(200).send(
      buildResponse({
        effectiveMode: 'baked',
        editable: cleanFlip,
        lockedReason: cleanFlip ? null : 'requer_revisao',
        modo,
        area,
        nomeNegocio,
        seedConfig: ex.found ? { verbatim: ex.cartao } : null,
      }),
    );
  });

  app.put('/portal/cartao-config', { preHandler: withTenant }, async (req, reply) => {
    if (!config.CARTAO_RUNTIME_ENABLED) {
      return reply.code(404).send({ error: 'recurso indisponivel' });
    }
    const { slot } = requireTenant(req);
    const parsed = putSchema.safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: 'dados_invalidos' });

    // Allowlist FECHADA de emoji (NFC + sequência inteira). Fora do catálogo / chave desconhecida
    // → 400 com a chave ofensora (a UI não deveria chegar aqui; é a 2ª trava, server-side).
    const emojiCheck = promptBuilder.validateCartaoEmojis(parsed.data.emojis);
    if (!emojiCheck.ok) {
      return reply.code(400).send({ error: 'emoji_invalido', campo: emojiCheck.invalidKey });
    }

    const { area, promptCustom, cartaoMode, nomeNegocio } =
      await cloneColaboradores.getAreaPromptCustomCartao(slot);
    const modo = await resolveModo(slot);

    // A. Já runtime → só atualiza a config (comportamento atual; não re-flipa).
    if (cartaoMode === 'runtime') {
      const novaConfig = { template: parsed.data.template, emojis: emojiCheck.emojis };
      const ok = await cloneColaboradores.setCartaoConfigBySlot(slot, novaConfig);
      if (!ok) return reply.code(404).send({ error: 'fluxo nao encontrado' });
      return reply.code(200).send(
        buildResponse({
          effectiveMode: 'runtime',
          editable: true,
          lockedReason: null,
          modo,
          area,
          nomeNegocio,
          seedConfig: novaConfig,
        }),
      );
    }

    // B. Baked + persona à mão → 409 (NUNCA flipa uma persona gerenciada à mão; invariante).
    if (promptCustom) {
      log.warn({ slot }, 'PUT cartao-config bloqueado: prompt_custom (persona à mão)');
      return reply.code(409).send({ error: 'cartao_bloqueado', reason: 'prompt_custom' });
    }

    // C. Baked + template-tracking → tenta flip-on-customize. Só flipa se a extração é FLIP-SAFE
    // (isCartaoFlipSafe: 'bloco' OU 'template' legado, trailing, persona não-vazia, cartão 100%
    // removido — guard anti-cartão-duplo). Não-confiável → 422, mantém baked (não muta o prompt).
    // O `!ex.found ||` é redundante em runtime (isCartaoFlipSafe já exige found) mas ESTREITA o
    // tipo pra found:true no resto do handler (ex.cartao/ex.personaOnly abaixo) sem cast.
    const ex = await extractCurrentCartao(slot);
    if (!ex.found || !promptBuilder.isCartaoFlipSafe(ex)) {
      const reason = ex.found ? `cartao_${ex.strategy}` : ex.reason;
      log.warn({ slot, reason }, 'PUT cartao-config: flip requer revisão (extração não-confiável)');
      return reply.code(422).send({ error: 'requer_revisao', reason });
    }

    // Detecta se o dono mudou o cartão: compara os 7 emojis resolvidos (defaults ∪ override) e o
    // template. NÃO mudou → grava VERBATIM (cartão legado byte-a-byte, zero mudança visível).
    // Mudou → grava { template, emojis } (cartão montado com a escolha dele; dropa o legado).
    // Nos dois casos o bot_prompt vira persona-only e é revertível pelo snapshot do migrate.
    const seedEmojisFull = {
      ...promptBuilder.resolveDefaultCartaoEmojis(modo, area),
      ...promptBuilder.extractSeedEmojis(ex.cartao),
    };
    const submittedEmojisFull = {
      ...promptBuilder.resolveDefaultCartaoEmojis(modo, area),
      ...emojiCheck.emojis,
    };
    const unchanged =
      parsed.data.template === 'padrao' && emojisEqual(seedEmojisFull, submittedEmojisFull);
    const cartaoConfig: CartaoConfigLike = unchanged
      ? { verbatim: ex.cartao, emojis: promptBuilder.extractSeedEmojis(ex.cartao) }
      : { template: parsed.data.template, emojis: emojiCheck.emojis };

    const res = await botPrompt.migrateCloneToCartaoRuntime({
      slot,
      personaOnlyPrompt: ex.personaOnly,
      cartaoConfig,
      editedBy: EDITED_BY,
    });
    if (!res.migrated) {
      // Corrida: prompt_custom virou true entre a leitura e o lock, ou clone/prompt sumiu.
      if (res.skipped === 'prompt_custom') {
        return reply.code(409).send({ error: 'cartao_bloqueado', reason: 'prompt_custom' });
      }
      return reply.code(404).send({ error: 'fluxo nao encontrado' });
    }
    log.info(
      { slot, changed: !unchanged, version: res.versionSaved },
      'cartao flip-on-customize OK',
    );

    return reply.code(200).send(
      buildResponse({
        effectiveMode: 'runtime',
        editable: true,
        lockedReason: null,
        modo,
        area,
        nomeNegocio,
        seedConfig: cartaoConfig,
      }),
    );
  });
};
