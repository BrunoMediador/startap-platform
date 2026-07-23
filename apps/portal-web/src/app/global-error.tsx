'use client';

/**
 * Boundary de ULTIMO recurso (SCRUM-93): so dispara quando o proprio layout raiz
 * falha, entao precisa ser AUTO-CONTIDO — renderiza <html>/<body> proprios (o
 * layout quebrado nao existe aqui) e importa o proprio CSS (nao depende do
 * modulo de layout que caiu). Ainda assim reusa o <ErrorState> pra manter a
 * marca/foco/a11y; se por acaso o CSS nao aplicar, o pior caso e um texto PT-BR
 * legivel — nunca a tela crua do Next em ingles.
 */
import { ErrorState } from '@/components/ui/states';
import { ERRO_GLOBAL } from '@/lib/telas-erro';
import { useEffect } from 'react';
import './globals.css';

export default function GlobalError({ error }: { error: Error & { digest?: string } }) {
  useEffect(() => {
    console.error('[portal] erro no layout raiz:', error);
  }, [error]);

  return (
    // data-theme="dark" fixa o tema (as CSS vars do design system vivem em
    // [data-theme="dark"] / :root); lang PT-BR pra leitores de tela.
    <html lang="pt-BR" data-theme="dark">
      <body>
        <main className="flex min-h-dvh flex-col items-center justify-center px-5">
          <ErrorState
            title={ERRO_GLOBAL.title}
            description={ERRO_GLOBAL.description}
            onRetry={() => window.location.reload()}
            retryLabel={ERRO_GLOBAL.reload}
          />
        </main>
      </body>
    </html>
  );
}
