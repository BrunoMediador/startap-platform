'use client';

/**
 * Agenda completa (Bloco A — rota dedicada /agenda). Reusa a MESMA query da
 * Início (useAgendamentos: cache quente, sem fetch duplicado). Aqui:
 *   - Seletor de visão Lista (default mobile) / Semana (grade CSS 7 colunas).
 *   - Botão expandir/tela-cheia (toggle full-width + requestFullscreen opcional).
 *   - Linha/chip clicável -> AgendaDetailSheet (detalhe + remarcar/trocar/cancelar).
 *
 * Estados (loading/erro/empty) ficam na PÁGINA (RSC-ish wrapper); este client só
 * recebe `data` já pronta. Mobile-first; a visão Semana só faz sentido com largura
 * -> no mobile vira scroll horizontal das 7 colunas.
 */
import { IconCalendar, IconChevronLeft, IconChevronRight, IconPlus } from '@/components/icons';
import { useTenant } from '@/components/shell/session-context';
import { useTenantTz } from '@/components/shell/tenant-tz-context';
import { inicialDoTitulo } from '@/lib/agenda-titulo';
import { type PeriodoFiltro, filtrarAgendamentos } from '@/lib/agendamentos';
import type { Agendamento, AgendamentosResponse } from '@/lib/api-types';
import { cn } from '@/lib/cn';
import { formatAgendamentoDia, formatAgendamentoHora } from '@/lib/format';
import Link from 'next/link';
import { useMemo, useRef, useState } from 'react';
import { AgendaDetailSheet } from './agenda-detail-sheet';
import { EventoTitulo } from './evento-titulo';
import { IconArrowsIn, IconArrowsOut, IconGrid, IconList } from './icons-agenda';
import { SemanaGrade } from './semana-grade';

const PAGE_SIZE = 12; // maior que a Home (5): tela dedicada cabe mais.

const ABAS: { value: PeriodoFiltro; label: string }[] = [
  { value: 'todos', label: 'Todos' },
  { value: 'hoje', label: 'Hoje' },
  { value: 'proximos', label: 'Próximos' },
  { value: 'recentes', label: 'Recentes' },
];

type Visao = 'lista' | 'semana';

