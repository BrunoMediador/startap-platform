'use client';

import { IconAlert, IconCalendar, IconClock, IconPause, IconTrash } from '@/components/icons';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { Skeleton } from '@/components/ui/skeleton';
import { ErrorState } from '@/components/ui/states';
import { useToast } from '@/components/ui/toast';
import {
  BLOQUEIO_TIPO_LABEL,
  defaultBloqueioFormValues,
  zonedDateTimeToUtcIso,
} from '@/lib/agenda-bloqueios';
import { ApiError } from '@/lib/api';
import type { AgendaBloqueio, AgendaBloqueioInput, AgendaBloqueioTipo } from '@/lib/api-types';
import { cn } from '@/lib/cn';
import { formatAgendamentoDia, formatAgendamentoHora } from '@/lib/format';
import {
  useAgendaBloqueios,
  useColaboradorBloqueios,
  useCriarAgendaBloqueio,
  useCriarColaboradorBloqueio,
  useEquipe,
  useRemoverAgendaBloqueio,
  useRemoverColaboradorBloqueio,
} from '@/lib/queries';
import { useId, useMemo, useState } from 'react';

type ScopeMode = 'owner' | 'colaborador';

interface AgendaBloqueiosSectionProps {
  mode: ScopeMode;
  slot: string;
  timeZone: string;
  isEstabelecimento?: boolean;
  colaboradorId?: number;
}

interface FormState {
  colaboradorId: string;
  tipo: AgendaBloqueioTipo;
  motivo: string;
  inicioData: string;
  inicioHora: string;
  fimData: string;
  fimHora: string;
}

interface FormErrors {
  colaborador?: string;
  inicio?: string;
  fim?: string;
}

interface ProfissionalOption {
  id: number;
  nome: string;
}

const DEFAULT_TIPO: AgendaBloqueioTipo = 'almoco';

function buildFormState(timeZone: string, defaultColaboradorId = ''): FormState {
  const defaults = defaultBloqueioFormValues(timeZone);
  return {
    colaboradorId: defaultColaboradorId,
    tipo: DEFAULT_TIPO,
    motivo: '',
    inicioData: defaults.inicioData,
    inicioHora: defaults.inicioHora,
    fimData: defaults.fimData,
    fimHora: defaults.fimHora,
  };
}

function tipoTone(tipo: AgendaBloqueioTipo): string {
  if (tipo === 'almoco') return 'border-amber-400/35 bg-amber-400/12 text-amber-200';
  if (tipo === 'ausencia') return 'border-line-strong bg-surface-sunken text-ink-soft';
  if (tipo === 'ferias') return 'border-brand/35 bg-brand-soft text-brand';
  return 'border-danger/35 bg-danger/12 text-danger';
}

function blockRangeLabel(bloqueio: AgendaBloqueio, timeZone: string): string {
  const inicioDia = formatAgendamentoDia(bloqueio.inicio_at, undefined, timeZone);
  const inicioHora = formatAgendamentoHora(bloqueio.inicio_at, timeZone);
  const fimDia = formatAgendamentoDia(bloqueio.fim_at, undefined, timeZone);
  const fimHora = formatAgendamentoHora(bloqueio.fim_at, timeZone);
  if (inicioDia === fimDia) return `${inicioDia} · ${inicioHora} - ${fimHora}`;
  return `${inicioDia} ${inicioHora} ate ${fimDia} ${fimHora}`;
}

function createErrorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    const code =
      error.body && typeof error.body === 'object' && 'error' in error.body
        ? (error.body as { error?: unknown }).error
        : null;
    if (code === 'feature_off') return 'Bloqueio de agenda indisponivel agora.';
    if (code === 'gcal_nao_configurado') return 'A agenda ainda nao esta conectada.';
    if (code === 'colaborador_nao_encontrado') return 'Escolha um profissional valido.';
    if (code === 'payload_invalido') return 'Confira as datas e tente de novo.';
    return 'Nao foi possivel salvar o bloqueio. Tente de novo.';
  }
  return 'Nao foi possivel salvar o bloqueio. Tente de novo.';
}

function removeErrorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    const code =
      error.body && typeof error.body === 'object' && 'error' in error.body
        ? (error.body as { error?: unknown }).error
        : null;
    if (code === 'feature_off') return 'Bloqueio de agenda indisponivel agora.';
    if (code === 'bloqueio_nao_encontrado') return 'Esse bloqueio ja nao esta mais aqui.';
    if (code === 'gcal_nao_configurado') return 'A agenda ainda nao esta conectada.';
    return 'Nao foi possivel remover o bloqueio. Tente de novo.';
  }
  return 'Nao foi possivel remover o bloqueio. Tente de novo.';
}

export function AgendaBloqueiosSection({
  mode,
  slot,
  timeZone,
  isEstabelecimento = false,
  colaboradorId,
}: AgendaBloqueiosSectionProps) {
  const toast = useToast();
  const canPickProfissional = mode === 'owner' && isEstabelecimento;
  const equipeQ = useEquipe(canPickProfissional ? slot : '', canPickProfissional);
  const profissionais = useMemo<ProfissionalOption[]>(
    () =>
      ((equipeQ.data?.colaboradores ?? []) as ProfissionalOption[])
        .filter((item) => typeof item.id === 'number')
        .map((item) => ({ id: item.id, nome: item.nome })),
    [equipeQ.data?.colaboradores],
  );
  const defaultProfissionalId =
    canPickProfissional && profissionais.length === 1 ? String(profissionais[0]?.id ?? '') : '';

  const ownerQ = useAgendaBloqueios(slot, null, mode === 'owner');
  const colaboradorQ = useColaboradorBloqueios(
    slot,
    colaboradorId ?? 0,
    mode === 'colaborador' && typeof colaboradorId === 'number',
  );
  const bloqueiosQ = mode === 'colaborador' ? colaboradorQ : ownerQ;

  const ownerCreate = useCriarAgendaBloqueio(slot);
  const ownerRemove = useRemoverAgendaBloqueio(slot);
  const colaboradorCreate = useCriarColaboradorBloqueio(slot, colaboradorId ?? 0);
  const colaboradorRemove = useRemoverColaboradorBloqueio(slot, colaboradorId ?? 0);
  const createMutation = mode === 'colaborador' ? colaboradorCreate : ownerCreate;
  const removeMutation = mode === 'colaborador' ? colaboradorRemove : ownerRemove;

  const [openForm, setOpenForm] = useState(false);
  const [form, setForm] = useState<FormState>(() =>
    buildFormState(timeZone, defaultProfissionalId),
  );
  const [errors, setErrors] = useState<FormErrors>({});
  const [confirmRemove, setConfirmRemove] = useState<AgendaBloqueio | null>(null);
  const motivoId = useId();

  const nomeByProfissionalId = useMemo(
    () => new Map(profissionais.map((item) => [item.id, item.nome])),
    [profissionais],
  );

  function resetForm() {
    setForm(buildFormState(timeZone, defaultProfissionalId));
    setErrors({});
  }

  function abrirFormulario() {
    resetForm();
    setOpenForm(true);
  }

  function fecharFormulario() {
    setOpenForm(false);
    setErrors({});
  }

  function submit() {
    const nextErrors: FormErrors = {};
    if (canPickProfissional && !form.colaboradorId) {
      nextErrors.colaborador = 'Escolha um profissional.';
    }
    if (!form.inicioData || !form.inicioHora) {
      nextErrors.inicio = 'Preencha o inicio.';
    }
    if (!form.fimData || !form.fimHora) {
      nextErrors.fim = 'Preencha o fim.';
    }
    if (Object.keys(nextErrors).length > 0) {
      setErrors(nextErrors);
      return;
    }

    const inicioAt = zonedDateTimeToUtcIso(form.inicioData, form.inicioHora, timeZone);
    const fimAt = zonedDateTimeToUtcIso(form.fimData, form.fimHora, timeZone);
    if (!inicioAt || !fimAt) {
      setErrors({
        inicio: !inicioAt ? 'Horario invalido.' : undefined,
        fim: !fimAt ? 'Horario invalido.' : undefined,
      });
      return;
    }
    if (new Date(fimAt).getTime() <= new Date(inicioAt).getTime()) {
      setErrors({ fim: 'O fim precisa ficar depois do inicio.' });
      return;
    }

    const body: AgendaBloqueioInput = {
      inicio_at: inicioAt,
      fim_at: fimAt,
      timezone: timeZone,
      tipo: form.tipo,
      motivo: form.motivo.trim() || undefined,
      colaborador_id: canPickProfissional ? Number(form.colaboradorId) : undefined,
    };

    createMutation.mutate(body, {
      onSuccess: () => {
        toast.success('Bloqueio criado');
        resetForm();
        setOpenForm(false);
      },
      onError: (error) => toast.error(createErrorMessage(error)),
    });
  }

  function removeBloqueio(id: string) {
    removeMutation.mutate(id, {
      onSuccess: () => {
        toast.success('Bloqueio removido');
        setConfirmRemove(null);
      },
      onError: (error) => {
        setConfirmRemove(null);
        toast.error(removeErrorMessage(error));
      },
    });
  }

  if (bloqueiosQ.isPending || (canPickProfissional && equipeQ.isPending)) {
    return (
      <section className="overflow-hidden rounded-card border border-line bg-surface shadow-card">
        <div className="flex items-center gap-3 p-4 sm:p-5">
          <Skeleton className="size-11 rounded-[14px]" />
          <div className="min-w-0 flex-1 space-y-2">
            <Skeleton className="h-4 w-40" />
            <Skeleton className="h-3 w-56" />
          </div>
          <Skeleton className="h-11 w-32 rounded-btn" />
        </div>
        <div className="border-t border-line-soft px-4 py-4 sm:px-5">
          <div className="space-y-3">
            <Skeleton className="h-12 w-full" />
            <Skeleton className="h-12 w-full" />
          </div>
        </div>
      </section>
    );
  }

  if (bloqueiosQ.isError || (canPickProfissional && equipeQ.isError)) {
    return (
      <section className="overflow-hidden rounded-card border border-line bg-surface shadow-card">
        <SectionHeader count={0} onToggle={abrirFormulario} openForm={false} mode={mode} disabled />
        <div className="border-t border-line-soft">
          <ErrorState
            title="Nao foi possivel carregar os bloqueios"
            onRetry={() => {
              void bloqueiosQ.refetch();
              if (canPickProfissional) void equipeQ.refetch();
            }}
          />
        </div>
      </section>
    );
  }

  if (!bloqueiosQ.data?.available) return null;

  const bloqueios = bloqueiosQ.data.bloqueios;

  return (
    <section className="overflow-hidden rounded-card border border-line bg-surface shadow-card">
      <SectionHeader
        count={bloqueios.length}
        onToggle={openForm ? fecharFormulario : abrirFormulario}
        openForm={openForm}
        mode={mode}
      />

      {openForm && (
        <div className="border-t border-line-soft px-4 py-4 sm:px-5">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            {canPickProfissional && (
              <SelectField
                label="Profissional"
                value={form.colaboradorId}
                onChange={(value) => {
                  setForm((current) => ({ ...current, colaboradorId: value }));
                  if (errors.colaborador)
                    setErrors((current) => ({ ...current, colaborador: undefined }));
                }}
                error={errors.colaborador}
              >
                <option value="">Escolher</option>
                {profissionais.map((item) => (
                  <option key={item.id} value={String(item.id)}>
                    {item.nome}
                  </option>
                ))}
              </SelectField>
            )}

            <SelectField
              label="Tipo"
              value={form.tipo}
              onChange={(value) =>
                setForm((current) => ({ ...current, tipo: value as AgendaBloqueioTipo }))
              }
            >
              <option value="almoco">Almoco</option>
              <option value="ausencia">Ausencia</option>
              <option value="ferias">Ferias</option>
              <option value="indisponivel">Indisponivel</option>
            </SelectField>

            <DateTimeField
              label="Inicio"
              dateValue={form.inicioData}
              timeValue={form.inicioHora}
              onDateChange={(value) => setForm((current) => ({ ...current, inicioData: value }))}
              onTimeChange={(value) => setForm((current) => ({ ...current, inicioHora: value }))}
              error={errors.inicio}
            />

            <DateTimeField
              label="Fim"
              dateValue={form.fimData}
              timeValue={form.fimHora}
              onDateChange={(value) => setForm((current) => ({ ...current, fimData: value }))}
              onTimeChange={(value) => setForm((current) => ({ ...current, fimHora: value }))}
              error={errors.fim}
            />

            <div className="sm:col-span-2">
              <label
                htmlFor={motivoId}
                className="mb-[7px] block text-[13px] font-semibold text-ink"
              >
                Motivo
              </label>
              <textarea
                id={motivoId}
                value={form.motivo}
                onChange={(event) =>
                  setForm((current) => ({ ...current, motivo: event.target.value }))
                }
                maxLength={240}
                rows={3}
                placeholder="Opcional"
                className="w-full rounded-field border-[1.5px] border-line-strong bg-surface-sunken px-3.5 py-3 text-[15px] text-ink outline-none transition-[border-color,box-shadow] duration-[120ms] placeholder:text-ink-faint hover:border-[var(--c-input-hover-border)] focus:border-brand focus:ring-[3px] focus:ring-brand/35 focus:shadow-focus"
              />
            </div>
          </div>

          <div className="mt-4 flex flex-col gap-2 sm:flex-row sm:justify-end">
            <Button
              variant="secondary"
              size="inline"
              onClick={fecharFormulario}
              disabled={createMutation.isPending}
            >
              Cancelar
            </Button>
            <Button size="inline" loading={createMutation.isPending} onClick={submit}>
              Criar bloqueio
            </Button>
          </div>
        </div>
      )}

      <div className="border-t border-line-soft">
        {bloqueios.length === 0 ? (
          <div className="px-4 py-4 text-[13.5px] text-ink-soft sm:px-5">
            Nenhum bloqueio de agenda agora.
          </div>
        ) : (
          bloqueios.map((bloqueio) => {
            const profissionalNome =
              bloqueio.colaborador_id == null
                ? null
                : (nomeByProfissionalId.get(bloqueio.colaborador_id) ??
                  `Profissional #${bloqueio.colaborador_id}`);

            return (
              <div
                key={bloqueio.id}
                className={cn(
                  'flex flex-col gap-3 border-b border-line-soft px-4 py-4 last:border-b-0 sm:px-5',
                  bloqueio.status === 'gcal_cleanup_failed' && 'bg-amber-400/8',
                )}
              >
                <div className="flex items-start gap-3">
                  <span
                    className={cn(
                      'mt-0.5 flex size-10 shrink-0 items-center justify-center rounded-[12px] border text-ink',
                      bloqueio.status === 'gcal_cleanup_failed'
                        ? 'border-amber-400/35 bg-amber-400/12 text-amber-200'
                        : 'border-danger/20 bg-danger/10 text-danger',
                    )}
                  >
                    {bloqueio.tipo === 'almoco' ? (
                      <IconPause size={18} />
                    ) : (
                      <IconCalendar size={18} />
                    )}
                  </span>

                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <p className="font-display text-[15px] font-semibold text-ink">
                        Bloqueio de agenda
                      </p>
                      <Pill className={tipoTone(bloqueio.tipo)}>
                        {BLOQUEIO_TIPO_LABEL[bloqueio.tipo]}
                      </Pill>
                      {profissionalNome && (
                        <Pill className="border-line-strong bg-surface-sunken text-ink-soft">
                          {profissionalNome}
                        </Pill>
                      )}
                      {bloqueio.status === 'gcal_cleanup_failed' && (
                        <Pill className="border-amber-400/35 bg-amber-400/12 text-amber-200">
                          Limpeza pendente
                        </Pill>
                      )}
                    </div>

                    <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[13px] text-ink-soft">
                      <span className="inline-flex items-center gap-1.5">
                        <IconClock size={15} />
                        {blockRangeLabel(bloqueio, timeZone)}
                      </span>
                    </div>

                    {bloqueio.motivo && (
                      <p className="mt-2 text-[13px] leading-normal text-ink-soft">
                        {bloqueio.motivo}
                      </p>
                    )}

                    {bloqueio.status === 'gcal_cleanup_failed' && (
                      <p className="mt-2 inline-flex items-center gap-1.5 text-[12.5px] font-medium text-amber-200">
                        <IconAlert size={14} />
                        Remova daqui para tentar limpar de novo.
                      </p>
                    )}
                  </div>

                  <button
                    type="button"
                    onClick={() => setConfirmRemove(bloqueio)}
                    className="inline-flex h-10 shrink-0 items-center gap-1.5 rounded-pill border border-line-strong bg-surface px-3 font-display text-[13px] font-semibold text-ink-soft outline-none transition-colors hover:bg-surface-hover hover:text-ink focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-2 focus-visible:ring-offset-bg"
                  >
                    <IconTrash size={15} />
                    Remover
                  </button>
                </div>
              </div>
            );
          })
        )}
      </div>

      <ConfirmDialog
        open={Boolean(confirmRemove)}
        title="Remover bloqueio?"
        description="Esse horario volta a ficar livre na agenda."
        confirmLabel="Remover"
        confirmVariant="destructive"
        loading={removeMutation.isPending}
        icon={<IconTrash size={20} />}
        onCancel={() => setConfirmRemove(null)}
        onConfirm={() => confirmRemove && removeBloqueio(confirmRemove.id)}
      />
    </section>
  );
}

