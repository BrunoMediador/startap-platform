/** Cabecalho de tela: titulo (Sora 22) + subtitulo (spec page-head dos prototipos). */
export function PageHead({ title, subtitle }: { title: string; subtitle: string }) {
  return (
    <div className="mb-[18px]">
      <h1 className="font-display text-[22px] font-bold tracking-[-0.01em] text-ink">{title}</h1>
      <p className="mt-1 text-[13.5px] leading-snug text-ink-soft">{subtitle}</p>
    </div>
  );
}
