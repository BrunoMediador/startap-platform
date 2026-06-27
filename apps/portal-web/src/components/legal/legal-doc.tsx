import { Brandmark } from '@/components/icons';
import type { LegalBlock, LegalDocument } from '@/lib/legal';
import Link from 'next/link';

/**
 * Render genérico de um documento legal (Termos de Uso / Política de Privacidade),
 * SCRUM-1. Puramente de apresentação: recebe o `LegalDocument` (dados em
 * @/lib/legal) e desenha cada bloco tipado — trocar o TEXTO não exige tocar aqui.
 *
 * Página pública, tema escuro (igual /login e /cadastro). Sem JS de cliente.
 */
export function LegalDoc({ doc }: { doc: LegalDocument }) {
  return (
    <div data-theme="dark" className="min-h-dvh bg-bg text-ink">
      <header className="border-line-strong border-b">
        <div className="mx-auto flex max-w-[820px] items-center justify-between px-5 py-4 sm:px-8">
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

      <main className="mx-auto max-w-[820px] px-5 py-10 sm:px-8 sm:py-14">
        <h1 className="font-display text-[clamp(26px,4vw,34px)] font-bold leading-tight tracking-[-0.02em] text-ink">
          {doc.title}
        </h1>
        <p className="mt-2 text-[12.5px] text-ink-faint">
          Versão {doc.version} · Atualizado em {doc.updatedAt}
        </p>

        <div className="mt-8 flex flex-col gap-7">
          {doc.intro.map((block, i) => (
            <Block key={blockKey(block, i)} block={block} />
          ))}

          {doc.sections.map((section) => (
            <section key={section.heading} className="flex flex-col gap-3.5">
              <h2 className="font-display text-[19px] font-bold tracking-[-0.01em] text-ink">
                {section.heading}
              </h2>
              {section.blocks.map((block, i) => (
                <Block key={blockKey(block, i)} block={block} />
              ))}
            </section>
          ))}
        </div>
      </main>
    </div>
  );
}

/** Chave estável por bloco (conteúdo + índice — sem depender de id). */
function blockKey(block: LegalBlock, i: number): string {
  if (block.kind === 'ul') return `ul-${i}-${block.items[0]?.slice(0, 24) ?? ''}`;
  if (block.kind === 'table') return `tbl-${i}-${block.columns[0] ?? ''}`;
  return `${block.kind}-${i}-${block.text.slice(0, 24)}`;
}

function Block({ block }: { block: LegalBlock }) {
  switch (block.kind) {
    case 'p':
      return <p className="text-[14.5px] leading-[1.7] text-ink-soft">{block.text}</p>;
    case 'sub':
      return (
        <h3 className="mt-1 font-display text-[15.5px] font-semibold tracking-[-0.01em] text-ink">
          {block.text}
        </h3>
      );
    case 'ul':
      return (
        <ul className="flex flex-col gap-2 pl-1">
          {block.items.map((item) => (
            <li
              key={item.slice(0, 32)}
              className="flex gap-2.5 text-[14.5px] leading-[1.65] text-ink-soft"
            >
              <span aria-hidden className="mt-[9px] size-1.5 shrink-0 rounded-full bg-brand/70" />
              <span>{item}</span>
            </li>
          ))}
        </ul>
      );
    case 'callout':
      return (
        <p className="rounded-[12px] border border-line-strong border-l-2 border-l-brand bg-surface px-4 py-3 text-[13.5px] leading-[1.65] text-ink-soft">
          {block.text}
        </p>
      );
    case 'table':
      return (
        <div className="overflow-x-auto rounded-[12px] border border-line-strong">
          <table className="w-full border-collapse text-left text-[13px]">
            <thead>
              <tr className="border-line-strong border-b bg-surface">
                {block.columns.map((col) => (
                  <th
                    key={col}
                    className="px-3 py-2.5 font-display text-[12.5px] font-semibold text-ink"
                  >
                    {col}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {block.rows.map((row) => (
                <tr
                  key={row.join('|').slice(0, 48)}
                  className="border-line/70 border-b last:border-0"
                >
                  {row.map((cell, ci) => (
                    <td
                      key={`${ci}-${cell.slice(0, 20)}`}
                      className="px-3 py-2.5 align-top leading-[1.55] text-ink-soft"
                    >
                      {cell}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
  }
}
