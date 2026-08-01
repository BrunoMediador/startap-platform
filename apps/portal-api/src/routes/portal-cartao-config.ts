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
 * SEGURANÇA (decisão do Bruno, PR backend): emoji LIVRE do teclado do dispositivo, validado
 * estritamente (validateCartaoEmojis → isSingleValidEmoji: 1 grapheme cluster, RGI_Emoji,
 * deny-list de tag chars/controle/invisíveis — ver cartao-catalog.ts). NÃO é mais allowlist
 * fechada por catálogo curado. `template` = enum fechado. slot SEMPRE da SESSÃO (withTenant) —
 * nunca do body (anti-IDOR). Emojis são DESABILITÁVEIS via o sentinela CARTAO_EMOJI_DISABLED
 * (`'__off__'`) no lugar de um emoji — a linha correspondente perde só o ícone (bloco-estrutural.ts).
 *
 * Contrato (casa com apps/portal-web/src/lib/cartao-config.ts):
 *   GET  -> { mode, editable, locked_reason, config:{template,emojis}|null,
 *            defaults:{template,emojis}, canDisable:false, preview:string|null,
 *            previews:{padrao,compacto,detalhado}, previewsSegmentados:{padrao,compacto,detalhado} }
 *   PUT { template, emojis } -> mesmo shape (após flip/update). `emojis[key]` aceita 1 emoji
 *            livre válido OU o sentinela de desabilitado. Erros: 400 (input/emoji), 409
 *            (prompt_custom), 422 (requer_revisao), 404 (flag OFF / sem clone).
 *   `previewsSegmentados` (PR backend, consumido pela PR 2/front): MESMO conteúdo de `previews`,
 *            mas como lista de segmentos {tipo,valor,slot?} — permite o front tornar cada emoji
 *            clicável sem adivinhar posição na string (buildCartaoExemploSegmentado; fonte única
 *            com `previews`, nunca construído por regex/busca na string pronta).
 */
import { logger } from '@startap/core/logger';
import { botPrompt, cloneColaboradores, portalConfig } from '@startap/db';
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

// Body do PUT: template obrigatório (enum fechado) + emojis parcial (validado no HANDLER por
// validateCartaoEmojis: emoji LIVRE estrito — 1 grapheme cluster, RGI_Emoji, deny-list de tag
// chars/controle/invisíveis — OU o sentinela CARTAO_EMOJI_DISABLED). .strict() → chave
// desconhecida = 400 (anti mass-assignment). emojis é `record` cru aqui; o Zod só garante que
// cada valor é string|unknown — a validação real (e a única fonte de verdade) é o handler.
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

// ── Prévia FIEL do cartão (SCRUM-99) ──────────────────────────────────────────────────────
// A seção mostra o EXEMPLO do cartão que o cliente RECEBE, renderizado pela MESMA função do
// runtime (promptBuilder.buildCartaoExemplo) — fonte única, sem a "prévia que mente". A amostra
// é semeada com o NOME real do negócio + um SERVIÇO/PREÇO real do catálogo do clone; dia/horário
// são neutros (não são dado do clone). Individual → sem linha de profissional (a função já cuida).

const PREVIEW_TEMPLATES = ['padrao', 'compacto', 'detalhado'] as const;
type PreviewTemplate = (typeof PREVIEW_TEMPLATES)[number];

// Amostra neutra e evergreen (sem data absoluta que envelhece). Fallbacks usados só quando o
// clone não tem catálogo/colaborador — o caminho comum usa os dados reais do clone.
const SAMPLE_DIA = 'quinta-feira';
const SAMPLE_HORARIO = '15:00';
const FALLBACK_SERVICO = 'Serviço';
const FALLBACK_VALOR = 'R$ 50,00';
const FALLBACK_PROFISSIONAL = 'profissional';

/** Formata centavos em 'R$ X,XX' pt-BR sem libs (Intl varia por runtime) — espelha o
 *  precoLabel do bot (apps/api/src/lib/package-context.ts), pra prévia bater com o que o bot diz. */
function formatPrecoBRL(cents: number): string {
  const reais = Math.trunc(cents / 100);
  const centavos = String(Math.abs(cents % 100)).padStart(2, '0');
  return `R$ ${reais},${centavos}`;
}

/**
 * Semeia a amostra do exemplo com dados REAIS do clone: nome do negócio (já lido), 1º serviço do
 * catálogo (nome + preço formatado) e, no estabelecimento, o nome de um profissional. Nunca lança
 * (readers com catch → fallback neutro); escopado por slot da sessão (sem vazar outro tenant).
 */
