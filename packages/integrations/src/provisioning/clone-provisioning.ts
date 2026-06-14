/**
 * clone-provisioning — orquestração compartilhada de criação de clone + sessão WAHA.
 *
 * EXTRAÍDO de painel-admin/server.js (POST /api/clones/with-waha) na Missão 020 F1,
 * em caráter "move, não muda": mesma transação, mesmos defaults, mesmo render de
 * prompt, mesma criação de sessão WAHA com retry-friendly result. O painel-admin
 * passa a delegar pra cá (zero duplicação) e o portal-api (signup self-service)
 * usa o MESMO caminho — herda o isolamento já validado em prod.
 *
 * POR QUE dependency-injection (db/config como parâmetros, sem importar
 * @startap/db): o painel-admin roda em container próprio que só embarca os dists
 * de @startap/core e @startap/integrations (ver painel-admin/Dockerfile) e tem o
 * próprio pg.Pool. Injetar o executor SQL deixa o módulo consumível pelos dois
 * mundos sem mudar o build do painel.
 *
 * Multi-tenant: tudo keyed por slot; sessão WAHA derivada do slot; defaults vêm
 * do banco da MATRIZ (bot_config) — zero default de modelo hardcoded.
 */
import { logger } from '@startap/core/logger';

const log = logger.child({ module: 'clone-provisioning' });

// ---------------------------------------------------------------------------
// Contratos de injeção (pg.Pool e pg.PoolClient satisfazem estruturalmente)
// ---------------------------------------------------------------------------

export interface SqlResult {
  rows: Array<Record<string, unknown>>;
}

export interface SqlClient {
  query(text: string, values?: unknown[]): Promise<SqlResult>;
  release(): void;
}

export interface SqlPool {
  query(text: string, values?: unknown[]): Promise<SqlResult>;
  connect(): Promise<SqlClient>;
}

export interface WahaConfig {
  /** Base da API WAHA (ex: http://waha:3000). */
  url: string;
  apiKey: string;
  /** URL do webhook do apps/api (TS_WEBHOOK_URL). */
  webhookUrl: string;
  /**
   * Auth do webhook WAHA em sessão NOVA (P0 security #268 + spike 2026-06-11).
   * AMBOS opcionais (ausentes = comportamento atual, sem auth). Mesmas envs do
   * apps/api — manter em sincronia (a precedência de validação é decidida LÁ):
   *  - webhookHmacKey (plano A, env WAHA_WEBHOOK_HMAC_KEY): sessão nasce com
   *    webhooks[].hmac.key — o WAHA assina o raw body de cada POST.
   *  - webhookSecret (plano B, env WAHA_WEBHOOK_SECRET): sessão nasce com o
   *    header estático X-Webhook-Secret via webhooks[].customHeaders (contrato
   *    do nome: apps/api/src/lib/webhook-auth.ts).
   * Sem isso aqui, sessão criada com a env ligada no apps/api levaria 401 e o
   * bot nasceria surdo. NUNCA logar os valores.
   */
  webhookHmacKey?: string;
  webhookSecret?: string;
}

// ---------------------------------------------------------------------------
// Defaults por matriz (movido de painel-admin/server.js — fallback quando a
// matriz não tem horarios/servicos preenchidos em bot_config)
// ---------------------------------------------------------------------------

const CLONE_DEFAULTS_BARBEARIA = {
  horarios_funcionamento: {
    segunda: { abre: null, fecha: null, fechado: true },
    terca: { abre: '09:00', fecha: '18:00', fechado: false },
    quarta: { abre: '09:00', fecha: '18:00', fechado: false },
    quinta: { abre: '09:00', fecha: '18:00', fechado: false },
    sexta: { abre: '09:00', fecha: '18:00', fechado: false },
    sabado: { abre: '09:00', fecha: '18:00', fechado: false },
    domingo: { abre: null, fecha: null, fechado: true },
  },
  servicos: [
    { nome: 'Corte', preco_cents: 5000, duracao_min: 30 },
    { nome: 'Barba', preco_cents: 5000, duracao_min: 30 },
    { nome: 'Sobrancelha', preco_cents: 5000, duracao_min: 30 },
    { nome: 'Pezinho', preco_cents: 5000, duracao_min: 30 },
  ],
} as const;

export interface CloneDefaults {
  horarios_funcionamento: unknown | null;
  servicos: unknown | null;
}

/**
 * Defaults para clone novo (movido de painel-admin). Hierarquia:
 *  1) bot_config.horarios_funcionamento + bot_config.servicos da MATRIZ.
 *  2) Hardcoded por matriz (teste_barbearia).
 *  3) null/null (outras matrizes).
 */
export async function getCloneDefaults(db: SqlPool, matrizSlot: string): Promise<CloneDefaults> {
  try {
    const r = await db.query(
      'SELECT horarios_funcionamento, servicos FROM bot_config WHERE slot = $1',
      [matrizSlot],
    );
    const row = r.rows[0];
    if (row && (row.horarios_funcionamento || row.servicos)) {
      const fallback: CloneDefaults =
        matrizSlot === 'teste_barbearia'
          ? CLONE_DEFAULTS_BARBEARIA
          : { horarios_funcionamento: null, servicos: null };
      return {
        horarios_funcionamento: row.horarios_funcionamento ?? fallback.horarios_funcionamento,
        servicos: row.servicos ?? fallback.servicos,
      };
    }
  } catch (e) {
    log.warn(
      { matrizSlot, err: e instanceof Error ? e.message : String(e) },
      'getCloneDefaults: falha ao ler bot_config da matriz',
    );
  }
  if (matrizSlot === 'teste_barbearia') return CLONE_DEFAULTS_BARBEARIA;
  return { horarios_funcionamento: null, servicos: null };
}

