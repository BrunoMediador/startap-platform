'use client';

/**
 * Agendamentos da Home — leva 3 (BLOCO B): paginacao 5/pagina + 3 filtros
 * combinaveis (periodo / busca por nome / data exata).
 *
 * O backend manda janela -7/+14d ASC. Aqui:
 *   - gcal_configured=false -> empty "agenda nao conectada" (pre-setup).
 *   - sem eventos na janela  -> empty caprichado "sem agendamentos" (1.D.5).
 *   - com eventos            -> abas de periodo + busca + data, lista paginada
 *     (5/pagina, "X–Y de N", anterior/proxima). Filtro vazio (mas com eventos
 *     na janela) -> empty "nenhum resultado pro filtro", distinto do anterior.
 *
 * Polish 1.D.5: linhas E0, divisor line-soft, icone com borda line-strong,
 * titulo Sora 15px, chevron no hover. Realce ambar lateral no 1o de hoje (1.2).
 */
import { IconCalendar, IconChevronLeft, IconChevronRight, IconSearch } from '@/components/icons';
import { type PeriodoFiltro, classify, filtrarAgendamentos } from '@/lib/agendamentos';
import type { Agendamento, AgendamentosResponse } from '@/lib/api-types';
import { cn } from '@/lib/cn';
import { formatAgendamentoDia, formatAgendamentoHora, initials } from '@/lib/format';
import { useRouter } from 'next/navigation';
import { useMemo, useState } from 'react';

const PAGE_SIZE = 5;

const ABAS: { value: PeriodoFiltro; label: string }[] = [
  { value: 'todos', label: 'Todos' },
  { value: 'hoje', label: 'Hoje' },
  { value: 'proximos', label: 'Próximos' },
  { value: 'recentes', label: 'Recentes' },
];

