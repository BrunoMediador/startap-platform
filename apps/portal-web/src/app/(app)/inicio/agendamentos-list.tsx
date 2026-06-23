'use client';

/**
 * Agendamentos da Home — agora é um RESUMO (top-5) com link pra /agenda
 * (Bloco A). Antes era a lista paginada completa; a tela cheia migrou pra rota
 * dedicada. Aqui:
 *   - gcal off (pré-setup)        -> empty "agenda não conectada".
 *   - sem eventos na janela       -> empty "sem agendamentos" + CTA Novo.
 *   - com eventos                 -> abas de período + os 5 PRIMEIROS da seleção +
 *     "Ver agenda completa" (quando há mais que 5) -> /agenda.
 *
 * Bloco B (nomes legíveis): cada linha usa <EventoTitulo> (nome + serviço em 2
 * linhas, marquee no desktop quando transborda). Bloco C: a linha é CLICÁVEL e
 * abre o <AgendaDetailSheet> (detalhe + remarcar/trocar/cancelar). O cancelar
 * rápido (lixeira) continua na linha, abrindo a confirmação destrutiva.
 */
import { AgendaDetailSheet } from '@/components/agenda/agenda-detail-sheet';
import { EventoTitulo } from '@/components/agenda/evento-titulo';
import { IconCalendar, IconChevronRight, IconTrash } from '@/components/icons';
import { useTenant } from '@/components/shell/session-context';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { useToast } from '@/components/ui/toast';
import { inicialDoTitulo, parseTitulo } from '@/lib/agenda-titulo';
import { type PeriodoFiltro, classify, filtrarAgendamentos } from '@/lib/agendamentos';
import { ApiError } from '@/lib/api';
import type { Agendamento, AgendamentosResponse } from '@/lib/api-types';
import { cn } from '@/lib/cn';
import { formatAgendamentoDia, formatAgendamentoHora } from '@/lib/format';
import { useExcluirAgendamento } from '@/lib/queries';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useMemo, useState } from 'react';

const TOP = 5;

const ABAS: { value: PeriodoFiltro; label: string }[] = [
  { value: 'todos', label: 'Todos' },
  { value: 'hoje', label: 'Hoje' },
  { value: 'proximos', label: 'Próximos' },
  { value: 'recentes', label: 'Recentes' },
];

