'use client';

/**
 * Um GRUPO de horário da agenda de estabelecimento: o rótulo do horário à
 * esquerda + os eventos PARALELOS (mesmo horário, profissionais distintos)
 * LADO A LADO à direita. Não empilha como conflito — mostra que cada profissional
 * atende em paralelo.
 *
 * Mobile-first: os cartões paralelos quebram em grid auto-fit (mín. 168px) → no
 * celular ficam 1–2 por linha, no desktop quantos couberem. Cada cartão é
 * clicável (abre o sheet de detalhe), com a COR do profissional na barra lateral
 * + nome do profissional + cliente/serviço (tratamento de nome longo do #332).
 */
import { corDoProfissional } from '@/lib/agenda-estabelecimento';
import type { GrupoHorario } from '@/lib/agenda-estabelecimento';
import { parseTitulo } from '@/lib/agenda-titulo';
import type { Agendamento } from '@/lib/api-types';
import { formatAgendamentoDia, formatAgendamentoHora } from '@/lib/format';

export function EstabelecimentoHorarioGrupo({
  grupo,
  /** Mostra o dia no rótulo (lista "Todos" cruza dias). */
  mostrarDia,
  onAbrir,
}: {
  grupo: GrupoHorario;
  mostrarDia: boolean;
  onAbrir: (ag: Agendamento) => void;
}) {
  const hora = formatAgendamentoHora(grupo.inicio);
  const dia = formatAgendamentoDia(grupo.inicio);

  return (
    <div className="flex flex-col gap-2 sm:flex-row sm:gap-3.5">
      {/* Rótulo do horário (sticky-ish à esquerda no desktop). */}
      <div className="flex shrink-0 items-center gap-2 sm:w-[88px] sm:flex-col sm:items-end sm:gap-0 sm:pt-1.5 sm:text-right">
        <span className="font-display text-[15px] font-bold tabular-nums text-ink">
          {hora || 'Sem hora'}
        </span>
        {mostrarDia && dia && <span className="text-[12px] text-ink-soft">{dia}</span>}
        {grupo.eventos.length > 1 && (
          <span className="text-[11px] font-semibold text-ink-faint sm:mt-0.5">
            {grupo.eventos.length} em paralelo
          </span>
        )}
      </div>

      {/* Cartões paralelos lado a lado. */}
      <div className="grid flex-1 gap-2 [grid-template-columns:repeat(auto-fill,minmax(168px,1fr))]">
        {grupo.eventos.map((ag) => (
          <CartaoEvento key={ag.id} ag={ag} onClick={() => onAbrir(ag)} />
        ))}
      </div>
    </div>
  );
}

function CartaoEvento({ ag, onClick }: { ag: Agendamento; onClick: () => void }) {
  const { nome, servico, raw } = parseTitulo(ag.titulo);
  const cor = corDoProfissional(ag.colaborador_id, ag.profissional_nome);
  const profissional = ag.profissional_nome?.trim();

  return (
    <button
      type="button"
      onClick={onClick}
      title={raw || undefined}
      className="group flex min-h-[64px] flex-col gap-1 rounded-card-sm border border-line bg-surface py-2.5 pr-3 pl-3 text-left outline-none transition-colors hover:bg-surface-hover focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-2 focus-visible:ring-offset-bg"
      // Barra lateral colorida do profissional (dinâmico → style calculado).
      style={{ borderLeft: `3px solid ${cor.solid}` }}
    >
      {/* Profissional (chip de cor). */}
      {profissional && (
        <span className="inline-flex items-center gap-1.5">
          <span
            aria-hidden
            className="size-2 shrink-0 rounded-full"
            style={{ backgroundColor: cor.solid }}
          />
          <span
            className="truncate text-[11.5px] font-bold uppercase tracking-[0.02em]"
            style={{ color: cor.ink }}
          >
            {profissional}
          </span>
        </span>
      )}
      {/* Cliente (nome legível, truncado — completo no sheet de detalhe). */}
      <span className="truncate font-display text-[14px] font-semibold text-ink">{nome}</span>
      {servico && <span className="line-clamp-1 text-[12.5px] text-ink-soft">{servico}</span>}
    </button>
  );
}
