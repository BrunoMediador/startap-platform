import { logger } from '@startap/core/logger';
/**
 * Tom da conversa do assistente (SCRUM-92) — o DONO ajusta, pelo portal, o quão "solto" o bot
 * responde. Por baixo é a `temperature` do `bot_config` do clone (o mesmo campo que o gestão já
 * edita e que o runtime consome em run-agent.ts: `opts.temperature ?? cfg.temperature ?? 0.3`).
 *
 * O dono NÃO digita um número cru — ele ESCOLHE um NÍVEL nomeado de um catálogo fechado
 * (princípio "selecionar, não digitar"). Cada nível mapeia pra uma temperatura dentro de uma
 * FAIXA SEGURA [MIN, MAX]. Fora dessa faixa o bot degrada (muito baixo = robótico/repetitivo;
 * muito alto = alucina, quebra JSON de tool-call, inventa preço/horário). Por isso:
 *
 *   - `nivel` (caminho recomendado, o front usa este): enum fechado → nome fora do catálogo = 400.
 *   - `temperatura` (caminho cru/defensivo): número contínuo → CLAMP DURO em [MIN, MAX]. Mesmo um
 *     cliente malformado/hostil que burle o enum NUNCA grava fora da faixa (defesa em profundidade).
 *
 * Escopado por request.tenant.slot (withTenant) — o slot vem SEMPRE da sessão, NUNCA do body
 * (anti-IDOR, regra de ouro 5). Só mexe em `temperature`; `model`/`provider` são intocados
 * (decisão do Bruno).
 */
import { botConfig } from '@startap/db';
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { requireTenant, withTenant } from '../lib/tenant.js';

const log = logger.child({ service: 'portal-api', module: 'tom-assistente' });

/** Faixa segura DURA. Nenhuma temperatura gravada por esta rota escapa daqui. */
export const TEMP_MIN = 0.2;
export const TEMP_MAX = 0.85;

/**
 * Catálogo de níveis (ordenado por temperatura crescente). O front renderiza o seletor/slider a
 * partir daqui; o mapa nível↔temperatura é a fonte única. Todos os valores caem dentro da faixa
 * segura [TEMP_MIN, TEMP_MAX].
 */
export interface NivelTom {
  nivel: string;
  temperatura: number;
  label: string;
  descricao: string;
}

export const NIVEIS_TOM: readonly NivelTom[] = [
  {
    nivel: 'direto',
    temperatura: 0.3,
    label: 'Direto e objetivo',
    descricao: 'Respostas curtas e previsíveis, foco em resolver rápido.',
  },
  {
    nivel: 'equilibrado',
    temperatura: 0.5,
    label: 'Equilibrado',
    descricao: 'Simpático sem enrolar. Recomendado pra maioria dos negócios.',
  },
  {
    nivel: 'caloroso',
    temperatura: 0.7,
    label: 'Caloroso',
    descricao: 'Mais conversa, acolhedor, com um toque a mais de simpatia.',
  },
  {
    nivel: 'bem_descontraido',
    temperatura: 0.85,
    label: 'Bem descontraído',
    descricao: 'Bem informal e espontâneo. Varia mais o jeito de responder.',
  },
] as const;

export const NIVEL_DEFAULT = 'equilibrado';

const NIVEIS_ENUM = NIVEIS_TOM.map((n) => n.nivel) as [string, ...string[]];

/** Prende `t` na faixa segura. Fora dos limites → gruda no limite mais próximo. */
function clampTemp(t: number): number {
  if (t < TEMP_MIN) return TEMP_MIN;
  if (t > TEMP_MAX) return TEMP_MAX;
  return t;
}

/**
 * Mapeia uma temperatura crua (do banco) pro nível nomeado mais próximo, pra exibição.
 * Empate → o de MENOR temperatura (mais conservador). Nunca retorna undefined (catálogo != vazio).
 */
