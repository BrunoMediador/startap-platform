'use client';

/**
 * Hero-zone da Inicio (spec 1.D.1/1.D.3). O fundo vivo (constelacao do login)
 * agora vive no shell (app)/layout — persiste em todas as rotas, atras de todas
 * as telas. A aurora roxa local FOI REMOVIDA: como era um radial confinado ao
 * retangulo do hero (position:absolute; inset:0), ela criava uma "caixa"/seam
 * visivel em volta da saudacao agora que o fundo da tela inteira e uniforme.
 * O contraste do texto sobre a constelacao vem da .app-vignette global do shell.
 * Sem a aurora os wrappers de stacking (.hero-zone/.hero-content) ficaram
 * redundantes — achatados num unico <div> que mantem so o espacamento.
 *
 * Saudacao editorial (1.D.3): kicker por horario + "Olá, {businessName}" grande
 * (Sora, gradiente de tinta) + linha de contexto calorosa que muda por estado do
 * bot. Sem emoji. MANTER grande (decisao Bruno).
 *
 * Layout em 1 coluna no mobile, 2 colunas (status | billing) no lg (>=1100px).
 */
import type { StatusResponse } from '@/lib/api-types';
import { dataPorExtenso, saudacao } from '@/lib/format';
import { resolveStatusHeroView } from '@/lib/status-operacional';
import { BillingCard } from './billing-card';
import { StatusHero } from './status-hero';

export function HeroZone({
  status,
  businessName,
}: { status: StatusResponse; businessName: string }) {
  const contexto = resolveStatusHeroView(status).context;

  return (
    // Sem wrappers de stacking: o fundo vivo (constelacao) vem do shell
    // (app)/layout e o conteudo rola por cima dele naturalmente. Mantem so as
    // classes de espacamento do hero.
    <div className="-mx-5 mb-[18px] px-5 pt-1 md:-mx-0 md:px-0">
      {/* Saudacao editorial (1.D.3) */}
      <div className="stagger stagger-1 min-w-0 px-0.5 pb-1 pt-1.5">
        <div className="mb-2.5 inline-flex items-center gap-2.5 text-[11px] font-semibold uppercase tracking-[0.14em] text-ink-faint">
          <span aria-hidden className="inline-block h-px w-[22px] bg-brand" />
          {saudacao()}
        </div>
        {/* break-words/overflow-wrap:anywhere garante que um nome de negócio longo
            quebre com elegância em vez de transbordar a borda do hero no mobile.
            Mantém o tamanho grande (decisão Bruno) — só muda a quebra. */}
        <h1 className="font-display text-[clamp(23px,5.6vw,28px)] font-bold leading-[1.12] tracking-[-0.02em] text-ink">
          Olá,{' '}
          <span className="break-words [overflow-wrap:anywhere] bg-gradient-to-b from-ink to-ink-soft bg-clip-text text-transparent">
            {businessName}
          </span>
        </h1>
        <p className="mt-[7px] text-[13.5px] text-ink-soft">
          {dataPorExtenso()} · {contexto}
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
  );
}
