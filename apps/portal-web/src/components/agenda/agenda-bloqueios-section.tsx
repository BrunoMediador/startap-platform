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
  contarMarcadosAgendaBloqueioRecorrencia,
  defaultBloqueioFormValues,
  falhaAgendaBloqueioSerieLabel,
  initRevisaoAgendaBloqueioRecorrencia,
  resumoResultadoAgendaBloqueioSerie,
  statusAgendaBloqueioRecorrenciaLabel,
  zonedDateTimeToUtcIso,
} from '@/lib/agenda-bloqueios';
import { ApiError } from '@/lib/api';
import { OCORRENCIAS_MAX, OCORRENCIAS_MIN } from '@/lib/api-types';
import type {
  AgendaBloqueio,
  AgendaBloqueioInput,
  AgendaBloqueioTipo,
  CriarAgendaBloqueioSerieResponse,
  Periodicidade,
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
const DEFAULT_PERIODICIDADE: Periodicidade = 'semanal';
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
  const [periodicidade, setPeriodicidade] = useState<Periodicidade>(DEFAULT_PERIODICIDADE);
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
  const contagemSerie = contarMarcadosAgendaBloqueioRecorrencia(revisaoSerie ?? []);
  const previewAtual = Boolean(
    !resultadoSerie &&
      revisaoSerie &&
      previewKey &&
      currentPreviewKey &&
      previewKey === currentPreviewKey,
  );
  const podeCriarSerie = previewAtual && contagemSerie.marcados > 0;

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
    if (contagemSerie.marcados === 0) {
      toast.error('Marque pelo menos uma ocorrencia para enviar a Agenda Google.');
      return;
    }

    createSerieMutation.mutate(
      buildCriarAgendaBloqueioSerieBody({
        base: currentInput.body,
        ocorrencias: revisaoSerie,
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

  function toggleRevisao(index: number) {
    if (resultadoSerie) return;
    setRevisaoSerie((current) =>
      current
        ? current.map((ocorrencia, currentIndex) =>
            currentIndex === index ? { ...ocorrencia, marcado: !ocorrencia.marcado } : ocorrencia,
          )
        : current,
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
        toast.success(
          response.removidos === 1
            ? '1 bloqueio futuro removido da Agenda Google'
            : `${response.removidos} bloqueios futuros removidos da Agenda Google`,
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
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            {canPickProfissional && (
              <SelectField
                label="Profissional"
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

            <SelectField
              label="Tipo"
              value={form.tipo}
              onChange={(value) => updateForm({ tipo: value as AgendaBloqueioTipo })}
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
              onDateChange={(value) => updateForm({ inicioData: value })}
              onTimeChange={(value) => updateForm({ inicioHora: value })}
              error={errors.inicio}
            />

            <DateTimeField
              label="Fim"
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
                Motivo
              </label>
              <textarea
                id={motivoId}
                value={form.motivo}
                onChange={(event) => updateForm({ motivo: event.target.value })}
                maxLength={240}
                rows={3}
                placeholder="Opcional"
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
                    {(Object.keys(BLOQUEIO_PERIODICIDADE_LABELS) as Periodicidade[]).map(
                      (value) => {
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
                      },
                    )}
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
                            : 'Cada ocorrencia marcada sera enviada para a Agenda Google do profissional.'}
                        </p>
                      </div>
                      {!resultadoSerie && (
                        <Pill className="border-line-strong bg-surface-sunken text-ink-soft">
                          {contagemSerie.marcados} de {contagemSerie.total} marcados
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
                        O que estiver desmarcado nao sera enviado para a Agenda Google.
                      </p>
                    )}

                    <ReviewList
                      ocorrencias={revisaoSerie}
                      resultado={resultadoSerie}
                      timeZone={timeZone}
                      loading={createSerieMutation.isPending}
                      onToggle={toggleRevisao}
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
                    {bloqueio.tipo === 'almoco' ? (
                      <IconPause size={18} />
                    ) : (
                      <IconCalendar size={18} />
                    )}
                  </span>

                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <p className="font-display text-[15px] font-semibold text-ink">
                        Bloqueio na Agenda Google
                      </p>
                      <Pill className={tipoTone(bloqueio.tipo)}>
                        {BLOQUEIO_TIPO_LABEL[bloqueio.tipo]}
                      </Pill>
                      {profissionalNome && (
                        <Pill className="border-line-strong bg-surface-sunken text-ink-soft">
                          {profissionalNome}
                        </Pill>
                      )}
                      {bloqueio.serie_id && (
                        <Pill className="border-line-strong bg-surface-sunken text-ink-soft">
                          Serie
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
                        {blockRangeLabel(bloqueio.inicio_at, bloqueio.fim_at, timeZone)}
                      </span>
                    </div>

                    <p className="mt-2 text-[12.5px] leading-snug text-ink-faint">
                      Evento de bloqueio na Agenda Google do profissional.
                    </p>

                    {bloqueio.motivo && (
                      <p className="mt-2 text-[13px] leading-normal text-ink-soft">
                        {bloqueio.motivo}
                      </p>
                    )}

                    {bloqueio.status === 'gcal_cleanup_failed' && (
                      <p className="mt-2 inline-flex items-center gap-1.5 text-[12.5px] font-medium text-amber-200">
                        <IconAlert size={14} />
                        Remova daqui para tentar limpar de novo na Agenda Google.
                      </p>
                    )}

                    <div className="mt-3 flex flex-wrap gap-2">
                      {bloqueio.serie_id && (
                        <Button
                          variant="secondary"
                          size="inline"
                          className="h-10 px-3 text-[13px]"
                          onClick={() =>
                            setConfirmRemoveSerie({
                              serieId: bloqueio.serie_id ?? '',
                              referencia: blockRangeLabel(
                                bloqueio.inicio_at,
                                bloqueio.fim_at,
                                timeZone,
                              ),
                            })
                          }
                        >
                          <IconRefresh size={15} />
                          Remover serie
                        </Button>
                      )}
                      <Button
                        variant="destructive"
                        size="inline"
                        className="h-10 px-3 text-[13px]"
                        onClick={() => setConfirmRemove(bloqueio)}
                      >
                        <IconTrash size={15} />
                        Remover este
                      </Button>
                    </div>
                  </div>
                </div>
              </div>
            );
          })
        )}
      </div>

      <ConfirmDialog
        open={Boolean(confirmRemove)}
        title="Remover este bloqueio?"
        description="Esse horario volta a ficar livre na Agenda Google do profissional."
        confirmLabel="Remover"
        confirmVariant="destructive"
        loading={removeMutation.isPending}
        icon={<IconTrash size={20} />}
        onCancel={() => setConfirmRemove(null)}
        onConfirm={() => confirmRemove && removeBloqueio(confirmRemove.id)}
      />

      <ConfirmDialog
        open={Boolean(confirmRemoveSerie)}
        title="Remover a serie futura?"
        description={
          confirmRemoveSerie
            ? `Os proximos bloqueios desta serie serao removidos da Agenda Google a partir de ${confirmRemoveSerie.referencia}.`
            : ''
        }
        confirmLabel="Remover serie"
        confirmVariant="destructive"
        loading={removeSerieMutation.isPending}
        icon={<IconRefresh size={20} />}
        onCancel={() => setConfirmRemoveSerie(null)}
        onConfirm={() => confirmRemoveSerie && removeSerie(confirmRemoveSerie.serieId)}
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
            ? 'Reserve almoco, ausencia, ferias ou indisponibilidade na sua Agenda Google.'
            : 'Trave horarios sem cliente e, se quiser, repita a serie com revisao antes de gravar na Agenda Google.'}
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

function ReviewList({
  ocorrencias,
  resultado,
  timeZone,
  loading,
  onToggle,
}: {
  ocorrencias: RevisaoAgendaBloqueioRecorrencia[];
  resultado: CriarAgendaBloqueioSerieResponse | null;
  timeZone: string;
  loading: boolean;
  onToggle: (index: number) => void;
}) {
  const falhasPorChave = useMemo(() => {
    const map = new Map<string, { error: string; reason: string }>();
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
      {ocorrencias.map((ocorrencia, index) => {
        const chave = `${ocorrencia.inicio_at}|${ocorrencia.fim_at}`;
        const falha = falhasPorChave.get(chave);
        const criada = criadosSet.has(chave);
        const statusBase = statusAgendaBloqueioRecorrenciaLabel(ocorrencia.status);
        return (
          <li
            key={chave}
            className={cn(
              'flex gap-3 py-3',
              falha && 'bg-danger/6',
              criada && 'bg-brand/6',
              !resultado && ocorrencia.status !== 'livre' && 'bg-amber-400/6',
            )}
          >
            {!resultado ? (
              <input
                type="checkbox"
                aria-label={`Enviar ${blockRangeLabel(ocorrencia.inicio_at, ocorrencia.fim_at, timeZone)} para a Agenda Google`}
                checked={ocorrencia.marcado}
                disabled={loading}
                onChange={() => onToggle(index)}
                className="mt-0.5 size-[18px] shrink-0 rounded border-[1.5px] border-line-strong bg-surface-sunken text-brand outline-none focus-visible:ring-2 focus-visible:ring-brand"
              />
            ) : (
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
                ) : ocorrencia.marcado ? (
                  <Pill className="border-brand/40 bg-brand-soft text-brand">
                    Vai para a agenda
                  </Pill>
                ) : (
                  <Pill className="border-line-strong bg-surface-sunken text-ink-soft">
                    Fora da serie
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
                  : ocorrencia.status === 'livre'
                    ? ocorrencia.marcado
                      ? 'Livre para inserir na Agenda Google do profissional.'
                      : 'Livre, mas nao sera enviado para a Agenda Google.'
                    : statusBase}
              </p>

              {!resultado && ocorrencia.status !== 'livre' && (
                <p className="mt-1 text-[12px] leading-snug text-amber-200">
                  {ocorrencia.marcado
                    ? 'Marcado mesmo com conflito. O resultado final depende da Agenda Google no instante da criacao.'
                    : 'Desmarcado por padrao para nao tentar gravar esse conflito na Agenda Google.'}
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
