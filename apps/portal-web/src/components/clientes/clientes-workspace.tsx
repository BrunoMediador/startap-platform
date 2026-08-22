'use client';

import {
  WhatsAppManualDialog,
  type WhatsAppManualTarget,
} from '@/components/clientes/whatsapp-manual-dialog';
import {
  IconCalendar,
  IconChevronLeft,
  IconChevronRight,
  IconClock,
  IconPencil,
  IconUser,
  IconUsers,
  IconWhatsapp,
  IconX,
} from '@/components/icons';
import { Button } from '@/components/ui/button';
import { Overlay } from '@/components/ui/overlay';
import { PageHead } from '@/components/ui/page-head';
import { SkeletonList } from '@/components/ui/skeleton';
import { EmptyState, ErrorState } from '@/components/ui/states';
import { useToast } from '@/components/ui/toast';
import type { ClienteListItem, ClientePerfil, SaveClienteBody } from '@/lib/api-types';
import {
  clienteDisplayName,
  clientePhoneMasked,
  clientesPageFromOffset,
  clientesTotalPages,
} from '@/lib/clientes';
import { formatAgendamentoDia, formatAgendamentoHora, initials } from '@/lib/format';
import {
  useClientePerfil,
  useClientes,
  useClientesAniversariantes,
  useClientesAniversariantesCalendario,
  useClientesResumo,
  useClientesSemRetorno,
  useColaboradorClientePerfil,
  useColaboradorClientes,
  useColaboradorClientesAniversariantes,
  useColaboradorClientesAniversariantesCalendario,
  useColaboradorClientesResumo,
  useColaboradorClientesSemRetorno,
  useEnviarWhatsappManual,
  useSaveCliente,
} from '@/lib/queries';
import Image from 'next/image';
import { useDeferredValue, useEffect, useState } from 'react';
import {
  type ClientesFilters,
  activeClientesFilters,
  clearClientesFilter,
  initialClientesFilters,
} from './cliente-filters';

type Mode = 'owner' | 'colaborador';
type Panel = 'birthdays' | 'ranking' | null;

interface ClientesWorkspaceProps {
  mode: Mode;
  slot: string;
  timezone: string;
  crmEnabled: boolean;
  whatsappManualEnabled?: boolean;
  colaboradorId?: number;
}

