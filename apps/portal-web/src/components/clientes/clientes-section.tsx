'use client';

import {
  IconCalendar,
  IconChevronLeft,
  IconChevronRight,
  IconClock,
  IconPencil,
  IconSearch,
  IconSend,
  IconUser,
  IconUsers,
  IconX,
} from '@/components/icons';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Overlay } from '@/components/ui/overlay';
import { PageHead } from '@/components/ui/page-head';
import { SkeletonList } from '@/components/ui/skeleton';
import { EmptyState, ErrorState } from '@/components/ui/states';
import { useToast } from '@/components/ui/toast';
import {
  WhatsAppManualDialog,
  type WhatsAppManualTarget,
} from '@/components/clientes/whatsapp-manual-dialog';
import { ApiError } from '@/lib/api';
import type {
  ClientePerfil,
  ClienteListItem,
  ClientesAniversariantesModo,
  SaveClienteBody,
} from '@/lib/api-types';
import {
  CLIENTES_ANIVERSARIANTES_PAGE_SIZE,
  CLIENTES_PAGE_SIZE,
  CLIENTES_SEM_RETORNO_PAGE_SIZE,
  aniversarianteDiasLabel,
  aniversarianteFaixaLabel,
  aniversarianteMatchesSearch,
  aniversarianteOccurrenceLabel,
  birthdayLabel,
  birthdayToDateInput,
  birthdayFromDateInput,
  buildClientePatchBody,
  currentMonthInTimezone,
  type ClienteAniversarianteItem,
  type ClienteSemRetornoItem,
  clienteDraftChanged,
  clienteDraftFromPerfil,
  clienteDisplayName,
  clientePhoneMasked,
  clientesPageFromOffset,
  clientesTotalPages,
  monthName,
  semRetornoDiasLabel,
  semRetornoFaixaLabel,
  semRetornoMatchesSearch,
  sanitizeClientesSearch,
} from '@/lib/clientes';
import { cn } from '@/lib/cn';
import {
  formatAgendamentoDia,
  formatAgendamentoHora,
  formatPhoneDisplay,
  initials,
} from '@/lib/format';
import {
  useClientePerfil,
  useClientesAniversariantes,
  useClientes,
  useClientesSemRetorno,
  useColaboradorClientePerfil,
  useColaboradorClientesAniversariantes,
  useColaboradorClientes,
  useColaboradorClientesSemRetorno,
  useSaveCliente,
  useEnviarWhatsappManual,
} from '@/lib/queries';
import { useDeferredValue, useEffect, useState } from 'react';

type Mode = 'owner' | 'colaborador';

interface ClientesSectionProps {
  mode: Mode;
  slot: string;
  timezone: string;
  crmEnabled: boolean;
  whatsappManualEnabled?: boolean;
  colaboradorId?: number;
}

const OWNER_SUBTITLE =
  'Sua carteira de clientes em um só lugar, com histórico e campos opcionais para completar o perfil.';
const COLABORADOR_SUBTITLE =
  'Clientes que já atenderam com você, com histórico para consulta rápida.';
const OWNER_BIRTHDAY_SUBTITLE =
  'Fila de aniversários com telefone mascarado, sem envio automático, automação ou exportação.';
const COLABORADOR_BIRTHDAY_SUBTITLE =
  'Aniversários dos clientes que já passaram com você, em leitura simples e com PII mínima.';
const OWNER_RANKING_SUBTITLE =
  'Fila priorizada por maior tempo sem retorno, sem disparo automático e com telefone mascarado.';
const COLABORADOR_RANKING_SUBTITLE =
  'Fila pessoal baseada só nos seus atendimentos elegíveis, também com telefone mascarado.';

const ANIVERSARIANTE_DAY_OPTIONS = [7, 15, 30] as const;
const MONTH_OPTIONS = Array.from({ length: 12 }, (_, index) => index + 1);

function isFeatureOffApiError(error: unknown): boolean {
  return (
    error instanceof ApiError &&
    error.status === 404 &&
    typeof error.body === 'object' &&
    error.body !== null &&
    'error' in error.body &&
    (error.body as { error?: unknown }).error === 'feature_off'
  );
}

