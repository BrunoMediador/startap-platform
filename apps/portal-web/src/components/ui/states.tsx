/**
 * Estados reutilizaveis: EmptyState e ErrorState (spec 3.7 / 6.15).
 * EmptyState SEMPRE diz o que fazer (CTA opcional). ErrorState oferece "Tente de
 * novo". Centralizados, icone tracado 48px.
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
    <div className="flex flex-col items-center px-6 py-12 text-center">
      <div className="mb-4 text-ink-faint" aria-hidden>
        {icon}
      </div>
      <h3 className="font-display text-[17px] font-semibold text-ink">{title}</h3>
      <p className="mt-1.5 max-w-[280px] text-[14px] leading-normal text-ink-soft">{description}</p>
      {action && (
        <div className="mt-5 w-full max-w-[260px]">
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