function SectionHeader({
  count,
  mode,
  openForm,
  onToggle,
  disabled = false,
}: {
  count: number;
  mode: ScopeMode;
  openForm: boolean;
  onToggle: () => void;
  disabled?: boolean;
}) {
  return (
    <div className="flex items-start gap-3 p-4 sm:p-5">
      <span className="flex size-11 shrink-0 items-center justify-center rounded-[14px] border border-danger/20 bg-danger/10 text-danger">
        <IconCalendar size={20} />
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="font-display text-[17px] font-semibold text-ink">Bloqueio de agenda</h2>
          <Pill className="border-line-strong bg-surface-sunken text-ink-soft">
            {count} {count === 1 ? 'ativo' : 'ativos'}
          </Pill>
        </div>
        <p className="mt-0.5 text-[13px] leading-snug text-ink-soft">
          {mode === 'colaborador'
            ? 'Reserve almoco, ausencia, ferias ou indisponibilidade.'
            : 'Trave horarios sem cliente nem servico.'}
        </p>
      </div>
      <Button
        size="inline"
        variant={openForm ? 'secondary' : 'primary'}
        onClick={onToggle}
        disabled={disabled}
      >
        {openForm ? 'Cancelar' : 'Novo bloqueio'}
      </Button>
    </div>
  );
}

