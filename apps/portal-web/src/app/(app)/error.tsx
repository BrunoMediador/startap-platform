'use client';

/**
 * Error boundary de rota do app autenticado (SCRUM-93). Captura crash de render
 * das paginas dentro do grupo (app) e renderiza DENTRO do shell (topbar + nav),
 * entao o dono nunca cai na tela crua do Next em ingles — tem marca e rota de
 * fuga. Reusa o <ErrorState> (mesma marca/foco/a11y do erro de carga inline).
 */
import { ErrorState } from '@/components/ui/states';
import { ERRO_BOUNDARY, HOME_HREF } from '@/lib/telas-erro';
import { useEffect } from 'react';

export default function AppError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  // Log pra observabilidade (nao e data fetch). O digest correlaciona com o log
  // do servidor sem expor nada tecnico pro usuario.
  useEffect(() => {
    console.error('[portal] erro de rota:', error);
  }, [error]);

  return (
    <div className="flex min-h-[50vh] flex-col justify-center">
      <ErrorState
        title={ERRO_BOUNDARY.title}
        description={ERRO_BOUNDARY.description}
        onRetry={reset}
        retryLabel={ERRO_BOUNDARY.retry}
        secondaryAction={{ label: ERRO_BOUNDARY.home, href: HOME_HREF }}
      />
    </div>
  );
}
