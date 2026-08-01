'use client';

/**
 * Novo agendamento (Missão 020 F4, Fluxo B) — o dono marca um horário pra um
 * cliente final SEM passar pelo robô. 4 decisões numa tela só (doc 020 B3):
 * serviço (radio) → dia (strip semanal navegável, horizonte de 365d — Bruno
 * 31/07) → horário (grade SÓ de livres, agrupada manhã/tarde/noite) → nome
 * (+ WhatsApp opcional) → confirmar.
 *
 * Estados (020 B4):
 *  - serviços: skeleton / erro+retry / vazio → "Cadastre um serviço primeiro".
 *  - agenda Google não conectada (gcal_configured:false ou 422) → estado
 *    explicativo com CTA pro suporte (conexão self-service é fase 3).
 *  - dia fechado (aberto:false) / dia lotado (count 0 🎉) / erro da grade.
 *  - 201 → toast sucesso + prepend no cache da lista da Início (useCriarAgendamento)
 *    + volta pra /inicio. 409 → aviso amber inline + grade recarregada, mantendo
 *    dia/serviço. Trocar serviço com horário escolhido limpa a hora com aviso.
 *
 * Cancelar/remarcar é fase 2 (020 B8) — esta tela só CRIA.
 */
import { ContactSheet } from '@/components/contatos/contact-sheet';
import {
  IconAlert,
  IconCalendar,
  IconCheck,
  IconChevronLeft,
  IconChevronRight,
  IconRefresh,
  IconScissors,
  IconUsers,
  IconWhatsapp,
} from '@/components/icons';
import { useTenant } from '@/components/shell/session-context';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Overlay } from '@/components/ui/overlay';
import { Skeleton, SkeletonList, skeletonKeys } from '@/components/ui/skeleton';
import { EmptyState, ErrorState } from '@/components/ui/states';
import { Switch } from '@/components/ui/switch';
import { useToast } from '@/components/ui/toast';
import { ApiError } from '@/lib/api';
import {
  type Colaborador,
  type ConflitoReason,
  type CriarSerieResponse,
  OCORRENCIAS_MAX,
  OCORRENCIAS_MIN,
  type Periodicidade,
  type RecentContact,
  type Servico,
  type SlotsGrupos,
} from '@/lib/api-types';
import { cn } from '@/lib/cn';
import { formatDuracao, formatPrecoCents } from '@/lib/format';
import {
  type NovoAgendamentoCliente,
  type NovoAgendamentoErrors,
  PERIODICIDADE_LABELS,
  type RevisaoOcorrencia,
  addMinutosHora,
  buildCriarAgendamentoBody,
  buildCriarSerieBody,
  buildPreviewRecorrenciaBody,
  buildWeekStrip,
  contarMarcados,
  formatDiaCurto,
  formatDiaExtenso,
  formatIntervaloSemana,
  formatPhoneBR,
  initRevisaoOcorrencias,
  podeAvancarSemana,
  podeVoltarSemana,
  resumoResultadoSerie,
  statusOcorrenciaLabel,
  validateNovoAgendamento,
} from '@/lib/novo-agendamento';
import {
  useAgendaSlots,
  useAgendamentos,
  useCriarAgendamento,
  useCriarSerie,
  useEquipe,
  useHorarios,
  usePreviewRecorrencia,
  useServicos,
} from '@/lib/queries';
import { SUPORTE_WHATSAPP_URL } from '@/lib/suporte';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useMemo, useState } from 'react';

const CONFLITO_MSG: Record<ConflitoReason, string> = {
  ocupado: 'Esse horário acabou de ser ocupado. Escolha outro.',
  horario_passado: 'Esse horário já passou. Escolha outro.',
  fora_do_horario: 'Esse horário ficou fora do seu funcionamento. Escolha outro.',
};

function is422(err: unknown): boolean {
  return err instanceof ApiError && err.status === 422;
}

/** Código `error` do corpo de um ApiError (ex.: 'colaborador_obrigatorio'). */
function errorCode(err: unknown): string | null {
  if (err instanceof ApiError && err.body && typeof err.body === 'object' && 'error' in err.body) {
    const e = (err.body as { error?: unknown }).error;
    if (typeof e === 'string') return e;
  }
  return null;
}

/** 422/404 do estabelecimento sobre o profissional — toast, NÃO bloqueio de gcal. */
function isColaboradorErro(err: unknown): boolean {
  const code = errorCode(err);
  return code === 'colaborador_obrigatorio' || code === 'colaborador_nao_encontrado';
}

/**
 * Copy de UMA falha do POST /serie (shape `falhas[].reason` do backend:
 * status de avaliarSlot reaproveitado + 'gcal_rate_limit'/'erro_gcal').
 * Reusa statusOcorrenciaLabel pros reasons que casam com o enum de status;
 * fallback pros reasons exclusivos do /serie (rate-limit/erro de rede).
 */
function falhaOcorrenciaLabel(reason: string): string {
  if (reason === 'gcal_rate_limit') return 'A agenda ficou sobrecarregada nesse momento';
  if (reason === 'erro_gcal') return 'Não foi possível confirmar com a agenda';
  return statusOcorrenciaLabel(reason as Parameters<typeof statusOcorrenciaLabel>[0]);
}

/** Extrai o `reason` do corpo do 409 (shape do POST /portal/agendamentos). */
function conflitoReason(body: unknown): ConflitoReason {
  if (body && typeof body === 'object' && 'reason' in body) {
    const r = (body as { reason?: unknown }).reason;
    if (r === 'ocupado' || r === 'horario_passado' || r === 'fora_do_horario') return r;
  }
  return 'ocupado';
}