export function AgendamentosList({ data }: { data: AgendamentosResponse }) {
  const router = useRouter();
  const { slot } = useTenant();
  const toast = useToast();
  const excluir = useExcluirAgendamento(slot);
  const [periodo, setPeriodo] = useState<PeriodoFiltro>('todos');
  /** Evento aguardando confirmação de exclusão (modal). null = fechado. */
  const [aExcluir, setAExcluir] = useState<Agendamento | null>(null);
  /** Evento aberto no sheet de detalhe (null = fechado). */
  const [aberto, setAberto] = useState<Agendamento | null>(null);

  function confirmarExclusao() {
    if (!aExcluir) return;
    excluir.mutate(aExcluir.id, {
      onSuccess: (res) => {
        toast.success(
          res.already_gone ? 'Esse horário já não estava na agenda.' : 'Horário cancelado.',
        );
        setAExcluir(null);
      },
      onError: (err) => {
        if (err instanceof ApiError && err.status === 404) {
          toast.success('Esse horário já não estava na agenda.');
          setAExcluir(null);
          return;
        }
        toast.error('Não foi possível cancelar agora. Tente de novo.');
      },
    });
  }

  const filtradas = useMemo(
    () => filtrarAgendamentos(data.agendamentos, { periodo, busca: '', data: '' }),
    [data.agendamentos, periodo],
  );

  const totalNaJanela = data.agendamentos.length;
  const visiveis = filtradas.slice(0, TOP);
  const temMais = filtradas.length > TOP;

  // id do 1o evento de hoje na lista (realce ambar lateral, 1.2).
  const idDestaqueHoje = useMemo(() => {
    const hoje = filtradas.find((ag) => classify(ag.inicio) === 'hoje');
    return hoje?.id ?? null;
  }, [filtradas]);

  // gcal off (pré-setup): empty especifico, sem filtros.
  if (!data.gcal_configured) {
    return (
      <EmptyBox
        title="Agenda ainda não conectada"
        description="Quando sua agenda estiver ligada, os próximos atendimentos aparecem aqui pra você acompanhar."
      />
    );
  }

  // Sem nenhum evento na janela (-7/+14d): empty "vazio de verdade", sem filtros.
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
              onClick={() => setPeriodo(aba.value)}
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

      {filtradas.length === 0 ? (
        <EmptyBox
          compacto
          title="Nada nesse período"
          description="Tente outro período ou veja a agenda completa."
          action={{ label: 'Ver agenda completa', onClick: () => router.push('/agenda') }}
        />
      ) : (
        <>
          <div className="overflow-hidden rounded-card-sm border border-line bg-surface">
            {visiveis.map((ag) => (
              <AgendamentoRow
                key={ag.id}
                ag={ag}
                destaque={periodo !== 'recentes' && ag.id === idDestaqueHoje}
                onAbrir={() => setAberto(ag)}
                onExcluir={() => setAExcluir(ag)}
              />
            ))}
          </div>

          {/* Link pra agenda completa — sempre presente; conta os extras se houver. */}
          <Link
            href="/agenda"
            className="flex items-center justify-center gap-1.5 rounded-card-sm border border-line bg-surface py-2.5 font-display text-[13.5px] font-semibold text-brand outline-none transition-colors hover:bg-surface-hover focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-2 focus-visible:ring-offset-bg"
          >
            Ver agenda completa
            {temMais && <span className="text-ink-soft">(+{filtradas.length - TOP})</span>}
            <IconChevronRight size={16} />
          </Link>
        </>
      )}

      {/* Detalhe + remarcar/trocar/cancelar (Bloco C). */}
      <AgendaDetailSheet slot={slot} agendamento={aberto} onClose={() => setAberto(null)} />

      {/* Confirmação de exclusão rápida (lixeira da linha) — irreversível: apaga no GCal. */}
      <ConfirmDialog
        open={aExcluir !== null}
        title="Cancelar este horário?"
        description={
          aExcluir
            ? `“${descricaoEvento(aExcluir)}” vai ser removido da sua agenda do Google. Isso não tem como desfazer.`
            : ''
        }
        confirmLabel="Cancelar horário"
        cancelLabel="Voltar"
        confirmVariant="destructive"
        loading={excluir.isPending}
        icon={<IconTrash size={22} />}
        onConfirm={confirmarExclusao}
        onCancel={() => {
          if (!excluir.isPending) setAExcluir(null);
        }}
      />
    </div>
  );
}

/** "Nome — Serviço" legível pro modal de confirmação (sem o telefone). */
function descricaoEvento(ag: Agendamento): string {
  const { nome, servico } = parseTitulo(ag.titulo);
  return servico ? `${nome} — ${servico}` : nome;
}

function AgendamentoRow({
  ag,
  destaque,
  onAbrir,
  onExcluir,
}: {
  ag: Agendamento;
  destaque: boolean;
  onAbrir: () => void;
  onExcluir: () => void;
}) {
  const hora = formatAgendamentoHora(ag.inicio);
  const dia = formatAgendamentoDia(ag.inicio);
  return (
    <div
      className={cn(
        'group flex min-h-14 items-center gap-3.5 border-b border-line-soft pr-2.5 transition-colors last:border-b-0 hover:bg-surface-hover',
        destaque && 'border-l-[3px] border-l-amber',
      )}
    >
      {/* Área clicável (abre o detalhe). A lixeira fica FORA dela pra não conflitar. */}
      <button
        type="button"
        onClick={onAbrir}
        aria-label={`Abrir detalhe de ${parseTitulo(ag.titulo).nome}`}
        className="flex min-w-0 flex-1 items-center gap-3.5 py-[13px] pl-[15px] text-left outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand"
      >
        <span className="flex size-[38px] shrink-0 items-center justify-center rounded-[10px] border border-line-strong bg-brand-soft font-display text-[13px] font-bold text-brand">
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
      </button>
      {/* Cancelar rápido: some no repouso, aparece no hover/foco (desktop); no
          toque o foco/tab revela. Detalhe completo fica no sheet (botão acima). */}
      <button
        type="button"
        onClick={onExcluir}
        aria-label={`Cancelar horário de ${parseTitulo(ag.titulo).nome}`}
        className="flex size-9 shrink-0 items-center justify-center rounded-[9px] text-ink-faint outline-none transition-colors hover:bg-danger/12 hover:text-danger focus-visible:bg-danger/12 focus-visible:text-danger focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-danger sm:opacity-0 sm:group-hover:opacity-100"
      >
        <IconTrash size={17} />
      </button>
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
