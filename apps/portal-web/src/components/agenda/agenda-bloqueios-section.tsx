'use client';

import {
  IconAlert,
  IconCalendar,
  IconCheck,
  IconClock,
  IconPause,
  IconRefresh,
  IconTrash,
} from '@/components/icons';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { Skeleton } from '@/components/ui/skeleton';
import { ErrorState } from '@/components/ui/states';
import { Switch } from '@/components/ui/switch';
import { useToast } from '@/components/ui/toast';
import {
  BLOQUEIO_PERIODICIDADE_LABELS,
  BLOQUEIO_TIPO_LABEL,
  type RevisaoAgendaBloqueioRecorrencia,
  buildAgendaBloqueioRecorrenciaKey,
  buildCriarAgendaBloqueioSerieBody,
  buildPreviewAgendaBloqueioRecorrenciaBody,
  countRemovidosAgendaBloqueioSerie,
  defaultBloqueioFormValues,
  falhaAgendaBloqueioSerieLabel,
  initRevisaoAgendaBloqueioRecorrencia,
  isAgendaBloqueioRecorrenciaLivre,
  resumoResultadoAgendaBloqueioSerie,
  statusAgendaBloqueioRecorrenciaLabel,
  zonedDateTimeToUtcIso,
} from '@/lib/agenda-bloqueios';
import { BLOQUEIO_TIPO_OPTIONS, bloqueioEtapaAtual } from '@/lib/agenda-bloqueios-ui';
import { ApiError } from '@/lib/api';
import { OCORRENCIAS_MAX, OCORRENCIAS_MIN } from '@/lib/api-types';
import type {
  AgendaBloqueio,
  AgendaBloqueioInput,
  AgendaBloqueioPeriodicidade,
  AgendaBloqueioTipo,
  CriarAgendaBloqueioSerieResponse,
} from '@/lib/api-types';
import { cn } from '@/lib/cn';
import { formatAgendamentoDia, formatAgendamentoHora } from '@/lib/format';
import {
  useAgendaBloqueios,
  useColaboradorBloqueios,
  useCriarAgendaBloqueio,
  useCriarAgendaBloqueioSerie,
  useCriarColaboradorBloqueio,
  useCriarColaboradorBloqueioSerie,
  useEquipe,
  usePreviewAgendaBloqueioRecorrencia,
  usePreviewColaboradorBloqueioRecorrencia,
  useRemoverAgendaBloqueio,
  useRemoverAgendaBloqueioSerie,
  useRemoverColaboradorBloqueio,
  useRemoverColaboradorBloqueioSerie,
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

interface RemoveSerieState {
  serieId: string;
  referencia: string;
}

const DEFAULT_TIPO: AgendaBloqueioTipo = 'almoco';
const DEFAULT_PERIODICIDADE: AgendaBloqueioPeriodicidade = 'semanal';
const DEFAULT_OCORRENCIAS = 4;

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

function blockRangeLabel(inicioAt: string, fimAt: string, timeZone: string): string {
  const inicioDia = formatAgendamentoDia(inicioAt, undefined, timeZone);
  const inicioHora = formatAgendamentoHora(inicioAt, timeZone);
  const fimDia = formatAgendamentoDia(fimAt, undefined, timeZone);
  const fimHora = formatAgendamentoHora(fimAt, timeZone);
  if (inicioDia === fimDia) return `${inicioDia} · ${inicioHora} - ${fimHora}`;
  return `${inicioDia} ${inicioHora} ate ${fimDia} ${fimHora}`;
}

function apiErrorCode(error: unknown): string | null {
  if (!(error instanceof ApiError) || !error.body || typeof error.body !== 'object') return null;
  if (!('error' in error.body)) return null;
  const code = (error.body as { error?: unknown }).error;
  return typeof code === 'string' ? code : null;
}

function createErrorMessage(error: unknown): string {
  const code = apiErrorCode(error);
  if (code === 'feature_off') return 'Bloqueio de agenda indisponivel agora.';
  if (code === 'gcal_nao_configurado') return 'A Agenda Google ainda nao esta conectada.';
  if (code === 'colaborador_nao_encontrado') return 'Escolha um profissional valido.';
  if (code === 'payload_invalido') return 'Confira as datas e tente de novo.';
  return 'Nao foi possivel salvar o bloqueio na Agenda Google. Tente de novo.';
}

function previewErrorMessage(error: unknown): string {
  const code = apiErrorCode(error);
  if (code === 'feature_off') return 'Bloqueio de agenda indisponivel agora.';
  if (code === 'gcal_nao_configurado') return 'A Agenda Google ainda nao esta conectada.';
  if (code === 'colaborador_nao_encontrado') return 'Escolha um profissional valido.';
  if (code === 'payload_invalido') return 'Confira as datas e gere a previa de novo.';
  return 'Nao foi possivel gerar a previa na Agenda Google. Tente de novo.';
}

function removeErrorMessage(error: unknown): string {
  const code = apiErrorCode(error);
  if (code === 'feature_off') return 'Bloqueio de agenda indisponivel agora.';
  if (code === 'bloqueio_nao_encontrado') return 'Esse bloqueio ja nao esta mais aqui.';
  if (code === 'gcal_nao_configurado') return 'A Agenda Google ainda nao esta conectada.';
  return 'Nao foi possivel remover o bloqueio da Agenda Google. Tente de novo.';
}

function removeSerieErrorMessage(error: unknown): string {
  const code = apiErrorCode(error);
  if (code === 'feature_off') return 'Bloqueio de agenda indisponivel agora.';
  if (code === 'serie_nao_encontrada') return 'Essa serie ja nao tem mais bloqueios futuros.';
  if (code === 'gcal_nao_configurado') return 'A Agenda Google ainda nao esta conectada.';
  return 'Nao foi possivel remover a serie futura da Agenda Google. Tente de novo.';
}

function buildInputFromForm(args: {
  canPickProfissional: boolean;
  form: FormState;
  timeZone: string;
}): { ok: true; body: AgendaBloqueioInput } | { ok: false; errors: FormErrors } {
  const errors: FormErrors = {};
  if (args.canPickProfissional && !args.form.colaboradorId) {
    errors.colaborador = 'Escolha um profissional.';
  }
  if (!args.form.inicioData || !args.form.inicioHora) {
    errors.inicio = 'Preencha o inicio.';
  }
  if (!args.form.fimData || !args.form.fimHora) {
    errors.fim = 'Preencha o fim.';
  }
  if (Object.keys(errors).length > 0) return { ok: false, errors };

  const inicioAt = zonedDateTimeToUtcIso(args.form.inicioData, args.form.inicioHora, args.timeZone);
  const fimAt = zonedDateTimeToUtcIso(args.form.fimData, args.form.fimHora, args.timeZone);
  if (!inicioAt || !fimAt) {
    return {
      ok: false,
      errors: {
        inicio: !inicioAt ? 'Horario invalido.' : undefined,
        fim: !fimAt ? 'Horario invalido.' : undefined,
      },
    };
  }
  if (new Date(fimAt).getTime() <= new Date(inicioAt).getTime()) {
    return { ok: false, errors: { fim: 'O fim precisa ficar depois do inicio.' } };
  }

  return {
    ok: true,
    body: {
      inicio_at: inicioAt,
      fim_at: fimAt,
      timezone: args.timeZone,
      tipo: args.form.tipo,
      motivo: args.form.motivo.trim() || undefined,
      colaborador_id: args.canPickProfissional ? Number(args.form.colaboradorId) : undefined,
    },
  };
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
  const ownerPreviewSerie = usePreviewAgendaBloqueioRecorrencia();
  const ownerCreateSerie = useCriarAgendaBloqueioSerie(slot);
  const ownerRemoveSerie = useRemoverAgendaBloqueioSerie(slot);

  const colaboradorCreate = useCriarColaboradorBloqueio(slot, colaboradorId ?? 0);
  const colaboradorRemove = useRemoverColaboradorBloqueio(slot, colaboradorId ?? 0);
  const colaboradorPreviewSerie = usePreviewColaboradorBloqueioRecorrencia();
  const colaboradorCreateSerie = useCriarColaboradorBloqueioSerie(slot, colaboradorId ?? 0);
  const colaboradorRemoveSerie = useRemoverColaboradorBloqueioSerie(slot, colaboradorId ?? 0);

  const createMutation = mode === 'colaborador' ? colaboradorCreate : ownerCreate;
  const removeMutation = mode === 'colaborador' ? colaboradorRemove : ownerRemove;
  const previewSerieMutation = mode === 'colaborador' ? colaboradorPreviewSerie : ownerPreviewSerie;
  const createSerieMutation = mode === 'colaborador' ? colaboradorCreateSerie : ownerCreateSerie;
  const removeSerieMutation = mode === 'colaborador' ? colaboradorRemoveSerie : ownerRemoveSerie;

  const [openForm, setOpenForm] = useState(false);
  const [form, setForm] = useState<FormState>(() =>
    buildFormState(timeZone, defaultProfissionalId),
  );
  const [errors, setErrors] = useState<FormErrors>({});
  const [repetir, setRepetir] = useState(false);
  const [periodicidade, setPeriodicidade] =
    useState<AgendaBloqueioPeriodicidade>(DEFAULT_PERIODICIDADE);
  const [ocorrencias, setOcorrencias] = useState(DEFAULT_OCORRENCIAS);
  const [revisaoSerie, setRevisaoSerie] = useState<RevisaoAgendaBloqueioRecorrencia[] | null>(null);
  const [resultadoSerie, setResultadoSerie] = useState<CriarAgendaBloqueioSerieResponse | null>(
    null,
  );
  const [previewKey, setPreviewKey] = useState<string | null>(null);
  const [confirmRemove, setConfirmRemove] = useState<AgendaBloqueio | null>(null);
  const [confirmRemoveSerie, setConfirmRemoveSerie] = useState<RemoveSerieState | null>(null);
  const motivoId = useId();

  const nomeByProfissionalId = useMemo(
    () => new Map(profissionais.map((item) => [item.id, item.nome])),
    [profissionais],
  );

  function limparRecorrencia() {
    setRevisaoSerie(null);
    setResultadoSerie(null);
    setPreviewKey(null);
  }

  function resetForm() {
    setForm(buildFormState(timeZone, defaultProfissionalId));
    setErrors({});
    setRepetir(false);
    setPeriodicidade(DEFAULT_PERIODICIDADE);
    setOcorrencias(DEFAULT_OCORRENCIAS);
    limparRecorrencia();
  }

  function abrirFormulario() {
    resetForm();
    setOpenForm(true);
  }

  function fecharFormulario() {
    setOpenForm(false);
    resetForm();
  }

  function updateForm(patch: Partial<FormState>) {
    setForm((current) => ({ ...current, ...patch }));
    limparRecorrencia();
  }

  const currentInput = buildInputFromForm({ canPickProfissional, form, timeZone });
  const currentPreviewKey =
    repetir && currentInput.ok
      ? buildAgendaBloqueioRecorrenciaKey({
          base: currentInput.body,
          periodicidade,
          ocorrencias,
        })
      : null;
  const totalSerie = revisaoSerie?.length ?? 0;
  const previewAtual = Boolean(
    !resultadoSerie &&
      revisaoSerie &&
      previewKey &&
      currentPreviewKey &&
      previewKey === currentPreviewKey,
  );
  const podeCriarSerie = previewAtual && totalSerie > 0;

  function submit() {
    if (!currentInput.ok) {
      setErrors(currentInput.errors);
      return;
    }

    createMutation.mutate(currentInput.body, {
      onSuccess: () => {
        toast.success('Bloqueio criado na Agenda Google');
        fecharFormulario();
      },
      onError: (error) => toast.error(createErrorMessage(error)),
    });
  }

  function gerarPreviaSerie() {
    if (!currentInput.ok) {
      setErrors(currentInput.errors);
      return;
    }

    const nextKey = buildAgendaBloqueioRecorrenciaKey({
      base: currentInput.body,
      periodicidade,
      ocorrencias,
    });

    previewSerieMutation.mutate(
      buildPreviewAgendaBloqueioRecorrenciaBody({
        base: currentInput.body,
        periodicidade,
        ocorrencias,
      }),
      {
        onSuccess: (response) => {
          setRevisaoSerie(initRevisaoAgendaBloqueioRecorrencia(response.previews));
          setResultadoSerie(null);
          setPreviewKey(nextKey);
        },
        onError: (error) => toast.error(previewErrorMessage(error)),
      },
    );
  }

  function confirmarSerie() {
    if (!currentInput.ok) {
      setErrors(currentInput.errors);
      return;
    }
    if (!revisaoSerie || !currentPreviewKey || previewKey !== currentPreviewKey) {
      toast.error('Atualize a previa antes de criar a serie na Agenda Google.');
      return;
    }

    createSerieMutation.mutate(
      buildCriarAgendaBloqueioSerieBody({
        base: currentInput.body,
        periodicidade,
        ocorrencias,
      }),
      {
        onSuccess: (response) => {
          setResultadoSerie(response);
          if (response.falhas.length === 0) {
            toast.success(
              response.criados.length === 1
                ? '1 bloqueio criado na Agenda Google'
                : 'Serie criada na Agenda Google',
            );
          }
        },
        onError: (error) => toast.error(createErrorMessage(error)),
      },
    );
  }

  function removeBloqueio(id: string) {
    removeMutation.mutate(id, {
      onSuccess: () => {
        toast.success('Bloqueio removido da Agenda Google');
        setConfirmRemove(null);
      },
      onError: (error) => {
        setConfirmRemove(null);
        toast.error(removeErrorMessage(error));
      },
    });
  }

  function removeSerie(serieId: string) {
    removeSerieMutation.mutate(serieId, {
      onSuccess: (response) => {
        setConfirmRemoveSerie(null);
        const totalRemovidos = countRemovidosAgendaBloqueioSerie(response);
        toast.success(
          totalRemovidos === 1
            ? '1 bloqueio futuro removido da Agenda Google'
            : `${totalRemovidos} bloqueios futuros removidos da Agenda Google`,
        );
      },
      onError: (error) => {
        setConfirmRemoveSerie(null);
        toast.error(removeSerieErrorMessage(error));
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
  const loadingForm =
    createMutation.isPending || previewSerieMutation.isPending || createSerieMutation.isPending;

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
          <BloqueioFlowSteps
            current={bloqueioEtapaAtual({ repetir, temPrevia: Boolean(revisaoSerie) })}
            canPickProfissional={canPickProfissional}
          />
          <div className="mb-4 rounded-field border border-brand/25 bg-brand-soft/50 px-3 py-2.5 text-[12.5px] leading-snug text-ink-soft">
            {canPickProfissional
              ? 'Escolha primeiro quem ficará indisponível. O bloqueio será enviado apenas para a Agenda Google desse profissional.'
              : 'Você está bloqueando apenas a sua própria agenda. Seus colegas não serão afetados.'}
          </div>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            {canPickProfissional && (
              <SelectField
                label="1. Quem ficará indisponível?"
                value={form.colaboradorId}
                onChange={(value) => {
                  updateForm({ colaboradorId: value });
                  if (errors.colaborador) {
                    setErrors((current) => ({ ...current, colaborador: undefined }));
                  }
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

            <div className={cn('sm:col-span-2', !canPickProfissional && 'sm:col-span-2')}>
              <TipoChooser
                value={form.tipo}
                onChange={(tipo) => updateForm({ tipo })}
                disabled={loadingForm}
              />
            </div>

            <DateTimeField
              label="2. Começa em"
              dateValue={form.inicioData}
              timeValue={form.inicioHora}
              onDateChange={(value) => updateForm({ inicioData: value })}
              onTimeChange={(value) => updateForm({ inicioHora: value })}
              error={errors.inicio}
            />

            <DateTimeField
              label="Termina em"
              dateValue={form.fimData}
              timeValue={form.fimHora}
              onDateChange={(value) => updateForm({ fimData: value })}
              onTimeChange={(value) => updateForm({ fimHora: value })}
              error={errors.fim}
            />

            <div className="sm:col-span-2">
              <label
                htmlFor={motivoId}
                className="mb-[7px] block text-[13px] font-semibold text-ink"
              >
                Motivo (opcional)
              </label>
              <textarea
                id={motivoId}
                value={form.motivo}
                onChange={(event) => updateForm({ motivo: event.target.value })}
                maxLength={240}
                rows={3}
                placeholder="Ex.: treinamento interno"
                className="w-full rounded-field border-[1.5px] border-line-strong bg-surface-sunken px-3.5 py-3 text-[15px] text-ink outline-none transition-[border-color,box-shadow] duration-[120ms] placeholder:text-ink-faint hover:border-[var(--c-input-hover-border)] focus:border-brand focus:ring-[3px] focus:ring-brand/35 focus:shadow-focus"
              />
            </div>
          </div>

          <div className="mt-4 border-t border-line-soft pt-4">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <h3 className="font-display text-[15px] font-semibold text-ink">
                  Repetir este bloqueio
                </h3>
                <p className="mt-0.5 text-[12.5px] leading-snug text-ink-soft">
                  Cada ocorrencia vira um evento de bloqueio na Agenda Google do profissional.
                </p>
              </div>
              <Switch
                checked={repetir}
                onChange={(checked) => {
                  setRepetir(checked);
                  limparRecorrencia();
                }}
                label="Repetir este bloqueio"
                disabled={loadingForm}
              />
            </div>

            {repetir && (
              <div className="mt-4 space-y-4">
                <div>
                  <span className="mb-2 block text-[13px] font-semibold text-ink">
                    Com que frequencia?
                  </span>
                  <div className="grid grid-cols-2 gap-2">
                    {(
                      Object.keys(BLOQUEIO_PERIODICIDADE_LABELS) as AgendaBloqueioPeriodicidade[]
                    ).map((value) => {
                      const ativo = value === periodicidade;
                      return (
                        <button
                          key={value}
                          type="button"
                          aria-pressed={ativo}
                          onClick={() => {
                            setPeriodicidade(value);
                            limparRecorrencia();
                          }}
                          className={cn(
                            'min-h-11 rounded-field border px-3 py-2 font-display text-[13.5px] font-semibold outline-none transition-colors focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-2 focus-visible:ring-offset-bg',
                            ativo
                              ? 'border-brand bg-brand-soft text-brand'
                              : 'border-line bg-surface-sunken text-ink hover:bg-surface-hover',
                          )}
                        >
                          {BLOQUEIO_PERIODICIDADE_LABELS[value]}
                        </button>
                      );
                    })}
                  </div>
                </div>

                <div>
                  <p className="mb-2 block text-[13px] font-semibold text-ink">
                    Quantas ocorrencias?
                  </p>
                  <div className="flex items-center gap-3">
                    <button
                      type="button"
                      aria-label="Diminuir ocorrencias"
                      disabled={ocorrencias <= OCORRENCIAS_MIN || loadingForm}
                      onClick={() => {
                        setOcorrencias((current) => Math.max(OCORRENCIAS_MIN, current - 1));
                        limparRecorrencia();
                      }}
                      className="flex size-11 shrink-0 items-center justify-center rounded-field border border-line-strong bg-surface font-display text-[18px] font-semibold text-ink outline-none transition-colors hover:bg-surface-hover focus-visible:ring-2 focus-visible:ring-brand disabled:cursor-not-allowed disabled:opacity-40"
                    >
                      −
                    </button>
                    <span className="min-w-[72px] text-center font-display text-[20px] font-bold tabular-nums text-ink">
                      {ocorrencias}×
                    </span>
                    <button
                      type="button"
                      aria-label="Aumentar ocorrencias"
                      disabled={ocorrencias >= OCORRENCIAS_MAX || loadingForm}
                      onClick={() => {
                        setOcorrencias((current) => Math.min(OCORRENCIAS_MAX, current + 1));
                        limparRecorrencia();
                      }}
                      className="flex size-11 shrink-0 items-center justify-center rounded-field border border-line-strong bg-surface font-display text-[18px] font-semibold text-ink outline-none transition-colors hover:bg-surface-hover focus-visible:ring-2 focus-visible:ring-brand disabled:cursor-not-allowed disabled:opacity-40"
                    >
                      +
                    </button>
                  </div>
                  <p className="mt-1.5 text-[12.5px] leading-snug text-ink-faint">
                    De {OCORRENCIAS_MIN} a {OCORRENCIAS_MAX}. A criacao so libera com a previa
                    atualizada da Agenda Google.
                  </p>
                </div>

                {revisaoSerie && (
                  <div className="border-t border-line-soft pt-4">
                    <div className="flex flex-wrap items-start justify-between gap-2">
                      <div>
                        <h4 className="font-display text-[15px] font-semibold text-ink">
                          {resultadoSerie
                            ? 'Resultado na Agenda Google'
                            : 'Revise a serie antes de confirmar'}
                        </h4>
                        <p className="mt-0.5 text-[12.5px] leading-snug text-ink-soft">
                          {resultadoSerie
                            ? 'Cada linha abaixo mostra o que entrou ou falhou na Agenda Google do profissional.'
                            : 'A confirmacao usara esta previa para inserir a serie na Agenda Google do profissional.'}
                        </p>
                      </div>
                      {!resultadoSerie && (
                        <Pill className="border-line-strong bg-surface-sunken text-ink-soft">
                          {totalSerie} ocorrencias na previa
                        </Pill>
                      )}
                    </div>

                    {resultadoSerie && (
                      <p
                        role="status"
                        className={cn(
                          'mt-3 rounded-field border px-3 py-2 text-[13px] font-medium leading-snug',
                          resultadoSerie.falhas.length === 0
                            ? 'border-brand/40 bg-brand-soft text-brand'
                            : resultadoSerie.criados.length === 0
                              ? 'border-danger/40 bg-danger/10 text-danger'
                              : 'border-amber-400/35 bg-amber-400/12 text-amber-200',
                        )}
                      >
                        {resumoResultadoAgendaBloqueioSerie(resultadoSerie)}
                      </p>
                    )}

                    {!resultadoSerie && (
                      <p className="mt-3 text-[12.5px] leading-snug text-ink-faint">
                        A previa separa o que esta livre do que ja esta ocupado ou indisponivel na
                        Agenda Google. A serie sera recalculada no servidor na confirmacao, entao o
                        resultado ainda pode voltar parcial se a agenda mudar.
                      </p>
                    )}

                    <ReviewList
                      ocorrencias={revisaoSerie}
                      resultado={resultadoSerie}
                      timeZone={timeZone}
                    />
                  </div>
                )}
              </div>
            )}
          </div>

          <div className="mt-4 flex flex-col gap-2 sm:flex-row sm:justify-end">
            <Button
              variant="secondary"
              size="inline"
              onClick={fecharFormulario}
              disabled={loadingForm}
            >
              Cancelar
            </Button>

            {repetir ? (
              <>
                <Button
                  variant={revisaoSerie ? 'secondary' : 'primary'}
                  size="inline"
                  loading={previewSerieMutation.isPending}
                  loadingLabel="Montando previa…"
                  onClick={gerarPreviaSerie}
                  disabled={createSerieMutation.isPending}
                >
                  {revisaoSerie ? 'Atualizar previa' : 'Ver previa'}
                </Button>
                {resultadoSerie ? (
                  <Button size="inline" onClick={fecharFormulario}>
                    Concluir
                  </Button>
                ) : (
                  <Button
                    size="inline"
                    loading={createSerieMutation.isPending}
                    loadingLabel="Criando serie…"
                    onClick={confirmarSerie}
                    disabled={!podeCriarSerie || previewSerieMutation.isPending}
                  >
                    Criar serie
                  </Button>
                )}
              </>
            ) : (
              <Button size="inline" loading={createMutation.isPending} onClick={submit}>
                Criar bloqueio
              </Button>
            )}
          </div>
        </div>
      )}

      <BloqueiosList
        bloqueios={bloqueios}
        timeZone={timeZone}
        nomeByProfissionalId={nomeByProfissionalId}
        onRemove={setConfirmRemove}
        onRemoveSerie={setConfirmRemoveSerie}
      />

      <BloqueioRemoveDialogs
        bloqueio={confirmRemove}
        serie={confirmRemoveSerie}
        removing={removeMutation.isPending}
        removingSerie={removeSerieMutation.isPending}
        onCancelBloqueio={() => setConfirmRemove(null)}
        onCancelSerie={() => setConfirmRemoveSerie(null)}
        onRemoveBloqueio={() => confirmRemove && removeBloqueio(confirmRemove.id)}
        onRemoveSerie={() => confirmRemoveSerie && removeSerie(confirmRemoveSerie.serieId)}
      />
    </section>
  );
}

function BloqueiosList({
  bloqueios,
  timeZone,
  nomeByProfissionalId,
  onRemove,
  onRemoveSerie,
}: {
  bloqueios: AgendaBloqueio[];
  timeZone: string;
  nomeByProfissionalId: Map<number, string>;
  onRemove: (bloqueio: AgendaBloqueio) => void;
  onRemoveSerie: (serie: RemoveSerieState) => void;
}) {
  const grupos = new Map<string, AgendaBloqueio[]>();
  for (const bloqueio of bloqueios) {
    const nome =
      bloqueio.colaborador_id == null
        ? 'Agenda principal'
        : (nomeByProfissionalId.get(bloqueio.colaborador_id) ??
          `Profissional #${bloqueio.colaborador_id}`);
    grupos.set(nome, [...(grupos.get(nome) ?? []), bloqueio]);
  }

  if (bloqueios.length === 0) {
    return (
      <div className="border-t border-line-soft px-4 py-5 sm:px-5">
        <p className="font-display text-[14px] font-semibold text-ink">Equipe disponível</p>
        <p className="mt-1 text-[13px] leading-snug text-ink-soft">
          Nenhuma indisponibilidade cadastrada agora.
        </p>
      </div>
    );
  }

  return (
    <div className="border-t border-line-soft">
      <div className="border-b border-line-soft px-4 py-3 sm:px-5">
        <p className="text-[12px] font-semibold uppercase tracking-[0.08em] text-ink-faint">
          Disponibilidade cadastrada por profissional
        </p>
      </div>
      {[...grupos.entries()].map(([nome, itens]) => (
        <section key={nome} aria-label={`Indisponibilidades de ${nome}`}>
          <div className="border-b border-line-soft bg-surface-sunken px-4 py-2.5 sm:px-5">
            <p className="font-display text-[14px] font-semibold text-ink">{nome}</p>
          </div>
          {itens.map((bloqueio) => (
            <BloqueioListItem
              key={bloqueio.id}
              bloqueio={bloqueio}
              timeZone={timeZone}
              onRemove={onRemove}
              onRemoveSerie={onRemoveSerie}
            />
          ))}
        </section>
      ))}
    </div>
  );
}

function BloqueioListItem({
  bloqueio,
  timeZone,
  onRemove,
  onRemoveSerie,
}: {
  bloqueio: AgendaBloqueio;
  timeZone: string;
  onRemove: (bloqueio: AgendaBloqueio) => void;
  onRemoveSerie: (serie: RemoveSerieState) => void;
}) {
  return (
    <div
      className={cn(
        'border-b border-line-soft px-4 py-4 last:border-b-0 sm:px-5',
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
          {bloqueio.tipo === 'almoco' ? <IconPause size={18} /> : <IconCalendar size={18} />}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <p className="font-display text-[15px] font-semibold text-ink">
              {BLOQUEIO_TIPO_LABEL[bloqueio.tipo]}
            </p>
            {bloqueio.serie_id && (
              <Pill className="border-line-strong bg-surface-sunken text-ink-soft">Série</Pill>
            )}
            {bloqueio.status === 'gcal_cleanup_failed' && (
              <Pill className="border-amber-400/35 bg-amber-400/12 text-amber-200">
                Limpeza pendente
              </Pill>
            )}
          </div>
          <p className="mt-2 inline-flex items-center gap-1.5 text-[13px] text-ink-soft">
            <IconClock size={15} />
            {blockRangeLabel(bloqueio.inicio_at, bloqueio.fim_at, timeZone)}
          </p>
          {bloqueio.motivo && (
            <p className="mt-2 text-[13px] leading-normal text-ink-soft">{bloqueio.motivo}</p>
          )}
          {bloqueio.status === 'gcal_cleanup_failed' && (
            <p className="mt-2 inline-flex items-center gap-1.5 text-[12.5px] font-medium text-amber-200">
              <IconAlert size={14} /> Remova para tentar limpar de novo na Agenda Google.
            </p>
          )}
          <div className="mt-3 flex flex-wrap gap-2">
            {bloqueio.serie_id && (
              <Button
                variant="secondary"
                size="inline"
                className="h-10 px-3 text-[13px]"
                onClick={() =>
                  onRemoveSerie({
                    serieId: bloqueio.serie_id ?? '',
                    referencia: blockRangeLabel(bloqueio.inicio_at, bloqueio.fim_at, timeZone),
                  })
                }
              >
                <IconRefresh size={15} /> Remover futuras da série
              </Button>
            )}
            <Button
              variant="destructive"
              size="inline"
              className="h-10 px-3 text-[13px]"
              onClick={() => onRemove(bloqueio)}
            >
              <IconTrash size={15} /> Remover este horário
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}

function BloqueioRemoveDialogs({
  bloqueio,
  serie,
  removing,
  removingSerie,
  onCancelBloqueio,
  onCancelSerie,
  onRemoveBloqueio,
  onRemoveSerie,
}: {
  bloqueio: AgendaBloqueio | null;
  serie: RemoveSerieState | null;
  removing: boolean;
  removingSerie: boolean;
  onCancelBloqueio: () => void;
  onCancelSerie: () => void;
  onRemoveBloqueio: () => void;
  onRemoveSerie: () => void;
}) {
  return (
    <>
      <ConfirmDialog
        open={Boolean(bloqueio)}
        title="Remover este horário?"
        description="Somente esta ocorrência volta a ficar livre na Agenda Google. As outras datas da série continuam protegidas."
        confirmLabel="Remover este horário"
        confirmVariant="destructive"
        loading={removing}
        icon={<IconTrash size={20} />}
        onCancel={onCancelBloqueio}
        onConfirm={onRemoveBloqueio}
      />
      <ConfirmDialog
        open={Boolean(serie)}
        title="Remover futuras da série?"
        description={
          serie
            ? `Os próximos bloqueios desta série serão removidos a partir de ${serie.referencia}. Os bloqueios passados permanecem no histórico.`
            : ''
        }
        confirmLabel="Remover futuras"
        confirmVariant="destructive"
        loading={removingSerie}
        icon={<IconRefresh size={20} />}
        onCancel={onCancelSerie}
        onConfirm={onRemoveSerie}
      />
    </>
  );
}

function BloqueioFlowSteps({
  current,
  canPickProfissional,
}: {
  current: number;
  canPickProfissional: boolean;
}) {
  const steps = canPickProfissional
    ? ['Quem', 'Quando', 'Tipo', 'Repetir', 'Revisar']
    : ['Quando', 'Tipo', 'Repetir', 'Revisar'];
  const currentStep = canPickProfissional ? current + 1 : current;
  return (
    <ol
      aria-label="Etapas para declarar indisponibilidade"
      className="mb-4 flex items-center gap-1.5"
    >
      {steps.map((step, index) => {
        const stepNumber = index + 1;
        return (
          <li key={step} className="flex min-w-0 flex-1 items-center gap-1.5">
            <span
              className={cn(
                'flex size-6 shrink-0 items-center justify-center rounded-full border text-[11px] font-bold',
                stepNumber <= currentStep
                  ? 'border-brand bg-brand text-white'
                  : 'border-line-strong bg-surface-sunken text-ink-faint',
              )}
            >
              {stepNumber}
            </span>
            <span className="truncate text-[11px] font-semibold text-ink-soft sm:text-[12px]">
              {step}
            </span>
            {index < steps.length - 1 && <span className="h-px min-w-1 flex-1 bg-line-soft" />}
          </li>
        );
      })}
    </ol>
  );
}

function TipoChooser({
  value,
  onChange,
  disabled,
}: {
  value: AgendaBloqueioTipo;
  onChange: (tipo: AgendaBloqueioTipo) => void;
  disabled: boolean;
}) {
  return (
    <fieldset>
      <legend className="mb-2 text-[13px] font-semibold text-ink">
        3. Qual indisponibilidade?
      </legend>
      <div className="grid grid-cols-2 gap-2">
        {BLOQUEIO_TIPO_OPTIONS.map((option) => {
          const selected = option.value === value;
          return (
            <button
              key={option.value}
              type="button"
              aria-pressed={selected}
              disabled={disabled}
              onClick={() => onChange(option.value)}
              className={cn(
                'min-h-[68px] rounded-field border px-3 py-2 text-left outline-none transition-colors focus-visible:ring-2 focus-visible:ring-brand disabled:cursor-not-allowed disabled:opacity-50',
                selected
                  ? 'border-brand bg-brand-soft text-brand'
                  : 'border-line-strong bg-surface-sunken text-ink hover:bg-surface-hover',
              )}
            >
              <span className="block font-display text-[13.5px] font-semibold">{option.label}</span>
              <span className="mt-0.5 block text-[11.5px] leading-snug text-ink-soft">
                {option.description}
              </span>
            </button>
          );
        })}
      </div>
    </fieldset>
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
          <h2 className="font-display text-[17px] font-semibold text-ink">
            Disponibilidade da equipe
          </h2>
          <Pill className="border-line-strong bg-surface-sunken text-ink-soft">
            {count} {count === 1 ? 'ativo' : 'ativos'}
          </Pill>
        </div>
        <p className="mt-0.5 text-[13px] leading-snug text-ink-soft">
          {mode === 'colaborador'
            ? 'Declare quando você não atende. Só a sua agenda será bloqueada.'
            : 'Veja quem está indisponível e declare períodos sem atendimento.'}
        </p>
      </div>
      <Button
        size="inline"
        variant={openForm ? 'secondary' : 'primary'}
        onClick={onToggle}
        disabled={disabled}
      >
        {openForm ? 'Cancelar' : 'Declarar indisponibilidade'}
      </Button>
    </div>
  );
}

function ReviewList({
  ocorrencias,
  resultado,
  timeZone,
}: {
  ocorrencias: RevisaoAgendaBloqueioRecorrencia[];
  resultado: CriarAgendaBloqueioSerieResponse | null;
  timeZone: string;
}) {
  const falhasPorChave = useMemo(() => {
    const map = new Map<string, { error: string; reason?: string | null }>();
    for (const falha of resultado?.falhas ?? []) {
      map.set(`${falha.inicio_at}|${falha.fim_at}`, {
        error: falha.error,
        reason: falha.reason,
      });
    }
    return map;
  }, [resultado]);

  const criadosSet = useMemo(
    () => new Set((resultado?.criados ?? []).map((item) => `${item.inicio_at}|${item.fim_at}`)),
    [resultado],
  );

  return (
    <ul className="mt-3 divide-y divide-line-soft border-t border-line-soft">
      {ocorrencias.map((ocorrencia) => {
        const chave = `${ocorrencia.inicio_at}|${ocorrencia.fim_at}`;
        const falha = falhasPorChave.get(chave);
        const criada = criadosSet.has(chave);
        const livre = isAgendaBloqueioRecorrenciaLivre(ocorrencia.status);
        const statusBase = statusAgendaBloqueioRecorrenciaLabel(ocorrencia.status);
        return (
          <li
            key={chave}
            className={cn(
              'flex gap-3 py-3',
              falha && 'bg-danger/6',
              criada && 'bg-brand/6',
              !resultado && !livre && 'bg-amber-400/6',
            )}
          >
            {resultado ? (
              <span
                className={cn(
                  'mt-0.5 flex size-[18px] shrink-0 items-center justify-center rounded-full border',
                  criada
                    ? 'border-brand/40 bg-brand-soft text-brand'
                    : falha
                      ? 'border-danger/40 bg-danger/10 text-danger'
                      : 'border-line-strong bg-surface-sunken text-ink-soft',
                )}
              >
                {criada ? <IconCheck size={12} /> : <IconAlert size={12} />}
              </span>
            ) : (
              <span
                className={cn(
                  'mt-0.5 flex size-[18px] shrink-0 items-center justify-center rounded-full border',
                  livre
                    ? 'border-brand/40 bg-brand-soft text-brand'
                    : 'border-amber-400/35 bg-amber-400/12 text-amber-200',
                )}
              >
                {livre ? <IconCheck size={12} /> : <IconAlert size={12} />}
              </span>
            )}

            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <p className="font-display text-[14px] font-semibold text-ink">
                  {blockRangeLabel(ocorrencia.inicio_at, ocorrencia.fim_at, timeZone)}
                </p>
                {resultado ? (
                  criada ? (
                    <Pill className="border-brand/40 bg-brand-soft text-brand">
                      Criado na agenda
                    </Pill>
                  ) : falha ? (
                    <Pill className="border-danger/40 bg-danger/10 text-danger">
                      Falhou na agenda
                    </Pill>
                  ) : (
                    <Pill className="border-line-strong bg-surface-sunken text-ink-soft">
                      Nao enviado
                    </Pill>
                  )
                ) : livre ? (
                  <Pill className="border-brand/40 bg-brand-soft text-brand">Livre na agenda</Pill>
                ) : (
                  <Pill className="border-amber-400/35 bg-amber-400/12 text-amber-200">
                    Ocupado ou indisponivel
                  </Pill>
                )}
              </div>

              <p className="mt-1 text-[12.5px] leading-snug text-ink-soft">
                {resultado
                  ? criada
                    ? 'Inserido como bloqueio na Agenda Google do profissional.'
                    : falha
                      ? falhaAgendaBloqueioSerieLabel(falha.reason)
                      : 'Nao foi enviado para a Agenda Google.'
                  : livre
                    ? 'Se nada mudar, este bloqueio sera inserido na Agenda Google do profissional.'
                    : statusBase}
              </p>

              {!resultado && !livre && (
                <p className="mt-1 text-[12px] leading-snug text-amber-200">
                  O backend recalcula a serie na confirmacao. Se esse conflito continuar, esta
                  ocorrencia pode voltar como falha parcial.
                </p>
              )}
            </div>
          </li>
        );
      })}
    </ul>
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