export default function NovoAgendamentoPage() {
  const { slot, productType } = useTenant();
  const router = useRouter();
  const toast = useToast();
  const isEstabelecimento = productType === 'estabelecimento';

  const servicosQ = useServicos(slot);
  const horariosQ = useHorarios(slot);
  // Só pro pré-check da agenda Google (mesma query da Início — cache quente).
  const agendamentosQ = useAgendamentos(slot);
  // Profissionais: só no estabelecimento (no individual não há quem escolher).
  const equipeQ = useEquipe(isEstabelecimento ? slot : '');

  const [servicoSel, setServicoSel] = useState<string | null>(null);
  const [dataSel, setDataSel] = useState<string | null>(null);
  const [horaSel, setHoraSel] = useState<string | null>(null);
  /** Semana exibida no strip de Dia (0 = semana atual). Navegação até MAX_AHEAD_DAYS. */
  const [weekOffset, setWeekOffset] = useState(0);
  const [colaboradorSel, setColaboradorSel] = useState<number | null>(null);
  /** Erro inline do seletor de profissional (obrigatório no estabelecimento). */
  const [colaboradorErro, setColaboradorErro] = useState<string | null>(null);
  const [nome, setNome] = useState('');
  const [telefone, setTelefone] = useState('');
  /** Checkbox "Não tenho o WhatsApp deste cliente" — escape hatch do telefone obrigatório. */
  const [semWhatsapp, setSemWhatsapp] = useState(false);
  const [contatoSheetOpen, setContatoSheetOpen] = useState(false);
  const [errors, setErrors] = useState<NovoAgendamentoErrors>({});
  /** Aviso amber inline na grade (409 / troca de serviço com hora escolhida). */
  const [aviso, setAviso] = useState<string | null>(null);
  /** 422 no POST (gcal_nao_configurado/config_ausente) — vira o estado explicativo. */
  const [gcalBloqueado, setGcalBloqueado] = useState(false);

  // Recorrência: "os usuários que têm agenda podem além de criar um único
  // agendamento poder vincular serviços recorrentes" (Bruno). Conflitos aparecem
  // ANTES de gravar — revisaoOcorrencias é o estado da tela de revisão (nulo até
  // o preview voltar; o dono desmarca/ajusta e só então confirma via /serie).
  const [repetir, setRepetir] = useState(false);
  const [periodicidade, setPeriodicidade] = useState<Periodicidade>('semanal');
  const [ocorrencias, setOcorrencias] = useState(4);
  const [revisaoOcorrencias, setRevisaoOcorrencias] = useState<RevisaoOcorrencia[] | null>(null);
  const [resultadoSerie, setResultadoSerie] = useState<CriarSerieResponse | null>(null);

  // No estabelecimento a grade tem que olhar a agenda DO PROFISSIONAL escolhido (que já é
  // selecionado antes da grade); senão o backend não acha agenda própria do clone e devolve
  // gcal_configured:false em todo dia. No individual passamos null (single-agenda, inalterado).
  const slotsQ = useAgendaSlots(
    slot,
    dataSel,
    servicoSel,
    isEstabelecimento ? colaboradorSel : null,
  );
  const criar = useCriarAgendamento(slot);
  const preview = usePreviewRecorrencia();
  const criarSerie = useCriarSerie(slot);

  const servicos = servicosQ.data ?? [];
  const servico = servicos.find((s) => s.nome === servicoSel) ?? null;
  const strip = useMemo(
    () => buildWeekStrip(horariosQ.data, weekOffset),
    [horariosQ.data, weekOffset],
  );
  const intervaloSemana = useMemo(() => formatIntervaloSemana(strip), [strip]);
  // Só ativos podem ser escolhidos (mesma regra da tela de Atendimento).
  const colaboradores = (equipeQ.data?.colaboradores ?? []).filter((c) => c.ativo);

  // Agenda Google não conectada: pelo cache da Início, pela resposta da grade
  // ou por 422 (grade/POST). Estado explicativo — conectar é fase 3.
  const gcalOff =
    gcalBloqueado ||
    agendamentosQ.data?.gcal_configured === false ||
    slotsQ.data?.gcal_configured === false ||
    is422(slotsQ.error);

  function selecionarServico(nomeServico: string) {
    if (nomeServico === servicoSel) return;
    setServicoSel(nomeServico);
    if (horaSel) {
      setHoraSel(null);
      setAviso('A duração mudou — escolha o horário de novo.');
    }
  }

  function selecionarDia(dateKey: string) {
    if (dateKey === dataSel) return;
    setDataSel(dateKey);
    setHoraSel(null);
    setAviso(null);
  }

  /** Troca de semana: mesma regra de "muda o contexto → limpa a hora" das trocas de serviço/profissional. */
  function navegarSemana(delta: 1 | -1) {
    setWeekOffset((w) => w + delta);
    if (horaSel) {
      setHoraSel(null);
      setAviso('Você trocou de semana — escolha o horário de novo.');
    }
  }

  function selecionarHora(hora: string) {
    setHoraSel(hora);
    setAviso(null);
  }

  function selecionarColaborador(id: number) {
    if (id === colaboradorSel) return;
    setColaboradorSel(id);
    setColaboradorErro(null);
    // A grade agora reflete a agenda DESTE profissional — uma hora escolhida pra outro
    // pode não existir nela. Zera a hora pra evitar submeter um slot que sumiu da grade.
    if (horaSel) {
      setHoraSel(null);
      setAviso('Você trocou de profissional — escolha o horário de novo.');
    }
  }

  // No estabelecimento, escolher o profissional é parte da prontidão.
  const profissionalOk = !isEstabelecimento || colaboradorSel != null;
  const pronto = Boolean(servico && dataSel && horaSel && nome.trim() && profissionalOk);

  function onSelecionarContato(c: RecentContact) {
    setContatoSheetOpen(false);
    setTelefone(formatPhoneBR(c.phone));
    setSemWhatsapp(false);
    setErrors((prev) => ({ ...prev, telefone: undefined }));
  }

  function onConfirmar() {
    const res = validateNovoAgendamento({ nome, telefone, semWhatsapp });
    if (!res.ok) {
      setErrors(res.errors);
      return;
    }
    setErrors({});
    if (!servico || !dataSel || !horaSel) return;

    if (repetir) {
      onPreviewRecorrencia({ servico, dataSel, horaSel, cliente: res.value });
      return;
    }

    // Monta o body com o gating de profissional do backend (estabelecimento exige
    // colaborador_id; individual nunca envia). Trava antes de bater na API.
    const built = buildCriarAgendamentoBody({
      productType,
      base: { servico: servico.nome, data: dataSel, hora: horaSel, ...res.value },
      colaboradorId: colaboradorSel,
    });
    if (!built.ok) {
      setColaboradorErro('Escolha o profissional que vai atender.');
      return;
    }
    setColaboradorErro(null);

    criar.mutate(built.body, {
      onSuccess: () => {
        toast.success(`Horário marcado: ${servico.nome} · ${formatDiaCurto(dataSel)} · ${horaSel}`);
        router.push('/inicio');
      },
      onError: (err) => {
        if (err instanceof ApiError && err.status === 409) {
          // Conflito de corrida com o robô: o slot escolhido some, a grade
          // recarrega e dia/serviço ficam como estavam (020 B4).
          setHoraSel(null);
          setAviso(CONFLITO_MSG[conflitoReason(err.body)]);
          slotsQ.refetch();
          return;
        }
        // Estabelecimento: profissional faltando (422) ou inválido (404) — toast
        // claro + erro inline no seletor. Precede o bloqueio de gcal (mesmo 422).
        if (isColaboradorErro(err)) {
          setColaboradorErro('Escolha o profissional que vai atender.');
          toast.error('Escolha um profissional pra marcar o horário.');
          return;
        }
        if (is422(err)) {
          setGcalBloqueado(true);
          return;
        }
        toast.error('Não foi possível marcar. Tente de novo.');
      },
    });
  }

  /**
   * Recorrência passo 1: SÓ LÊ (preview). Decisão do Bruno: conflitos aparecem
   * ANTES de gravar — abre a tela de revisão com o estado inicial de seleção
   * (livre marcado, o resto desmarcado por padrão).
   */
  function onPreviewRecorrencia(args: {
    servico: Servico;
    dataSel: string;
    horaSel: string;
    cliente: NovoAgendamentoCliente;
  }) {
    const { servico: svc, dataSel: data, horaSel: hora, cliente } = args;
    const built = buildPreviewRecorrenciaBody({
      productType,
      base: { servico: svc.nome, data, hora, ...cliente },
      colaboradorId: colaboradorSel,
      periodicidade,
      ocorrencias,
    });
    if (!built.ok) {
      setColaboradorErro('Escolha o profissional que vai atender.');
      return;
    }
    setColaboradorErro(null);

    preview.mutate(built.body, {
      onSuccess: (resp) => {
        setRevisaoOcorrencias(initRevisaoOcorrencias(resp.previews));
      },
      onError: (err) => {
        if (isColaboradorErro(err)) {
          setColaboradorErro('Escolha o profissional que vai atender.');
          toast.error('Escolha um profissional pra marcar o horário.');
          return;
        }
        if (is422(err)) {
          setGcalBloqueado(true);
          return;
        }
        toast.error('Não foi possível calcular a série agora. Tente de novo.');
      },
    });
  }

  /** Alterna a marcação de UMA ocorrência na tela de revisão. */
  function onToggleOcorrencia(index: number) {
    setRevisaoOcorrencias((prev) =>
      prev ? prev.map((o, i) => (i === index ? { ...o, marcado: !o.marcado } : o)) : prev,
    );
  }

  /** Recorrência passo 2: grava só as datas MARCADAS pelo dono na revisão. */
  function onConfirmarSerie() {
    if (!servico || !revisaoOcorrencias) return;
    const res = validateNovoAgendamento({ nome, telefone, semWhatsapp });
    if (!res.ok) return; // já validado no passo 1; defensivo.

    const built = buildCriarSerieBody({
      productType,
      servico: servico.nome,
      cliente: res.value,
      colaboradorId: colaboradorSel,
      ocorrencias: revisaoOcorrencias,
    });
    if (!built.ok) {
      setColaboradorErro('Escolha o profissional que vai atender.');
      return;
    }

    criarSerie.mutate(built.body, {
      onSuccess: (resp) => {
        setResultadoSerie(resp);
      },
      onError: (err) => {
        if (err instanceof ApiError && err.status === 409) {
          // Nenhuma ocorrência entrou — o corpo do 409 tem o mesmo shape (falhas).
          setResultadoSerie(err.body as CriarSerieResponse);
          return;
        }
        if (is422(err)) {
          setGcalBloqueado(true);
          setRevisaoOcorrencias(null);
          return;
        }
        toast.error('Não foi possível criar a série agora. Tente de novo.');
      },
    });
  }

  function onFecharRevisao() {
    setRevisaoOcorrencias(null);
    setResultadoSerie(null);
  }

  function onConcluirSerie() {
    onFecharRevisao();
    router.push('/inicio');
  }

  return (
    <>
      {/* Cabeçalho com voltar (página dedicada — back do navegador = cancelar). */}
      <div className="mb-[18px] flex items-start gap-3">
        <Link
          href="/inicio"
          aria-label="Voltar pro Início"
          className="mt-0.5 flex size-11 shrink-0 items-center justify-center rounded-[11px] border border-line-strong bg-surface text-ink-soft outline-none transition-colors hover:bg-surface-hover hover:text-ink focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-2 focus-visible:ring-offset-bg"
        >
          <IconChevronLeft size={20} />
        </Link>
        <div>
          <h1 className="font-display text-[22px] font-bold tracking-[-0.01em] text-ink">
            Novo agendamento
          </h1>
          <p className="mt-1 text-[13.5px] leading-snug text-ink-soft">
            Marque um horário pra um cliente, sem passar pelo assistente.
          </p>
        </div>
      </div>

      {gcalOff ? (
        <GcalPendente />
      ) : servicosQ.isPending ? (
        <>
          <span className="sr-only">Carregando seus serviços…</span>
          <SkeletonList rows={3} />
        </>
      ) : servicosQ.isError ? (
        <ErrorState onRetry={() => servicosQ.refetch()} />
      ) : servicos.length === 0 ? (
        <EmptyState
          icon={<IconScissors size={26} />}
          title="Cadastre um serviço primeiro"
          description="É o serviço que define a duração do horário. Leva menos de um minuto."
          action={{ label: 'Ir pra Serviços', onClick: () => router.push('/negocio/servicos') }}
        />
      ) : (
        <div className="space-y-6">
          {/* 0. Profissional — só estabelecimento (individual = 1 agenda só). */}
          {isEstabelecimento && (
            <section aria-labelledby="sec-profissional">
              <h2
                id="sec-profissional"
                className="mx-0.5 mb-2.5 font-display text-[15px] font-semibold text-ink"
              >
                Profissional
              </h2>
              {equipeQ.isPending ? (
                <SkeletonList rows={2} />
              ) : equipeQ.isError ? (
                <ErrorState
                  title="Não foi possível carregar a equipe"
                  onRetry={() => equipeQ.refetch()}
                />
              ) : colaboradores.length === 0 ? (
                <NotaGrade texto="Nenhum profissional ativo. Cadastre um em Equipe pra marcar horários.">
                  <Button
                    variant="secondary"
                    size="inline"
                    onClick={() => router.push('/negocio/equipe')}
                  >
                    Ir pra Equipe
                  </Button>
                </NotaGrade>
              ) : (
                <ProfissionalRadioList
                  colaboradores={colaboradores}
                  selecionado={colaboradorSel}
                  onPick={selecionarColaborador}
                />
              )}
              {colaboradorErro && (
                <p role="alert" className="mx-0.5 mt-2 text-[13px] font-medium text-danger">
                  {colaboradorErro}
                </p>
              )}
            </section>
          )}

          {/* 1. Serviço */}
          <section aria-labelledby="sec-servico">
            <h2
              id="sec-servico"
              className="mx-0.5 mb-2.5 font-display text-[15px] font-semibold text-ink"
            >
              Serviço
            </h2>
            <ServiceRadioList
              servicos={servicos}
              selecionado={servicoSel}
              onPick={selecionarServico}
            />
          </section>

          {/* 2. Dia */}
          <section aria-labelledby="sec-dia">
            <div className="mx-0.5 mb-2.5 flex items-center justify-between gap-2">
              <h2 id="sec-dia" className="font-display text-[15px] font-semibold text-ink">
                Dia
              </h2>
              <div className="flex items-center gap-1.5">
                <button
                  type="button"
                  disabled={!podeVoltarSemana(weekOffset)}
                  aria-label="Semana anterior"
                  onClick={() => navegarSemana(-1)}
                  className="flex size-8 items-center justify-center rounded-full text-ink-soft outline-none transition-colors hover:bg-surface-hover focus-visible:ring-2 focus-visible:ring-brand disabled:cursor-not-allowed disabled:opacity-30 disabled:hover:bg-transparent"
                >
                  <IconChevronLeft size={18} />
                </button>
                <span className="min-w-[104px] text-center text-[12.5px] font-medium text-ink-soft">
                  {intervaloSemana}
                </span>
                <button
                  type="button"
                  disabled={!podeAvancarSemana(weekOffset)}
                  aria-label="Próxima semana"
                  onClick={() => navegarSemana(1)}
                  className="flex size-8 items-center justify-center rounded-full text-ink-soft outline-none transition-colors hover:bg-surface-hover focus-visible:ring-2 focus-visible:ring-brand disabled:cursor-not-allowed disabled:opacity-30 disabled:hover:bg-transparent"
                >
                  <IconChevronRight size={18} />
                </button>
              </div>
            </div>
            <div
              role="radiogroup"
              aria-label="Escolha o dia"
              className="flex gap-2 overflow-x-auto pb-1"
            >
              {strip.map((d) => {
                const ativo = d.dateKey === dataSel;
                const desabilitado = d.fechado || d.passado || d.foraDaJanela;
                return (
                  <button
                    key={d.dateKey}
                    type="button"
                    role="radio"
                    aria-checked={ativo}
                    disabled={desabilitado}
                    aria-label={`${d.longo}${d.fechado ? ' — fechado' : ''}`}
                    onClick={() => selecionarDia(d.dateKey)}
                    className={cn(
                      'flex min-w-[64px] shrink-0 flex-col items-center gap-0.5 rounded-card-sm border px-2 py-2.5 outline-none transition-colors focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-2 focus-visible:ring-offset-bg',
                      ativo
                        ? 'border-brand bg-brand-soft'
                        : 'border-line bg-surface hover:bg-surface-hover',
                      desabilitado && 'cursor-not-allowed opacity-45 hover:bg-surface',
                    )}
                  >
                    <span
                      className={cn(
                        'text-[12px] font-semibold',
                        ativo ? 'text-brand' : 'text-ink-soft',
                      )}
                    >
                      {d.label}
                    </span>
                    <span
                      className={cn(
                        'font-display text-[17px] font-bold tabular-nums',
                        ativo ? 'text-brand' : 'text-ink',
                      )}
                    >
                      {d.diaNum}
                    </span>
                    <span className="text-[10.5px] text-ink-faint">
                      {d.fechado ? 'Fechado' : d.passado ? 'Passou' : ' '}
                    </span>
                  </button>
                );
              })}
            </div>
          </section>

          {/* 3. Horários livres — só com serviço E dia escolhidos. */}
          {servico && dataSel ? (
            <section aria-labelledby="sec-horarios" aria-live="polite">
              <h2
                id="sec-horarios"
                className="mx-0.5 mb-2.5 font-display text-[15px] font-semibold text-ink"
              >
                Horários livres · {formatDiaExtenso(dataSel)}
              </h2>

              {aviso && (
                <p
                  role="status"
                  className="mb-2.5 rounded-card-sm border border-amber/40 bg-amber-soft px-3.5 py-2.5 text-[13.5px] font-medium text-amber"
                >
                  {aviso}
                </p>
              )}

              {slotsQ.isPending ? (
                <>
                  <span className="sr-only">Procurando horários livres…</span>
                  <div aria-hidden className="grid grid-cols-4 gap-2 sm:grid-cols-6">
                    {skeletonKeys(8).map((k) => (
                      <Skeleton key={k} className="h-10 rounded-pill" />
                    ))}
                  </div>
                </>
              ) : slotsQ.isError ? (
                <NotaGrade texto="Não conseguimos ver a agenda agora.">
                  <Button variant="secondary" size="inline" onClick={() => slotsQ.refetch()}>
                    Tentar de novo
                  </Button>
                </NotaGrade>
              ) : !slotsQ.data.aberto ? (
                <NotaGrade texto="Fechado nesse dia. Escolha outro na lista acima." />
              ) : slotsQ.data.count === 0 ? (
                <NotaGrade texto="Esse dia já tá cheio 🎉 Tente outro dia." />
              ) : (
                <SlotGrid grupos={slotsQ.data.grupos} horaSel={horaSel} onPick={selecionarHora} />
              )}
            </section>
          ) : (
            <p className="mx-0.5 text-[13.5px] text-ink-soft">
              Escolha o serviço e o dia pra ver os horários livres.
            </p>
          )}

          {/* 4. Cliente */}
          <section aria-labelledby="sec-cliente" className="space-y-3">
            <h2 id="sec-cliente" className="mx-0.5 font-display text-[15px] font-semibold text-ink">
              Cliente
            </h2>
            <Input
              label="Nome do cliente"
              value={nome}
              error={errors.nome}
              autoComplete="off"
              onChange={(e) => setNome(e.target.value)}
            />
            <div>
              <div className="mb-2 flex items-center justify-between gap-2">
                <label htmlFor="telefone-cliente" className="text-[13px] font-semibold text-ink">
                  WhatsApp do cliente
                </label>
                <button
                  type="button"
                  onClick={() => setContatoSheetOpen(true)}
                  className="flex h-8 shrink-0 items-center gap-1.5 rounded-pill border border-line-strong bg-surface px-3 font-display text-[12.5px] font-semibold text-brand outline-none transition-colors hover:bg-surface-hover focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-2 focus-visible:ring-offset-bg"
                >
                  <IconUsers size={14} />
                  Escolher dos contatos
                </button>
              </div>
              <Input
                id="telefone-cliente"
                hideLabel
                label="WhatsApp do cliente"
                type="tel"
                inputMode="tel"
                placeholder="(11) 99999-9999"
                value={telefone}
                error={errors.telefone}
                autoComplete="off"
                disabled={semWhatsapp}
                onChange={(e) => setTelefone(formatPhoneBR(e.target.value))}
              />
              <p className="mt-1.5 text-[12.5px] leading-snug text-ink-faint">
                Abra o WhatsApp do cliente, copie o número de lá e cole aqui — a gente formata. É o
                número que recebe o lembrete automático do horário.
              </p>
              <label className="mt-2.5 flex cursor-pointer items-start gap-2.5 rounded-card-sm border border-line bg-surface px-3.5 py-3">
                <input
                  type="checkbox"
                  checked={semWhatsapp}
                  onChange={(e) => {
                    setSemWhatsapp(e.target.checked);
                    if (e.target.checked) setTelefone('');
                    setErrors((prev) => ({ ...prev, telefone: undefined }));
                  }}
                  className="mt-0.5 size-[18px] shrink-0 rounded border-[1.5px] border-line-strong bg-surface-sunken text-brand outline-none focus-visible:ring-2 focus-visible:ring-brand"
                />
                <span className="text-[13px] leading-snug text-ink-soft">
                  Não tenho o WhatsApp deste cliente
                  <span className="block text-[12px] text-ink-faint">
                    Sem número, não tem lembrete automático pra esse horário.
                  </span>
                </span>
              </label>
            </div>
          </section>

          {/* 5. Repetição — Frente 4 (recorrência). Conflitos aparecem ANTES de
              gravar (decisão do Bruno): ligar o toggle não cria nada ainda. */}
          <section aria-labelledby="sec-repetir" className="space-y-3">
            <div className="flex items-center justify-between gap-3 rounded-card-sm border border-line bg-surface px-4 py-3.5">
              <div>
                <h2 id="sec-repetir" className="font-display text-[15px] font-semibold text-ink">
                  Repetir esse agendamento
                </h2>
                <p className="mt-0.5 text-[12.5px] leading-snug text-ink-soft">
                  Cria vários horários de uma vez, no mesmo dia da semana e hora.
                </p>
              </div>
              <Switch checked={repetir} onChange={setRepetir} label="Repetir esse agendamento" />
            </div>

            {repetir && (
              <div className="space-y-3 rounded-card-sm border border-line bg-surface px-4 py-3.5">
                <div>
                  <span className="mb-2 block text-[13px] font-semibold text-ink">
                    Com que frequência?
                  </span>
                  <div
                    role="radiogroup"
                    aria-label="Frequência da repetição"
                    className="grid grid-cols-2 gap-2"
                  >
                    {(Object.keys(PERIODICIDADE_LABELS) as Periodicidade[]).map((p) => {
                      const ativo = p === periodicidade;
                      return (
                        <button
                          key={p}
                          type="button"
                          role="radio"
                          aria-checked={ativo}
                          onClick={() => setPeriodicidade(p)}
                          className={cn(
                            'h-11 rounded-field border px-3 font-display text-[13.5px] font-semibold outline-none transition-colors focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-2 focus-visible:ring-offset-bg',
                            ativo
                              ? 'border-brand bg-brand-soft text-brand'
                              : 'border-line bg-surface-sunken text-ink hover:bg-surface-hover',
                          )}
                        >
                          {PERIODICIDADE_LABELS[p]}
                        </button>
                      );
                    })}
                  </div>
                </div>

                <div>
                  <label
                    htmlFor="ocorrencias"
                    className="mb-2 block text-[13px] font-semibold text-ink"
                  >
                    Quantas vezes?
                  </label>
                  <div className="flex items-center gap-3">
                    <button
                      type="button"
                      aria-label="Diminuir quantidade de vezes"
                      disabled={ocorrencias <= OCORRENCIAS_MIN}
                      onClick={() => setOcorrencias((o) => Math.max(OCORRENCIAS_MIN, o - 1))}
                      className="flex size-11 shrink-0 items-center justify-center rounded-field border border-line-strong bg-surface font-display text-[18px] font-semibold text-ink outline-none transition-colors hover:bg-surface-hover focus-visible:ring-2 focus-visible:ring-brand disabled:cursor-not-allowed disabled:opacity-40"
                    >
                      −
                    </button>
                    <span
                      id="ocorrencias"
                      className="min-w-[64px] text-center font-display text-[20px] font-bold tabular-nums text-ink"
                    >
                      {ocorrencias}×
                    </span>
                    <button
                      type="button"
                      aria-label="Aumentar quantidade de vezes"
                      disabled={ocorrencias >= OCORRENCIAS_MAX}
                      onClick={() => setOcorrencias((o) => Math.min(OCORRENCIAS_MAX, o + 1))}
                      className="flex size-11 shrink-0 items-center justify-center rounded-field border border-line-strong bg-surface font-display text-[18px] font-semibold text-ink outline-none transition-colors hover:bg-surface-hover focus-visible:ring-2 focus-visible:ring-brand disabled:cursor-not-allowed disabled:opacity-40"
                    >
                      +
                    </button>
                  </div>
                  <p className="mt-1.5 text-[12.5px] leading-snug text-ink-faint">
                    De {OCORRENCIAS_MIN} a {OCORRENCIAS_MAX} vezes. Você revisa cada data antes de
                    confirmar.
                  </p>
                </div>
              </div>
            )}
          </section>

          {/* Resumo vivo (prevenção de erro — sem dialog de confirmação). */}
          {(servico || dataSel || horaSel || nome.trim()) && (
            <div className="rounded-card-sm border border-line bg-surface px-4 py-3.5 shadow-card">
              <div className="font-display text-[14.5px] font-semibold text-ink">
                {[
                  servico?.nome,
                  dataSel ? formatDiaCurto(dataSel) : null,
                  horaSel && servico
                    ? `${horaSel}–${addMinutosHora(horaSel, servico.duracao_min)}`
                    : null,
                ]
                  .filter(Boolean)
                  .join(' · ')}
              </div>
              {nome.trim() && <div className="mt-0.5 text-[13px] text-ink-soft">{nome.trim()}</div>}
            </div>
          )}

          <Button
            disabled={!pronto}
            loading={criar.isPending || preview.isPending}
            loadingLabel={repetir ? 'Calculando as datas…' : 'Marcando…'}
            onClick={onConfirmar}
          >
            {repetir ? 'Ver datas da série' : 'Confirmar agendamento'}
          </Button>
        </div>
      )}

      <ContactSheet
        open={contatoSheetOpen}
        slot={slot}
        onClose={() => setContatoSheetOpen(false)}
        onSelect={onSelecionarContato}
      />

      {revisaoOcorrencias && servico && (
        <RevisaoSerieSheet
          servico={servico}
          periodicidade={periodicidade}
          ocorrencias={revisaoOcorrencias}
          resultado={resultadoSerie}
          loading={criarSerie.isPending}
          onToggle={onToggleOcorrencia}
          onConfirmar={onConfirmarSerie}
          onFechar={resultadoSerie ? onConcluirSerie : onFecharRevisao}
        />
      )}
    </>
  );
}