export function ClientesWorkspace({
  mode,
  slot,
  timezone,
  crmEnabled,
  whatsappManualEnabled = false,
  colaboradorId,
}: ClientesWorkspaceProps) {
  const toast = useToast();
  const [filters, setFilters] = useState<ClientesFilters>(initialClientesFilters);
  const deferredFilters = useDeferredValue(filters);
  const [page, setPage] = useState(1);
  const [openFilter, setOpenFilter] = useState<string | null>(null);
  const [mobileFiltersOpen, setMobileFiltersOpen] = useState(false);
  const [panel, setPanel] = useState<Panel>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [menuId, setMenuId] = useState<string | null>(null);
  const [target, setTarget] = useState<WhatsAppManualTarget | null>(null);

  const ownerList = useClientes(slot, page, 20, deferredFilters, mode === 'owner' && crmEnabled);
  const collaboratorList = useColaboradorClientes(
    slot,
    colaboradorId ?? 0,
    page,
    20,
    deferredFilters,
    mode === 'colaborador' && crmEnabled,
  );
  const list = mode === 'owner' ? ownerList : collaboratorList;
  const summary = useClientesResumo(slot, mode === 'owner' && crmEnabled);
  const collaboratorSummary = useColaboradorClientesResumo(
    slot,
    colaboradorId ?? 0,
    mode === 'colaborador' && crmEnabled,
  );
  const profileOwner = useClientePerfil(slot, selectedId, mode === 'owner' && crmEnabled);
  const profileCollaborator = useColaboradorClientePerfil(
    slot,
    colaboradorId ?? 0,
    selectedId,
    mode === 'colaborador' && crmEnabled,
  );
  const profile = mode === 'owner' ? profileOwner : profileCollaborator;
  const save = useSaveCliente(slot);
  const send = useEnviarWhatsappManual(slot);

  const data = list.data;
  const items = data?.clientes ?? [];
  const total = data?.total ?? 0;
  const totalPages = clientesTotalPages(total, data?.limit ?? 20);
  const currentPage = clientesPageFromOffset(data?.offset ?? 0, data?.limit ?? 20);
  const active = activeClientesFilters(filters);
  const canSend = mode === 'owner' && whatsappManualEnabled;
  const unavailable = !crmEnabled || data?.available === false;

  const update = (patch: Partial<ClientesFilters>) => {
    setPage(1);
    setFilters((current) => ({ ...current, ...patch }));
  };
  const openProfile = (id: string) => {
    setMenuId(null);
    setSelectedId(id);
  };
  const targetFor = (item: {
    id: string;
    nome: string | null;
    telefone?: string;
    telefone_masked?: string;
  }) => ({
    id: item.id,
    nome: clienteDisplayName(item.nome),
    telefoneMasked: item.telefone_masked ?? clientePhoneMasked(item.telefone ?? null),
  });

  return (
    <>
      <PageHead title="Clientes" subtitle="Gerencie sua carteira e acompanhe os atendimentos." />

      {unavailable ? (
        <EmptyState
          icon={<IconUsers size={26} />}
          title="Clientes indisponível"
          description="Esta área ainda não está disponível para sua conta."
        />
      ) : (
        <>
          <SummaryCards
            summary={(mode === 'owner' ? summary : collaboratorSummary).data}
            loading={(mode === 'owner' ? summary : collaboratorSummary).isPending}
            onBirthdays={() => setPanel('birthdays')}
            onRanking={() => setPanel('ranking')}
          />

          <div className="mb-3 flex items-center justify-between gap-3 md:hidden">
            <p className="text-[13px] text-ink-soft">Lista de clientes</p>
            <button
              type="button"
              onClick={() => setMobileFiltersOpen(true)}
              className="inline-flex min-h-11 items-center gap-2 rounded-btn border border-line-strong bg-surface px-3 text-[13px] font-semibold text-ink outline-none hover:bg-surface-hover focus-visible:ring-2 focus-visible:ring-brand"
            >
              <FilterGlyph /> Filtrar{active.length ? ` (${active.length})` : ''}
            </button>
          </div>

          {active.length > 0 && (
            <div className="mb-3 flex flex-wrap items-center gap-2" aria-label="Filtros ativos">
              {active.map((chip) => (
                <button
                  key={chip.key}
                  type="button"
                  onClick={() => update(clearClientesFilter(filters, chip.key))}
                  className="inline-flex min-h-8 items-center gap-1 rounded-pill border border-brand/35 bg-brand-soft px-2.5 text-[12px] font-medium text-ink outline-none hover:bg-brand/20 focus-visible:ring-2 focus-visible:ring-brand"
                  aria-label={`Remover filtro ${chip.label}`}
                >
                  {chip.label}
                  <IconX size={13} />
                </button>
              ))}
              <button
                type="button"
                onClick={() => update(initialClientesFilters)}
                className="min-h-8 px-1 text-[12px] font-semibold text-brand outline-none hover:underline focus-visible:ring-2 focus-visible:ring-brand"
              >
                Limpar todos
              </button>
            </div>
          )}

          {list.isPending ? (
            <ClientesLoading />
          ) : list.isError || !data ? (
            <ErrorState
              title="Não foi possível carregar seus clientes."
              onRetry={() => list.refetch()}
              retryLabel="Tentar de novo"
            />
          ) : items.length === 0 ? (
            active.length > 0 ? (
              <EmptyState
                icon={<FilterGlyph />}
                title="Nenhum cliente corresponde a estes filtros."
                description="Ajuste ou limpe os filtros para ver a carteira completa."
                action={{
                  label: 'Limpar filtros',
                  onClick: () => update(initialClientesFilters),
                }}
              />
            ) : (
              <EmptyState
                icon={<IconUsers size={26} />}
                title="Sua carteira ainda está vazia"
                description="Quando você atender alguém, o perfil aparece aqui."
              />
            )
          ) : (
            <>
              <div className="mb-3 flex items-center justify-between gap-3">
                <span className="text-[12.5px] tabular-nums text-ink-soft">
                  {(data.offset ?? 0) + 1}–{(data.offset ?? 0) + items.length} de {total} clientes
                </span>
                {list.isFetching && (
                  <span className="text-[12px] text-ink-faint">Atualizando filtros…</span>
                )}
              </div>
              <ClientesDesktopTable
                items={items}
                mode={mode}
                timezone={timezone}
                filters={filters}
                openFilter={openFilter}
                setOpenFilter={setOpenFilter}
                update={update}
                onOpen={openProfile}
                canSend={canSend}
                onSend={(item) => setTarget(targetFor(item))}
                menuId={menuId}
                setMenuId={setMenuId}
              />
              <ClientesMobileList
                items={items}
                mode={mode}
                timezone={timezone}
                onOpen={openProfile}
                canSend={canSend}
                onSend={(item) => setTarget(targetFor(item))}
                menuId={menuId}
                setMenuId={setMenuId}
              />
              {totalPages > 1 && (
                <Pagination
                  page={currentPage}
                  totalPages={totalPages}
                  onPrevious={() => setPage((current) => Math.max(1, current - 1))}
                  onNext={() => setPage((current) => Math.min(totalPages, current + 1))}
                />
              )}
            </>
          )}
        </>
      )}

      <MobileFilterSheet
        open={mobileFiltersOpen}
        filters={filters}
        total={total}
        onClose={() => setMobileFiltersOpen(false)}
        onChange={update}
        onClear={() => update(initialClientesFilters)}
      />
      <InsightsPanel
        panel={panel}
        mode={mode}
        colaboradorId={colaboradorId ?? 0}
        slot={slot}
        canSend={canSend}
        onClose={() => setPanel(null)}
        onOpen={openProfile}
        onSend={setTarget}
      />
      <ClienteProfilePanel
        mode={mode}
        open={selectedId != null}
        profile={profile}
        saving={save.isPending}
        onClose={() => setSelectedId(null)}
        onSave={(cliente, body) =>
          save.mutate(
            { id: cliente.id, body },
            {
              onSuccess: () => toast.success('Nome exibido atualizado.'),
              onError: () => toast.error('Não foi possível salvar agora. Tente de novo.'),
            },
          )
        }
        canSend={canSend}
        onSend={(cliente) => setTarget(targetFor(cliente))}
      />
      <WhatsAppManualDialog
        key={target?.id ?? 'closed'}
        target={target}
        onClose={() => setTarget(null)}
        onFeatureOff={() => {
          setTarget(null);
          toast.error('Envio manual indisponível agora.');
        }}
        onSend={async (id, mensagem) => {
          await send.mutateAsync({ id, body: { mensagem, confirmed: true } });
        }}
      />
    </>
  );
}

function SummaryCards({
  summary,
  loading,
  onBirthdays,
  onRanking,
}: {
  summary:
    | { total_clientes: number; aniversariantes_hoje: number; sem_retorno: number }
    | undefined;
  loading: boolean;
  onBirthdays: () => void;
  onRanking: () => void;
}) {
  const cards = [
    {
      label: 'Total de clientes',
      value: summary?.total_clientes ?? 0,
      icon: <IconUsers size={23} />,
      onClick: undefined,
    },
    {
      label: 'Aniversariantes hoje',
      value: summary?.aniversariantes_hoje ?? 0,
      icon: <IconCalendar size={23} />,
      onClick: onBirthdays,
    },
    {
      label: 'Há mais tempo sem retornar',
      value: summary?.sem_retorno ?? 0,
      icon: <IconClock size={23} />,
      onClick: onRanking,
    },
  ];
  return (
    <div className="mb-5 grid gap-3 sm:grid-cols-3">
      {cards.map((card) => {
        const content = (
          <span key={card.label} className="contents">
            <span className="flex size-11 shrink-0 items-center justify-center rounded-[14px] bg-brand-soft text-brand">
              {card.icon}
            </span>
            <span className="min-w-0">
              <span className="block text-[13px] text-ink-soft">{card.label}</span>
              <span className="mt-0.5 block font-display text-[25px] font-semibold tabular-nums text-ink">
                {loading ? '—' : card.value}
              </span>
            </span>
          </span>
        );
        return card.onClick ? (
          <button
            key={card.label}
            type="button"
            onClick={card.onClick}
            className="flex min-h-[94px] items-center gap-3 rounded-card border border-line bg-surface px-4 text-left shadow-card outline-none transition hover:border-line-strong hover:bg-surface-hover focus-visible:ring-2 focus-visible:ring-brand"
          >
            {content}
          </button>
        ) : (
          <div
            key={card.label}
            className="flex min-h-[94px] items-center gap-3 rounded-card border border-line bg-surface px-4 shadow-card"
          >
            {content}
          </div>
        );
      })}
    </div>
  );
}