export function temperaturaParaNivel(t: number): string {
  // Distância arredondada (milésimos) pra neutralizar ruído de ponto flutuante — sem isso,
  // 0.4 "empataria" entre 0.3 e 0.5 de forma não-determinística. Empate real → NIVEIS_TOM está
  // ordenado por temperatura crescente e só troca com dist ESTRITAMENTE menor, então o primeiro
  // (menor temperatura, mais conservador) vence.
  const dist = (n: NivelTom) => Math.round(Math.abs(t - n.temperatura) * 1000);
  let best = NIVEIS_TOM[0]!;
  let bestDist = dist(best);
  for (const n of NIVEIS_TOM) {
    const d = dist(n);
    if (d < bestDist) {
      best = n;
      bestDist = d;
    }
  }
  return best.nivel;
}

// PUT aceita OU um nível nomeado OU uma temperatura crua — exatamente um dos dois.
const putSchema = z
  .object({
    nivel: z.enum(NIVEIS_ENUM).optional(),
    temperatura: z.number().finite().optional(),
  })
  .strict()
  .refine((b) => (b.nivel === undefined) !== (b.temperatura === undefined), {
    message: 'informe_nivel_ou_temperatura',
  });

export const portalTomRoutes: FastifyPluginAsync = async (app) => {
  // GET: valor atual do clone (lê bot_config.temperature) + nível mapeado + catálogo + faixa.
  app.get(
    '/portal/tom-assistente',
    { preHandler: withTenant },
    async (req: FastifyRequest, reply) => {
      const { slot } = requireTenant(req);

      const cfg = await botConfig.getConfig(slot);
      if (!cfg) {
        // Clone sem bot_config: estado anormal (não provisionado) — o bot nem roda. Honesto: 404.
        return reply.code(404).send({ error: 'configuracao_indisponivel' });
      }

      const temperatura = cfg.temperature;
      return reply.code(200).send({
        temperatura,
        nivel: temperaturaParaNivel(temperatura),
        niveis: NIVEIS_TOM,
        faixa: { min: TEMP_MIN, max: TEMP_MAX },
        default: NIVEL_DEFAULT,
      });
    },
  );

  // PUT: grava um novo tom. Nível (enum) OU temperatura crua (clampada na faixa segura).
  app.put(
    '/portal/tom-assistente',
    { preHandler: withTenant },
    async (req: FastifyRequest, reply) => {
      const { slot, userId } = requireTenant(req);

      const parsed = putSchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        return reply
          .code(400)
          .send({ error: parsed.error.issues[0]?.message ?? 'payload_invalido' });
      }

      // Resolve a temperatura pedida: de um nível do catálogo (sempre in-range) ou do número cru.
      let pedida: number;
      if (parsed.data.nivel !== undefined) {
        const nivelDef = NIVEIS_TOM.find((n) => n.nivel === parsed.data.nivel);
        // Enum garante que existe; o `!` é defensivo pro TS.
        pedida = nivelDef!.temperatura;
      } else {
        pedida = parsed.data.temperatura as number;
      }

      // CLAMP DURO: defesa em profundidade. Mesmo se o enum for burlado, nada escapa da faixa.
      const efetiva = clampTemp(pedida);
      const clamped = efetiva !== pedida;

      const updated = await botConfig.updateConfig(slot, { temperature: efetiva });
      if (!updated) {
        // updateConfig faz UPDATE ... WHERE slot; 0 linhas = clone sem bot_config (não provisionado).
        return reply.code(404).send({ error: 'configuracao_indisponivel' });
      }

      log.info(
        { slot, userId, pedida, efetiva, clamped, nivel: temperaturaParaNivel(efetiva) },
        'tom do assistente atualizado via portal',
      );

      return reply.code(200).send({
        ok: true,
        temperatura: updated.temperature,
        nivel: temperaturaParaNivel(updated.temperature),
        clamped,
      });
    },
  );
};