export function AgendaClient({ data }: { data: AgendamentosResponse }) {
  const { slot } = useTenant();
  const containerRef = useRef<HTMLDivElement>(null);

  const [visao, setVisao] = useState<Visao>('lista');
  const [expandido, setExpandido] = useState(false);
  const [periodo, setPeriodo] = useState<PeriodoFiltro>('todos');
  const [page, setPage] = useState(1);
  /** Evento aberto no sheet de detalhe (null = fechado). */
  const [aberto, setAberto] = useState<Agendamento | null>(null);

  const filtradas = useMemo(
    () => filtrarAgendamentos(data.agendamentos, { periodo, busca: '', data: '' }),
    [data.agendamentos, periodo],
  );

  const totalPages = Math.max(1, Math.ceil(filtradas.length / PAGE_SIZE));
  const pageSafe = Math.min(page, totalPages);
  const inicioIdx = (pageSafe - 1) * PAGE_SIZE;
  const visiveis = filtradas.slice(inicioIdx, inicioIdx + PAGE_SIZE);
  const de = filtradas.length === 0 ? 0 : inicioIdx + 1;
  const ate = inicioIdx + visiveis.length;

  function resetPage(fn: () => void) {
    fn();
    setPage(1);
  }

  // Tela-cheia: toggle do flag (full-width) + tenta a Fullscreen API (best-effort;
  // alguns browsers/iframes negam — o full-width visual já vale por si).
  function toggleExpandir() {
    const next = !expandido;
    setExpandido(next);
    const el = containerRef.current;
    if (!el) return;
    try {
      if (next && document.fullscreenEnabled && !document.fullscreenElement) {
        void el.requestFullscreen?.();
      } else if (!next && document.fullscreenElement) {
        void document.exitFullscreen?.();
      }
    } catch {
      // Fullscreen negado: o full-width (flag) continua valendo. Sem ruído pro dono.
    }
  }

  return (
    <div
      ref={containerRef}
      className={cn(
        // Tela-cheia: reserva o topo (notch/status bar) e a base (home indicator).
        // No mobile a base precisa reservar a ALTURA REAL DA BOTTOM-NAV
        // (var(--nav-clearance) = nav + safe-area + respiro), senao as ultimas
        // linhas/paginacao/acoes da lista caem ATRAS da nav (que e sticky z-30 e
        // pinta depois no DOM) e ficam inalcancaveis. No desktop (md) a nav some
        // -> basta o respiro do home indicator.
        expandido &&
          'fixed inset-0 z-30 overflow-y-auto bg-bg px-5 pt-[calc(20px+env(safe-area-inset-top))] pb-[var(--nav-clearance)] md:pb-[calc(20px+env(safe-area-inset-bottom))]',
        expandido && 'mx-auto max-w-[1100px]',
      )}
    >
      {/* Barra de controles: visão (Lista/Semana) + expandir + Novo. */}
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <div
          role="tablist"
          aria-label="Modo de visualização"
          className="inline-flex rounded-pill border border-line bg-surface p-0.5"
        >
          <VisaoBtn ativo={visao === 'lista'} onClick={() => setVisao('lista')} label="Lista">
            <IconList size={16} />
          </VisaoBtn>
          <VisaoBtn ativo={visao === 'semana'} onClick={() => setVisao('semana')} label="Semana">
            <IconGrid size={16} />
          </VisaoBtn>
        </div>

        <button
          type="button"
          onClick={toggleExpandir}
          aria-pressed={expandido}
          aria-label={expandido ? 'Sair da tela cheia' : 'Expandir pra tela cheia'}
          className="flex h-9 items-center gap-1.5 rounded-pill border border-line-strong bg-surface px-3 font-display text-[13px] font-semibold text-ink-soft outline-none transition-colors hover:bg-surface-hover hover:text-ink focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-2 focus-visible:ring-offset-bg"
        >
          {expandido ? <IconArrowsIn size={16} /> : <IconArrowsOut size={16} />}
          {/* Em tela cheia, mostra o rótulo "Recolher" TAMBÉM no mobile: é a única
              saída do modo expandido (sem chrome/bottom-nav), então não pode virar
              só um ícone sem texto. "Expandir" segue oculto no mobile (espaço). */}
          <span className={cn(expandido ? 'inline' : 'hidden sm:inline')}>
            {expandido ? 'Recolher' : 'Expandir'}
          </span>
        </button>

        <Link
          href="/agendamentos/novo"
          className="ml-auto inline-flex h-9 items-center gap-1.5 rounded-pill border border-line-strong bg-surface px-3.5 font-display text-[13px] font-semibold text-brand outline-none transition-colors hover:bg-surface-hover focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-2 focus-visible:ring-offset-bg"
        >
          <IconPlus size={16} />
          Novo
        </Link>
      </div>

      {/* Abas de período (valem nas duas visões; na semana, navega por semana à parte). */}
      {visao === 'lista' && (
        <div
          role="tablist"
          aria-label="Filtrar por período"
          className="mb-3 flex gap-1.5 overflow-x-auto pb-0.5"
        >
          {ABAS.map((aba) => {
            const ativo = periodo === aba.value;
            return (
              <button
                key={aba.value}
                type="button"
                role="tab"
                aria-selected={ativo}
                onClick={() => resetPage(() => setPeriodo(aba.value))}
                className={cn(
                  'shrink-0 rounded-pill px-3.5 py-1.5 font-display text-[13px] font-semibold outline-none transition-colors focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-2 focus-visible:ring-offset-bg',
                  ativo
                    ? 'bg-brand-soft text-brand'
                    : 'border border-line bg-surface text-ink-soft hover:bg-surface-hover hover:text-ink',
                )}
              >
                {aba.label}
              </button>
            );
          })}
        </div>
      )}

      {visao === 'lista' ? (
        filtradas.length === 0 ? (
          <VazioFiltro periodo={periodo} onLimpar={() => resetPage(() => setPeriodo('todos'))} />
        ) : (
          <>
            <div className="overflow-hidden rounded-card-sm border border-line bg-surface">
              {visiveis.map((ag) => (
                <ListaRow key={ag.id} ag={ag} onClick={() => setAberto(ag)} />
              ))}
            </div>
            {totalPages > 1 && (
              <div className="mt-3 flex items-center justify-between gap-3">
                <span className="text-[12.5px] tabular-nums text-ink-soft">
                  {de}–{ate} de {filtradas.length}
                </span>
                <div className="flex items-center gap-2">
                  <PageBtn
                    label="Página anterior"
                    disabled={pageSafe <= 1}
                    onClick={() => setPage((p) => Math.max(1, p - 1))}
                  >
                    <IconChevronLeft size={18} />
                  </PageBtn>
                  <span className="min-w-[64px] text-center text-[12.5px] tabular-nums text-ink-soft">
                    {pageSafe} / {totalPages}
                  </span>
                  <PageBtn
                    label="Próxima página"
                    disabled={pageSafe >= totalPages}
                    onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                  >
                    <IconChevronRight size={18} />
                  </PageBtn>
                </div>
              </div>
            )}
          </>
        )
      ) : (
        <SemanaGrade agendamentos={data.agendamentos} onAbrir={(ag) => setAberto(ag)} />
      )}

      <AgendaDetailSheet slot={slot} agendamento={aberto} onClose={() => setAberto(null)} />
    </div>
  );
}