function ClientesDesktopTable({
  items,
  mode,
  timezone,
  filters,
  openFilter,
  setOpenFilter,
  update,
  onOpen,
  canSend,
  onSend,
  menuId,
  setMenuId,
}: {
  items: ClienteListItem[];
  mode: Mode;
  timezone: string;
  filters: ClientesFilters;
  openFilter: string | null;
  setOpenFilter: (value: string | null) => void;
  update: (value: Partial<ClientesFilters>) => void;
  onOpen: (id: string) => void;
  canSend: boolean;
  onSend: (item: ClienteListItem) => void;
  menuId: string | null;
  setMenuId: (id: string | null) => void;
}) {
  return (
    <div className="hidden overflow-visible rounded-card border border-line bg-surface shadow-card md:block">
      <table className="w-full border-collapse text-left">
        <thead>
          <tr className="border-b border-line text-[13px] text-ink-soft">
            <TableHead
              label="Cliente"
              active={openFilter === 'cliente'}
              onClick={() => setOpenFilter(openFilter === 'cliente' ? null : 'cliente')}
            >
              <FilterPopover open={openFilter === 'cliente'}>
                <label className="block text-[12px] font-medium text-ink">
                  Nome
                  <input
                    value={filters.nome}
                    onChange={(e) => update({ nome: e.target.value })}
                    className="mt-1.5 h-10 w-full rounded-btn border border-line-strong bg-surface-sunken px-2.5 text-[13px] text-ink outline-none focus:border-brand focus:ring-2 focus:ring-brand/35"
                    placeholder="Filtrar por nome"
                  />
                </label>
              </FilterPopover>
            </TableHead>
            <TableHead
              label="WhatsApp"
              active={openFilter === 'whatsapp'}
              onClick={() => setOpenFilter(openFilter === 'whatsapp' ? null : 'whatsapp')}
            >
              <FilterPopover open={openFilter === 'whatsapp'}>
                <label className="block text-[12px] font-medium text-ink">
                  DDD ou número
                  <input
                    inputMode="tel"
                    value={filters.telefone}
                    onChange={(e) => update({ telefone: e.target.value })}
                    className="mt-1.5 h-10 w-full rounded-btn border border-line-strong bg-surface-sunken px-2.5 text-[13px] text-ink outline-none focus:border-brand focus:ring-2 focus:ring-brand/35"
                    placeholder="Ex.: 189"
                  />
                </label>
              </FilterPopover>
            </TableHead>
            <TableHead
              label="Último atendimento"
              active={openFilter === 'ultimo'}
              onClick={() => setOpenFilter(openFilter === 'ultimo' ? null : 'ultimo')}
            >
              <FilterPopover open={openFilter === 'ultimo'}>
                <FilterSelect
                  value={filters.ultimoAtendimento ?? ''}
                  onChange={(value) =>
                    update({
                      ultimoAtendimento: (value || null) as ClientesFilters['ultimoAtendimento'],
                    })
                  }
                  label="Período"
                  options={[
                    ['', 'Todos'],
                    ['hoje', 'Hoje'],
                    ['7d', 'Últimos 7 dias'],
                    ['30d', 'Últimos 30 dias'],
                    ['sem_historico', 'Sem histórico'],
                  ]}
                />
                <div className="mt-3 grid grid-cols-2 gap-2">
                  <DateInput
                    label="De"
                    value={filters.periodoInicio}
                    onChange={(periodoInicio) => update({ periodoInicio })}
                  />
                  <DateInput
                    label="Até"
                    value={filters.periodoFim}
                    onChange={(periodoFim) => update({ periodoFim })}
                  />
                </div>
                <SortButtons
                  active={filters.ordenarPor === 'ultimo_atendimento' ? filters.ordem : null}
                  onChange={(ordem) => update({ ordenarPor: 'ultimo_atendimento', ordem })}
                />
              </FilterPopover>
            </TableHead>
            <TableHead
              label="Visitas"
              active={openFilter === 'visitas'}
              onClick={() => setOpenFilter(openFilter === 'visitas' ? null : 'visitas')}
            >
              <FilterPopover open={openFilter === 'visitas'}>
                <FilterSelect
                  value={filters.visitas}
                  onChange={(visitas) => update({ visitas: visitas as ClientesFilters['visitas'] })}
                  label="Faixa"
                  options={[
                    ['todas', 'Todas'],
                    ['uma', '1 visita'],
                    ['2_5', '2–5 visitas'],
                    ['6_10', '6–10 visitas'],
                    ['11_mais', '11 ou mais'],
                  ]}
                />
                <SortButtons
                  active={filters.ordenarPor === 'visitas' ? filters.ordem : null}
                  onChange={(ordem) => update({ ordenarPor: 'visitas', ordem })}
                />
              </FilterPopover>
            </TableHead>
            <th className="w-[130px] px-4 py-4 text-right">Ações</th>
          </tr>
        </thead>
        <tbody>
          {items.map((item) => (
            <DesktopRow
              key={item.id}
              item={item}
              mode={mode}
              timezone={timezone}
              onOpen={() => onOpen(item.id)}
              canSend={canSend}
              onSend={() => onSend(item)}
              menuOpen={menuId === item.id}
              onMenu={() => setMenuId(menuId === item.id ? null : item.id)}
            />
          ))}
        </tbody>
      </table>
    </div>
  );
}

