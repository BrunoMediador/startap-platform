/**
 * Schemas Zod compartilhados para configuracao do fluxo editavel pelo cliente.
 *
 * Fonte unica de verdade (ADR 0012, Decisao 6): o portal-api JA nasce com esta
 * validacao forte; o painel-admin pode adotar num PR seguinte. Hoje a validacao
 * do painel e fraca (server.js:3752 so checa `nome`). Estes schemas validam
 * preco_cents >= 0 inteiro, duracao_min > 0 inteiro MULTIPLO DE 5 (grade de
 * agenda anda em passos de 5min — decisao Bruno 2026-06-11) e HH:MM com
 * abre < fecha.
 *
 * Espelha os tipos `ServicoConfig` e `HorariosFuncionamento` de
 * packages/db/src/queries/flow-clones.ts — mantidos compativeis de proposito.
 */
import { z } from 'zod';

// Re-export do validador de fuso (timezones.ts) para quem consome só o subpath
// @startap/core/schemas (portal-perfil, signup) achar timezoneSchema aqui também.
export { DEFAULT_TIMEZONE, isValidIanaTimezone, timezoneSchema } from '../timezones.js';

// ---------------------------------------------------------------------------
// Servicos: array de { nome, preco_cents, duracao_min }
// ---------------------------------------------------------------------------

export const servicoSchema = z
  .object({
    nome: z.string().trim().min(1, 'nome obrigatorio').max(120, 'nome muito longo'),
    preco_cents: z
      .number({ invalid_type_error: 'preco_cents deve ser numero' })
      .int('preco_cents deve ser inteiro (centavos)')
      .min(0, 'preco_cents nao pode ser negativo')
      .max(100_000_000, 'preco_cents fora do intervalo'),
    duracao_min: z
      .number({ invalid_type_error: 'duracao_min deve ser numero' })
      .int('duracao_min deve ser inteiro')
      .positive('duracao_min deve ser maior que zero')
      .multipleOf(5, 'duracao_min deve ser multiplo de 5 minutos')
      .max(1440, 'duracao_min nao pode exceder 24h'),
  })
  .strict();

export type Servico = z.infer<typeof servicoSchema>;

/** Array de servicos. Maximo 100 itens — guarda contra payload abusivo. */
export const servicosSchema = z.array(servicoSchema).max(100, 'maximo de 100 servicos');

export type Servicos = z.infer<typeof servicosSchema>;

// ---------------------------------------------------------------------------
// Horarios de funcionamento: { segunda..domingo: { abre, fecha, fechado } }
// ---------------------------------------------------------------------------

const HHMM_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

/** "HH:MM" 24h valido (00:00..23:59). */
export const horaSchema = z.string().regex(HHMM_RE, 'horario deve ser HH:MM (00:00..23:59)');

/** Converte "HH:MM" em minutos desde meia-noite (para comparar abre < fecha). */
function hhmmToMinutes(v: string): number {
  const [h, m] = v.split(':').map(Number);
  return h * 60 + m;
}

export const horarioDiaSchema = z
  .object({
    abre: horaSchema.nullable(),
    fecha: horaSchema.nullable(),
    fechado: z.boolean(),
  })
  .strict()
  .superRefine((dia, ctx) => {
    if (dia.fechado) {
      // Dia fechado: abre/fecha devem ser null (coerencia de dados).
      if (dia.abre !== null || dia.fecha !== null) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'dia fechado deve ter abre e fecha nulos',
        });
      }
      return;
    }
    // Dia aberto: abre e fecha obrigatorios e abre < fecha.
    if (dia.abre === null || dia.fecha === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'dia aberto exige abre e fecha preenchidos',
      });
      return;
    }
    if (hhmmToMinutes(dia.abre) >= hhmmToMinutes(dia.fecha)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'abre deve ser anterior a fecha',
      });
    }
  });

export type HorarioDia = z.infer<typeof horarioDiaSchema>;

export const DIAS_SEMANA = [
  'segunda',
  'terca',
  'quarta',
  'quinta',
  'sexta',
  'sabado',
  'domingo',
] as const;

/**
 * Grade horaria semanal. Cada dia e opcional (compativel com o tipo existente
 * HorariosFuncionamento), mas quando presente deve passar pelo horarioDiaSchema.
 */
export const horariosSchema = z
  .object({
    segunda: horarioDiaSchema.optional(),
    terca: horarioDiaSchema.optional(),
    quarta: horarioDiaSchema.optional(),
    quinta: horarioDiaSchema.optional(),
    sexta: horarioDiaSchema.optional(),
    sabado: horarioDiaSchema.optional(),
    domingo: horarioDiaSchema.optional(),
  })
  .strict();