/** Lista radio de serviços (cards finos, 1 toque seleciona — 020 B3). */
function ServiceRadioList({
  servicos,
  selecionado,
  onPick,
}: {
  servicos: Servico[];
  selecionado: string | null;
  onPick: (nome: string) => void;
}) {
  return (
    <div
      role="radiogroup"
      aria-label="Escolha o serviço"
      className="overflow-hidden rounded-card border border-line bg-surface shadow-card"
    >
      {servicos.map((s) => {
        const ativo = s.nome === selecionado;
        return (
          <button
            key={s.nome}
            type="button"
            role="radio"
            aria-checked={ativo}
            onClick={() => onPick(s.nome)}
            className={cn(
              'flex min-h-[52px] w-full items-center gap-3 border-b border-line-soft px-[15px] py-3 text-left outline-none transition-colors last:border-b-0 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand',
              ativo ? 'bg-brand-soft' : 'hover:bg-surface-hover',
            )}
          >
            <span
              aria-hidden
              className={cn(
                'flex size-[18px] shrink-0 items-center justify-center rounded-full border-[1.5px]',
                ativo ? 'border-brand' : 'border-line-strong',
              )}
            >
              {ativo && <span className="size-2.5 rounded-full bg-brand" />}
            </span>
            <span
              className={cn(
                'min-w-0 flex-1 truncate font-display text-[15px] font-semibold',
                ativo ? 'text-brand' : 'text-ink',
              )}
            >
              {s.nome}
            </span>
            <span className="shrink-0 text-[12.5px] text-ink-soft">
              {formatDuracao(s.duracao_min)} · {formatPrecoCents(s.preco_cents)}
            </span>
          </button>
        );
      })}
    </div>
  );
}