function VisaoBtn({
  ativo,
  onClick,
  label,
  children,
}: {
  ativo: boolean;
  onClick: () => void;
  label: string;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={ativo}
      onClick={onClick}
      className={cn(
        'inline-flex h-8 items-center gap-1.5 rounded-pill px-3 font-display text-[12.5px] font-semibold outline-none transition-colors focus-visible:ring-2 focus-visible:ring-brand',
        ativo ? 'bg-brand-soft text-brand' : 'text-ink-soft hover:text-ink',
      )}
    >
      {children}
      {label}
    </button>
  );
}

/** Linha clicável da Lista — abre o detalhe; nome 2-linhas + marquee no PC. */
function ListaRow({ ag, onClick }: { ag: Agendamento; onClick: () => void }) {
  const tz = useTenantTz();
  const hora = formatAgendamentoHora(ag.inicio, tz);
  const dia = formatAgendamentoDia(ag.inicio, undefined, tz);
  return (
    <button
      type="button"
      onClick={onClick}
      className="group flex w-full min-h-14 items-center gap-3.5 border-b border-line-soft px-[15px] py-[13px] text-left outline-none transition-colors last:border-b-0 hover:bg-surface-hover focus-visible:bg-surface-hover focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand"
    >
      <span className="flex size-[38px] shrink-0 items-center justify-center rounded-[10px] border border-line-strong bg-brand-soft font-display text-[13px] font-bold text-brand">
        {/* inicial usa o NOME parseado (não a 1a letra do título concatenado). */}
        {inicialDoTitulo(ag.titulo)}
      </span>
      <EventoTitulo titulo={ag.titulo} className="flex-1" />
      <div className="shrink-0 text-right text-[12.5px] text-ink-soft">
        {hora ? (
          <b className="block font-display text-[14px] font-semibold tabular-nums text-ink">
            {hora}
          </b>
        ) : null}
        {dia}
      </div>
      <IconChevronRight
        size={18}
        className="shrink-0 text-ink-faint transition-colors group-hover:text-ink-soft"
      />
    </button>
  );
}

function PageBtn({
  label,
  disabled,
  onClick,
  children,
}: {
  label: string;
  disabled: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      disabled={disabled}
      onClick={onClick}
      className="flex size-10 items-center justify-center rounded-[11px] border border-line-strong bg-surface text-ink-soft outline-none transition-colors hover:bg-surface-hover hover:text-ink focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-2 focus-visible:ring-offset-bg disabled:cursor-not-allowed disabled:opacity-40"
    >
      {children}
    </button>
  );
}

function VazioFiltro({
  periodo,
  onLimpar,
}: {
  periodo: PeriodoFiltro;
  onLimpar: () => void;
}) {
  if (periodo === 'todos') {
    return (
      <div className="rounded-card-sm border border-line bg-surface px-6 py-9 text-center">
        <span className="inline-flex size-14 items-center justify-center rounded-[16px] border border-line-strong bg-brand-soft text-brand">
          <IconCalendar size={26} />
        </span>
        <h3 className="mt-3.5 font-display text-[16px] font-semibold text-ink">
          Nenhum agendamento por aqui
        </h3>
        <p className="mx-auto mt-1.5 max-w-[34ch] text-[13.5px] text-ink-soft">
          Quando o robô marcar um horário no WhatsApp, ele aparece aqui.
        </p>
      </div>
    );
  }
  return (
    <div className="rounded-card-sm border border-line bg-surface px-6 py-7 text-center">
      <h3 className="font-display text-[15px] font-semibold text-ink">Nada nesse período</h3>
      <button
        type="button"
        onClick={onLimpar}
        className="mt-3 inline-flex h-9 items-center rounded-card-sm border border-line-strong bg-surface px-4 font-display text-[13px] font-semibold text-brand outline-none transition-colors hover:bg-surface-hover focus-visible:ring-2 focus-visible:ring-brand"
      >
        Ver todos
      </button>
    </div>
  );
}
