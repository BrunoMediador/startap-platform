'use client';

/**
 * Legenda + filtro por profissional (variante estabelecimento, multi-profissional).
 * Mostra "Todos" + um chip por profissional presente na janela, com o DOT da cor
 * estável dele (lib/agenda-estabelecimento) e a contagem de eventos. Clicar filtra
 * a agenda (toggle): clicar no profissional ativo volta pra "Todos".
 *
 * É legenda E filtro ao mesmo tempo — cada chip ensina a cor do profissional e
 * serve de ação. Mobile-first: rola na horizontal quando há muitos profissionais.
 * Acessível: role="tablist"/"tab" + aria-selected; foco visível; dot é aria-hidden
 * (a cor não carrega informação sozinha — o NOME está sempre no rótulo).
 */
import type { ProfissionalNaAgenda } from '@/lib/agenda-estabelecimento';
import { cn } from '@/lib/cn';

export function ProfissionalFiltro({
  profissionais,
  selecionado,
  onSelecionar,
}: {
  profissionais: ProfissionalNaAgenda[];
  /** colaborador_id ativo, ou null = "Todos". */
  selecionado: number | null;
  onSelecionar: (id: number | null) => void;
}) {
  return (
    <div
      role="tablist"
      aria-label="Filtrar por profissional"
      className="flex gap-1.5 overflow-x-auto pb-0.5"
    >
      <ChipTodos
        ativo={selecionado === null}
        total={profissionais.reduce((acc, p) => acc + p.count, 0)}
        onClick={() => onSelecionar(null)}
      />
      {profissionais.map((p) => {
        const ativo = selecionado === p.id;
        return (
          <button
            key={p.id ?? 'sem'}
            type="button"
            role="tab"
            aria-selected={ativo}
            onClick={() => onSelecionar(ativo ? null : p.id)}
            className={cn(
              'inline-flex h-9 shrink-0 items-center gap-2 rounded-pill border px-3 font-display text-[13px] font-semibold outline-none transition-colors focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-2 focus-visible:ring-offset-bg',
              ativo
                ? 'border-transparent text-ink'
                : 'border-line bg-surface text-ink-soft hover:bg-surface-hover hover:text-ink',
            )}
            // Quando ativo, pinta o fundo com a cor SOFT do profissional (dinâmico
            // por profissional — uso legítimo de style calculado).
            style={ativo ? { backgroundColor: p.cor.soft } : undefined}
          >
            <span
              aria-hidden
              className="size-2.5 shrink-0 rounded-full"
              style={{ backgroundColor: p.cor.solid }}
            />
            <span className="max-w-[12ch] truncate">{p.nome}</span>
            <span
              className="tabular-nums text-[12px] font-bold"
              style={ativo ? { color: p.cor.ink } : undefined}
            >
              {p.count}
            </span>
          </button>
        );
      })}
    </div>
  );
}

function ChipTodos({
  ativo,
  total,
  onClick,
}: {
  ativo: boolean;
  total: number;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={ativo}
      onClick={onClick}
      className={cn(
        'inline-flex h-9 shrink-0 items-center gap-1.5 rounded-pill px-3.5 font-display text-[13px] font-semibold outline-none transition-colors focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-2 focus-visible:ring-offset-bg',
        ativo
          ? 'bg-brand-soft text-brand'
          : 'border border-line bg-surface text-ink-soft hover:bg-surface-hover hover:text-ink',
      )}
    >
      Todos
      <span className="tabular-nums text-[12px] font-bold">{total}</span>
    </button>
  );
}