function Pill({ className, children }: { className: string; children: React.ReactNode }) {
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-pill border px-2.5 py-1 font-display text-[12px] font-semibold',
        className,
      )}
    >
      {children}
    </span>
  );
}

function SelectField({
  label,
  value,
  onChange,
  children,
  error,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  children: React.ReactNode;
  error?: string;
}) {
  const id = useId();
  return (
    <div className="flex w-full flex-col gap-[7px]">
      <label htmlFor={id} className="text-[13px] font-semibold text-ink">
        {label}
      </label>
      <select
        id={id}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className={cn(
          'h-[50px] w-full cursor-pointer appearance-none rounded-field border-[1.5px] border-line-strong bg-surface-sunken px-3.5 text-[15px] text-ink outline-none transition-colors hover:border-[var(--c-input-hover-border)] focus:border-brand focus:ring-[3px] focus:ring-brand/35 focus:shadow-focus',
          error && 'border-danger',
        )}
      >
        {children}
      </select>
      {error && <p className="text-[13px] text-danger">{error}</p>}
    </div>
  );
}

function DateTimeField({
  label,
  dateValue,
  timeValue,
  onDateChange,
  onTimeChange,
  error,
}: {
  label: string;
  dateValue: string;
  timeValue: string;
  onDateChange: (value: string) => void;
  onTimeChange: (value: string) => void;
  error?: string;
}) {
  const dateId = useId();
  return (
    <div className="flex w-full flex-col gap-[7px]">
      <label htmlFor={dateId} className="text-[13px] font-semibold text-ink">
        {label}
      </label>
      <div className="grid grid-cols-[1fr_116px] gap-2">
        <input
          id={dateId}
          type="date"
          value={dateValue}
          onChange={(event) => onDateChange(event.target.value)}
          className={cn(
            'h-[50px] w-full rounded-field border-[1.5px] border-line-strong bg-surface-sunken px-3.5 text-[15px] text-ink outline-none transition-colors hover:border-[var(--c-input-hover-border)] focus:border-brand focus:ring-[3px] focus:ring-brand/35 focus:shadow-focus',
            error && 'border-danger',
          )}
        />
        <input
          type="time"
          aria-label={`${label} hora`}
          value={timeValue}
          onChange={(event) => onTimeChange(event.target.value)}
          className={cn(
            'h-[50px] w-full rounded-field border-[1.5px] border-line-strong bg-surface-sunken px-3.5 text-[15px] text-ink outline-none transition-colors hover:border-[var(--c-input-hover-border)] focus:border-brand focus:ring-[3px] focus:ring-brand/35 focus:shadow-focus',
            error && 'border-danger',
          )}
        />
      </div>
      {error && <p className="text-[13px] text-danger">{error}</p>}
    </div>
  );
}
