import { ParticleField } from '@/components/fx/particle-field';
import { Brandmark } from '@/components/icons';
import { DemoCelular } from '@/components/landing/demo-celular';
import { HelpFab } from '@/components/landing/help-fab';
import type { Metadata } from 'next';
import Link from 'next/link';

export const metadata: Metadata = {
  title: 'Demonstração · Startap',
  description: 'Converse com uma demonstração do assistente de atendimento da Startap.',
};

const FOCUS_RING =
  'outline-none focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-2 focus-visible:ring-offset-bg';

/**
 * Página pública da demonstração. O proxy existente em /demo/chat permanece
 * responsável pela conversa; esta rota apenas torna a experiência acessível
 * pela landing e por URL direta.
 */
export default function DemoPage() {
  return (
    <div className="relative min-h-dvh overflow-x-clip bg-bg text-ink">
      <ParticleField />
      <div className="login-vignette pointer-events-none fixed inset-0 z-[1]" aria-hidden />

      <div className="relative z-[2] mx-auto w-full max-w-[1040px] px-5 pb-20">
        <header className="flex min-h-16 items-center justify-between gap-4 border-b border-line-soft">
          <Link
            href="/"
            aria-label="Startap — voltar para a página inicial"
            className={`inline-flex items-center gap-2 rounded-[6px] font-display text-[19px] font-bold ${FOCUS_RING}`}
          >
            <Brandmark size={32} />
            <span>
              Start<span className="text-brand">ap</span>
            </span>
          </Link>
          <Link
            href="/"
            className={`rounded-[6px] text-[14px] font-semibold text-brand hover:underline ${FOCUS_RING}`}
          >
            Voltar ao início
          </Link>
        </header>

        <main>
          <DemoCelular />
        </main>
      </div>

      <HelpFab />
    </div>
  );
}