export type Horarios = z.infer<typeof horariosSchema>;

// ---------------------------------------------------------------------------
// Perfil do negocio: dados editaveis pelo cliente no portal (Missao 023 W13).
//
// Os 6 campos vivem em flow_clones.personalizacao (JSONB), MESMA fonte que o
// gestao grava (PATCH /api/clones/:id) — sem migration. Todos OPCIONAIS: o
// cliente preenche o que quiser; vazio/ausente nao polui o contexto do bot
// (free-slots.ts omite chave vazia). `instagram` aceita com ou sem '@' (o
// renderer ja prefixa '@'); aqui so normalizamos removendo um '@' inicial pra
// nao virar '@@'. `formas_pagamento` agora e uma SELECAO (checklist), nao mais
// texto livre: array das opcoes fixas que o negocio aceita (SCRUM-23, principio
// "selecionar, nao digitar" — #365/#367). Array vazio ([]) limpa o campo.
// Storage continua STRING canonica no personalizacao (o bot/gestao leem string);
// a conversao array<->string vive no data layer (portal-config.ts).
// ---------------------------------------------------------------------------

/** Remove um unico '@' inicial e espacos das pontas (idempotente). */
function stripAtPrefix(v: string): string {
  return v.trim().replace(/^@+/, '');
}

// ---------------------------------------------------------------------------
// Formas de pagamento: lista FIXA de opcoes (decisao provisoria do Bruno —
// pode mudar antes do merge). Fonte unica usada pelo schema (validacao),
// pelo parser do legado e pelo serializador de storage.
// ---------------------------------------------------------------------------

export const FORMAS_PAGAMENTO_OPCOES = [
  'Dinheiro',
  'PIX',
  'Cartão de débito',
  'Cartão de crédito',
] as const;

export type FormaPagamentoOpcao = (typeof FORMAS_PAGAMENTO_OPCOES)[number];

/**
 * Array das formas aceitas, validado contra a lista fixa. Valor fora da lista
 * => ZodError (path `formas_pagamento`) => 400 no portal-api. Deduplica e
 * devolve SEMPRE na ordem canonica de FORMAS_PAGAMENTO_OPCOES (estavel pro
 * diff/dirty e pra string de storage). `[]` = "limpar". Campo opcional.
 */
export const formasPagamentoSchema = z
  .array(z.enum(FORMAS_PAGAMENTO_OPCOES), {
    invalid_type_error: 'formas de pagamento deve ser lista',
  })
  .max(FORMAS_PAGAMENTO_OPCOES.length, 'formas de pagamento invalidas')
  .transform((arr) => {
    const set = new Set<FormaPagamentoOpcao>(arr);
    return FORMAS_PAGAMENTO_OPCOES.filter((o) => set.has(o));
  })
  .optional();

/** Tokens normalizados (sem acento, minusculo) -> forma canonica, pro legado. */
const FORMA_PAGAMENTO_SINONIMOS: Record<string, FormaPagamentoOpcao> = {
  dinheiro: 'Dinheiro',
  especie: 'Dinheiro',
  cash: 'Dinheiro',
  pix: 'PIX',
  debito: 'Cartão de débito',
  'cartao de debito': 'Cartão de débito',
  'cartao debito': 'Cartão de débito',
  credito: 'Cartão de crédito',
  'cartao de credito': 'Cartão de crédito',
  'cartao credito': 'Cartão de crédito',
};

function normalizarToken(s: string): string {
  return s
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '') // tira acentos (combining diacritics)
    .toLowerCase()
    .trim();
}

/**
 * Best-effort: converte o `formas_pagamento` ANTIGO (texto livre, ex.: "Pix,
 * cartao, dinheiro") guardado no personalizacao para o array canonico do
 * checklist. Migracao LAZY: nada e reescrito no banco ate o dono salvar; aqui
 * so interpretamos pra pre-marcar os chips. Tokens nao-mapeaveis sao IGNORADOS
 * (ex.: "fiado" some do checklist; o texto antigo segue no DB ate o save).
 * "cartao" generico (sem debito/credito) marca AMBOS os cartoes. Ordem canonica,
 * deduplicado. Entrada vazia/invalida => [].
 */
