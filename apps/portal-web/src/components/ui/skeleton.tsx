/**
 * Skeleton (spec 6.14). Bloco com shimmer (desliga em reduced-motion via CSS).
 * Sempre acompanhado de texto contextual quando for tela inteira (ver telas).
 */
import { cn } from '@/lib/cn';

export function Skeleton({ className }: { className?: string }) {
  return <div aria-hidden className={cn('skeleton rounded-card-sm', className)} />;
}

/** Chaves estaveis pra loops de skeleton (evita key por indice). */
function skeletonKeys(n: number): string[] {
  return Array.from({ length: n }, (_, i) => `sk-${i}`);
}

/** N linhas de lista em skeleton dentro de um card. */
export function SkeletonList({ rows }: { rows: number }) {
  return (
    <div className="overflow-hidden rounded-card border border-line bg-surface">
      {skeletonKeys(rows).map((key) => (
        <div key={key} className="flex items-center gap-3 border-b border-line p-4 last:border-b-0">
          <Skeleton className="size-10 rounded-card-sm" />
          <div className="flex-1 space-y-2">
            <Skeleton className="h-3.5 w-1/2" />
            <Skeleton className="h-3 w-1/3" />
          </div>
        </div>
      ))}
    </div>
  );
}

export { skeletonKeys };