/** Lista radio de profissionais (estabelecimento). 1 toque seleciona. */
function ProfissionalRadioList({
  colaboradores,
  selecionado,
  onPick,
}: {
  colaboradores: Colaborador[];
  selecionado: number | null;
  onPick: (id: number) => void;
}) {
  return (
    <div
      role="radiogroup"
      aria-label="Escolha o profissional"
      className="overflow-hidden rounded-card border border-line bg-surface shadow-card"
    >
      {colaboradores.map((c) => {
        const ativo = c.id === selecionado;
        return (
          <button
            key={c.id}
            type="button"
            role="radio"
            aria-checked={ativo}
            onClick={() => onPick(c.id)}
            className={cn(
              'flex min-h-[52px] w-full items-center gap-3 border-b border-line-soft px-[15px] py-3 text-left outline-none transition-colors last:border-b-0 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand',
              ativo ? 'bg-brand-soft' : 'hover:bg-surface-hover',
            )}
          >
            <span
              aria-hidden
              className={cn(
                'flex size-[18px] shrink-0 items-center justify-center rounded-full border-[1.5px]',
                ativo ? 'border-brand' : 'border-line-strong',
              )}
            >
              {ativo && <span className="size-2.5 rounded-full bg-brand" />}
            </span>
            <span
              className={cn(
                'min-w-0 flex-1 truncate font-display text-[15px] font-semibold',
                ativo ? 'text-brand' : 'text-ink',
              )}
            >
              {c.nome}
            </span>
          </button>
        );
      })}
    </div>
  );
}

