'use client';

/**
 * Card de billing (spec 6.6 + 3.2). Tom por regra D1 (computeBillingView):
 *   roxo (>=6d) · ambar (1..5d) · vermelho (vencido). Sem billing => roxo "em dia".
 *
 * Contraste (spec 1.A.9 + D2): no card ambar (solido), TODO o texto usa tinta
 * escura (amber-ink #1A1208) — branco sobre ambar reprova AA. Roxo/vermelho
 * solidos usam texto branco (AA). Barra de progresso com aria-label textual.
 */
import { IconChevronRight, IconWallet } from '@/components/icons';
import type { StatusBilling } from '@/lib/api-types';
import { type BillingTone, computeBillingView } from '@/lib/billing';
import { cn } from '@/lib/cn';
import { formatDueDate } from '@/lib/format';
import Link from 'next/link';

interface BillingCardProps {
  billing: StatusBilling | null;
}

// Cards de marca/billing seguem com fundo SOLIDO colorido mesmo no tema escuro
// (spec 1.A.9 / D10) — sao o ponto focal da Home sobre o fundo apagado.
const SURFACE: Record<BillingTone, string> = {
  brand: 'bg-brand-fill text-white',
  amber: 'bg-amber-fill text-amber-ink',
  danger: 'bg-danger-fill text-white',
  neutral: 'bg-brand-fill text-white',
};

/** Cor da meta (texto pequeno) — escura no ambar pra contraste (D2/1.A.9). */
const META: Record<BillingTone, string> = {
  brand: 'text-white/[0.82]',
  amber: 'text-amber-ink/85',
  danger: 'text-white/[0.85]',
  neutral: 'text-white/[0.82]',
};
const LABEL: Record<BillingTone, string> = {
  brand: 'text-white/70',
  amber: 'text-amber-ink/80',
  danger: 'text-white/75',
  neutral: 'text-white/70',
};
/** Cor do numero/titulo forte — escuro no ambar, branco no roxo/vermelho (1.A.9). */
const STRONG: Record<BillingTone, string> = {
  brand: 'text-white',
  amber: 'text-amber-ink',
  danger: 'text-white',
  neutral: 'text-white',
};

/**
 * CTA "Pagar mensalidade" sobre o card solido. Em vez de herdar a paleta da app,
 * o botao usa a TINTA do proprio card como superficie pra ter o contraste maximo
 * AA sobre o fundo colorido (espelha o primary D8: superficie clara, texto
 * escuro): no roxo/vermelho -> botao branco com texto na cor do card; no ambar
 * (ja escuro) -> botao amber-ink com texto claro. Foco com ring na cor do card.
 */
const CTA: Record<BillingTone, string> = {
  brand:
    'bg-white text-brand-fill hover:bg-white/90 focus-visible:ring-white/80 focus-visible:ring-offset-brand-fill',
  amber:
    'bg-amber-ink text-amber-fill hover:bg-amber-ink/90 focus-visible:ring-amber-ink/70 focus-visible:ring-offset-amber-fill',
  danger:
    'bg-white text-danger-fill hover:bg-white/90 focus-visible:ring-white/80 focus-visible:ring-offset-danger-fill',
  neutral:
    'bg-white text-brand-fill hover:bg-white/90 focus-visible:ring-white/80 focus-visible:ring-offset-brand-fill',
};