export function ClientesSection({
  mode,
  slot,
  timezone,
  crmEnabled,
  whatsappManualEnabled = false,
  colaboradorId,
}: ClientesSectionProps) {
  const toast = useToast();
  const [search, setSearch] = useState('');
  const deferredSearch = useDeferredValue(sanitizeClientesSearch(search));
  const [page, setPage] = useState(1);
  const [birthdayPage, setBirthdayPage] = useState(1);
  const [birthdayMode, setBirthdayMode] = useState<ClientesAniversariantesModo>('proximos');
  const [birthdayDays, setBirthdayDays] = useState<number>(30);
  const [birthdayMonth, setBirthdayMonth] = useState<number>(() => currentMonthInTimezone(timezone));
  const [rankingPage, setRankingPage] = useState(1);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [whatsAppTarget, setWhatsAppTarget] = useState<WhatsAppManualTarget | null>(null);
  const [forceUnavailable, setForceUnavailable] = useState(false);

  const ownerListQ = useClientes(
    slot,
    page,
    CLIENTES_PAGE_SIZE,
    deferredSearch,
    mode === 'owner' && crmEnabled && !forceUnavailable,
  );
  const colaboradorListQ = useColaboradorClientes(
    slot,
    colaboradorId ?? 0,
    page,
    CLIENTES_PAGE_SIZE,
    deferredSearch,
    mode === 'colaborador' && crmEnabled && !forceUnavailable,
  );
  const listQ = mode === 'owner' ? ownerListQ : colaboradorListQ;
  const birthdayWindowValue = birthdayMode === 'proximos' ? birthdayDays : birthdayMonth;
  const ownerBirthdaysQ = useClientesAniversariantes(
    slot,
    birthdayMode,
    birthdayWindowValue,
    birthdayPage,
    CLIENTES_ANIVERSARIANTES_PAGE_SIZE,
    mode === 'owner' && crmEnabled,
  );
  const colaboradorBirthdaysQ = useColaboradorClientesAniversariantes(
    slot,
    colaboradorId ?? 0,
    birthdayMode,
    birthdayWindowValue,
    birthdayPage,
    CLIENTES_ANIVERSARIANTES_PAGE_SIZE,
    mode === 'colaborador' && crmEnabled,
  );
  const birthdaysQ = mode === 'owner' ? ownerBirthdaysQ : colaboradorBirthdaysQ;
  const ownerRankingQ = useClientesSemRetorno(
    slot,
    rankingPage,
    CLIENTES_SEM_RETORNO_PAGE_SIZE,
    mode === 'owner' && crmEnabled,
  );
  const colaboradorRankingQ = useColaboradorClientesSemRetorno(
    slot,
    colaboradorId ?? 0,
    rankingPage,
    CLIENTES_SEM_RETORNO_PAGE_SIZE,
    mode === 'colaborador' && crmEnabled,
  );
  const rankingQ = mode === 'owner' ? ownerRankingQ : colaboradorRankingQ;
  const ownerProfileQ = useClientePerfil(
    slot,
    selectedId,
    mode === 'owner' && crmEnabled && !forceUnavailable,
  );
  const colaboradorProfileQ = useColaboradorClientePerfil(
    slot,
    colaboradorId ?? 0,
    selectedId,
    mode === 'colaborador' && crmEnabled && !forceUnavailable,
  );
  const profileQ = mode === 'owner' ? ownerProfileQ : colaboradorProfileQ;
  const saveCliente = useSaveCliente(slot);
  const sendWhatsApp = useEnviarWhatsappManual(slot);

  useEffect(() => {
    setPage(1);
    setBirthdayPage(1);
    setRankingPage(1);
  }, [deferredSearch]);

  useEffect(() => {
    setBirthdayPage(1);
  }, [birthdayMode, birthdayDays, birthdayMonth]);

  useEffect(() => {
    if (listQ.data?.available === false || profileQ.data?.available === false) {
      setForceUnavailable(true);
      setSelectedId(null);
    }
  }, [listQ.data?.available, profileQ.data?.available]);

  const unavailable = !crmEnabled || forceUnavailable || listQ.data?.available === false;

  const data = listQ.data;
  const items = data?.clientes ?? [];
  const total = data?.total ?? 0;
  const totalPages = clientesTotalPages(total, data?.limit ?? CLIENTES_PAGE_SIZE);
  const currentPage = clientesPageFromOffset(data?.offset ?? 0, data?.limit ?? CLIENTES_PAGE_SIZE);
  const de = total === 0 ? 0 : (data?.offset ?? 0) + 1;
  const ate = (data?.offset ?? 0) + items.length;
  const buscaAtiva = deferredSearch.length > 0;
  const birthdaysData = birthdaysQ.data;
  const birthdayItems = (birthdaysData?.clientes ?? []).filter((item) =>
    aniversarianteMatchesSearch(item, deferredSearch),
  );
  const birthdayTotal = birthdaysData?.total ?? 0;
  const birthdayTotalPages = clientesTotalPages(
    birthdayTotal,
    birthdaysData?.limit ?? CLIENTES_ANIVERSARIANTES_PAGE_SIZE,
  );
  const birthdayCurrentPage = clientesPageFromOffset(
    birthdaysData?.offset ?? 0,
    birthdaysData?.limit ?? CLIENTES_ANIVERSARIANTES_PAGE_SIZE,
  );
  const birthdayDe = birthdayTotal === 0 ? 0 : (birthdaysData?.offset ?? 0) + 1;
  const birthdayAte = (birthdaysData?.offset ?? 0) + (birthdaysData?.clientes.length ?? 0);
  const birthdaysAvailable = birthdaysData?.available !== false;
  const rankingData = rankingQ.data;
  const rankingItems = (rankingData?.clientes ?? []).filter((item) =>
    semRetornoMatchesSearch(item, deferredSearch),
  );
  const rankingTotal = rankingData?.total ?? 0;
  const rankingTotalPages = clientesTotalPages(
    rankingTotal,
    rankingData?.limit ?? CLIENTES_SEM_RETORNO_PAGE_SIZE,
  );
  const rankingCurrentPage = clientesPageFromOffset(
    rankingData?.offset ?? 0,
    rankingData?.limit ?? CLIENTES_SEM_RETORNO_PAGE_SIZE,
  );
  const rankingDe = rankingTotal === 0 ? 0 : (rankingData?.offset ?? 0) + 1;
  const rankingAte = (rankingData?.offset ?? 0) + (rankingData?.clientes.length ?? 0);
  const rankingAvailable = rankingData?.available !== false;

  return (
    <>
      <PageHead
        title="Clientes"
        subtitle={mode === 'owner' ? OWNER_SUBTITLE : COLABORADOR_SUBTITLE}
      />

      {unavailable ? (
        <UnavailableState mode={mode} />
      ) : (
        <>
          <div className="relative mb-3">
            <span className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-ink-faint">
              <IconSearch size={18} />
            </span>
            <input
              type="search"
              inputMode="search"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              aria-label="Buscar clientes por nome ou telefone"
              placeholder="Buscar por nome ou telefone"
              className="h-[46px] w-full rounded-field border-[1.5px] border-line-strong bg-surface-sunken pl-[42px] pr-3.5 text-[15px] text-ink outline-none transition-[border-color,box-shadow] duration-[120ms] placeholder:text-ink-faint hover:border-[var(--c-input-hover-border)] focus:border-brand focus:shadow-focus focus:ring-[3px] focus:ring-brand/35"
            />
          </div>

          {birthdaysAvailable && (
            <AniversariantesSection
              mode={mode}
              search={deferredSearch}
              birthdayMode={birthdayMode}
              birthdayDays={birthdayDays}
              birthdayMonth={birthdayMonth}
              query={birthdaysQ}
              items={birthdayItems}
              total={birthdayTotal}
              de={birthdayDe}
              ate={birthdayAte}
              currentPage={birthdayCurrentPage}
              totalPages={birthdayTotalPages}
              onModeChange={setBirthdayMode}
              onDaysChange={setBirthdayDays}
              onMonthChange={setBirthdayMonth}
              onPrevPage={() => setBirthdayPage((current) => Math.max(1, current - 1))}
              onNextPage={() =>
                setBirthdayPage((current) => Math.min(birthdayTotalPages, current + 1))
              }
              onOpen={(id) => setSelectedId(id)}
              manualWhatsAppEnabled={mode === 'owner' && whatsappManualEnabled}
              onSend={(target) => setWhatsAppTarget(target)}
            />
          )}

          {rankingAvailable && (
            <SemRetornoSection
              mode={mode}
              timezone={timezone}
              search={deferredSearch}
              query={rankingQ}
              items={rankingItems}
              total={rankingTotal}
              de={rankingDe}
              ate={rankingAte}
              currentPage={rankingCurrentPage}
              totalPages={rankingTotalPages}
              onPrevPage={() => setRankingPage((current) => Math.max(1, current - 1))}
              onNextPage={() =>
                setRankingPage((current) => Math.min(rankingTotalPages, current + 1))
              }
              onOpen={(id) => setSelectedId(id)}
              manualWhatsAppEnabled={mode === 'owner' && whatsappManualEnabled}
              onSend={(target) => setWhatsAppTarget(target)}
            />
          )}

          {listQ.isPending ? (
            <>
              <span className="sr-only">Carregando clientes…</span>
              <SkeletonList rows={6} />
            </>
          ) : listQ.isError || !data ? (
            <ErrorState
              title="Não foi possível carregar os clientes"
              onRetry={() => listQ.refetch()}
            />
          ) : items.length === 0 ? (
            buscaAtiva ? (
              <div className="rounded-card border border-line bg-surface px-6 py-10 text-center shadow-card">
                <h3 className="font-display text-[15px] font-semibold text-ink">
                  Nenhum resultado para "{deferredSearch}"
                </h3>
                <p className="mt-1 text-[13px] text-ink-soft">
                  Tente outro nome ou telefone, ou limpe a busca.
                </p>
              </div>
            ) : (
              <EmptyState
                icon={<IconUsers size={26} />}
                title={
                  mode === 'owner' ? 'Nenhum cliente por aqui ainda' : 'Nenhum cliente encontrado'
                }
                description={
                  mode === 'owner'
                    ? 'Assim que os atendimentos forem entrando, os perfis aparecem aqui para consulta e organização.'
                    : 'Quando você atender alguém, o perfil dessa pessoa aparece aqui para consulta.'
                }
              />
            )
          ) : (
            <>
              <div className="mb-3 flex items-center justify-between gap-3">
                <span className="text-[12.5px] tabular-nums text-ink-soft">
                  {de}–{ate} de {total} cliente{total === 1 ? '' : 's'}
                </span>
                {listQ.isFetching && (
                  <span className="text-[12px] text-ink-faint">Atualizando…</span>
                )}
              </div>

              <div className="overflow-hidden rounded-card border border-line bg-surface shadow-card">
                {items.map((item) => (
                  <ClienteRow
                    key={item.id}
                    item={item}
                    timezone={timezone}
                    mode={mode}
                    onOpen={() => setSelectedId(item.id)}
                  />
                ))}
              </div>

              {totalPages > 1 && (
                <div className="mt-3 flex items-center justify-between gap-3">
                  <span className="text-[12.5px] tabular-nums text-ink-soft">
                    Página {currentPage} de {totalPages}
                  </span>
                  <div className="flex items-center gap-2">
                    <PageBtn
                      label="Página anterior"
                      disabled={currentPage <= 1}
                      onClick={() => setPage((current) => Math.max(1, current - 1))}
                    >
                      <IconChevronLeft size={18} />
                    </PageBtn>
                    <PageBtn
                      label="Próxima página"
                      disabled={currentPage >= totalPages}
                      onClick={() => setPage((current) => Math.min(totalPages, current + 1))}
                    >
                      <IconChevronRight size={18} />
                    </PageBtn>
                  </div>
                </div>
              )}
            </>
          )}
        </>
      )}

      <ClienteDetailSheet
        open={selectedId != null}
        mode={mode}
        timezone={timezone}
        query={profileQ}
        onClose={() => setSelectedId(null)}
        onSave={(cliente, body) => {
          saveCliente.mutate(
            { id: cliente.id, body },
            {
              onSuccess: () => {
                toast.success('Perfil atualizado');
              },
              onError: (error) => {
                if (isFeatureOffApiError(error)) {
                  setForceUnavailable(true);
                  toast.error('CRM de clientes indisponível agora.');
                  return;
                }
                if (error instanceof ApiError && error.status === 400) {
                  toast.error('Confira os campos e tente de novo.');
                  return;
                }
                toast.error('Não foi possível salvar agora. Tente de novo.');
              },
            },
          );
        }}
        saving={saveCliente.isPending}
        manualWhatsAppEnabled={mode === 'owner' && whatsappManualEnabled}
        onSend={(cliente) =>
          setWhatsAppTarget({
            id: cliente.id,
            nome: clienteDisplayName(cliente.nome),
            telefoneMasked: clientePhoneMasked(cliente.telefone),
          })
        }
      />
      <WhatsAppManualDialog
        key={whatsAppTarget?.id ?? 'closed'}
        target={whatsAppTarget}
        onClose={() => setWhatsAppTarget(null)}
        onFeatureOff={() => {
          setWhatsAppTarget(null);
          toast.error('Envio manual indisponível agora.');
        }}
        onSend={async (id, mensagem) => {
          await sendWhatsApp.mutateAsync({ id, body: { mensagem, confirmed: true } });
        }}
      />
    </>
  );
}