/** Grade de pills SÓ com horários livres, agrupada manhã/tarde/noite. */
function SlotGrid({
  grupos,
  horaSel,
  onPick,
}: {
  grupos: SlotsGrupos;
  horaSel: string | null;
  onPick: (hora: string) => void;
}) {
  const ordem: { key: keyof SlotsGrupos; label: string }[] = [
    { key: 'manha', label: 'Manhã' },
    { key: 'tarde', label: 'Tarde' },
    { key: 'noite', label: 'Noite' },
  ];
  return (
    <div role="radiogroup" aria-label="Escolha o horário" className="space-y-3.5">
      {ordem.map(({ key, label }) =>
        grupos[key].length === 0 ? null : (
          <div key={key}>
            <h3 className="mb-1.5 text-[12.5px] font-semibold uppercase tracking-[0.05em] text-ink-faint">
              {label}
            </h3>
            <div className="grid grid-cols-4 gap-2 sm:grid-cols-6">
              {grupos[key].map((h) => {
                const ativo = h === horaSel;
                return (
                  <button
                    key={h}
                    type="button"
                    role="radio"
                    aria-checked={ativo}
                    onClick={() => onPick(h)}
                    className={cn(
                      'h-10 rounded-pill border font-display text-[13.5px] font-semibold tabular-nums outline-none transition-colors focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-2 focus-visible:ring-offset-bg',
                      ativo
                        ? 'border-brand bg-brand text-bg'
                        : 'border-line bg-surface text-ink hover:bg-surface-hover',
                    )}
                  >
                    {h}
                  </button>
                );
              })}
            </div>
          </div>
        ),
      )}
    </div>
  );
}

