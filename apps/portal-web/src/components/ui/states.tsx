/**
 * Estados reutilizaveis: EmptyState e ErrorState (spec 3.7 / 6.15).
 * EmptyState SEMPRE diz o que fazer (CTA opcional). ErrorState oferece "Tente de
 * novo".
 *
 * Polish v2 (1.D.5): empty state caprichado — card surface com halo radial roxo
 * atras de um icone-chip 56px (brand-soft + borda line-strong). E o lugar onde o
 * vazio "respira". O `icon` deve vir em ~26px (cabe no chip). O halo fica mais
 * fraco no tema claro (gerido no CSS via [data-theme]).
 */
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

export function ErrorState({
  title = 'Não foi possível carregar',
  onRetry,
}: {
  title?: string;
  onRetry: () => void;
}) {
  return (
    <div className="flex flex-col items-center px-6 py-12 text-center" role="alert">
      <h3 className="font-display text-[17px] font-semibold text-ink">{title}</h3>
      <p className="mt-1.5 text-[14px] text-ink-soft">Verifique sua conexão e tente novamente.</p>
      <div className="mt-5 w-full max-w-[200px]">
        <Button variant="secondary" onClick={onRetry}>
          Tente de novo
        </Button>
      </div>
    </div>
  );
}
