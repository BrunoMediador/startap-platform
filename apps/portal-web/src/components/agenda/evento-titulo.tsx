'use client';

/**
 * Nome + serviço legíveis de um agendamento (Bloco B). Bruno escolheu
 * "2 linhas + marquee no PC":
 *   - O NOME do cliente fica numa linha truncada (ellipsis). No DESKTOP, quando
 *     transborda, vira marquee no hover/foco da linha-pai (`.group`). No mobile
 *     (sem hover real) não há marquee — fica o truncado e o nome completo aparece
 *     ao tocar (sheet de detalhe). `prefers-reduced-motion` desliga (CSS).
 *   - O SERVIÇO vai numa 2a linha com line-clamp-2. Sem serviço, some.
 *
 * O título cru (`raw`) vira `title=` (tooltip nativo no desktop). O parse é
 * tolerante (lib/agenda-titulo) — nunca quebra com formato fora do padrão.
 *
 * Por que medir no client: o marquee só faz sentido quando o nome realmente
 * transborda. A medição é de LAYOUT (scrollWidth vs clientWidth), não data-fetch:
 * roda num efeito leve + ResizeObserver pra reagir a mudança de largura
 * (expandir/tela-cheia, resize do desktop).
 */
import { parseTitulo } from '@/lib/agenda-titulo';
import { cn } from '@/lib/cn';
import { useEffect, useRef, useState } from 'react';

export function EventoTitulo({
  titulo,
  className,
  /** Tamanho do nome (px). Default 15 (linha da lista). */
  nomeSize = 15,
}: {
  titulo: string;
  className?: string;
  nomeSize?: number;
}) {
  const { nome, servico, raw } = parseTitulo(titulo);
  const faixaRef = useRef<HTMLDivElement>(null);
  const nomeRef = useRef<HTMLSpanElement>(null);
  const [shift, setShift] = useState(0);

  // Mede o overflow: largura natural do nome (span) - largura visível (faixa).
  // shift negativo = quanto o nome precisa deslizar pra revelar o que foi cortado.
  useEffect(() => {
    const faixa = faixaRef.current;
    const nomeEl = nomeRef.current;
    if (!faixa || !nomeEl) return;
    const medir = () => {
      const over = nomeEl.scrollWidth - faixa.clientWidth;
      setShift(over > 4 ? -over : 0); // folga de 4px contra jitter
    };
    medir();
    const ro = new ResizeObserver(medir);
    ro.observe(faixa);
    return () => ro.disconnect();
  }, []);

  const transborda = shift < 0;

  return (
    <div className={cn('min-w-0', className)} title={raw || undefined}>
      {/* Faixa que CLIPA o nome (overflow-hidden). O span dentro tem nowrap e
          largura natural; no desktop com overflow, desliza via `.agenda-marquee`
          (transform) revelando o que foi cortado. No mobile/repouso, fica cortado
          (o nome completo aparece ao tocar, no sheet de detalhe). */}
      <div ref={faixaRef} className="overflow-hidden">
        <span
          ref={nomeRef}
          className={cn(
            'inline-block max-w-none whitespace-nowrap font-display font-semibold text-ink',
            transborda && 'agenda-marquee will-change-transform',
          )}
          style={
            {
              fontSize: `${nomeSize}px`,
              ...(transborda ? { '--marquee-shift': `${shift}px` } : {}),
            } as React.CSSProperties
          }
        >
          {nome}
        </span>
      </div>
      {servico && (
        <div className="mt-0.5 line-clamp-2 text-[12.5px] leading-snug text-ink-soft">
          {servico}
        </div>
      )}
    </div>
  );
}