function TableHead({
  label,
  active,
  onClick,
  children,
}: { label: string; active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <th className="relative px-4 py-4 font-semibold">
      <button
        type="button"
        onClick={onClick}
        aria-expanded={active}
        className="inline-flex min-h-8 items-center gap-1.5 rounded-btn outline-none hover:text-ink focus-visible:ring-2 focus-visible:ring-brand"
      >
        {label}
        <FilterGlyph />
      </button>
      {children}
    </th>
  );
}
function FilterPopover({ open, children }: { open: boolean; children: React.ReactNode }) {
  return open ? (
    <div className="absolute left-3 top-[calc(100%-4px)] z-20 w-[260px] rounded-card border border-line-strong bg-surface-elev p-3 text-left shadow-elev">
      {children}
    </div>
  ) : null;
}
function FilterSelect({
  label,
  value,
  onChange,
  options,
}: { label: string; value: string; onChange: (value: string) => void; options: string[][] }) {
  return (
    <label className="block text-[12px] font-medium text-ink">
      {label}
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="mt-1.5 h-10 w-full rounded-btn border border-line-strong bg-surface-sunken px-2 text-[13px] text-ink outline-none focus:border-brand focus:ring-2 focus:ring-brand/35"
      >
        {options.map(([option, text]) => (
          <option key={option} value={option}>
            {text}
          </option>
        ))}
      </select>
    </label>
  );
}
function DateInput({
  label,
  value,
  onChange,
}: { label: string; value: string; onChange: (value: string) => void }) {
  return (
    <label className="block text-[11px] font-medium text-ink-soft">
      {label}
      <input
        type="date"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="mt-1 block h-9 w-full rounded-btn border border-line-strong bg-surface-sunken px-1.5 text-[11px] text-ink outline-none focus:border-brand focus:ring-2 focus:ring-brand/35"
      />
    </label>
  );
}
function SortButtons({
  active,
  onChange,
}: { active: 'asc' | 'desc' | null; onChange: (order: 'asc' | 'desc') => void }) {
  return (
    <div className="mt-3 flex gap-1">
      <button
        type="button"
        className={`min-h-8 rounded-btn px-2 text-[11px] font-semibold outline-none focus-visible:ring-2 focus-visible:ring-brand ${active === 'desc' ? 'bg-brand text-white' : 'bg-surface-hover text-ink-soft'}`}
        onClick={() => onChange('desc')}
      >
        Maior primeiro
      </button>
      <button
        type="button"
        className={`min-h-8 rounded-btn px-2 text-[11px] font-semibold outline-none focus-visible:ring-2 focus-visible:ring-brand ${active === 'asc' ? 'bg-brand text-white' : 'bg-surface-hover text-ink-soft'}`}
        onClick={() => onChange('asc')}
      >
        Menor primeiro
      </button>
    </div>
  );
}

function DesktopRow({
  item,
  mode,
  timezone,
  onOpen,
  canSend,
  onSend,
  menuOpen,
  onMenu,
}: {
  item: ClienteListItem;
  mode: Mode;
  timezone: string;
  onOpen: () => void;
  canSend: boolean;
  onSend: () => void;
  menuOpen: boolean;
  onMenu: () => void;
}) {
  return (
    <tr
      tabIndex={0}
      role="button"
      onClick={onOpen}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onOpen();
        }
      }}
      className="group cursor-pointer border-b border-line last:border-0 outline-none hover:bg-surface-hover focus-visible:bg-surface-hover focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand"
    >
      <td className="px-4 py-3.5">
        <div className="flex items-center gap-3">
          <ClienteAvatar item={item} mode={mode} />
          <span className="font-medium text-ink">{displayName(item)}</span>
        </div>
      </td>
      <td className="px-4 py-3.5 text-[13px] text-ink-soft">{clientePhoneMasked(item.telefone)}</td>
      <td className="px-4 py-3.5">
        <LastAttendance item={item} timezone={timezone} />
      </td>
      <td className="px-4 py-3.5 font-medium tabular-nums text-ink">{item.total_atendimentos}</td>
      <td className="px-4 py-3.5">
        <RowActions
          name={displayName(item)}
          canSend={canSend}
          canEditName={mode === 'owner'}
          onSend={onSend}
          menuOpen={menuOpen}
          onMenu={onMenu}
          onOpen={onOpen}
        />
      </td>
    </tr>
  );
}

function ClientesMobileList({
  items,
  mode,
  timezone,
  onOpen,
  canSend,
  onSend,
  menuId,
  setMenuId,
}: {
  items: ClienteListItem[];
  mode: Mode;
  timezone: string;
  onOpen: (id: string) => void;
  canSend: boolean;
  onSend: (item: ClienteListItem) => void;
  menuId: string | null;
  setMenuId: (value: string | null) => void;
}) {
  return (
    <div className="space-y-2 md:hidden">
      {items.map((item) => (
        <div
          key={item.id}
          tabIndex={0}
          role="button"
          onClick={() => onOpen(item.id)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') onOpen(item.id);
          }}
          className="rounded-card border border-line bg-surface p-3 outline-none hover:bg-surface-hover focus-visible:ring-2 focus-visible:ring-brand"
        >
          <div className="flex items-start gap-3">
            <ClienteAvatar item={item} mode={mode} />
            <div className="min-w-0 flex-1">
              <p className="truncate font-medium text-ink">{displayName(item)}</p>
              <p className="mt-0.5 text-[12px] text-ink-soft">
                {clientePhoneMasked(item.telefone)}
              </p>
              <div className="mt-2 flex items-center gap-3 text-[12px] text-ink-soft">
                <LastAttendance item={item} timezone={timezone} compact />
                <span>
                  {item.total_atendimentos} visita{item.total_atendimentos === 1 ? '' : 's'}
                </span>
              </div>
            </div>
            <RowActions
              name={displayName(item)}
              canSend={canSend}
              canEditName={mode === 'owner'}
              onSend={() => onSend(item)}
              menuOpen={menuId === item.id}
              onMenu={() => setMenuId(menuId === item.id ? null : item.id)}
              onOpen={() => onOpen(item.id)}
            />
          </div>
        </div>
      ))}
    </div>
  );
}