export function AgendamentosList({ data }: { data: AgendamentosResponse }) {
  const router = useRouter();
  const [periodo, setPeriodo] = useState<PeriodoFiltro>('todos');
  const [busca, setBusca] = useState('');
  const [data_, setData_] = useState(''); // "YYYY-MM-DD"
  const [page, setPage] = useState(1);

  const filtradas = useMemo(
    () => filtrarAgendamentos(data.agendamentos, { periodo, busca, data: data_ }),
    [data.agendamentos, periodo, busca, data_],
  );

  const totalNaJanela = data.agendamentos.length;
  const totalPages = Math.max(1, Math.ceil(filtradas.length / PAGE_SIZE));
  const pageSafe = Math.min(page, totalPages);
  const inicioIdx = (pageSafe - 1) * PAGE_SIZE;
  const visiveis = filtradas.slice(inicioIdx, inicioIdx + PAGE_SIZE);
  const de = filtradas.length === 0 ? 0 : inicioIdx + 1;
  const ate = inicioIdx + visiveis.length;

  // id do 1o evento de hoje na lista filtrada (realce ambar lateral, 1.2).
  const idDestaqueHoje = useMemo(() => {
    const hoje = filtradas.find((ag) => classify(ag.inicio) === 'hoje');
    return hoje?.id ?? null;
  }, [filtradas]);

  // Qualquer mudanca de filtro volta pra pagina 1.
  function resetPage(fn: () => void) {
    fn();
    setPage(1);
  }

  // gcal off (pre-setup): empty especifico, sem filtros.
  if (!data.gcal_configured) {
    return (
      <EmptyBox
        title="Agenda ainda não conectada"
        description="Quando sua agenda estiver ligada, os próximos atendimentos aparecem aqui pra você acompanhar."
      />
    );
  }

  // Sem nenhum evento na janela (-7/+14d): empty "vazio de verdade", sem filtros.
  // CTA leva pro agendamento manual (Missão 020 F4 — Fluxo B, ponto 2).
  if (totalNaJanela === 0) {
    return (
      <EmptyBox
        title="Nenhum agendamento ainda"
        description="Assim que o robô marcar um atendimento no WhatsApp, ele aparece aqui pra você acompanhar."
        action={{ label: 'Marcar um horário', onClick: () => router.push('/agendamentos/novo') }}
      />
    );
  }

  return (
    <div className="space-y-3">
      {/* Abas de periodo */}
      <div
        role="tablist"
        aria-label="Filtrar por período"
        className="flex gap-1.5 overflow-x-auto pb-0.5"
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
                'shrink-0 rounded-pill px-3.5 py-1.5 font-display text-[13px] font-semibold outline-none transition-colors duration-[120ms] focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-2 focus-visible:ring-offset-bg',
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

      {/* Busca por nome + filtro de data */}
      <div className="flex flex-col gap-2 sm:flex-row">
        <div className="relative flex-1">
          <span className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-ink-faint">
            <IconSearch size={18} />
          </span>
          <input
            type="search"
            inputMode="search"
            value={busca}
            onChange={(e) => resetPage(() => setBusca(e.target.value))}
            aria-label="Buscar agendamento por nome do cliente"
            placeholder="Buscar por nome"
            className="h-[44px] w-full rounded-field border-[1.5px] border-line-strong bg-surface-sunken pl-[42px] pr-3.5 text-[15px] text-ink outline-none transition-[border-color,box-shadow] duration-[120ms] placeholder:text-ink-faint focus:border-brand focus:shadow-focus focus:ring-[3px] focus:ring-brand/35"
          />
        </div>
        <input
          type="date"
          value={data_}
          onChange={(e) => resetPage(() => setData_(e.target.value))}
          aria-label="Filtrar por data específica"
          className="h-[44px] rounded-field border-[1.5px] border-line-strong bg-surface-sunken px-3.5 text-[15px] text-ink outline-none transition-[border-color,box-shadow] duration-[120ms] focus:border-brand focus:shadow-focus focus:ring-[3px] focus:ring-brand/35 sm:w-[170px]"
        />
      </div>

      {/* Lista / empty de filtro */}
      {filtradas.length === 0 ? (
        <EmptyBox
          compacto
          title="Nenhum resultado pra esse filtro"
          description="Tente outro período, limpe a busca ou escolha outra data."
          action={{
            label: 'Limpar filtros',
            onClick: () =>
              resetPage(() => {
                setPeriodo('todos');
                setBusca('');
                setData_('');
              }),
          }}
        />
      ) : (
        <>
          <div className="overflow-hidden rounded-card-sm border border-line bg-surface">
            {visiveis.map((ag) => (
              <AgendamentoRow
                key={ag.id}
                ag={ag}
                destaque={periodo !== 'recentes' && ag.id === idDestaqueHoje}
              />
            ))}
          </div>

          {/* Controles de paginacao — so se houver mais de 1 pagina. */}
          {totalPages > 1 && (
            <div className="flex items-center justify-between gap-3">
              <span className="text-[12.5px] tabular-nums text-ink-soft">
                {de}–{ate} de {filtradas.length}
              </span>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  aria-label="Página anterior"
                  disabled={pageSafe <= 1}
                  onClick={() => setPage((p) => Math.max(1, p - 1))}
                  className="flex size-10 items-center justify-center rounded-[11px] border border-line-strong bg-surface text-ink-soft outline-none transition-colors hover:bg-surface-hover hover:text-ink focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-2 focus-visible:ring-offset-bg disabled:cursor-not-allowed disabled:opacity-40"
                >
                  <IconChevronLeft size={18} />
                </button>
                <span className="min-w-[64px] text-center text-[12.5px] tabular-nums text-ink-soft">
                  {pageSafe} / {totalPages}
                </span>
                <button
                  type="button"
                  aria-label="Próxima página"
                  disabled={pageSafe >= totalPages}
                  onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                  className="flex size-10 items-center justify-center rounded-[11px] border border-line-strong bg-surface text-ink-soft outline-none transition-colors hover:bg-surface-hover hover:text-ink focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-2 focus-visible:ring-offset-bg disabled:cursor-not-allowed disabled:opacity-40"
                >
                  <IconChevronRight size={18} />
                </button>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}

function AgendamentoRow({ ag, destaque }: { ag: Agendamento; destaque: boolean }) {
  const hora = formatAgendamentoHora(ag.inicio);
  const dia = formatAgendamentoDia(ag.inicio);
  return (
    <div
      className={cn(
        // Linha E0 (1.D.5): divisor line-soft, hover acende, chevron entra.
        'group flex min-h-14 items-center gap-3.5 border-b border-line-soft px-[15px] py-[13px] transition-colors last:border-b-0 hover:bg-surface-hover',
        destaque && 'border-l-[3px] border-l-amber',
      )}
    >
      <span className="flex size-[38px] shrink-0 items-center justify-center rounded-[10px] border border-line-strong bg-brand-soft font-display text-[13px] font-bold text-brand">
        {initials(ag.titulo)}
      </span>
      <div className="min-w-0 flex-1">
        <div className="truncate font-display text-[15px] font-semibold text-ink">{ag.titulo}</div>
      </div>
      <div className="shrink-0 text-right text-[12.5px] text-ink-soft">
        {hora ? (
          <b className="block font-display text-[14px] font-semibold tabular-nums text-ink">
            {hora}
          </b>
        ) : null}
        {dia}
      </div>
      <span
        aria-hidden
        className="ml-1 shrink-0 text-ink-faint opacity-0 transition-[opacity,transform] duration-[120ms] -translate-x-[3px] group-hover:translate-x-0 group-hover:opacity-100"
      >
        <IconChevronRight size={16} />
      </span>
    </div>
  );
}

/**
 * Empty state caprichado (1.D.5): halo radial roxo + icone-chip 56px + copy
 * instrutiva + CTA opcional. `compacto` reduz o padding pro empty de filtro.
 */
function EmptyBox({
  title,
  description,
  action,
  compacto,
}: {
  title: string;
  description: string;
  action?: { label: string; onClick: () => void };
  compacto?: boolean;
}) {
  return (
    <div
      className={cn(
        'relative overflow-hidden rounded-card-sm border border-line bg-surface text-center shadow-card',
        compacto ? 'px-6 py-7' : 'px-6 py-9',
      )}
    >
      <span
        aria-hidden
        className="pointer-events-none absolute left-1/2 top-3.5 size-[120px] -translate-x-1/2 rounded-full"
        style={{
          background: 'radial-gradient(circle, rgba(100,49,214,.18), transparent 70%)',
        }}
      />
      <span className="relative z-10 inline-flex size-14 items-center justify-center rounded-[16px] border border-line-strong bg-brand-soft text-brand">
        <IconCalendar size={26} />
      </span>
      <h3 className="relative z-10 mt-3.5 font-display text-[16px] font-semibold text-ink">
        {title}
      </h3>
      <p className="relative z-10 mx-auto mt-1.5 max-w-[34ch] text-[13.5px] leading-relaxed text-ink-soft">
        {description}
      </p>
      {action && (
        <button
          type="button"
          onClick={action.onClick}
          className="relative z-10 mt-4 inline-flex h-10 items-center justify-center rounded-card-sm border border-line-strong bg-surface px-4 font-display text-[13.5px] font-semibold text-brand outline-none transition-colors hover:bg-surface-hover focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-2 focus-visible:ring-offset-bg"
        >
          {action.label}
        </button>
      )}
    </div>
  );
}
