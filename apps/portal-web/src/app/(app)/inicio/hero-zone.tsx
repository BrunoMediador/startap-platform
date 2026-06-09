'use client';

/**
 * Hero-zone da Inicio (spec 1.D.1/1.D.3). "Vida" SO na Inicio:
 *  - canvas `fullbg` = fundo full-viewport FIXO atras de TODO o conteudo da
 *    Inicio (preenche o preto vazio que sobrava no desktop). Como vive na page
 *    da Inicio, ele desmonta ao navegar -> outras telas ficam limpas;
 *  - aurora CSS no topo do hero como acento premium.
 * Atras vivem a saudacao editorial e os cards-heroi (status E1 + billing E2).
 * Nenhuma outra tela tem hero nem fundo vivo.
 *
 * Saudacao editorial (1.D.3): kicker por horario + "Olá, {businessName}" grande
 * (Sora, gradiente de tinta) + linha de contexto calorosa que muda por estado do
 * bot. Sem emoji. MANTER grande (decisao Bruno).
 *
 * O canvas (ParticleField variant="fullbg") ja: pausa fora de foco, e estatico
 * em reduced-motion, fica off no tema claro, dimensiona pelo viewport. Layout em
 * 1 coluna no mobile, 2 colunas (status | billing) no lg (>=1100px).
 */
import { ParticleField } from '@/components/fx/particle-field';
import type { StatusResponse } from '@/lib/api-types';
import { dataPorExtenso, saudacao } from '@/lib/format';
import { BillingCard } from './billing-card';
import { StatusHero } from './status-hero';

type BotState = 'ativo' | 'desconectado' | 'pausado';

function resolveState(status: StatusResponse): BotState {
  if (!status.flow_enabled) return 'pausado';
  return (status.waha.status ?? '').toUpperCase() === 'WORKING' ? 'ativo' : 'desconectado';
}

/** Frase de contexto calorosa por estado do bot (1.D.3). Sem emoji. */
const CONTEXTO: Record<BotState, string> = {
  ativo: 'tudo rodando por aqui.',
  desconectado: 'seu robô precisa de você — toque no status.',
  pausado: 'atendimento pausado, regularize pra voltar.',
};

export function HeroZone({
  status,
  businessName,
}: { status: StatusResponse; businessName: string }) {
  const state = resolveState(status);

  return (
    <>
      {/* Fundo full-viewport FIXO (atras de TODO o conteudo da Inicio): preenche
          o preto vazio que sobrava no desktop. Renderizado FORA da .hero-zone
          (que e um stacking context com z-index:1) pra nao ficar preso a ela —
          assim o canvas fica atras de tudo na pagina (saudacao, cards, metricas,
          agendamentos). z-index:-1, pointer-events:none, off no claro, desmonta
          ao sair da rota. */}
      <ParticleField variant="fullbg" />

      <div className="hero-zone -mx-5 mb-[18px] px-5 pt-1 md:-mx-0 md:px-0">
        {/* Aurora CSS como acento premium no topo do hero. */}
        <span className="hero-aurora" aria-hidden />

        {/* conteudo (acima do fundo via .hero-content z-index) */}
        <div className="hero-content">
          {/* Saudacao editorial (1.D.3) */}
          <div className="stagger stagger-1 px-0.5 pb-1 pt-1.5">
            <div className="mb-2.5 inline-flex items-center gap-2.5 text-[11px] font-semibold uppercase tracking-[0.14em] text-ink-faint">
              <span aria-hidden className="inline-block h-px w-[22px] bg-brand" />
              {saudacao()}
            </div>
            <h1 className="font-display text-[clamp(23px,5.6vw,28px)] font-bold leading-[1.12] tracking-[-0.02em] text-ink">
              Olá,{' '}
              <span className="bg-gradient-to-b from-ink to-ink-soft bg-clip-text text-transparent">
                {businessName}
              </span>
            </h1>
            <p className="mt-[7px] text-[13.5px] text-ink-soft">
              {dataPorExtenso()} · {CONTEXTO[state]}
            </p>
          </div>

          {/* Cards-heroi: status (E1) + billing (E2). 2 colunas no lg (>=1100px).
            Stagger de entrada 0.06s (status) e 0.12s (billing) — 1.D.6. */}
          <div className="mt-[18px] grid gap-3.5 min-[1100px]:grid-cols-2 min-[1100px]:items-stretch">
            <div className="stagger stagger-2 min-w-0 min-[1100px]:h-full">
              <StatusHero status={status} />
            </div>
            <div className="stagger stagger-3 min-w-0 min-[1100px]:h-full">
              <BillingCard billing={status.billing} />
            </div>
          </div>
        </div>
      </div>
    </>
  );
}
