/**
 * 404 PT-BR do portal (SCRUM-93). URL inexistente para de cair na tela crua do
 * Next em ingles — vira a marca do app com rota de fuga pro inicio. Server
 * Component (sem interatividade: so um <Link>), centralizado no viewport sobre o
 * fundo escuro. Reusa o <ErrorState> sem onRetry (retry nao faz sentido num 404).
 */
import { ErrorState } from '@/components/ui/states';
import { ERRO_NAO_ENCONTRADO, HOME_HREF } from '@/lib/telas-erro';

export default function NotFound() {
  return (
    <main className="flex min-h-dvh flex-col items-center justify-center px-5">
      <ErrorState
        title={ERRO_NAO_ENCONTRADO.title}
        description={ERRO_NAO_ENCONTRADO.description}
        secondaryAction={{ label: ERRO_NAO_ENCONTRADO.home, href: HOME_HREF }}
      />
    </main>
  );
}