function RowActions({
  name,
  canSend,
  canEditName,
  onSend,
  menuOpen,
  onMenu,
  onOpen,
}: {
  name: string;
  canSend: boolean;
  canEditName: boolean;
  onSend: () => void;
  menuOpen: boolean;
  onMenu: () => void;
  onOpen: () => void;
}) {
  const stop = (handler: () => void) => (e: React.MouseEvent) => {
    e.stopPropagation();
    handler();
  };
  return (
    <div className="relative flex justify-end gap-1">
      <button
        type="button"
        title={`Abrir perfil de ${name}`}
        aria-label={`Abrir perfil de ${name}`}
        onClick={stop(onOpen)}
        className="sr-only"
      >
        Abrir perfil
      </button>
      {canSend && (
        <button
          type="button"
          title={`Enviar mensagem para ${name}`}
          aria-label={`Enviar mensagem para ${name}`}
          onClick={stop(onSend)}
          className="flex size-11 items-center justify-center rounded-full border border-line-strong text-ink outline-none hover:bg-brand-soft hover:text-brand focus-visible:ring-2 focus-visible:ring-brand"
        >
          <IconWhatsapp size={19} />
        </button>
      )}
      <button
        type="button"
        title={`Mais opções de ${name}`}
        aria-label={`Mais opções de ${name}`}
        aria-expanded={menuOpen}
        onClick={stop(onMenu)}
        className="flex size-11 items-center justify-center rounded-full border border-line-strong text-ink outline-none hover:bg-surface-hover focus-visible:ring-2 focus-visible:ring-brand"
      >
        <DotsGlyph />
      </button>
      {menuOpen && (
        <div className="absolute right-0 top-12 z-20 w-52 rounded-card border border-line-strong bg-surface-elev p-1.5 shadow-elev">
          <button
            type="button"
            onClick={stop(onOpen)}
            className="flex min-h-10 w-full items-center rounded-btn px-2.5 text-left text-[13px] text-ink hover:bg-surface-hover"
          >
            Abrir perfil
          </button>
          {canEditName && (
            <button
              type="button"
              onClick={stop(onOpen)}
              className="flex min-h-10 w-full items-center rounded-btn px-2.5 text-left text-[13px] text-ink hover:bg-surface-hover"
            >
              Personalizar nome exibido
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function ClienteAvatar({
  item,
  mode,
}: { item: Pick<ClienteListItem, 'id' | 'nome' | 'nome_personalizado'>; mode: Mode }) {
  const [failed, setFailed] = useState(false);
  const name = displayName(item);
  if (mode === 'owner' && !failed)
    return (
      <span className="relative flex size-10 shrink-0 overflow-hidden rounded-full border border-line-strong bg-surface-sunken">
        <Image
          src={`/portal/clientes/${item.id}/avatar`}
          alt=""
          fill
          sizes="40px"
          unoptimized
          onError={() => setFailed(true)}
        />
      </span>
    );
  const letters = name === 'Cliente sem nome' ? null : initials(name);
  return (
    <span
      aria-hidden
      className="flex size-10 shrink-0 items-center justify-center rounded-full border border-line-strong bg-brand-soft text-[12px] font-semibold text-brand"
    >
      {letters || <IconUser size={18} />}
    </span>
  );
}
function displayName(item: Pick<ClienteListItem, 'nome' | 'nome_personalizado'>) {
  return clienteDisplayName(item.nome_personalizado ?? item.nome);
}
function LastAttendance({
  item,
  timezone,
  compact = false,
}: {
  item: Pick<ClienteListItem, 'ultima_interacao_at' | 'ultimo_profissional_nome'>;
  timezone: string;
  compact?: boolean;
}) {
  if (!item.ultima_interacao_at)
    return <span className="text-[12px] text-ink-faint">Sem histórico</span>;
  const date = formatAgendamentoDia(item.ultima_interacao_at, undefined, timezone);
  const hour = formatAgendamentoHora(item.ultima_interacao_at, timezone);
  return (
    <span className={compact ? 'truncate' : 'block'}>
      <span className="block text-[13px] text-ink">
        {date}
        {compact ? '' : ` · ${hour}`}
      </span>
      {!compact && (
        <span className="mt-0.5 block text-[12px] text-ink-soft">
          {item.ultimo_profissional_nome ?? 'Sem profissional'}
        </span>
      )}
    </span>
  );
}

function MobileFilterSheet({
  open,
  filters,
  total,
  onClose,
  onChange,
  onClear,
}: {
  open: boolean;
  filters: ClientesFilters;
  total: number;
  onClose: () => void;
  onChange: (patch: Partial<ClientesFilters>) => void;
  onClear: () => void;
}) {
  return (
    <Overlay open={open} onClose={onClose} variant="sheet" ariaLabel="Filtrar clientes">
      <div className="px-5 pb-2 pt-4">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="font-display text-[18px] font-semibold text-ink">Filtrar clientes</h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Fechar filtros"
            className="flex size-11 items-center justify-center rounded-btn text-ink-soft outline-none hover:bg-surface-hover focus-visible:ring-2 focus-visible:ring-brand"
          >
            <IconX size={19} />
          </button>
        </div>
        <div className="space-y-4">
          <label className="block text-[13px] font-semibold text-ink">
            Cliente
            <input
              value={filters.nome}
              onChange={(e) => onChange({ nome: e.target.value })}
              className="mt-1.5 h-11 w-full rounded-btn border border-line-strong bg-surface-sunken px-3 text-[14px] text-ink outline-none focus:border-brand focus:ring-2 focus:ring-brand/35"
              placeholder="Nome"
            />
          </label>
          <label className="block text-[13px] font-semibold text-ink">
            WhatsApp
            <input
              inputMode="tel"
              value={filters.telefone}
              onChange={(e) => onChange({ telefone: e.target.value })}
              className="mt-1.5 h-11 w-full rounded-btn border border-line-strong bg-surface-sunken px-3 text-[14px] text-ink outline-none focus:border-brand focus:ring-2 focus:ring-brand/35"
              placeholder="DDD ou número"
            />
          </label>
          <FilterSelect
            label="Último atendimento"
            value={filters.ultimoAtendimento ?? ''}
            onChange={(ultimoAtendimento) =>
              onChange({
                ultimoAtendimento: (ultimoAtendimento ||
                  null) as ClientesFilters['ultimoAtendimento'],
              })
            }
            options={[
              ['', 'Todos'],
              ['hoje', 'Hoje'],
              ['7d', 'Últimos 7 dias'],
              ['30d', 'Últimos 30 dias'],
              ['sem_historico', 'Sem histórico'],
            ]}
          />
          <div className="grid grid-cols-2 gap-3">
            <DateInput
              label="Período inicial"
              value={filters.periodoInicio}
              onChange={(periodoInicio) => onChange({ periodoInicio })}
            />
            <DateInput
              label="Período final"
              value={filters.periodoFim}
              onChange={(periodoFim) => onChange({ periodoFim })}
            />
          </div>
          <FilterSelect
            label="Visitas"
            value={filters.visitas}
            onChange={(visitas) => onChange({ visitas: visitas as ClientesFilters['visitas'] })}
            options={[
              ['todas', 'Todas'],
              ['uma', '1 visita'],
              ['2_5', '2–5 visitas'],
              ['6_10', '6–10 visitas'],
              ['11_mais', '11 ou mais'],
            ]}
          />
          <div className="grid grid-cols-2 gap-3">
            <FilterSelect
              label="Ordenar por"
              value={filters.ordenarPor}
              onChange={(ordenarPor) =>
                onChange({ ordenarPor: ordenarPor as ClientesFilters['ordenarPor'] })
              }
              options={[
                ['ultimo_atendimento', 'Atendimento'],
                ['visitas', 'Visitas'],
              ]}
            />
            <FilterSelect
              label="Ordem"
              value={filters.ordem}
              onChange={(ordem) => onChange({ ordem: ordem as ClientesFilters['ordem'] })}
              options={[
                ['desc', 'Maior primeiro'],
                ['asc', 'Menor primeiro'],
              ]}
            />
          </div>
        </div>
        <div className="mt-5 flex gap-2">
          <Button variant="secondary" onClick={onClear}>
            Limpar filtros
          </Button>
          <Button onClick={onClose}>Ver {total} clientes</Button>
        </div>
      </div>
    </Overlay>
  );
}

function InsightsPanel({
  panel,
  mode,
  colaboradorId,
  slot,
  canSend,
  onClose,
  onOpen,
  onSend,
}: {
  panel: Panel;
  mode: Mode;
  colaboradorId: number;
  slot: string;
  canSend: boolean;
  onClose: () => void;
  onOpen: (id: string) => void;
  onSend: (target: WhatsAppManualTarget) => void;
}) {
  const [birthdayView, setBirthdayView] = useState<'lista' | 'calendario'>('lista');
  const [calendarView, setCalendarView] = useState<'semana' | 'mes'>('semana');
  const [anchor, setAnchor] = useState(() => new Date().toISOString().slice(0, 10));
  const birthdays = useClientesAniversariantes(
    slot,
    'proximos',
    30,
    1,
    50,
    mode === 'owner' && panel === 'birthdays' && birthdayView === 'lista',
  );
  const collaboratorBirthdays = useColaboradorClientesAniversariantes(
    slot,
    colaboradorId,
    'proximos',
    30,
    1,
    50,
    mode === 'colaborador' && panel === 'birthdays' && birthdayView === 'lista',
  );
  const calendar = useClientesAniversariantesCalendario(
    slot,
    calendarView,
    anchor,
    mode === 'owner' && panel === 'birthdays' && birthdayView === 'calendario',
  );
  const collaboratorCalendar = useColaboradorClientesAniversariantesCalendario(
    slot,
    colaboradorId,
    calendarView,
    anchor,
    mode === 'colaborador' && panel === 'birthdays' && birthdayView === 'calendario',
  );
  const ranking = useClientesSemRetorno(slot, 1, 50, mode === 'owner' && panel === 'ranking');
  const collaboratorRanking = useColaboradorClientesSemRetorno(
    slot,
    colaboradorId,
    1,
    50,
    mode === 'colaborador' && panel === 'ranking',
  );
  const birthdayQuery = mode === 'owner' ? birthdays : collaboratorBirthdays;
  const calendarQuery = mode === 'owner' ? calendar : collaboratorCalendar;
  const rankingQuery = mode === 'owner' ? ranking : collaboratorRanking;
  const birthdayItems = (birthdayView === 'calendario' ? calendarQuery : birthdayQuery).data
    ?.clientes;
  const query =
    panel === 'ranking'
      ? rankingQuery
      : birthdayView === 'calendario'
        ? calendarQuery
        : birthdayQuery;
  const move = (amount: number) => {
    const date = new Date(`${anchor}T12:00:00`);
    date.setDate(date.getDate() + amount * (calendarView === 'semana' ? 7 : 30));
    setAnchor(date.toISOString().slice(0, 10));
  };
  return (
    <Overlay
      open={panel != null}
      onClose={onClose}
      variant="detail"
      ariaLabel={panel === 'birthdays' ? 'Aniversariantes' : 'Há mais tempo sem retornar'}
    >
      <div className="px-5 pb-5 pt-4 sm:px-6">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2 className="font-display text-[20px] font-semibold text-ink">
              {panel === 'birthdays' ? 'Aniversariantes' : 'Há mais tempo sem retornar'}
            </h2>
            <p className="mt-1 text-[13px] leading-snug text-ink-soft">
              {panel === 'birthdays'
                ? 'Acompanhe as datas sem automação de envio.'
                : 'Uma visão de acompanhamento, sem presumir abandono.'}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Fechar painel"
            className="flex size-11 shrink-0 items-center justify-center rounded-btn outline-none hover:bg-surface-hover focus-visible:ring-2 focus-visible:ring-brand"
          >
            <IconX size={19} />
          </button>
        </div>
        {panel === 'birthdays' && (
          <>
            <div className="mt-5 flex rounded-btn bg-surface-sunken p-1">
              <button
                type="button"
                onClick={() => setBirthdayView('lista')}
                className={`min-h-9 flex-1 rounded-btn text-[12px] font-semibold outline-none focus-visible:ring-2 focus-visible:ring-brand ${birthdayView === 'lista' ? 'bg-surface text-ink shadow-card' : 'text-ink-soft'}`}
              >
                Lista
              </button>
              <button
                type="button"
                onClick={() => setBirthdayView('calendario')}
                className={`min-h-9 flex-1 rounded-btn text-[12px] font-semibold outline-none focus-visible:ring-2 focus-visible:ring-brand ${birthdayView === 'calendario' ? 'bg-surface text-ink shadow-card' : 'text-ink-soft'}`}
              >
                Calendário
              </button>
            </div>
            {birthdayView === 'calendario' && (
              <div className="mt-3 flex items-center justify-between gap-2">
                <button
                  type="button"
                  aria-label="Período anterior"
                  onClick={() => move(-1)}
                  className="flex size-11 items-center justify-center rounded-btn border border-line outline-none hover:bg-surface-hover focus-visible:ring-2 focus-visible:ring-brand"
                >
                  <IconChevronLeft size={18} />
                </button>
                <button
                  type="button"
                  onClick={() => setAnchor(new Date().toISOString().slice(0, 10))}
                  className="min-h-10 rounded-btn px-3 text-[12px] font-semibold text-brand outline-none hover:bg-brand-soft focus-visible:ring-2 focus-visible:ring-brand"
                >
                  Hoje
                </button>
                <button
                  type="button"
                  aria-label="Próximo período"
                  onClick={() => move(1)}
                  className="flex size-11 items-center justify-center rounded-btn border border-line outline-none hover:bg-surface-hover focus-visible:ring-2 focus-visible:ring-brand"
                >
                  <IconChevronRight size={18} />
                </button>
              </div>
            )}
            <div className="mt-3 flex gap-1">
              {(['semana', 'mes'] as const).map((view) => (
                <button
                  key={view}
                  type="button"
                  onClick={() => setCalendarView(view)}
                  className={`min-h-8 rounded-pill px-3 text-[12px] font-semibold outline-none focus-visible:ring-2 focus-visible:ring-brand ${calendarView === view ? 'bg-brand-soft text-brand' : 'text-ink-soft hover:bg-surface-hover'}`}
                >
                  {view === 'semana' ? 'Semana' : 'Mês'}
                </button>
              ))}
            </div>
          </>
        )}
        {query.isPending ? (
          <div className="mt-5">
            <SkeletonList rows={5} />
          </div>
        ) : query.isError || !query.data ? (
          <div className="mt-5">
            <ErrorState
              title="Não foi possível carregar esta lista."
              onRetry={() => query.refetch()}
              retryLabel="Tentar de novo"
            />
          </div>
        ) : query.data.clientes.length === 0 ? (
          <div className="mt-6">
            <EmptyState
              icon={panel === 'birthdays' ? <IconCalendar size={26} /> : <IconClock size={26} />}
              title={
                panel === 'birthdays'
                  ? `Nenhum aniversário nesta ${calendarView}.`
                  : 'Nenhum cliente nesta fila.'
              }
              description={
                panel === 'birthdays'
                  ? 'Navegue para outro período ou complete as datas no perfil.'
                  : 'Os próximos retornos aparecerão aqui conforme houver histórico.'
              }
            />
          </div>
        ) : (
          <div className="mt-5 space-y-2">
            {panel === 'ranking'
              ? rankingQuery.data?.clientes.map((item) => (
                  <InsightRow
                    key={item.id}
                    name={clienteDisplayName(item.nome)}
                    subtitle={`${item.dias_sem_retorno} dias sem retorno`}
                    onOpen={() => onOpen(item.id)}
                    canSend={canSend}
                    onSend={() =>
                      onSend({
                        id: item.id,
                        nome: clienteDisplayName(item.nome),
                        telefoneMasked: item.telefone_masked,
                      })
                    }
                  />
                ))
              : birthdayItems?.map((item) => (
                  <InsightRow
                    key={item.id}
                    name={clienteDisplayName(item.nome)}
                    subtitle={
                      item.ocorrencia_local_date ??
                      item.proxima_ocorrencia_local_date ??
                      item.aniversario_mmdd
                    }
                    onOpen={() => onOpen(item.id)}
                    canSend={canSend}
                    onSend={() =>
                      onSend({
                        id: item.id,
                        nome: clienteDisplayName(item.nome),
                        telefoneMasked: item.telefone_masked,
                      })
                    }
                  />
                ))}
          </div>
        )}
      </div>
    </Overlay>
  );
}
function InsightRow({
  name,
  subtitle,
  onOpen,
  canSend,
  onSend,
}: {
  name: string;
  subtitle: string | null;
  onOpen: () => void;
  canSend: boolean;
  onSend: () => void;
}) {
  return (
    <div className="flex items-center gap-3 rounded-card border border-line bg-surface p-3">
      <span className="flex size-10 shrink-0 items-center justify-center rounded-full bg-brand-soft text-[12px] font-semibold text-brand">
        {initials(name) || <IconUser size={18} />}
      </span>
      <button
        type="button"
        onClick={onOpen}
        className="min-w-0 flex-1 text-left outline-none focus-visible:ring-2 focus-visible:ring-brand"
      >
        <span className="block truncate text-[14px] font-medium text-ink">{name}</span>
        <span className="mt-0.5 block text-[12px] text-ink-soft">{subtitle}</span>
      </button>
      {canSend && (
        <button
          type="button"
          onClick={onSend}
          aria-label={`Enviar mensagem para ${name}`}
          title={`Enviar mensagem para ${name}`}
          className="flex size-11 shrink-0 items-center justify-center rounded-full border border-line-strong outline-none hover:bg-brand-soft hover:text-brand focus-visible:ring-2 focus-visible:ring-brand"
        >
          <IconWhatsapp size={19} />
        </button>
      )}
    </div>
  );
}

function ClienteProfilePanel({
  mode,
  open,
  profile,
  saving,
  onClose,
  onSave,
  canSend,
  onSend,
}: {
  mode: Mode;
  open: boolean;
  profile: ReturnType<typeof useClientePerfil> | ReturnType<typeof useColaboradorClientePerfil>;
  saving: boolean;
  onClose: () => void;
  onSave: (cliente: ClientePerfil, body: SaveClienteBody) => void;
  canSend: boolean;
  onSend: (cliente: ClientePerfil) => void;
}) {
  const [customName, setCustomName] = useState('');
  useEffect(() => {
    if (profile.data?.cliente) setCustomName(profile.data.cliente.nome_personalizado ?? '');
  }, [profile.data?.cliente]);
  const cliente = profile.data?.cliente;
  return (
    <Overlay open={open} onClose={onClose} variant="detail" ariaLabel="Perfil do cliente">
      <div className="px-5 pb-5 pt-4 sm:px-6">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2 className="font-display text-[20px] font-semibold text-ink">Perfil do cliente</h2>
            <p className="mt-1 text-[13px] text-ink-soft">Dados de atendimento e identificação.</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Fechar perfil"
            className="flex size-11 shrink-0 items-center justify-center rounded-btn outline-none hover:bg-surface-hover focus-visible:ring-2 focus-visible:ring-brand"
          >
            <IconX size={19} />
          </button>
        </div>
        {profile.isPending ? (
          <div className="mt-5">
            <SkeletonList rows={5} />
          </div>
        ) : profile.isError || !cliente ? (
          <div className="mt-5">
            <ErrorState
              title="Não foi possível carregar o perfil."
              onRetry={() => profile.refetch()}
              retryLabel="Tentar de novo"
            />
          </div>
        ) : (
          <div className="mt-6">
            <div className="flex items-center gap-3">
              <span className="flex size-14 items-center justify-center rounded-full bg-brand-soft text-[16px] font-semibold text-brand">
                {initials(displayName(cliente)) || <IconUser size={22} />}
              </span>
              <div>
                <p className="font-display text-[18px] font-semibold text-ink">
                  {displayName(cliente)}
                </p>
                <p className="mt-0.5 text-[13px] text-ink-soft">
                  {clientePhoneMasked(cliente.telefone)}
                </p>
              </div>
            </div>
            <dl className="mt-6 divide-y divide-line rounded-card border border-line bg-surface">
              <ProfileItem label="Visitas" value={String(cliente.total_atendimentos)} />
              <ProfileItem
                label="Último atendimento"
                value={
                  cliente.ultima_interacao_at
                    ? `${formatAgendamentoDia(cliente.ultima_interacao_at, undefined, 'America/Sao_Paulo')} · ${formatAgendamentoHora(cliente.ultima_interacao_at, 'America/Sao_Paulo')}`
                    : 'Sem histórico'
                }
              />
            </dl>
            {mode === 'owner' && (
              <div className="mt-6">
                <label className="text-[13px] font-semibold text-ink" htmlFor="cliente-custom-name">
                  Nome exibido
                </label>
                <p className="mt-1 text-[12px] leading-snug text-ink-soft">
                  Este nome aparece somente na sua carteira e não altera o número nem o histórico.
                </p>
                <input
                  id="cliente-custom-name"
                  value={customName}
                  onChange={(e) => setCustomName(e.target.value.slice(0, 160))}
                  placeholder={cliente.nome ?? 'Adicionar nome'}
                  className="mt-2 h-11 w-full rounded-btn border border-line-strong bg-surface-sunken px-3 text-[14px] text-ink outline-none focus:border-brand focus:ring-2 focus:ring-brand/35"
                />
                <div className="mt-3 flex gap-2">
                  <Button
                    variant="secondary"
                    onClick={() => setCustomName(cliente.nome_personalizado ?? '')}
                  >
                    Cancelar
                  </Button>
                  <Button
                    loading={saving}
                    loadingLabel="Salvando…"
                    disabled={customName.trim() === (cliente.nome_personalizado ?? '')}
                    onClick={() =>
                      onSave(cliente, { nome_personalizado: customName.trim() || null })
                    }
                  >
                    <IconPencil size={16} />
                    Salvar nome
                  </Button>
                </div>
              </div>
            )}
            {canSend && (
              <div className="mt-6">
                <Button onClick={() => onSend(cliente)}>
                  <IconWhatsapp size={17} />
                  Enviar WhatsApp
                </Button>
              </div>
            )}
          </div>
        )}
      </div>
    </Overlay>
  );
}
function ProfileItem({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-3 px-3 py-3">
      <dt className="text-[12px] text-ink-soft">{label}</dt>
      <dd className="text-right text-[13px] font-medium text-ink">{value}</dd>
    </div>
  );
}
function Pagination({
  page,
  totalPages,
  onPrevious,
  onNext,
}: { page: number; totalPages: number; onPrevious: () => void; onNext: () => void }) {
  return (
    <div className="mt-4 flex items-center justify-between">
      <span className="text-[12px] text-ink-soft">
        Página {page} de {totalPages}
      </span>
      <div className="flex gap-2">
        <button
          type="button"
          disabled={page <= 1}
          onClick={onPrevious}
          aria-label="Página anterior"
          className="flex size-11 items-center justify-center rounded-btn border border-line outline-none hover:bg-surface-hover focus-visible:ring-2 focus-visible:ring-brand disabled:opacity-40"
        >
          <IconChevronLeft size={18} />
        </button>
        <button
          type="button"
          disabled={page >= totalPages}
          onClick={onNext}
          aria-label="Próxima página"
          className="flex size-11 items-center justify-center rounded-btn border border-line outline-none hover:bg-surface-hover focus-visible:ring-2 focus-visible:ring-brand disabled:opacity-40"
        >
          <IconChevronRight size={18} />
        </button>
      </div>
    </div>
  );
}
function ClientesLoading() {
  return (
    <>
      <div className="mb-3 grid gap-2 md:hidden">
        <div className="h-24 animate-pulse rounded-card bg-surface-hover" />
        <div className="h-24 animate-pulse rounded-card bg-surface-hover" />
        <div className="h-24 animate-pulse rounded-card bg-surface-hover" />
      </div>
      <div className="hidden md:block">
        <SkeletonList rows={7} />
      </div>
    </>
  );
}
function FilterGlyph() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M4 6h16M7 12h10m-7 6h4"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
      />
    </svg>
  );
}
function DotsGlyph() {
  return (
    <svg width="19" height="19" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <circle cx="12" cy="5" r="1.8" />
      <circle cx="12" cy="12" r="1.8" />
      <circle cx="12" cy="19" r="1.8" />
    </svg>
  );
}