async function buildSample(
  slot: string,
  modo: Modo,
  nomeNegocio: string | null,
): Promise<promptBuilder.CartaoExemploSample> {
  const servicos = await portalConfig.getServicosBySlot(slot).catch(() => null);
  let servico = FALLBACK_SERVICO;
  let valor = FALLBACK_VALOR;
  const primeiro = servicos?.find((s) => typeof s?.nome === 'string' && s.nome.trim() !== '');
  if (primeiro) {
    servico = primeiro.nome.trim();
    valor = Number.isFinite(primeiro.preco_cents)
      ? formatPrecoBRL(primeiro.preco_cents)
      : FALLBACK_VALOR;
  }

  let profissional = FALLBACK_PROFISSIONAL;
  if (modo === 'estabelecimento') {
    const colabs = await cloneColaboradores.listBySlot(slot).catch(() => []);
    const escolhido =
      colabs.find((c) => c.ativo && c.nome.trim() !== '') ??
      colabs.find((c) => c.nome.trim() !== '');
    if (escolhido) profissional = escolhido.nome.trim();
  }

  return {
    nomeNegocio: nomeNegocio ?? undefined,
    dia: SAMPLE_DIA,
    horario: SAMPLE_HORARIO,
    servico,
    valor,
    profissional,
  };
}

/**
 * Renderiza o EXEMPLO do cartão pros 3 templates com um dado conjunto de emojis (override
 * PARCIAL do dono — a função resolve os defaults da área por baixo, igual ao runtime). Uma
 * chamada cobre a prévia principal + as mini-prévias do seletor + a troca de template sem novo
 * fetch. Puro sobre a amostra; sem I/O.
 */
function renderPreviews(
  modo: Modo,
  area: string | null,
  emojisOverride: Partial<Record<EmojiKey, string>> | undefined,
  sample: promptBuilder.CartaoExemploSample,
): Record<PreviewTemplate, string> {
  const out = {} as Record<PreviewTemplate, string>;
  for (const template of PREVIEW_TEMPLATES) {
    out[template] = promptBuilder.buildCartaoExemplo({
      modo,
      area,
      config: { template, emojis: emojisOverride },
      sample,
    });
  }
  return out;
}

/**
 * Versão SEGMENTADA de renderPreviews (consumida pela PR 2/front — SCRUM, emoji clicável na
 * prévia). MESMOS parâmetros/MESMA amostra que renderPreviews — buildCartaoExemploSegmentado é
 * a fonte única com buildCartaoExemplo (nunca diverge por construção; ver bloco-estrutural.ts).
 */
function renderPreviewsSegmentados(
  modo: Modo,
  area: string | null,
  emojisOverride: Partial<Record<EmojiKey, string>> | undefined,
  sample: promptBuilder.CartaoExemploSample,
): Record<PreviewTemplate, promptBuilder.CartaoExemploSegmento[]> {
  const out = {} as Record<PreviewTemplate, promptBuilder.CartaoExemploSegmento[]>;
  for (const template of PREVIEW_TEMPLATES) {
    out[template] = promptBuilder.buildCartaoExemploSegmentado({
      modo,
      area,
      config: { template, emojis: emojisOverride },
      sample,
    });
  }
  return out;
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
  /** Amostra (nome+serviço+preço reais) que semeia o EXEMPLO fiel do cartão (SCRUM-99). */
  sample: promptBuilder.CartaoExemploSample;
}

/**
 * Monta o payload do contrato (GET e PUT compartilham). `config` (seed do picker) só é exposto
 * quando editable — clone locked/requer_revisao devolve config=null (read-only). `preview` mostra
 * o cartão ATUAL (verbatim) ou o que o runtime emitiria; null só quando não dá pra mostrar o
 * cartão real com segurança (locked sem cartão extraível).
 */