export function parseFormasPagamento(raw: unknown): FormaPagamentoOpcao[] {
  if (typeof raw !== 'string' || raw.trim() === '') return [];
  const achadas = new Set<FormaPagamentoOpcao>();
  for (const parte of raw.split(/[,;/\n•·|]+|\be\b/i)) {
    const tok = normalizarToken(parte);
    if (tok === '') continue;
    const direto = FORMA_PAGAMENTO_SINONIMOS[tok];
    if (direto) {
      achadas.add(direto);
      continue;
    }
    // "cartao" / "cartoes" generico, sem qualificar debito/credito => ambos.
    if (/\bcart(a|o|ao|oes|ões)/.test(tok) && !/debito|credito/.test(tok)) {
      achadas.add('Cartão de débito');
      achadas.add('Cartão de crédito');
    }
  }
  return FORMAS_PAGAMENTO_OPCOES.filter((o) => achadas.has(o));
}

/** Serializa o array canonico pra STRING de storage no personalizacao. [] => "". */
export function formasPagamentoToString(arr: readonly FormaPagamentoOpcao[]): string {
  const set = new Set<FormaPagamentoOpcao>(arr);
  return FORMAS_PAGAMENTO_OPCOES.filter((o) => set.has(o)).join(', ');
}

// ---------------------------------------------------------------------------
// FAQ PERSONALIZADO (SCRUM-65): ate 10 pares pergunta+resposta que o dono
// cadastra no portal pra EXPANDIR a base de conhecimento do bot (assuntos que a
// gente nao mapeou: estacionamento, formas de entrega, politica de crianca...).
// Storage: array de {pergunta, resposta} na chave `faq_personalizado` do JSONB
// flow_clones.personalizacao — 1o valor NAO-string do personalizacao (grava as-is,
// nao serializa pra string como formas_pagamento). Injecao no bot e em RUNTIME
// (free-slots.renderFaqBlock), nunca via re-render do bot_prompt — vale pra
// prompt_custom (Meduzza) e no ato de salvar (cache invalidado).
//
// LIMITES (spec do ai-engineer): pergunta 1..120, resposta 1..300 (apos trim);
// max 10 pares. O custo do bot e input-dominado; 10x(120+300)+framing ~1.2k tokens
// no PIOR caso (comparavel a uma agenda enxuta, NAO dobra o custo).
// ---------------------------------------------------------------------------

/** Um par pergunta/resposta do FAQ. Ambos obrigatorios, trim aplicado antes dos limites. */
export const faqItemSchema = z
  .object({
    pergunta: z
      .string({ invalid_type_error: 'pergunta deve ser texto' })
      .trim()
      .min(1, 'pergunta obrigatoria')
      .max(120, 'pergunta muito longa (max 120 caracteres)'),
    resposta: z
      .string({ invalid_type_error: 'resposta deve ser texto' })
      .trim()
      .min(1, 'resposta obrigatoria')
      .max(300, 'resposta muito longa (max 300 caracteres)'),
  })
  .strict();

export type FaqItem = z.infer<typeof faqItemSchema>;

/**
 * Array de pares do FAQ, max 10. O preprocess (a) devolve `undefined` quando o valor
 * NAO e array (nao toca a chave no PATCH parcial) e (b) trima cada par e DESCARTA os
 * que tem pergunta OU resposta vazia (nao viram erro — decisao do produto: linha em
 * branco no formulario simplesmente some). O que sobra e validado DURO por faqItemSchema:
 * pergunta >120, resposta >300 ou >10 itens => ZodError => 400 (nao persiste). `[]` = limpar.
 */
export const faqPersonalizadoSchema = z.preprocess((v) => {
  if (!Array.isArray(v)) return undefined;
  const out: Array<{ pergunta: string; resposta: string }> = [];
  for (const item of v) {
    if (item == null || typeof item !== 'object') continue;
    const rec = item as Record<string, unknown>;
    const pergunta = typeof rec.pergunta === 'string' ? rec.pergunta.trim() : '';
    const resposta = typeof rec.resposta === 'string' ? rec.resposta.trim() : '';
    if (pergunta === '' || resposta === '') continue; // par vazio = descartado (nao e erro)
    out.push({ pergunta, resposta });
  }
  return out;
}, z.array(faqItemSchema).max(10, 'maximo de 10 perguntas frequentes').optional());

