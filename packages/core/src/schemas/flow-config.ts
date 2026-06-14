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
// nao virar '@@'. `formas_pagamento` e texto livre (ex.: "Pix, cartao,
// dinheiro"). String vazia ("") e aceita como "limpar o campo".
// ---------------------------------------------------------------------------

/** Remove um unico '@' inicial e espacos das pontas (idempotente). */
function stripAtPrefix(v: string): string {
  return v.trim().replace(/^@+/, '');
}

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
    formas_pagamento: z.string().trim().max(240, 'formas de pagamento muito longo').optional(),
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
] as const;

export type PerfilKey = (typeof PERFIL_KEYS)[number];