function buildResponse(args: ResponseArgs): Record<string, unknown> {
  const { effectiveMode, editable, lockedReason, modo, area, nomeNegocio, seedConfig, sample } =
    args;
  const defaultsEmojis = promptBuilder.resolveDefaultCartaoEmojis(modo, area);
  const defaults = { template: 'padrao' as const, emojis: defaultsEmojis };

  // Emojis-semente do picker (override PARCIAL do dono): do cartão legado (verbatim) ou do config.
  // Sem seedConfig → vazio (a prévia cai nos defaults da área, resolvidos pela função do runtime).
  const seedOverride: Partial<Record<EmojiKey, string>> = seedConfig
    ? typeof seedConfig.verbatim === 'string' && seedConfig.verbatim.trim() !== ''
      ? promptBuilder.extractSeedEmojis(seedConfig.verbatim)
      : ((seedConfig.emojis ?? {}) as Partial<Record<EmojiKey, string>>)
    : {};

  // config (seed do picker): só quando editable e há uma base. Locked/requer_revisao → null.
  let configOut: { template: string; emojis: Record<string, string> } | null = null;
  if (editable && seedConfig) {
    const template = seedConfig.template ?? 'padrao';
    configOut = { template, emojis: { ...defaultsEmojis, ...seedOverride } };
  }

  // preview = bloco INTERNO do runtime (system-prompt cru; NÃO exibido ao dono) — mantido pra
  // compat/telemetria. verbatim vence; senão montado; locked sem cartão extraível → null.
  const preview =
    seedConfig || editable
      ? promptBuilder.buildCartaoRuntimeBlock({
          modo,
          area,
          config: seedConfig,
          nomeNegocio: nomeNegocio ?? undefined,
        })
      : null;

  // previews (SCRUM-99) = EXEMPLO fiel do cartão que o cliente RECEBE, pros 3 templates, com os
  // emojis-semente + nome/serviço reais. É o que a seção mostra (o `preview` acima nunca aparece).
  const previews = renderPreviews(modo, area, seedOverride, sample);
  // previewsSegmentados (PR backend, consumido pela PR 2/front): MESMO conteúdo, como segmentos
  // {tipo,valor,slot?} — permite tornar cada emoji clicável na prévia. Fonte única com `previews`.
  const previewsSegmentados = renderPreviewsSegmentados(modo, area, seedOverride, sample);

  return {
    mode: effectiveMode,
    editable,
    locked_reason: lockedReason,
    config: configOut,
    defaults,
    canDisable: false,
    preview,
    previews,
    previewsSegmentados,
    sample,
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
    const sample = await buildSample(slot, modo, nomeNegocio);

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
          sample,
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
          sample,
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
        sample,
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

    // SCRUM-143: caminho de ESCRITA que pode flipar cartao_mode→runtime → reader fail-CLOSED
    // (failClosed:true). No erro de DB ele RELANÇA e devolvemos 503 SEM tocar em nada, em vez de
    // ler {promptCustom:false} e deixar o guard isCartaoRuntimeFlipBlocked passar (flip cego).
    let readState: Awaited<ReturnType<typeof cloneColaboradores.getAreaPromptCustomCartao>>;
    try {
      readState = await cloneColaboradores.getAreaPromptCustomCartao(slot, { failClosed: true });
    } catch (err) {
      log.error(
        { slot, err: err instanceof Error ? err.message : 'unknown' },
        'PUT cartao-config bloqueado: estado do clone indeterminado (fail-closed, SCRUM-143)',
      );
      return reply.code(503).send({ error: 'estado_indeterminado' });
    }
    const { area, promptCustom, cartaoMode, nomeNegocio } = readState;
    const modo = await resolveModo(slot);
    const sample = await buildSample(slot, modo, nomeNegocio);

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
          sample,
        }),
      );
    }

    // B. Baked + persona à mão → 409 (NUNCA flipa uma persona gerenciada à mão; invariante).
    // SCRUM-120: guard ÚNICO compartilhado com o approve do builder (isCartaoRuntimeFlipBlocked).
    // Aqui cartaoMode já é != 'runtime' (o ramo A retornou), então o predicado reduz a `promptCustom`
    // — comportamento idêntico ao antigo `if (promptCustom)`, mas agora a regra vive num só lugar.
    if (promptBuilder.isCartaoRuntimeFlipBlocked({ promptCustom, cartaoMode })) {
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
        sample,
      }),
    );
  });

  // GET /portal/cartao-config/preview — prévia AO VIVO (SCRUM-99). Read-only, sem efeito
  // colateral: renderiza o EXEMPLO fiel do cartão (a MESMA função do runtime) pros 3 templates
  // com os emojis que o dono está escolhendo, semeado com nome/serviço reais do clone. Serve a
  // edição sem gravar nada — o dono vê o que o cliente recebe ANTES de salvar. Slot da SESSÃO
  // (nunca do cliente): sem vazamento cross-tenant. Emoji fora da allowlist → cai no default da
  // área (graceful; a prévia nunca quebra).
  app.get('/portal/cartao-config/preview', { preHandler: withTenant }, async (req, reply) => {
    if (!config.CARTAO_RUNTIME_ENABLED) {
      return reply.code(404).send({ error: 'recurso indisponivel' });
    }
    const { slot } = requireTenant(req);
    const { area, nomeNegocio } = await cloneColaboradores.getAreaPromptCustomCartao(slot);
    const modo = await resolveModo(slot);
    const sample = await buildSample(slot, modo, nomeNegocio);

    // Emojis vêm da query (?marca=&dia=&...): mantém só os que passam na validação estrita de
    // emoji ÚNICO (isEmojiAllowed/isSingleValidEmoji) OU são o sentinela de desabilitado —
    // inválido/desconhecido é IGNORADO (default da área vence), nunca renderiza lixo.
    const q = (req.query ?? {}) as Record<string, unknown>;
    const override: Partial<Record<EmojiKey, string>> = {};
    for (const key of promptBuilder.CARTAO_EMOJI_KEYS) {
      const v = q[key];
      if (typeof v !== 'string') continue;
      if (v === promptBuilder.CARTAO_EMOJI_DISABLED || promptBuilder.isEmojiAllowed(key, v)) {
        override[key] = v;
      }
    }

    return reply.code(200).send({
      previews: renderPreviews(modo, area, override, sample),
      previewsSegmentados: renderPreviewsSegmentados(modo, area, override, sample),
    });
  });
};