/** Nota compacta da grade (dia fechado / lotado / erro), com filho opcional. */
function NotaGrade({ texto, children }: { texto: string; children?: React.ReactNode }) {
  return (
    <div className="flex flex-col items-center gap-3 rounded-card-sm border border-line bg-surface px-5 py-6 text-center">
      <p className="text-[14px] text-ink-soft">{texto}</p>
      {children}
    </div>
  );
}

/**
 * Agenda Google não conectada (gcal_configured:false ou 422). Conexão
 * self-service é fase 3 (Fluxo A passo 4) — por ora o caminho é o suporte.
 */
function GcalPendente() {
  return (
    <div className="relative overflow-hidden rounded-card border border-line bg-surface px-6 pb-9 pt-8 text-center shadow-card">
      <span
        aria-hidden
        className="pointer-events-none absolute left-1/2 top-4 size-[120px] -translate-x-1/2 rounded-full"
        style={{ background: 'radial-gradient(circle, rgba(100,49,214,.18), transparent 70%)' }}
      />
      <span
        aria-hidden
        className="relative z-10 inline-flex size-14 items-center justify-center rounded-[16px] border border-line-strong bg-brand-soft text-brand"
      >
        <IconCalendar size={26} />
      </span>
      <h3 className="relative z-10 mt-3.5 font-display text-[17px] font-semibold text-ink">
        Conecte sua agenda Google pra marcar horários
      </h3>
      <p className="relative z-10 mx-auto mt-1.5 max-w-[36ch] text-[14px] leading-normal text-ink-soft">
        O assistente e o painel marcam na mesma agenda. Fale com a gente que conectamos a sua
        rapidinho.
      </p>
      <a
        href={SUPORTE_WHATSAPP_URL}
        target="_blank"
        rel="noreferrer"
        className="relative z-10 mt-5 inline-flex h-11 items-center justify-center gap-2 rounded-btn border border-line-strong bg-surface px-5 font-display text-[15px] font-semibold text-brand outline-none transition-colors hover:bg-surface-hover focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-2 focus-visible:ring-offset-bg"
      >
        <IconWhatsapp size={18} />
        Falar com o suporte
      </a>
    </div>
  );
}