// ---------------------------------------------------------------------------
// Render de prompt por clone (movido de painel-admin/server.js)
// ---------------------------------------------------------------------------

const DIAS_SEMANA: ReadonlyArray<readonly [string, string]> = [
  ['segunda', 'Segunda'],
  ['terca', 'Terca'],
  ['quarta', 'Quarta'],
  ['quinta', 'Quinta'],
  ['sexta', 'Sexta'],
  ['sabado', 'Sabado'],
  ['domingo', 'Domingo'],
];

interface HorarioDiaLike {
  abre?: string | null;
  fecha?: string | null;
  fechado?: boolean;
}

export function renderHorariosFuncionamento(horarios: unknown): string {
  if (!horarios || typeof horarios !== 'object') return 'Nao configurado.';
  const h = horarios as Record<string, HorarioDiaLike | undefined>;
  const linhas: string[] = [];
  for (const [key, label] of DIAS_SEMANA) {
    const dia = h[key];
    if (!dia || dia.fechado) {
      linhas.push(`${label}: fechado`);
    } else if (dia.abre && dia.fecha) {
      linhas.push(`${label}: ${dia.abre} as ${dia.fecha}`);
    } else {
      linhas.push(`${label}: nao configurado`);
    }
  }
  return linhas.join('\n');
}

interface ServicoLike {
  nome?: unknown;
  preco_cents?: unknown;
  duracao_min?: unknown;
}

export function renderServicosPrecos(servicos: unknown): string {
  if (!Array.isArray(servicos) || servicos.length === 0) return 'Nenhum servico cadastrado.';
  return (
    (servicos as ServicoLike[])
      .filter((s) => s && typeof s === 'object' && s.nome)
      .map((s) => {
        const nome = String(s.nome).trim();
        const preco = Number(s.preco_cents);
        const dur = Number(s.duracao_min);
        const precoStr =
          Number.isFinite(preco) && preco > 0
            ? `R$${(preco / 100).toFixed(2).replace('.', ',')}`
            : 'a combinar';
        const durStr = Number.isFinite(dur) && dur > 0 ? `${dur} min` : 'duracao a combinar';
        return `${nome}: ${precoStr} (${durStr})`;
      })
      .join('\n') || 'Nenhum servico cadastrado.'
  );
}

/**
 * Fallback seguro para o nome do negócio. Centralizado pra que o render e o
 * passe de sanitização final usem EXATAMENTE o mesmo texto.
 */
const NOME_NEGOCIO_FALLBACK = 'a barbearia';

/**
 * Área/vertical do negócio (Missão 023 W8). Mapa CÓDIGO -> {{area_artigo}}, a
 * frase pronta COM artigo que entra no prompt (ex.: "a barbearia", "o salao").
 *
 * Por que frase pronta e não montar artigo no template: evita concordância
 * errada da IA e mantém o prompt-base legível pro operador (decisão ai-engineer).
 *
 * Os valores são DELIBERADAMENTE iguais ao design (w5-w6-w8-w11-ia-design.md). A
 * TAXONOMIA canônica é validada por Zod NO APP (signup) — este mapa só traduz o
 * código já-validado pra frase. Código desconhecido/ausente cai no fallback
 * genérico AREA_ARTIGO_FALLBACK (nunca placeholder cru, nunca artigo errado).
 *
 * `'outro'` é o catch-all do signup; `'generico'` é alias histórico do design —
 * ambos mapeiam pro tom neutro.
 */
const AREA_ARTIGO: Readonly<Record<string, string>> = {
  barbearia: 'a barbearia',
  cabeleireiro: 'o salao',
  manicure: 'o espaco de unhas',
  estetica: 'o studio de estetica',
  outro: 'o atendimento',
  generico: 'o atendimento',
};

/** Tom neutro quando a área é ausente/desconhecida (clone antigo, valor fora do mapa). */
const AREA_ARTIGO_FALLBACK = 'o atendimento';

/**
 * Resolve a frase {{area_artigo}} a partir do código de área (já validado no app).
 * Trim + lower defensivo; valor fora do mapa -> fallback genérico ("o atendimento").
 * Centralizado pra que render e backfill/tests usem a MESMA tabela.
 */
export function areaArtigo(area: unknown): string {
  if (typeof area !== 'string') return AREA_ARTIGO_FALLBACK;
  const key = area.trim().toLowerCase();
  return AREA_ARTIGO[key] ?? AREA_ARTIGO_FALLBACK;
}

/**
 * Neutraliza um valor injetável (display_name / nome_negocio) ANTES de entrar no
 * prompt: remove as sequências de delimitador de placeholder ("{{" e "}}") e
 * quebras de linha (\n,\r). Isso impede que um nome de cadastro self-service
 * (a) injete um placeholder novo — ex.: um nome "{{servicos_precos_render}}"
 * passaria a ser expandido — e (b) reduz superfície de prompt-injection por
 * quebra de linha. Nomes legítimos não são alterados (só strip dessas
 * sequências). NÃO faz trim de espaços comuns — a checagem de "vazio" é feita
 * por quem chama, com trim.
 */