export const perfilSchema = z
  .object({
    nome_negocio: z.string().trim().max(120, 'nome do negocio muito longo').optional(),
    nome_prestador: z.string().trim().max(120, 'nome do prestador muito longo').optional(),
    telefone_contato: z.string().trim().max(40, 'telefone muito longo').optional(),
    endereco: z.string().trim().max(240, 'endereco muito longo').optional(),
    instagram: z
      .string()
      .trim()
      .max(120, 'instagram muito longo')
      .transform(stripAtPrefix)
      .optional(),
    formas_pagamento: formasPagamentoSchema,
    // ── MODO ATENDENTE (SCRUM-59) ──────────────────────────────────────────
    // Toggle fino por-clone: false = MODO ATENDENTE (bot sem agenda automática).
    // Efetivo-default TRUE via AUSÊNCIA (NÃO usa .default(true) de proposito: com
    // PATCH/merge, um .default reescreveria a chave em toda gravacao parcial e
    // CLOBBARIA um clone que estava em modo atendente). Ausente no payload = nao toca.
    // O bot/data-layer tratam ausencia como TRUE (agenda automatica = comportamento atual).
    agenda_automatica: z.boolean().optional(),
    // Link do sistema de agendamento externo do cliente (Booksy/Trinks/agenda propria).
    // OPCIONAL SEMPRE (decisao Bruno 03/07: o piloto insere depois): sem link, o bot
    // direciona pra "equipe confirma"; com link, entrega o link.
    // TRI-STATE (SCRUM-75 — corrige o SCRUM-59): o campo distingue 3 intencoes ->
    //   - AUSENTE (chave nao enviada)  = nao mexe (patch parcial).
    //   - ''  (ou so-espacos)          = LIMPAR (sentinela): o dono removeu o link. O data layer
    //                                    apaga a chave do JSONB (ver updatePerfilBySlot).
    //   - URL valida http(s)           = gravar (validada como hoje).
    // O preprocess normaliza so-espacos -> '' (NAO mais -> undefined). A justificativa antiga
    // ('' -> undefined pra "nao persistir lixo") ESTAVA ERRADA: mapear pra undefined fazia o
    // merge do data layer tratar '' como "chave ausente", entao LIMPAR o link virava no-op
    // silencioso (salvava 200 mas o link antigo ficava — bug reportado pelo Eduardo, SCRUM-75).
    // Agora '' e um valor de primeira classe (aceito via z.literal('')) que sinaliza limpar.
    // SECURITY (review SCRUM-59): z.url() sozinho aceita javascript:/data:/ftp: (so faz
    // new URL()). O backend e a fonte da verdade -> exige explicitamente http(s):// (o link
    // vai pro contexto do LLM e, no front, pode virar href). refine roda apos url().
    link_agendamento: z.preprocess(
      (v) => (typeof v === 'string' && v.trim() === '' ? '' : v),
      z
        .string()
        .trim()
        .url('link de agendamento invalido')
        .max(500)
        .refine(
          (v) => /^https?:\/\//i.test(v),
          'link de agendamento deve comecar com http:// ou https://',
        )
        .or(z.literal('')) // '' = sentinela de LIMPAR (aceito; nunca cai no .url())
        .optional(),
    ),
    // Planos / assinaturas / benefícios do negócio (pedido do cliente Meduzza, SCRUM-59).
    // Texto livre MULTI-LINHA — cai sozinho no bloco [OBSERVACOES E DADOS EXTRAS] do contexto do
    // LLM via _PERS_LABELS (free-slots), sem mudar o bot. TRI-STATE igual ao link_agendamento
    // (SCRUM-75): ausente = nao mexe; '' (ou so-espacos) = LIMPAR (o data layer apaga a chave do
    // JSONB); texto nao-vazio = grava (max 4000 chars, guarda contra payload abusivo). O preprocess
    // normaliza so-espacos -> '' (antes -> undefined, que transformava "limpar" em no-op silencioso).
    // z.string().max(4000) ja aceita '' nativamente (sem .url()), entao nao precisa de .literal('').
    planos_beneficios: z.preprocess(
      (v) => (typeof v === 'string' && v.trim() === '' ? '' : v),
      z.string().trim().max(4000, 'planos e assinaturas: texto muito longo').optional(),
    ),
    // FAQ personalizado (SCRUM-65): ate 10 pares pergunta+resposta cadastrados pelo dono.
    // Ausente/nao-array => undefined (nao toca a chave). [] => limpa. Injecao no bot em runtime.
    // Gate por-clone (FAQ_PERSONALIZADO_SLOTS): a rota recusa a chave quando OFF pro clone.
    faq_personalizado: faqPersonalizadoSchema,
  })
  .strict();

export type Perfil = z.infer<typeof perfilSchema>;

/** Chaves do perfil em flow_clones.personalizacao — fonte unica (GET/PUT + data layer). */
export const PERFIL_KEYS = [
  'nome_negocio',
  'nome_prestador',
  'telefone_contato',
  'endereco',
  'instagram',
  'formas_pagamento',
  'agenda_automatica',
  'link_agendamento',
  'planos_beneficios',
  'faq_personalizado',
] as const;

export type PerfilKey = (typeof PERFIL_KEYS)[number];