/**
 * Tela de revisão da série (recorrência, Frente 4). Decisão do Bruno: conflitos
 * aparecem ANTES de gravar — o dono vê CADA data com seu status, desmarca o que
 * não quer (problemáticas já vêm desmarcadas por padrão) e só então confirma.
 * Depois do POST /serie, a MESMA sheet vira o resultado (207 é sucesso PARCIAL,
 * nunca "sucesso" puro quando algo falhou).
 */
function RevisaoSerieSheet({
  servico,
  periodicidade,
  ocorrencias,
  resultado,
  loading,
  onToggle,
  onConfirmar,
  onFechar,
}: {
  servico: Servico;
  periodicidade: Periodicidade;
  ocorrencias: RevisaoOcorrencia[];
  resultado: CriarSerieResponse | null;
  loading: boolean;
  onToggle: (index: number) => void;
  onConfirmar: () => void;
  onFechar: () => void;
}) {
  const { marcados, total } = contarMarcados(ocorrencias);
  const falhasPorChave = useMemo(() => {
    const map = new Map<string, { error: string; reason: string }>();
    for (const f of resultado?.falhas ?? []) map.set(`${f.data}T${f.hora}`, f);
    return map;
  }, [resultado]);
  const criadosSet = useMemo(
    () => new Set((resultado?.criados ?? []).map((c) => `${c.data}T${c.hora}`)),
    [resultado],
  );

  return (
    <Overlay
      open
      onClose={onFechar}
      variant="detail"
      ariaLabel={resultado ? 'Resultado da série' : 'Revisar datas da série'}
    >
      <div className="flex items-center justify-between border-b border-line-soft px-5 py-4">
        <div>
          <h2 className="font-display text-[17px] font-semibold text-ink">
            {resultado ? 'Resultado da série' : 'Revise antes de confirmar'}
          </h2>
          <p className="mt-0.5 text-[12.5px] text-ink-soft">
            {servico.nome} · {PERIODICIDADE_LABELS[periodicidade]}
          </p>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto px-5 py-4">
        {resultado && (
          <p
            role="status"
            className={cn(
              'mb-4 rounded-card-sm border px-3.5 py-2.5 text-[13.5px] font-medium',
              resultado.falhas.length === 0
                ? 'border-brand/40 bg-brand-soft text-brand'
                : resultado.criados.length === 0
                  ? 'border-danger/40 bg-danger/10 text-danger'
                  : 'border-amber/40 bg-amber-soft text-amber',
            )}
          >
            {resumoResultadoSerie(resultado)}
          </p>
        )}

        {!resultado && (
          <p className="mb-4 text-[13px] font-medium text-ink-soft">
            {marcados} de {total} serão marcados
          </p>
        )}

        <ul className="space-y-2">
          {ocorrencias.map((o, i) => {
            const chave = `${o.data}T${o.hora}`;
            const conflitoOk = o.status === 'livre';
            const falha = falhasPorChave.get(chave);
            const criada = criadosSet.has(chave);
            return (
              <li
                key={chave}
                className={cn(
                  'flex items-start gap-3 rounded-card-sm border px-3.5 py-3',
                  conflitoOk ? 'border-line bg-surface' : 'border-amber/40 bg-amber-soft',
                )}
              >
                {!resultado ? (
                  <input
                    type="checkbox"
                    aria-label={`Incluir ${formatDiaExtenso(o.data)} às ${o.hora}`}
                    checked={o.marcado}
                    onChange={() => onToggle(i)}
                    className="mt-0.5 size-[18px] shrink-0 rounded border-[1.5px] border-line-strong bg-surface-sunken text-brand outline-none focus-visible:ring-2 focus-visible:ring-brand"
                  />
                ) : (
                  <span
                    aria-hidden
                    className={cn(
                      'mt-0.5 flex size-[18px] shrink-0 items-center justify-center rounded-full',
                      criada
                        ? 'bg-brand text-bg'
                        : falha
                          ? 'bg-danger/20 text-danger'
                          : 'bg-line text-ink-faint',
                    )}
                  >
                    {criada ? <IconCheck size={12} /> : <IconAlert size={11} />}
                  </span>
                )}
                <div className="min-w-0 flex-1">
                  <div className="font-display text-[14px] font-semibold text-ink">
                    {formatDiaExtenso(o.data)} · {o.hora}
                  </div>
                  {!conflitoOk && !resultado && (
                    <div className="mt-0.5 text-[12.5px] text-amber">
                      {statusOcorrenciaLabel(o.status)}
                      {o.conflito?.inicio && o.status === 'ocupado' && (
                        <>
                          {' '}
                          — já tem algo às{' '}
                          {new Date(o.conflito.inicio).toLocaleTimeString('pt-BR', {
                            hour: '2-digit',
                            minute: '2-digit',
                          })}
                        </>
                      )}
                    </div>
                  )}
                  {resultado && falha && (
                    <div className="mt-0.5 text-[12.5px] text-danger">
                      Não entrou — {falhaOcorrenciaLabel(falha.reason)}
                    </div>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      </div>

      <div className="border-t border-line-soft px-5 py-4">
        {resultado ? (
          <Button onClick={onFechar}>Concluir</Button>
        ) : (
          <>
            <Button
              disabled={marcados === 0}
              loading={loading}
              loadingLabel="Criando a série…"
              onClick={onConfirmar}
            >
              Confirmar {marcados} {marcados === 1 ? 'horário' : 'horários'}
            </Button>
            <button
              type="button"
              onClick={onFechar}
              className="mt-2.5 flex h-11 w-full items-center justify-center gap-2 rounded-btn text-[14px] font-semibold text-ink-soft outline-none transition-colors hover:text-ink focus-visible:ring-2 focus-visible:ring-brand"
            >
              <IconRefresh size={16} />
              Ajustar e recalcular
            </button>
          </>
        )}
      </div>
    </Overlay>
  );
}