export function sanitizeNomeInjetavel(nome: string): string {
  return nome.replace(/\{\{|\}\}/g, '').replace(/[\r\n]+/g, ' ');
}

/**
 * Passe final de sanitização: NUNCA deixar um placeholder {{chave}} órfão crú
 * no prompt persistido. Aplicado no fim de TODO caminho que grava bot_prompt do
 * clone (renderClonePrompt + render inline de bootstrap em createCloneRecords),
 * inclusive quando regerarPromptClone falha (warn-and-continue) e o prompt que
 * sobra é o do bootstrap — onde nome_negocio não foi resolvido.
 *
 * - {{nome_negocio}} órfão -> fallback seguro ("a barbearia"). É o caso real do
 *   gestão (personalizacao sem nome_negocio): antes ficava literal no banco,
 *   pior que o hardcode antigo.
 * - {{area_artigo}} órfão -> fallback genérico ("o atendimento"). Necessário no
 *   render de BOOTSTRAP de createCloneRecords (que só resolve chaves presentes em
 *   personalizacao): se o caminho não trouxer `area`, o {{area_artigo}} da matriz
 *   (Missão 023 W8) cairia literal no banco — mesmo problema que {{nome_negocio}}.
 *   No render normal (renderClonePrompt) area_artigo já é sempre resolvido (com
 *   fallback), então este passe só atua no caminho de bootstrap.
 * - demais placeholders órfãos -> preservados ({{chave}}), comportamento
 *   histórico (não perder dado/marcador desconhecido). Genérico: se um dia
 *   outro marcador "de nome" precisar de fallback, basta estendê-lo aqui.
 */
export function sanitizeOrphanPlaceholders(prompt: string): string {
  return prompt.replace(/\{\{(\w+)\}\}/g, (_m, k: string) => {
    if (k === 'nome_negocio') return NOME_NEGOCIO_FALLBACK;
    if (k === 'area_artigo') return AREA_ARTIGO_FALLBACK;
    return `{{${k}}}`;
  });
}

/**
 * Aplica os 3 grupos de placeholders {{double_brace}} sobre o template da matriz.
 * Placeholders não resolvidos são preservados ({{key}}), EXCETO {{nome_negocio}}
 * que é garantido pelo passe final de sanitização (nunca literal no persistido).
 */
export function renderClonePrompt(
  matrizPrompt: string,
  personalizacao: unknown,
  horarios: unknown,
  servicos: unknown,
  displayName?: string,
): string {
  const pers: Record<string, unknown> =
    personalizacao && typeof personalizacao === 'object' && !Array.isArray(personalizacao)
      ? (personalizacao as Record<string, unknown>)
      : {};
  // nome_negocio: precedência personalizacao > display_name do clone > fallback
  // genérico. A precedência usa CHECAGEM trim() EXPLÍCITA (não `??`): "" e
  // strings só-whitespace contam como vazio e caem pro próximo nível. Trocar
  // por `??` reintroduziria o bug de string vazia (um persNome = "" venceria o
  // display_name e renderizaria nome vazio). O fallback final garante que
  // {{nome_negocio}} nunca renderize literal nem vazio, mesmo num clone sem
  // display_name e sem personalização.
  const persNome = pers.nome_negocio;
  const rawNome =
    typeof persNome === 'string' && persNome.trim() !== ''
      ? persNome
      : displayName && displayName.trim() !== ''
        ? displayName
        : NOME_NEGOCIO_FALLBACK;
  // {{area}} / {{area_artigo}}: vêm de personalizacao.area (selecionada no signup).
  // Mesmo mecanismo de resolução do {{nome_negocio}} — sem mudança de assinatura.
  // area_artigo é frase pronta com artigo (mapa AREA_ARTIGO); fallback genérico
  // ("o atendimento") quando area é ausente/desconhecida — clones antigos (sem
  // area) renderizam tom neutro, NUNCA placeholder cru. O valor canônico de area
  // vai pra {{area}} sanitizado (não vaza {{ }} se vier sujo de algum caminho).
  const areaRaw = pers.area;
  const ctx: Record<string, unknown> = {
    ...pers,
    nome_negocio: sanitizeNomeInjetavel(rawNome),
    area: typeof areaRaw === 'string' ? sanitizeNomeInjetavel(areaRaw.trim()) : '',
    area_artigo: areaArtigo(areaRaw),
    horarios_funcionamento_render: renderHorariosFuncionamento(horarios),
    servicos_precos_render: renderServicosPrecos(servicos),
  };
  let out = matrizPrompt.replace(/\{\{(\w+)\}\}/g, (_m, k: string) =>
    Object.prototype.hasOwnProperty.call(ctx, k) ? String(ctx[k] ?? '') : `{{${k}}}`,
  );
  const clienteNome = pers.cliente_nome;
  if (clienteNome) {
    out = out.replace(/\[Ricardo\]/g, `[${String(clienteNome)}]`);
  }
  return sanitizeOrphanPlaceholders(out);
}

