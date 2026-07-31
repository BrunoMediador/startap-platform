'use client';

/**
 * Novo agendamento (Missão 020 F4, Fluxo B) — o dono marca um horário pra um
 * cliente final SEM passar pelo robô. 4 decisões numa tela só (doc 020 B3):
 * serviço (radio) → dia (strip de 14 dias) → horário (grade SÓ de livres,
 * agrupada manhã/tarde/noite) → nome (+ WhatsApp opcional) → confirmar.
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
import { IconCalendar, IconChevronLeft, IconScissors, IconWhatsapp } from '@/components/icons';
import { useTenant } from '@/components/shell/session-context';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Skeleton, SkeletonList, skeletonKeys } from '@/components/ui/skeleton';
import { EmptyState, ErrorState } from '@/components/ui/states';
import { useToast } from '@/components/ui/toast';
import { ApiError } from '@/lib/api';
import type { Colaborador, ConflitoReason, Servico, SlotsGrupos } from '@/lib/api-types';
import { cn } from '@/lib/cn';
import { formatDuracao, formatPrecoCents } from '@/lib/format';
import {
  type NovoAgendamentoErrors,
  addMinutosHora,
  buildCriarAgendamentoBody,
  buildDayStrip,
  formatDiaCurto,
  formatDiaExtenso,
  formatPhoneBR,
  validateNovoAgendamento,
} from '@/lib/novo-agendamento';
import {
  useAgendaSlots,
  useAgendamentos,
  useCriarAgendamento,
  useEquipe,
  useHorarios,
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
  const [colaboradorSel, setColaboradorSel] = useState<number | null>(null);
  /** Erro inline do seletor de profissional (obrigatório no estabelecimento). */
  const [colaboradorErro, setColaboradorErro] = useState<string | null>(null);
  const [nome, setNome] = useState('');
  const [telefone, setTelefone] = useState('');
  const [errors, setErrors] = useState<NovoAgendamentoErrors>({});
  /** Aviso amber inline na grade (409 / troca de serviço com hora escolhida). */
  const [aviso, setAviso] = useState<string | null>(null);
  /** 422 no POST (gcal_nao_configurado/config_ausente) — vira o estado explicativo. */
  const [gcalBloqueado, setGcalBloqueado] = useState(false);

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

  const servicos = servicosQ.data ?? [];
  const servico = servicos.find((s) => s.nome === servicoSel) ?? null;
  const strip = useMemo(() => buildDayStrip(horariosQ.data), [horariosQ.data]);
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

  function onConfirmar() {
    const res = validateNovoAgendamento({ nome, telefone });
    if (!res.ok) {
      setErrors(res.errors);
      return;
    }
    setErrors({});
    if (!servico || !dataSel || !horaSel) return;

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
            <h2
              id="sec-dia"
              className="mx-0.5 mb-2.5 font-display text-[15px] font-semibold text-ink"
            >
              Dia
            </h2>
            <div
              role="radiogroup"
              aria-label="Escolha o dia"
              className="flex gap-2 overflow-x-auto pb-1"
            >
              {strip.map((d) => {
                const ativo = d.dateKey === dataSel;
                return (
                  <button
                    key={d.dateKey}
                    type="button"
                    role="radio"
                    aria-checked={ativo}
                    disabled={d.fechado}
                    aria-label={`${d.longo}${d.fechado ? ' — fechado' : ''}`}
                    onClick={() => selecionarDia(d.dateKey)}
                    className={cn(
                      'flex min-w-[64px] shrink-0 flex-col items-center gap-0.5 rounded-card-sm border px-2 py-2.5 outline-none transition-colors focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-2 focus-visible:ring-offset-bg',
                      ativo
                        ? 'border-brand bg-brand-soft'
                        : 'border-line bg-surface hover:bg-surface-hover',
                      d.fechado && 'cursor-not-allowed opacity-45 hover:bg-surface',
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
                      {d.fechado ? 'Fechado' : ' '}
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
              <Input
                label="WhatsApp (opcional)"
                type="tel"
                inputMode="tel"
                placeholder="(11) 99999-9999"
                value={telefone}
                error={errors.telefone}
                autoComplete="off"
                onChange={(e) => setTelefone(formatPhoneBR(e.target.value))}
              />
              <p className="mt-1.5 text-[12.5px] leading-snug text-ink-faint">
                Com o WhatsApp do cliente, o assistente reconhece ele na próxima conversa.
              </p>
            </div>
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
            loading={criar.isPending}
            loadingLabel="Marcando…"
            onClick={onConfirmar}
          >
            Confirmar agendamento
          </Button>
        </div>
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