export function BillingCard({ billing }: BillingCardProps) {
  const view = computeBillingView(billing);
  const tone = view.tone;
  const due = formatDueDate(billing?.next_due_date ?? null);

  // Sem dados de billing — informativo, sem alarme (spec 3.2).
  if (!view.hasDueDate) {
    return (
      <BillingShell tone="brand">
        <BillingHeader label={LABEL.brand} tone="brand" />
        <div className="relative z-10 mt-1.5 font-display text-[20px] font-bold text-white">
          Mensalidade em dia
        </div>
        <p className={cn('relative z-10 mt-1 text-[13px]', META.brand)}>
          Pagamento controlado pelo suporte
        </p>
        <PagarLink tone="brand" label="Pagar mensalidade" />
      </BillingShell>
    );
  }

  const dias = view.diasRestantes ?? 0;

  // Texto do numero/estado.
  const big = view.vencido ? null : dias;
  const titleVencido = 'Mensalidade vencida';

  return (
    <BillingShell tone={tone}>
      <BillingHeader label={LABEL[tone]} tone={tone} />

      {view.vencido ? (
        <div
          className={cn(
            'relative z-10 mt-1.5 font-display text-[26px] font-bold tracking-[-0.02em]',
            STRONG[tone],
          )}
        >
          {titleVencido}
        </div>
      ) : (
        <div
          className={cn(
            'relative z-10 mt-1.5 font-display text-[34px] font-bold leading-none tracking-[-0.02em]',
            STRONG[tone],
          )}
        >
          {big}{' '}
          <span className="text-[15px] font-medium opacity-90">
            {dias === 1 ? 'dia restante' : 'dias restantes'}
          </span>
        </div>
      )}

      <p className={cn('relative z-10 mt-2 text-[13px]', META[tone])}>
        {view.vencido ? <>Vencia em {due}</> : <>Vence em {due}</>}
      </p>

      {view.proximo && (
        <p className={cn('relative z-10 mt-1 text-[13px] font-semibold', META.amber)}>
          Não deixe seu atendimento parar
        </p>
      )}
      {view.vencido && (
        <p className={cn('relative z-10 mt-1 text-[13px] font-semibold', META.danger)}>
          Fale com o suporte
        </p>
      )}

      {/* Barra de progresso do ciclo (decorativa-informativa, aria textual). */}
      {!view.vencido && (
        <div
          className={cn(
            'relative z-10 mt-3.5 h-1.5 overflow-hidden rounded-pill',
            tone === 'amber' ? 'bg-amber-ink/20' : 'bg-white/[0.22]',
          )}
          role="img"
          aria-label={`${dias} de 30 dias restantes`}
        >
          <span
            className={cn(
              'block h-full rounded-pill',
              tone === 'amber' ? 'bg-amber-ink' : 'bg-white',
            )}
            style={{ width: `${Math.max(0, Math.min(100, (dias / 30) * 100))}%` }}
          />
        </div>
      )}

      {/* Atalho pra pagar: urgente quando vencido/proximo, renovacao quando em dia. */}
      <PagarLink
        tone={tone}
        label={view.vencido || view.proximo ? 'Pagar agora' : 'Renovar mensalidade'}
      />
    </BillingShell>
  );
}

/**
 * Casca do billing (heroi E2, 1.D.2/1.D.4): fundo solido por tom + glow roxo
 * contido (hero-e2) + filete de marca branco no topo (billing-filete) + circulo
 * decorativo. h-full pra esticar junto do status no grid de 2 colunas (lg).
 */
function BillingShell({ tone, children }: { tone: BillingTone; children: React.ReactNode }) {
  return (
    <section
      aria-label="Sua mensalidade"
      className={cn(
        'hero-e2 billing-filete relative h-full overflow-hidden rounded-card p-5',
        SURFACE[tone],
      )}
    >
      <Decor />
      {children}
    </section>
  );
}

/** Linha de topo do billing (1.D.4): label + icone de contexto (carteira). */
function BillingHeader({ label, tone }: { label: string; tone: BillingTone }) {
  return (
    <div className="relative z-10 flex items-start justify-between gap-3">
      <span className={cn('text-[11px] font-semibold uppercase tracking-[0.08em]', label)}>
        Sua mensalidade
      </span>
      <span
        aria-hidden
        className={cn(
          'flex size-[34px] shrink-0 items-center justify-center rounded-[10px]',
          tone === 'amber' ? 'bg-amber-ink/12 text-amber-ink' : 'bg-white/[0.14] text-white',
        )}
      >
        <IconWallet size={18} />
      </span>
    </div>
  );
}

/**
 * Atalho pra tela de pagamento (/mensalidade). Requisito do dono: chegar ao PIX
 * em 1 toque a partir da Home. Link estilizado (nao usa <Button>, que e <button>
 * puro) — alvo de toque 44px (h-11), foco visivel, label contextual. So navega.
 */
function PagarLink({ tone, label }: { tone: BillingTone; label: string }) {
  return (
    <Link
      href="/mensalidade"
      aria-label={`${label} — abrir tela de pagamento`}
      className={cn(
        'relative z-10 mt-4 inline-flex h-11 w-full items-center justify-center gap-1.5 rounded-btn px-4 font-display text-[14px] font-semibold outline-none transition-[transform,background-color] duration-[120ms] active:scale-[0.98] focus-visible:ring-2 focus-visible:ring-offset-2',
        CTA[tone],
      )}
    >
      {label}
      <IconChevronRight size={17} />
    </Link>
  );
}

/** Circulo decorativo (rgba branco .07) — unico "brilho" permitido (spec 1.1). */
function Decor() {
  return (
    <span
      aria-hidden
      className="pointer-events-none absolute -bottom-[70px] -right-[60px] size-[170px] rounded-full bg-white/[0.07]"
    />
  );
}
