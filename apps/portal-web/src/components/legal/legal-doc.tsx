import { Brandmark } from '@/components/icons';
import type { LegalDocument } from '@/lib/legal';
import Link from 'next/link';

/**
 * Render genérico de um documento legal (Termos de Uso / Política de Privacidade),
 * SCRUM-1. Puramente de apresentação: recebe o `LegalDocument` (dados em
 * @/lib/legal) e desenha — trocar o TEXTO não exige tocar neste componente.
 *
 * Página pública, tema escuro (igual /login e /cadastro). Sem JS de cliente.
 */
export function LegalDoc({ doc }: { doc: LegalDocument }) {
  return (
    <div data-theme="dark" className="min-h-dvh bg-bg text-ink">
      <header className="border-b border-line-strong">
        <div className="mx-auto flex max-w-[760px] items-center justify-between px-5 py-4 sm:px-8">
          <Link
            href="/"
            className="inline-flex items-center gap-[10px] font-display text-[18px] font-bold tracking-[-0.01em] text-ink outline-none focus-visible:underline"
          >
            <Brandmark size={30} />
            <span>
              Start<span className="text-brand">ap</span>
            </span>
          </Link>
          <Link
            href="/cadastro"
            className="text-[13px] font-semibold text-brand outline-none focus-visible:underline"
          >
            Voltar ao cadastro
          </Link>
        </div>
      </header>

      <main className="mx-auto max-w-[760px] px-5 py-10 sm:px-8 sm:py-14">
        <h1 className="font-display text-[clamp(26px,4vw,34px)] font-bold leading-tight tracking-[-0.02em] text-ink">
          {doc.title}
        </h1>
        <p className="mt-2 text-[12.5px] text-ink-faint">
          Versão {doc.version} · Atualizado em {doc.updatedAt}
        </p>

        <div className="mt-7 flex flex-col gap-7 text-[14.5px] leading-[1.7] text-ink-soft">
          {doc.intro.map((p) => (
            <p key={p.slice(0, 48)}>{p}</p>
          ))}

          {doc.sections.map((section) => (
            <section key={section.heading} className="flex flex-col gap-2.5">
              <h2 className="font-display text-[18px] font-bold tracking-[-0.01em] text-ink">
                {section.heading}
              </h2>
              {section.body.map((p) => (
                <p key={p.slice(0, 48)}>{p}</p>
              ))}
            </section>
          ))}
        </div>
      </main>
    </div>
  );
}