function SemRetornoSection({
  mode,
  timezone,
  search,
  query,
  items,
  total,
  de,
  ate,
  currentPage,
  totalPages,
  onPrevPage,
  onNextPage,
  onOpen,
  manualWhatsAppEnabled,
  onSend,
}: {
  mode: Mode;
  timezone: string;
  search: string;
  query:
    | ReturnType<typeof useClientesSemRetorno>
    | ReturnType<typeof useColaboradorClientesSemRetorno>;
  items: ClienteSemRetornoItem[];
  total: number;
  de: number;
  ate: number;
  currentPage: number;
  totalPages: number;
  onPrevPage: () => void;
  onNextPage: () => void;
  onOpen: (id: string) => void;
  manualWhatsAppEnabled: boolean;
  onSend: (target: WhatsAppManualTarget) => void;
}) {
  const buscaAtiva = search.length > 0;

  return (
    <section className="mb-4">
      <div className="mb-3 flex items-start justify-between gap-3">
        <div>
          <h2 className="font-display text-[17px] font-semibold text-ink">Ranking sem retorno</h2>
          <p className="mt-1 max-w-[46rem] text-[13px] leading-snug text-ink-soft">
            {mode === 'owner' ? OWNER_RANKING_SUBTITLE : COLABORADOR_RANKING_SUBTITLE}
          </p>
        </div>
        <span className="shrink-0 rounded-pill border border-line bg-surface px-2.5 py-1 text-[11.5px] font-semibold text-ink-soft">
          Maior tempo primeiro
        </span>
      </div>

      {query.isPending ? (
        <>
          <span className="sr-only">Carregando ranking sem retorno…</span>
          <SkeletonList rows={4} />
        </>
      ) : query.isError || !query.data ? (
        <ErrorState
          title="Não foi possível carregar o ranking sem retorno"
          onRetry={() => query.refetch()}
        />
      ) : total === 0 ? (
        <EmptyState
          icon={<IconClock size={26} />}
          title="Nenhum cliente entrou nessa fila ainda"
          description="Quando houver atendimentos concluídos sem retorno, eles aparecem aqui em ordem de prioridade."
        />
      ) : items.length === 0 ? (
        <div className="rounded-card border border-line bg-surface px-6 py-8 text-center shadow-card">
          <h3 className="font-display text-[15px] font-semibold text-ink">
            Nenhum cliente desta página combina com "{search}"
          </h3>
          <p className="mt-1 text-[13px] text-ink-soft">
            A busca está filtrando a fila carregada agora. Limpe o termo ou avance a paginação.
          </p>
        </div>
      ) : (
        <>
          <div className="mb-3 flex items-center justify-between gap-3">
            <span className="text-[12.5px] tabular-nums text-ink-soft">
              {de}–{ate} de {total} cliente{total === 1 ? '' : 's'}
              {buscaAtiva
                ? ` · ${items.length} visível${items.length === 1 ? '' : 'is'} na busca`
                : ''}
            </span>
            {query.isFetching && <span className="text-[12px] text-ink-faint">Atualizando…</span>}
          </div>

          <div className="overflow-hidden rounded-card border border-line bg-surface shadow-card">
            {items.map((item) => (
              <SemRetornoRow
                key={item.id}
                item={item}
                timezone={timezone}
                mode={mode}
                onOpen={() => onOpen(item.id)}
                manualWhatsAppEnabled={manualWhatsAppEnabled}
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

          {totalPages > 1 && (
            <div className="mt-3 flex items-center justify-between gap-3">
              <span className="text-[12.5px] tabular-nums text-ink-soft">
                Página {currentPage} de {totalPages}
              </span>
              <div className="flex items-center gap-2">
                <PageBtn
                  label="Página anterior do ranking sem retorno"
                  disabled={currentPage <= 1}
                  onClick={onPrevPage}
                >
                  <IconChevronLeft size={18} />
                </PageBtn>
                <PageBtn
                  label="Próxima página do ranking sem retorno"
                  disabled={currentPage >= totalPages}
                  onClick={onNextPage}
                >
                  <IconChevronRight size={18} />
                </PageBtn>
              </div>
            </div>
          )}
        </>
      )}
    </section>
  );
}

function AniversariantesSection({
  mode,
  search,
  birthdayMode,
  birthdayDays,
  birthdayMonth,
  query,
  items,
  total,
  de,
  ate,
  currentPage,
  totalPages,
  onModeChange,
  onDaysChange,
  onMonthChange,
  onPrevPage,
  onNextPage,
  onOpen,
  manualWhatsAppEnabled,
  onSend,
}: {
  mode: Mode;
  search: string;
  birthdayMode: ClientesAniversariantesModo;
  birthdayDays: number;
  birthdayMonth: number;
  query:
    | ReturnType<typeof useClientesAniversariantes>
    | ReturnType<typeof useColaboradorClientesAniversariantes>;
  items: ClienteAniversarianteItem[];
  total: number;
  de: number;
  ate: number;
  currentPage: number;
  totalPages: number;
  onModeChange: (mode: ClientesAniversariantesModo) => void;
  onDaysChange: (days: number) => void;
  onMonthChange: (month: number) => void;
  onPrevPage: () => void;
  onNextPage: () => void;
  onOpen: (id: string) => void;
  manualWhatsAppEnabled: boolean;
  onSend: (target: WhatsAppManualTarget) => void;
}) {
  const buscaAtiva = search.length > 0;

  return (
    <section className="mb-4">
      <div className="mb-3 flex items-start justify-between gap-3">
        <div>
          <h2 className="font-display text-[17px] font-semibold text-ink">Aniversariantes</h2>
          <p className="mt-1 max-w-[46rem] text-[13px] leading-snug text-ink-soft">
            {mode === 'owner' ? OWNER_BIRTHDAY_SUBTITLE : COLABORADOR_BIRTHDAY_SUBTITLE}
          </p>
        </div>
        <span className="shrink-0 rounded-pill border border-line bg-surface px-2.5 py-1 text-[11.5px] font-semibold text-ink-soft">
          Read-only
        </span>
      </div>

      <div className="mb-3 rounded-card border border-line bg-surface px-3.5 py-3 shadow-card">
        <div className="flex flex-wrap gap-2">
          <ModeBtn
            active={birthdayMode === 'proximos'}
            onClick={() => onModeChange('proximos')}
            label="Próximos dias"
          />
          <ModeBtn
            active={birthdayMode === 'mes'}
            onClick={() => onModeChange('mes')}
            label="Por mês"
          />
        </div>
        <div className="mt-3 flex flex-col gap-2 sm:flex-row">
          {birthdayMode === 'proximos' ? (
            <div className="flex min-w-0 flex-1 flex-col gap-[7px]">
              <label className="text-[13px] font-semibold text-ink">Janela</label>
              <select
                value={birthdayDays}
                onChange={(event) => onDaysChange(Number(event.target.value))}
                className="h-[44px] rounded-field border-[1.5px] border-line-strong bg-surface-sunken px-3 text-[15px] text-ink outline-none transition-[border-color,box-shadow] duration-[120ms] hover:border-[var(--c-input-hover-border)] focus:border-brand focus:ring-[3px] focus:ring-brand/35"
              >
                {ANIVERSARIANTE_DAY_OPTIONS.map((days) => (
                  <option key={days} value={days}>
                    Próximos {days} dias
                  </option>
                ))}
              </select>
            </div>
          ) : (
            <div className="flex min-w-0 flex-1 flex-col gap-[7px]">
              <label className="text-[13px] font-semibold text-ink">Mês</label>
              <select
                value={birthdayMonth}
                onChange={(event) => onMonthChange(Number(event.target.value))}
                className="h-[44px] rounded-field border-[1.5px] border-line-strong bg-surface-sunken px-3 text-[15px] text-ink outline-none transition-[border-color,box-shadow] duration-[120ms] hover:border-[var(--c-input-hover-border)] focus:border-brand focus:ring-[3px] focus:ring-brand/35"
              >
                {MONTH_OPTIONS.map((month) => (
                  <option key={month} value={month}>
                    {monthName(month)}
                  </option>
                ))}
              </select>
            </div>
          )}
        </div>
      </div>

      {query.isPending ? (
        <>
          <span className="sr-only">Carregando aniversariantes…</span>
          <SkeletonList rows={4} />
        </>
      ) : query.isError || !query.data ? (
        <ErrorState title="Não foi possível carregar os aniversariantes" onRetry={() => query.refetch()} />
      ) : total === 0 ? (
        <EmptyState
          icon={<IconCalendar size={26} />}
          title="Nenhum aniversário cadastrado nessa faixa"
          description="Os aniversários preenchidos no perfil CRM aparecem aqui, sem envio automático nem exportação."
        />
      ) : items.length === 0 ? (
        <div className="rounded-card border border-line bg-surface px-6 py-8 text-center shadow-card">
          <h3 className="font-display text-[15px] font-semibold text-ink">
            Nenhum aniversariante desta página combina com "{search}"
          </h3>
          <p className="mt-1 text-[13px] text-ink-soft">
            A busca está filtrando a página carregada agora. Limpe o termo ou avance a paginação.
          </p>
        </div>
      ) : (
        <>
          <div className="mb-3 flex items-center justify-between gap-3">
            <span className="text-[12.5px] tabular-nums text-ink-soft">
              {de}–{ate} de {total} cliente{total === 1 ? '' : 's'}
              {buscaAtiva ? ` · ${items.length} visível${items.length === 1 ? '' : 'is'} na busca` : ''}
            </span>
            {query.isFetching && <span className="text-[12px] text-ink-faint">Atualizando…</span>}
          </div>

          <div className="overflow-hidden rounded-card border border-line bg-surface shadow-card">
            {items.map((item) => (
              <AniversarianteRow
                key={item.id}
                item={item}
                mode={birthdayMode}
                selectedMonth={birthdayMonth}
                onOpen={() => onOpen(item.id)}
                manualWhatsAppEnabled={manualWhatsAppEnabled}
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

          {totalPages > 1 && (
            <div className="mt-3 flex items-center justify-between gap-3">
              <span className="text-[12.5px] tabular-nums text-ink-soft">
                Página {currentPage} de {totalPages}
              </span>
              <div className="flex items-center gap-2">
                <PageBtn
                  label="Página anterior dos aniversariantes"
                  disabled={currentPage <= 1}
                  onClick={onPrevPage}
                >
                  <IconChevronLeft size={18} />
                </PageBtn>
                <PageBtn
                  label="Próxima página dos aniversariantes"
                  disabled={currentPage >= totalPages}
                  onClick={onNextPage}
                >
                  <IconChevronRight size={18} />
                </PageBtn>
              </div>
            </div>
          )}
        </>
      )}
    </section>
  );
}

function ModeBtn({
  active,
  label,
  onClick,
}: {
  active: boolean;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'rounded-pill border px-3 py-1.5 text-[12.5px] font-semibold transition-colors',
        active
          ? 'border-brand bg-brand-soft text-brand'
          : 'border-line bg-surface text-ink-soft hover:bg-surface-hover hover:text-ink',
      )}
    >
      {label}
    </button>
  );
}

function ClienteRow({
  item,
  timezone,
  mode,
  onOpen,
}: {
  item: ClienteListItem;
  timezone: string;
  mode: Mode;
  onOpen: () => void;
}) {
  const nome = clienteDisplayName(item.nome);
  const ultimaData = item.ultima_interacao_at
    ? `${formatAgendamentoDia(item.ultima_interacao_at, undefined, timezone)}${
        formatAgendamentoHora(item.ultima_interacao_at, timezone)
          ? ` · ${formatAgendamentoHora(item.ultima_interacao_at, timezone)}`
          : ''
      }`
    : 'Sem histórico';

  return (
    <button
      type="button"
      onClick={onOpen}
      className="group flex w-full items-start gap-3.5 border-b border-line-soft px-[15px] py-3.5 text-left transition-colors last:border-b-0 hover:bg-surface-hover focus-visible:bg-surface-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand"
    >
      <span className="flex size-[42px] shrink-0 items-center justify-center rounded-[12px] bg-brand-soft font-display text-[14px] font-bold text-brand">
        {initials(nome)}
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="truncate font-display text-[15px] font-semibold text-ink">{nome}</div>
            <div className="mt-0.5 truncate text-[12.5px] text-ink-soft">
              {clientePhoneMasked(item.telefone)}
            </div>
          </div>
          <span className="shrink-0 rounded-pill border border-line bg-surface-sunken px-2.5 py-1 text-[11.5px] font-semibold text-ink-soft">
            {item.total_atendimentos} atendimento{item.total_atendimentos === 1 ? '' : 's'}
          </span>
        </div>
        <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-[12.5px] text-ink-soft">
          <span>{ultimaData}</span>
          {item.cidade && <span>{item.cidade}</span>}
          {mode === 'owner' && item.ultimo_profissional_nome && (
            <span>Último com {item.ultimo_profissional_nome}</span>
          )}
        </div>
      </div>
    </button>
  );
}

function AniversarianteRow({
  item,
  mode,
  selectedMonth,
  onOpen,
  manualWhatsAppEnabled,
  onSend,
}: {
  item: ClienteAniversarianteItem;
  mode: ClientesAniversariantesModo;
  selectedMonth: number;
  onOpen: () => void;
  manualWhatsAppEnabled: boolean;
  onSend: () => void;
}) {
  const nome = clienteDisplayName(item.nome);

  return (
    <div className="group flex items-start gap-3.5 border-b border-line-soft px-[15px] py-3.5 last:border-b-0">
      <span className="flex size-[42px] shrink-0 items-center justify-center rounded-[12px] bg-brand-soft font-display text-[14px] font-bold text-brand">
        {initials(nome)}
      </span>
      <button
        type="button"
        onClick={onOpen}
        className="min-w-0 flex-1 text-left outline-none transition-colors group-hover:text-brand focus-visible:rounded-field focus-visible:ring-2 focus-visible:ring-brand"
      >
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="truncate font-display text-[15px] font-semibold text-ink">{nome}</div>
            <div className="mt-0.5 truncate text-[12.5px] text-ink-soft">
              {item.telefone_masked}
            </div>
          </div>
          <span className="shrink-0 rounded-pill border border-line bg-surface-sunken px-2.5 py-1 text-[11.5px] font-semibold text-ink-soft">
            {aniversarianteDiasLabel(item.dias_ate_aniversario)}
          </span>
        </div>
        <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-[12.5px] text-ink-soft">
          <span>{aniversarianteFaixaLabel(mode, item.dias_ate_aniversario, selectedMonth)}</span>
          <span>Aniversário em {aniversarianteOccurrenceLabel(item)}</span>
          <span>{birthdayLabel(item.aniversario_mmdd) ?? 'Data inválida'}</span>
        </div>
      </button>
      {manualWhatsAppEnabled && (
        <button
          type="button"
          onClick={onSend}
          aria-label={`Enviar WhatsApp para ${nome}`}
          className="flex size-11 shrink-0 items-center justify-center self-center rounded-btn border border-line-strong text-brand hover:bg-brand-soft focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
        >
          <IconSend size={18} />
        </button>
      )}
    </div>
  );
}

function SemRetornoRow({
  item,
  timezone,
  mode,
  onOpen,
  manualWhatsAppEnabled,
  onSend,
}: {
  item: ClienteSemRetornoItem;
  timezone: string;
  mode: Mode;
  onOpen: () => void;
  manualWhatsAppEnabled: boolean;
  onSend: () => void;
}) {
  const nome = clienteDisplayName(item.nome);
  const ultimoAtendimento = item.ultimo_atendimento_at
    ? `${formatAgendamentoDia(item.ultimo_atendimento_at, undefined, timezone)}${
        formatAgendamentoHora(item.ultimo_atendimento_at, timezone)
          ? ` · ${formatAgendamentoHora(item.ultimo_atendimento_at, timezone)}`
          : ''
      }`
    : 'Data indisponível';

  return (
    <div className="group flex items-start gap-3.5 border-b border-line-soft px-[15px] py-3.5 last:border-b-0">
      <span className="flex size-[42px] shrink-0 items-center justify-center rounded-[12px] bg-brand-soft font-display text-[14px] font-bold text-brand">
        {initials(nome)}
      </span>
      <button
        type="button"
        onClick={onOpen}
        className="min-w-0 flex-1 text-left outline-none transition-colors group-hover:text-brand focus-visible:rounded-field focus-visible:ring-2 focus-visible:ring-brand"
      >
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="truncate font-display text-[15px] font-semibold text-ink">{nome}</div>
            <div className="mt-0.5 truncate text-[12.5px] text-ink-soft">
              {item.telefone_masked}
            </div>
          </div>
          <span className="shrink-0 rounded-pill border border-line bg-surface-sunken px-2.5 py-1 text-[11.5px] font-semibold text-ink-soft">
            {semRetornoDiasLabel(item.dias_sem_retorno)}
          </span>
        </div>
        <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-[12.5px] text-ink-soft">
          <span>{semRetornoFaixaLabel(item.dias_sem_retorno)}</span>
          <span>Último atendimento {ultimoAtendimento}</span>
          {mode === 'owner' && item.ultimo_profissional_nome && (
            <span>Último com {item.ultimo_profissional_nome}</span>
          )}
        </div>
      </button>
      {manualWhatsAppEnabled && (
        <button
          type="button"
          onClick={onSend}
          aria-label={`Enviar WhatsApp para ${nome}`}
          className="flex size-11 shrink-0 items-center justify-center self-center rounded-btn border border-line-strong text-brand hover:bg-brand-soft focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
        >
          <IconSend size={18} />
        </button>
      )}
    </div>
  );
}

function ClienteDetailSheet({
  open,
  mode,
  timezone,
  query,
  onClose,
  onSave,
  saving,
  manualWhatsAppEnabled,
  onSend,
}: {
  open: boolean;
  mode: Mode;
  timezone: string;
  query: ReturnType<typeof useClientePerfil> | ReturnType<typeof useColaboradorClientePerfil>;
  onClose: () => void;
  onSave: (cliente: ClientePerfil, body: SaveClienteBody) => void;
  saving: boolean;
  manualWhatsAppEnabled: boolean;
  onSend: (cliente: ClientePerfil) => void;
}) {
  const [draft, setDraft] = useState<ReturnType<typeof clienteDraftFromPerfil> | null>(null);

  useEffect(() => {
    if (query.data?.cliente) setDraft(clienteDraftFromPerfil(query.data.cliente));
    if (!open) setDraft(null);
  }, [query.data?.cliente, open]);

  const cliente = query.data?.cliente ?? null;
  const canEdit = mode === 'owner' && cliente != null && draft != null;
  const historico = query.data?.historico ?? [];
  const dirty = cliente && draft ? clienteDraftChanged(cliente, draft) : false;
  const body = draft ? buildClientePatchBody(draft) : null;

  return (
    <Overlay open={open} onClose={onClose} variant="detail" ariaLabel="Perfil do cliente">
      <div className="flex min-h-0 flex-1 flex-col px-5 pt-3.5">
        <div className="sticky top-0 z-10 -mx-5 mb-3 flex items-center gap-2 bg-surface-elev px-5 pb-3 pt-[max(2px,env(safe-area-inset-top))]">
          <button
            type="button"
            onClick={onClose}
            aria-label="Fechar"
            className="flex size-9 shrink-0 items-center justify-center rounded-[10px] border border-line-strong bg-surface text-ink-soft outline-none transition-colors hover:bg-surface-hover hover:text-ink focus-visible:ring-2 focus-visible:ring-brand"
          >
            <IconX size={18} />
          </button>
          <h2 className="font-display text-[17px] font-semibold text-ink">Perfil do cliente</h2>
          {mode === 'owner' && (
            <span className="ml-auto inline-flex items-center gap-1 rounded-pill border border-line bg-surface px-2.5 py-1 text-[11.5px] font-semibold text-ink-soft">
              <IconPencil size={12} />
              Editável
            </span>
          )}
        </div>

        {query.isPending ? (
          <div className="pb-6">
            <span className="sr-only">Carregando perfil do cliente…</span>
            <SkeletonList rows={5} />
          </div>
        ) : query.isError ? (
          <ErrorState title="Não foi possível carregar o perfil" onRetry={() => query.refetch()} />
        ) : !cliente || !draft ? (
          <div className="pb-6">
            <ErrorState
              title="Cliente não encontrado"
              description="Esse perfil não está mais disponível para consulta."
            />
            <div className="mt-3">
              <Button variant="secondary" onClick={onClose}>
                Fechar
              </Button>
            </div>
          </div>
        ) : (
          <>
            <div className="pb-4">
              <p className="font-display text-[20px] font-bold leading-tight tracking-[-0.01em] text-ink">
                {clienteDisplayName(cliente.nome)}
              </p>
              <dl className="mt-3 space-y-2.5">
                <InfoRow
                  icon={<IconUser size={16} />}
                  label="Telefone"
                  value={formatPhoneDisplay(cliente.telefone)}
                />
                <InfoRow
                  icon={<IconCalendar size={16} />}
                  label="Aniversário"
                  value={birthdayLabel(cliente.aniversario_mmdd) ?? 'Não informado'}
                />
                <InfoRow
                  icon={<IconClock size={16} />}
                  label="Último atendimento"
                  value={
                    cliente.ultima_interacao_at
                      ? `${formatAgendamentoDia(cliente.ultima_interacao_at, undefined, timezone)}${
                          formatAgendamentoHora(cliente.ultima_interacao_at, timezone)
                            ? ` · ${formatAgendamentoHora(cliente.ultima_interacao_at, timezone)}`
                            : ''
                        }`
                      : 'Sem histórico'
                  }
                />
              </dl>
              {manualWhatsAppEnabled && mode === 'owner' && (
                <div className="mt-4">
                  <Button variant="secondary" size="inline" onClick={() => onSend(cliente)}>
                    <IconSend size={17} />
                    Enviar WhatsApp
                  </Button>
                </div>
              )}
            </div>

            <div className="border-t border-line pt-4">
              <h3 className="font-display text-[15px] font-semibold text-ink">
                {mode === 'owner' ? 'Dados do perfil' : 'Dados do perfil visíveis pra você'}
              </h3>
              <div className="mt-3 space-y-3.5">
                {mode === 'owner' ? (
                  <>
                    <Input
                      label="Aniversário"
                      type="date"
                      className="[color-scheme:dark]"
                      value={birthdayToDateInput(draft.aniversario_mmdd)}
                      onChange={(event) =>
                        setDraft((current) =>
                          current
                            ? {
                                ...current,
                                aniversario_mmdd: birthdayFromDateInput(event.target.value),
                              }
                            : current,
                        )
                      }
                    />
                    <Input
                      label="Cidade"
                      value={draft.cidade}
                      maxLength={80}
                      placeholder="Ex.: Itajubá"
                      onChange={(event) =>
                        setDraft((current) =>
                          current ? { ...current, cidade: event.target.value } : current,
                        )
                      }
                    />
                    <TextArea
                      label="Nota interna"
                      value={draft.nota_interna}
                      maxLength={2000}
                      placeholder="Observações internas sobre esse cliente"
                      onChange={(value) =>
                        setDraft((current) =>
                          current ? { ...current, nota_interna: value } : current,
                        )
                      }
                    />
                  </>
                ) : (
                  <>
                    <StaticField label="Cidade" value={cliente.cidade || 'Não informada'} />
                    <StaticField
                      label="Aniversário"
                      value={birthdayLabel(cliente.aniversario_mmdd) ?? 'Não informado'}
                    />
                  </>
                )}
              </div>
            </div>

            <div className="border-t border-line pt-4">
              <div className="flex items-center justify-between gap-3">
                <h3 className="font-display text-[15px] font-semibold text-ink">Histórico</h3>
                <span className="text-[12.5px] text-ink-soft">
                  {cliente.total_atendimentos} atendimento
                  {cliente.total_atendimentos === 1 ? '' : 's'}
                </span>
              </div>

              {historico.length === 0 ? (
                <p className="mt-3 text-[13.5px] leading-snug text-ink-soft">
                  Ainda não há atendimentos para mostrar nesse perfil.
                </p>
              ) : (
                <div className="mt-3 divide-y divide-line border-t border-line">
                  {historico.map((item) => {
                    const quando = item.inicio_at
                      ? `${formatAgendamentoDia(item.inicio_at, undefined, timezone)}${
                          formatAgendamentoHora(item.inicio_at, timezone)
                            ? ` · ${formatAgendamentoHora(item.inicio_at, timezone)}`
                            : ''
                        }`
                      : item.data;
                    return (
                      <div key={item.atendimento_id} className="py-3">
                        <div className="flex items-start justify-between gap-3">
                          <div className="min-w-0">
                            <p className="truncate font-display text-[14px] font-semibold text-ink">
                              {item.servico_nome || 'Serviço não informado'}
                            </p>
                            <p className="mt-0.5 text-[12.5px] text-ink-soft">{quando}</p>
                          </div>
                          {item.status && (
                            <span className="shrink-0 rounded-pill border border-line bg-surface px-2.5 py-1 text-[11px] font-semibold uppercase tracking-[0.04em] text-ink-soft">
                              {item.status}
                            </span>
                          )}
                        </div>
                        {item.profissional_nome && (
                          <p className="mt-1.5 text-[12.5px] text-ink-soft">
                            Profissional: {item.profissional_nome}
                          </p>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>

            {canEdit && body && (
              <div className="sticky bottom-0 mt-5 -mx-5 border-t border-line bg-surface-elev px-5 pb-[calc(14px+env(safe-area-inset-bottom))] pt-3">
                <Button disabled={!dirty || saving} onClick={() => onSave(cliente, body)}>
                  {saving ? 'Salvando…' : 'Salvar perfil'}
                </Button>
              </div>
            )}
          </>
        )}
      </div>
    </Overlay>
  );
}

function InfoRow({
  icon,
  label,
  value,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
}) {
  return (
    <div className="flex items-start gap-2.5">
      <span className="mt-0.5 text-ink-faint">{icon}</span>
      <div>
        <dt className="text-[12px] font-semibold uppercase tracking-[0.04em] text-ink-faint">
          {label}
        </dt>
        <dd className="text-[13.5px] leading-snug text-ink">{value}</dd>
      </div>
    </div>
  );
}

function StaticField({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-[12px] font-semibold uppercase tracking-[0.04em] text-ink-faint">
        {label}
      </p>
      <p className="mt-1 text-[13.5px] leading-snug text-ink">{value}</p>
    </div>
  );
}

function TextArea({
  label,
  value,
  placeholder,
  maxLength,
  onChange,
}: {
  label: string;
  value: string;
  placeholder?: string;
  maxLength?: number;
  onChange: (value: string) => void;
}) {
  const id = `ta-${label.toLowerCase().replace(/[^a-z]+/g, '-')}`;
  return (
    <div className="flex w-full flex-col gap-[7px]">
      <label htmlFor={id} className="text-[13px] font-semibold text-ink">
        {label}
      </label>
      <textarea
        id={id}
        rows={4}
        value={value}
        maxLength={maxLength}
        placeholder={placeholder}
        onChange={(event) => onChange(event.target.value)}
        className="w-full resize-y rounded-field border-[1.5px] border-line-strong bg-surface-sunken px-3.5 py-3 text-[15px] leading-snug text-ink outline-none transition-[border-color,box-shadow] duration-[120ms] placeholder:text-ink-faint hover:border-[var(--c-input-hover-border)] focus:border-brand focus:ring-[3px] focus:ring-brand/35 focus:shadow-focus"
      />
    </div>
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
      className={cn(
        'flex size-10 items-center justify-center rounded-[11px] border border-line-strong bg-surface text-ink-soft outline-none transition-colors hover:bg-surface-hover hover:text-ink focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-2 focus-visible:ring-offset-bg',
        disabled && 'cursor-not-allowed opacity-40',
      )}
    >
      {children}
    </button>
  );
}

function UnavailableState({ mode }: { mode: Mode }) {
  return (
    <ErrorState
      title="CRM de clientes indisponível agora"
      description={
        mode === 'owner'
          ? 'Essa área ainda não está liberada para a sua conta.'
          : 'Essa área ainda não está liberada para o seu acesso.'
      }
      secondaryAction={{
        label: mode === 'owner' ? 'Voltar ao início' : 'Voltar à agenda',
        href: mode === 'owner' ? '/inicio' : '/colaborador/agenda',
      }}
    />
  );
}
