/**
 * Estados reutilizaveis: EmptyState e ErrorState (spec 3.7 / 6.15).
 * EmptyState SEMPRE diz o que fazer (CTA opcional). ErrorState oferece "Tente de
 * novo".
 *
 * Polish v2 (1.D.5): empty state caprichado — card surface com halo radial roxo
 * atras de um icone-chip 56px (brand-soft + borda line-strong). E o lugar onde o
 * vazio "respira". O `icon` deve vir em ~26px (cabe no chip).
 */
import Link from 'next/link';
import { Button } from './button';

export function EmptyState({
  icon,
  title,
  description,
  action,
}: {
  icon: React.ReactNode;
  title: string;
  description: string;
  action?: { label: string; onClick: () => void };
}) {
  return (
    <div className="relative overflow-hidden rounded-card border border-line bg-surface px-6 pb-9 pt-8 text-center shadow-card">
      <span
        aria-hidden
        className="pointer-events-none absolute left-1/2 top-4 size-[120px] -translate-x-1/2 rounded-full"
        style={{ background: 'radial-gradient(circle, rgba(100,49,214,.18), transparent 70%)' }}
      />
      <span
        className="relative z-10 inline-flex size-14 items-center justify-center rounded-[16px] border border-line-strong bg-brand-soft text-brand"
        aria-hidden
      >
        {icon}
      </span>
      <h3 className="relative z-10 mt-3.5 font-display text-[17px] font-semibold text-ink">
        {title}
      </h3>
      <p className="relative z-10 mx-auto mt-1.5 max-w-[34ch] text-[14px] leading-normal text-ink-soft">
        {description}
      </p>
      {action && (
        <div className="relative z-10 mx-auto mt-5 w-full max-w-[260px]">
          <Button onClick={action.onClick}>{action.label}</Button>
        </div>
      )}
    </div>
  );
}

/**
 * ErrorState reusavel (spec 3.7 / 6.15) — tambem alimenta as telas de erro de
 * ROTA do App Router (SCRUM-93: error.tsx / not-found.tsx / global-error.tsx),
 * pra que crash de render e URL errada usem a MESMA marca/foco/a11y que o erro
 * inline de carga.
 *
 * Props aditivas (nao quebram os callers existentes, que passam so title+onRetry):
 *   - description: sobrescreve o texto de apoio (default = dica de conexao).
 *   - retryLabel: rotulo do botao de acao primaria (default "Tente de novo").
 *   - onRetry: OPCIONAL agora — sem ele, o botao de acao nao aparece (ex.: 404,
 *     onde "tentar de novo" nao faz sentido).
 *   - secondaryAction: rota de fuga como LINK (ex.: "Voltar ao inicio" -> /inicio),
 *     estilizada como o botao ghost. E um <Link> (navegacao real, server-safe).
 */
export function ErrorState({
  title = 'Não foi possível carregar',
  description = 'Verifique sua conexão e tente novamente.',
  onRetry,
  retryLabel = 'Tente de novo',
  secondaryAction,
}: {
  title?: string;
  description?: string;
  onRetry?: () => void;
  retryLabel?: string;
  secondaryAction?: { label: string; href: string };
}) {
  return (
    <div className="flex flex-col items-center px-6 py-12 text-center" role="alert">
      <h3 className="font-display text-[17px] font-semibold text-ink">{title}</h3>
      <p className="mt-1.5 max-w-[34ch] text-[14px] leading-normal text-ink-soft">{description}</p>
      {(onRetry || secondaryAction) && (
        <div className="mt-5 flex w-full max-w-[220px] flex-col gap-2.5">
          {onRetry && (
            <Button variant="secondary" onClick={onRetry}>
              {retryLabel}
            </Button>
          )}
          {secondaryAction && (
            <Link
              href={secondaryAction.href}
              className="inline-flex h-11 w-full items-center justify-center rounded-btn px-5 font-display text-[15px] font-semibold text-brand outline-none transition-colors hover:bg-brand-soft focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-2 focus-visible:ring-offset-bg"
            >
              {secondaryAction.label}
            </Link>
          )}
        </div>
      )}
    </div>
  );
}