export interface CloneRowLike {
  id: number;
  slot: string;
  matriz_slot: string;
  display_name?: string | null;
  personalizacao: unknown;
  horarios_funcionamento: unknown;
  servicos: unknown;
}

/**
 * Re-renderiza o prompt do clone a partir do template da MATRIZ e sobrescreve
 * bot_prompt do slot do clone. Idempotente (UPSERT).
 */
export async function regerarPromptClone(
  db: SqlPool,
  cloneRow: CloneRowLike,
): Promise<{ ok: true; prompt: string } | { ok: false; error: string }> {
  try {
    const matrizPrompt = await db.query('SELECT prompt FROM bot_prompt WHERE slot = $1', [
      cloneRow.matriz_slot,
    ]);
    const tpl = matrizPrompt.rows[0]?.prompt;
    if (typeof tpl !== 'string') {
      return { ok: false, error: `Matriz ${cloneRow.matriz_slot} sem prompt em bot_prompt` };
    }
    const prompt = renderClonePrompt(
      tpl,
      cloneRow.personalizacao,
      cloneRow.horarios_funcionamento,
      cloneRow.servicos,
      cloneRow.display_name ?? undefined,
    );
    // Dual-write tenant_id (ADR 0018, Fase 2): roda após o COMMIT do
    // createCloneRecords, então o clone já existe — subselect resolve o UUID.
    // NULL-safe se não houver linha.
    // Slot do subselect é parâmetro SEPARADO ($3) — não reusa $1 (evita
    // "inconsistent types deduced for parameter $1": bot_prompt.slot varchar(50)
    // vs flow_clones.slot varchar(80)).
    await db.query(
      `INSERT INTO bot_prompt (slot, prompt, updated_at, tenant_id)
       VALUES ($1, $2, NOW(), (SELECT tenant_id FROM flow_clones WHERE slot = $3))
       ON CONFLICT (slot) DO UPDATE SET prompt = EXCLUDED.prompt, updated_at = NOW(),
         tenant_id = COALESCE(bot_prompt.tenant_id, EXCLUDED.tenant_id)`,
      [cloneRow.slot, prompt, cloneRow.slot],
    );
    return { ok: true, prompt };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

// ---------------------------------------------------------------------------
// Sessão WAHA (movido de painel-admin/server.js)
// ---------------------------------------------------------------------------

/**
 * Deriva o nome da sessão WAHA a partir do slot do clone (movido do painel).
 * WAHA aceita apenas [a-zA-Z0-9_-]: troca hífens por underscores e prefixa
 * "clone_" para namespacing.
 */
export function wahaSessionName(slot: string): string {
  return `clone_${slot.replace(/-/g, '_')}`;
}

export interface WahaSessionResult {
  ok: boolean;
  status: string;
  error?: string;
}

/** Entrada de `config.webhooks[]` de uma sessão WAHA (subset que usamos). */
interface WahaWebhookEntry {
  url: string;
  events: string[];
  retries: { attempts: number; delaySeconds: number; policy: string };
  hmac?: { key: string };
  customHeaders?: Array<{ name: string; value: string }>;
}

// ---------------------------------------------------------------------------
// Padrão-ouro de sessão nova (diretriz Bruno 12/06): toda sessão WAHA criada
// pelo provisioning segue EXPLICITAMENTE a config das sessões prod comprovadas
// (GET real de `cirilobarbearia` na instância congelada WAHA Plus 2026.3.2
// NOWEB — evidência 2026-06-12). Os valores COINCIDEM com defaults da
// instância hoje, mas default implícito é FRÁGIL: a sessão do trial
// (`clone_bruna_barber_shop_gqgp4q`) nasceu com retries.delaySeconds=2
// enquanto Cirilo tem 3 — prova de que o default muda por fora do nosso
// código. NÃO remover esses blocos achando que são redundantes com o WAHA.
// Nomes de campo conferidos contra o schema da versão congelada (WebhookConfig
// tem `retries` no OpenAPI — spike docs/missoes/spike-waha-meid-customheaders.md;
// `ignore`/`noweb` aparecem no GET real das sessões dessa mesma instância).
// ---------------------------------------------------------------------------

/** Retry de entrega do webhook — igual Cirilo (attempts 15, constant 3s). */
const WEBHOOK_RETRIES = { attempts: 15, delaySeconds: 3, policy: 'constant' } as const;

/** Bot SÓ responde chat privado: ignora status, grupos, canais e broadcast. */
const SESSION_IGNORE = { status: true, groups: true, channels: true, broadcast: true } as const;

/**
 * Engine NOWEB igual Cirilo: markOnline ligado, store de chats/contatos
 * DESLIGADO (o painel já tem fallback via message_log pra sessões sem store —
 * recent-contacts). fullSync só faria sentido com store ligado.
 */
const SESSION_NOWEB = { markOnline: true, store: { enabled: false, fullSync: false } } as const;

/**
 * Monta a entrada de webhook da sessão nova: url do apps/api + events recebidos
 * + hmac.key (plano A) e/ou customHeaders (plano B), somente se configurados.
 * Os dois podem coexistir na sessão (o WAHA manda assinatura E header); a
 * precedência de validação é decidida pelo apps/api (webhook-auth.ts).
 * Espelho do buildWahaWebhooks do painel-admin/server.js (rota legada
 * POST /api/sessions) — manter em sincronia.
 */
function buildWebhook(waha: WahaConfig, events: string[]): WahaWebhookEntry {
  // retries explícito (padrão Cirilo, diretriz Bruno 12/06) — ver bloco
  // "Padrão-ouro de sessão nova" acima.
  const webhook: WahaWebhookEntry = { url: waha.webhookUrl, events, retries: WEBHOOK_RETRIES };
  if (waha.webhookHmacKey) {
    webhook.hmac = { key: waha.webhookHmacKey };
  }
  if (waha.webhookSecret) {
    webhook.customHeaders = [{ name: 'X-Webhook-Secret', value: waha.webhookSecret }];
  }
  return webhook;
}

/**
 * Cria sessão WAHA com webhook configurado. NUNCA lança — encapsula falha pra o
 * caller decidir (clone permanece em rascunho; retry-waha cobre).
 */
export async function createWahaSession(
  waha: WahaConfig,
  name: string,
): Promise<WahaSessionResult> {
  try {
    const r = await fetch(`${waha.url}/api/sessions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(waha.apiKey ? { 'X-Api-Key': waha.apiKey } : {}),
      },
      body: JSON.stringify({
        name,
        start: true,
        // events MUST include 'message.any' — engine NOWEB do WAHA so manda
        // audio/video/imagem sob 'message.any', nao 'message'. Sem isso o bot
        // fica surdo pra audio (Bruno 2026-05-21) e o pause do dono quebra
        // (memoria reference_waha_fromme_message_any). 'session.status' alimenta
        // o hook de trial do pareamento (Missao 020 F1).
        //
        // 'message' NAO entra de proposito: 'message.any' e SUPERSET de
        // 'message' na NOWEB — assinar os dois faz a mesma mensagem inbound
        // chegar 2x (event.id diferentes, dedup nao pega) e o bot responder
        // em dobro (bug do smoke do Bruno 2026-06-12, sessao
        // clone_bruna_barber_shop_gqgp4q). Sessoes estaveis em prod
        // (cirilobarbearia, STARTAP_AI_PROD) rodam so com
        // ['message.any','session.status'] e nunca duplicaram. NAO
        // "corrigir de volta" adicionando 'message'.
        //
        // buildWebhook injeta hmac.key e/ou customHeaders quando configurados
        // (auth do webhook — P0 #268 + spike 2026-06-11).
        //
        // ignore/noweb explícitos (padrão Cirilo, diretriz Bruno 12/06): toda
        // sessão nova segue a config das sessões prod comprovadas em vez de
        // herdar default implícito da instância WAHA — ver bloco "Padrão-ouro
        // de sessão nova" acima. ignore garante que o bot SÓ responde chat
        // privado (nada de status/grupos/canais/broadcast).
        config: {
          webhooks: [buildWebhook(waha, ['message.any', 'session.status'])],
          ignore: SESSION_IGNORE,
          noweb: SESSION_NOWEB,
        },
      }),
    });
    const body = (await r.json().catch(() => ({}))) as Record<string, unknown>;
    if (!r.ok) {
      const msg = (body.message ?? body.error ?? `HTTP ${r.status}`) as string;
      return { ok: false, status: 'failed', error: `WAHA: ${msg}` };
    }
    return { ok: true, status: (body.status as string | undefined) ?? 'STARTING' };
  } catch (e) {
    return {
      ok: false,
      status: 'failed',
      error: `Falha ao contatar WAHA: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
}

/**
 * Derruba a sessão WAHA (DELETE /api/sessions/{name} — para e remove). NUNCA
 * lança. Guarda: só sessões prefixadas clone_ (jamais toca sessão de matriz/
 * cliente manual como cirilobarbearia/startap).
 */
export async function deleteWahaSession(waha: WahaConfig, name: string): Promise<boolean> {
  if (!name.startsWith('clone_')) {
    log.error({ session: name }, 'deleteWahaSession recusado: sessão sem prefixo clone_');
    return false;
  }
  try {
    const r = await fetch(`${waha.url}/api/sessions/${encodeURIComponent(name)}`, {
      method: 'DELETE',
      headers: waha.apiKey ? { 'X-Api-Key': waha.apiKey } : {},
      signal: AbortSignal.timeout(8_000),
    });
    return r.ok;
  } catch (e) {
    log.warn(
      { session: name, err: e instanceof Error ? e.message : String(e) },
      'deleteWahaSession falhou (cleanup cron de órfãos cobre — card próprio)',
    );
    return false;
  }
}

export interface TeardownResult {
  wahaDeleted: boolean;
  dbDeleted: boolean;
}

/**
 * Compensating teardown de clone ÓRFÃO de falha parcial do signup (security
 * review PR #268, item P2 #5): provisionamento ok mas criação de conta/billing
 * falhou — sem isso, sessões WAHA sem dono acumulam e amplificam o DoS de RAM.
 *
 * Remove APENAS o que o próprio fluxo de signup acabou de criar, keyed pelo
 * slot fresco (sufixo aleatório, gerado neste mesmo request). NUNCA toca o
 * trial_ledger (permanente por design — e nesta fase nenhum trial foi consumido).
 *
 * Guardas (defesa em profundidade):
 *  - slot precisa do prefixo clone_;
 *  - a row de flow_clones precisa estar em rascunho/aguardando_qr (clone que já
 *    progrediu — conectado/pareado — JAMAIS é derrubado por aqui).
 *
 * Best-effort: NUNCA lança (o caller já está num caminho de erro 4xx/5xx).
 */
export async function teardownProvisionedClone(
  deps: { db: SqlPool; waha: WahaConfig },
  input: { slot: string; sessionName: string },
): Promise<TeardownResult> {
  const out: TeardownResult = { wahaDeleted: false, dbDeleted: false };
  if (!input.slot.startsWith('clone_')) {
    log.error({ slot: input.slot }, 'teardown recusado: slot sem prefixo clone_');
    return out;
  }

  out.wahaDeleted = await deleteWahaSession(deps.waha, input.sessionName);

  let client: SqlClient | null = null;
  try {
    client = await deps.db.connect();
    await client.query('BEGIN');
    const st = await client.query('SELECT status FROM flow_clones WHERE slot = $1 FOR UPDATE', [
      input.slot,
    ]);
    const status = st.rows[0]?.status as string | undefined;
    if (status !== undefined && status !== 'rascunho' && status !== 'aguardando_qr') {
      await client.query('ROLLBACK');
      log.error({ slot: input.slot, status }, 'teardown abortado: clone já progrediu de estado');
      return out;
    }
    // Espelho exato do que createCloneRecords + signup criaram para este slot.
    // portal_users/portal_user_clones por SLOT (nunca por username): no 23505 a
    // conta pré-existente tem outro slot e não é tocada.
    await client.query('DELETE FROM portal_user_clones WHERE slot = $1', [input.slot]);
    await client.query('DELETE FROM portal_users WHERE slot = $1', [input.slot]);
    await client.query('DELETE FROM client_billing WHERE slot = $1', [input.slot]);
    await client.query('DELETE FROM bot_media WHERE slot = $1', [input.slot]);
    await client.query('DELETE FROM bot_prompt WHERE slot = $1', [input.slot]);
    await client.query('DELETE FROM bot_config WHERE slot = $1', [input.slot]);
    await client.query('DELETE FROM flow_controls WHERE flow_id = $1', [input.slot]);
    await client.query('DELETE FROM flow_clones WHERE slot = $1', [input.slot]);
    await client.query('COMMIT');
    out.dbDeleted = true;
    log.info({ slot: input.slot, wahaDeleted: out.wahaDeleted }, 'clone órfão removido (teardown)');
  } catch (e) {
    if (client) await client.query('ROLLBACK').catch(() => {});
    log.error(
      { slot: input.slot, err: e instanceof Error ? e.message : String(e) },
      'teardown de clone órfão falhou — cleanup cron cobre (card próprio)',
    );
  } finally {
    client?.release();
  }
  return out;
}

// ---------------------------------------------------------------------------
// Geração de slot (signup self-service — espelha flow-clones.ts createClone)
// ---------------------------------------------------------------------------

function slugify(text: string): string {
  return (
    text
      .toLowerCase()
      .normalize('NFD')
      // Remove diacríticos (combining marks U+0300–U+036F) após o NFD —
      // mesmo padrão do slugify de packages/db/src/queries/flow-clones.ts.
      // biome-ignore lint/suspicious/noMisleadingCharacterClass: faixa de combining marks é proposital pós-NFD
      .replace(/[̀-ͯ]/g, '')
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '')
  );
}

function shortid(len: number): string {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let out = '';
  for (let i = 0; i < len; i++) {
    out += chars[Math.floor(Math.random() * chars.length)];
  }
  return out;
}

/**
 * Gera slot único para clone do signup: `clone_<slug>_<rand>`. O prefixo
 * "clone_" é OBRIGATÓRIO — o gate de billing (router 6b), o per-clone GCal e o
 * resolveCloneBot todos discriminam por `startsWith('clone_')`.
 */
export function generateCloneSlot(displayName: string): string {
  const slug = slugify(displayName).slice(0, 40) || 'negocio';
  return `clone_${slug}_${shortid(6)}`;
}

// ---------------------------------------------------------------------------
// Orquestração principal
// ---------------------------------------------------------------------------

/** Slot já existe em bot_config ou flow_clones. */
export class CloneSlotConflictError extends Error {
  constructor(slot: string) {
    super(`slot "${slot}" já existe`);
    this.name = 'CloneSlotConflictError';
  }
}

export class MatrizNotFoundError extends Error {
  constructor(matrizSlot: string) {
    super(`matriz_slot "${matrizSlot}" não encontrado em bot_config`);
    this.name = 'MatrizNotFoundError';
  }
}

export async function slotExists(db: SqlPool, slot: string): Promise<boolean> {
  const [bc, fc] = await Promise.all([
    db.query('SELECT 1 FROM bot_config WHERE slot = $1', [slot]),
    db.query('SELECT 1 FROM flow_clones WHERE slot = $1', [slot]),
  ]);
  return bc.rows.length > 0 || fc.rows.length > 0;
}

export interface ProvisionInput {
  matrizSlot: string;
  novoSlot: string;
  displayName: string;
  telefoneContato?: string | null;
  personalizacao?: Record<string, unknown>;
  /** Nome da sessão WAHA. Default: wahaSessionName(novoSlot) — comportamento do gestão. */
  sessionName?: string;
}

export interface ProvisionResult {
  cloneId: number;
  slot: string;
  sessionName: string;
  wahaStatus: string;
  wahaError?: string;
  cloneStatus: 'rascunho' | 'aguardando_qr';
}

/**
 * Cria os registros do clone em transação única (mesma sequência do with-waha):
 * bot_config (com overrides de personalizacao) -> bot_prompt (placeholders) ->
 * bot_media -> flow_controls -> flow_clones (status 'rascunho', defaults de
 * horarios/servicos da matriz). Retorna a row de flow_clones.
 */
export async function createCloneRecords(
  db: SqlPool,
  input: Omit<ProvisionInput, 'sessionName'>,
): Promise<CloneRowLike & Record<string, unknown>> {
  const pers =
    input.personalizacao &&
    typeof input.personalizacao === 'object' &&
    !Array.isArray(input.personalizacao)
      ? input.personalizacao
      : {};

  // Unicidade (defesa em profundidade — rotas também checam antes).
  if (await slotExists(db, input.novoSlot)) {
    throw new CloneSlotConflictError(input.novoSlot);
  }

  const client = await db.connect();
  try {
    await client.query('BEGIN');

    const cfgR = await client.query(
      'SELECT provider, model, temperature FROM bot_config WHERE slot = $1',
      [input.matrizSlot],
    );
    if (!cfgR.rows[0]) {
      await client.query('ROLLBACK');
      throw new MatrizNotFoundError(input.matrizSlot);
    }
    const { provider, model, temperature } = cfgR.rows[0] as {
      provider: string;
      model: string;
      temperature: string;
    };

    // Campos de bot_config podem ser sobrescritos por personalizacao (gestão).
    // No signup self-service NÃO passamos override — modelo vem da matriz (banco).
    const finalProvider = (pers.provider as string | undefined) ?? provider;
    const finalModel = (pers.model as string | undefined) ?? model;
    const finalTemperature = (pers.temperature as string | undefined) ?? temperature;

    await client.query(
      `INSERT INTO bot_config (slot, display_name, provider, model, temperature, updated_at)
       VALUES ($1, $2, $3, $4, $5::numeric, NOW())`,
      [input.novoSlot, input.displayName, finalProvider, finalModel, finalTemperature],
    );

    const promptR = await client.query('SELECT prompt FROM bot_prompt WHERE slot = $1', [
      input.matrizSlot,
    ]);
    const tpl = promptR.rows[0]?.prompt;
    if (typeof tpl === 'string') {
      // Render inline "de bootstrap": no caminho feliz é SOBRESCRITO logo após o
      // COMMIT por regerarPromptClone (que aplica nome_negocio/horarios/servicos
      // completos). Não replicar a lógica de nome_negocio aqui — inflaria o diff.
      // MAS regerarPromptClone pode falhar (warn-and-continue) e este prompt de
      // bootstrap fica sendo o persistido: por isso o passe final de sanitização
      // é OBRIGATÓRIO também aqui (no gestão, pers não traz nome_negocio, então
      // {{nome_negocio}} ficaria literal — pior que o hardcode antigo).
      let prompt = tpl.replace(/\{\{(\w+)\}\}/g, (_m, k: string) =>
        Object.prototype.hasOwnProperty.call(pers, k) ? String(pers[k] ?? '') : `{{${k}}}`,
      );
      const clienteNome = pers.cliente_nome;
      if (clienteNome) {
        prompt = prompt.replace(/\[Ricardo\]/g, `[${String(clienteNome)}]`);
      }
      await client.query(
        'INSERT INTO bot_prompt (slot, prompt, updated_at) VALUES ($1, $2, NOW())',
        [input.novoSlot, sanitizeOrphanPlaceholders(prompt)],
      );
    }

    // bot_media herdado da matriz (inclui course_slug e is_course_intro)
    const mediaR = await client.query(
      `SELECT position, media_type, url, caption, context, position_order, enabled,
              course_slug, is_course_intro
       FROM bot_media WHERE slot = $1`,
      [input.matrizSlot],
    );
    for (const m of mediaR.rows) {
      await client.query(
        `INSERT INTO bot_media
           (slot, position, media_type, url, caption, context, position_order, enabled,
            course_slug, is_course_intro, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,NOW())`,
        [
          input.novoSlot,
          m.position,
          m.media_type,
          m.url,
          m.caption,
          m.context,
          m.position_order,
          m.enabled,
          m.course_slug ?? null,
          m.is_course_intro ?? false,
        ],
      );
    }

    await client.query(
      `INSERT INTO flow_controls (flow_id, flow_name, source, active, updated_at)
       VALUES ($1, $2, 'clone', TRUE, NOW())
       ON CONFLICT (flow_id) DO UPDATE SET active = TRUE, updated_at = NOW()`,
      [input.novoSlot, input.displayName],
    );

    // Área/vertical (Missão 023 W8): chega via personalizacao.area (selecionada
    // no signup; validada por Zod no app). Persiste na COLUNA tipada flow_clones.area
    // (eixo de filtro/relatório) ALÉM de seguir em personalizacao (pro render do
    // prompt). NULL quando ausente — clone antigo/gestão-legado fica sem área e o
    // render usa o tom genérico. NÃO inventa default 'barbearia' aqui (o backfill da
    // migration cobre os clones atuais; novos sem escolha = NULL = neutro).
    const persArea = pers.area;
    const areaValue =
      typeof persArea === 'string' && persArea.trim() !== '' ? persArea.trim() : null;

    // Defaults de horarios/servicos conforme a matriz (clone novo já sai
    // oferecendo serviços comuns — evita "Nenhum servico cadastrado").
    const defaults = await getCloneDefaults(db, input.matrizSlot);
    const cloneR = await client.query(
      `INSERT INTO flow_clones
         (slot, matriz_slot, display_name, cliente_nome, cliente_telefone,
          personalizacao, area, horarios_funcionamento, servicos,
          status, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8::jsonb, $9::jsonb, 'rascunho', NOW(), NOW())
       RETURNING *`,
      [
        input.novoSlot,
        input.matrizSlot,
        input.displayName,
        null,
        input.telefoneContato ?? null,
        JSON.stringify(pers),
        areaValue,
        defaults.horarios_funcionamento ? JSON.stringify(defaults.horarios_funcionamento) : null,
        defaults.servicos ? JSON.stringify(defaults.servicos) : null,
      ],
    );

    // Dual-write tenant_id (ADR 0018, Fase 2): as satélites (bot_config/prompt/media)
    // foram inseridas ANTES de flow_clones existir (o UUID nasce no INSERT acima, do
    // DEFAULT gen_random_uuid()). Carimba o tenant_id recém-gerado nelas DENTRO da
    // mesma transação (atômico). Idempotente (guard tenant_id IS NULL). Fail-safe: se
    // ficar NULL, o backfill da migration 045 / próximo write cobre — nunca derruba o
    // provisioning do trial.
    const newTenantId = (cloneR.rows[0] as { tenant_id?: string }).tenant_id ?? null;
    if (newTenantId) {
      for (const tbl of ['bot_config', 'bot_prompt', 'bot_media', 'bot_courses'] as const) {
        await client.query(
          `UPDATE ${tbl} SET tenant_id = $1 WHERE slot = $2 AND tenant_id IS NULL`,
          [newTenantId, input.novoSlot],
        );
      }
    }

    await client.query('COMMIT');
    const row = cloneR.rows[0] as CloneRowLike & Record<string, unknown>;
    return { ...row, id: Number(row.id) };
  } catch (e) {
    // ROLLBACK já feito nos caminhos conhecidos; garante nos inesperados.
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

/**
 * Orquestração completa (mesmo contrato do POST /api/clones/with-waha):
 *  1. createCloneRecords (transação).
 *  2. regerarPromptClone (fora da transação — UPSERT idempotente).
 *  3. createWahaSession (falha NÃO reverte o clone — decisão Bruno 005-B;
 *     clone fica 'rascunho' e o retry-waha do gestão cobre).
 *  4. Vincula waha_sessao em flow_clones E bot_config (memória
 *     mapping_slot_waha_sessao) + status 'aguardando_qr'.
 */
export async function provisionCloneWithWaha(
  deps: { db: SqlPool; waha: WahaConfig },
  input: ProvisionInput,
): Promise<ProvisionResult> {
  const cloneRow = await createCloneRecords(deps.db, input);

  const rendered = await regerarPromptClone(deps.db, cloneRow);
  if (!rendered.ok) {
    log.warn({ slot: input.novoSlot, error: rendered.error }, 'regerarPromptClone falhou');
  }

  const sessionName = input.sessionName ?? wahaSessionName(input.novoSlot);
  const waha = await createWahaSession(deps.waha, sessionName);

  if (!waha.ok) {
    log.warn(
      { slot: input.novoSlot, cloneId: cloneRow.id, error: waha.error },
      'clone criado mas WAHA falhou',
    );
    return {
      cloneId: cloneRow.id,
      slot: input.novoSlot,
      sessionName,
      wahaStatus: 'failed',
      wahaError: waha.error,
      cloneStatus: 'rascunho',
    };
  }

  await Promise.all([
    deps.db
      .query(
        `UPDATE flow_clones SET waha_sessao = $1, status = 'aguardando_qr', updated_at = NOW() WHERE id = $2`,
        [sessionName, cloneRow.id],
      )
      .catch((e: unknown) =>
        log.error(
          { slot: input.novoSlot, err: e instanceof Error ? e.message : String(e) },
          'falha ao vincular sessão no DB',
        ),
      ),
    deps.db
      .query('UPDATE bot_config SET waha_sessao = $1, updated_at = NOW() WHERE slot = $2', [
        sessionName,
        input.novoSlot,
      ])
      .catch((e: unknown) =>
        log.error(
          { slot: input.novoSlot, err: e instanceof Error ? e.message : String(e) },
          'falha ao espelhar waha_sessao em bot_config',
        ),
      ),
  ]);

  log.info(
    { slot: input.novoSlot, cloneId: cloneRow.id, sessionName },
    'clone criado e sessão WAHA iniciada',
  );

  return {
    cloneId: cloneRow.id,
    slot: input.novoSlot,
    sessionName,
    wahaStatus: waha.status,
    cloneStatus: 'rascunho',
  };
}
