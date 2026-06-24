'use client';

/**
 * Detalhe + ações de um agendamento (Bloco C). Bottom-sheet no mobile / painel
 * lateral direito no desktop (Overlay variant="detail"). Três modos:
 *
 *   - 'detalhe' : nome COMPLETO sempre visível, serviço, horário, telefone +
 *                 3 ações (Remarcar · Trocar serviço · Cancelar).
 *   - 'remarcar': SlotPicker (dia + horário livre) pré-checado, mantendo o serviço.
 *   - 'trocar'  : lista de serviços + SlotPicker (a duração muda os horários).
 *
 * Cancelar reusa o DELETE existente (useExcluirAgendamento) com ConfirmDialog
 * destrutivo. Remarcar/trocar usam o PATCH (useEditarAgendamento) contra o
 * contrato do backend. Erros tratados aqui:
 *   409 conflito  -> aviso amber + recarrega a grade de slots (mostra só livres).
 *   404 não-pertence / 422 config / 502 GCal / rota ausente -> toast amigável.
 *
 * O endpoint PATCH só fica live quando a PR do backend mergear+deployar; até lá a
 * UI degrada com mensagem (toast) sem travar.
 */
import {
  IconCalendar,
  IconChevronLeft,
  IconClock,
  IconPencil,
  IconScissors,
  IconTrash,
  IconUser,
  IconWhatsapp,
} from '@/components/icons';
import { useTenant } from '@/components/shell/session-context';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { Overlay } from '@/components/ui/overlay';
import { useToast } from '@/components/ui/toast';
import { parseTitulo } from '@/lib/agenda-titulo';
import { ApiError } from '@/lib/api';
import type { Agendamento, ConflitoReason, Servico } from '@/lib/api-types';
import { cn } from '@/lib/cn';
import { formatAgendamentoDia, formatAgendamentoHora, formatPhoneDisplay } from '@/lib/format';
import { addMinutosHora, formatDiaCurto } from '@/lib/novo-agendamento';
import { qk, useEditarAgendamento, useExcluirAgendamento, useServicos } from '@/lib/queries';
import { useQueryClient } from '@tanstack/react-query';
import { useId, useState } from 'react';
import { AgendaValorSection } from './agenda-valor-section';
import { SlotPicker } from './slot-picker';

const CONFLITO_MSG: Record<ConflitoReason, string> = {
  ocupado: 'Esse horário acabou de ser ocupado. Escolha outro.',
  horario_passado: 'Esse horário já passou. Escolha outro.',
  fora_do_horario: 'Esse horário ficou fora do seu funcionamento. Escolha outro.',
};

function conflitoReason(body: unknown): ConflitoReason {
  if (body && typeof body === 'object' && 'reason' in body) {
    const r = (body as { reason?: unknown }).reason;
    if (r === 'ocupado' || r === 'horario_passado' || r === 'fora_do_horario') return r;
  }
  return 'ocupado';
}

/**
 * 409 NOVO do backend ao trocar pra um serviço mais LONGO que invade o próximo
 * horário: `{ error:'conflito_horario', message }`. Extrai a `message` amigável; se
 * vier sem corpo conhecido, cai num texto genérico (nunca renderiza null).
 */
function conflitoHorarioMsg(body: unknown): string | null {
  if (body && typeof body === 'object' && 'error' in body) {
    const e = (body as { error?: unknown }).error;
    if (e === 'conflito_horario') {
      const m = (body as { message?: unknown }).message;
      return typeof m === 'string' && m.trim() !== ''
        ? m
        : 'O novo serviço é mais longo e bate no próximo horário. Remarque ou escolha outro serviço.';
    }
  }
  return null;
}

type Modo = 'detalhe' | 'remarcar' | 'trocar';

export function AgendaDetailSheet({
  slot,
  agendamento,
  onClose,
}: {
  slot: string;
  /** Evento em foco. null = fechado. */
  agendamento: Agendamento | null;
  onClose: () => void;
}) {
  const titleId = useId();
  const toast = useToast();
  const queryClient = useQueryClient();
  const { atendFromAgenda } = useTenant();
  const editar = useEditarAgendamento(slot);
  const excluir = useExcluirAgendamento(slot);
  const servicosQ = useServicos(slot);

  const [modo, setModo] = useState<Modo>('detalhe');
  const [confirmarCancelar, setConfirmarCancelar] = useState(false);
  // Rascunho da edição (remarcar/trocar).
  const [servicoSel, setServicoSel] = useState<string | null>(null);
  const [dataSel, setDataSel] = useState<string | null>(null);
  const [horaSel, setHoraSel] = useState<string | null>(null);
  const [aviso, setAviso] = useState<string | null>(null);
  // Trocar serviço: por padrão MANTÉM o mesmo horário (dia/hora ausentes no PATCH);
  // o dono escolhe "outro dia" só se quiser remarcar junto.
  const [manterHorario, setManterHorario] = useState(true);

  const open = agendamento !== null;
  const parsed = agendamento ? parseTitulo(agendamento.titulo) : null;

  // Reseta tudo ao fechar (ou ao trocar de evento).
  function fechar() {
    setModo('detalhe');
    setServicoSel(null);
    setDataSel(null);
    setHoraSel(null);
    setAviso(null);
    setManterHorario(true);
    setConfirmarCancelar(false);
    onClose();
  }

  function abrirRemarcar() {
    if (!agendamento) return;
    // Mantém o serviço atual (parseado do título); pré-zera dia/hora.
    setServicoSel(parsed?.servico || null);
    setDataSel(null);
    setHoraSel(null);
    setAviso(null);
    setModo('remarcar');
  }

  function abrirTrocar() {
    setServicoSel(null);
    setDataSel(null);
    setHoraSel(null);
    setAviso(null);
    setManterHorario(true);
    setModo('trocar');
  }

  function selecionarServico(nome: string) {
    if (nome === servicoSel) return;
    setServicoSel(nome);
    // Trocar serviço muda a duração -> a hora escolhida pode não valer mais.
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

  // Trocar serviço escolhe um NOVO horário? (toggle "Escolher outro dia"). No
  // remarcar é sempre true (escolher dia/hora é o ponto). No trocar com "manter o
  // mesmo horário", o PATCH vai SÓ com o serviço (data/hora ausentes — backend ok).
  const escolheNovoHorario = modo === 'remarcar' || (modo === 'trocar' && !manterHorario);

  const podeSalvar =
    modo === 'remarcar'
      ? Boolean(dataSel && horaSel)
      : modo === 'trocar'
        ? Boolean(servicoSel) && (manterHorario || Boolean(dataSel && horaSel))
        : false;

  function salvar() {
    if (!agendamento) return;
    // Só manda dia/hora quando o dono de fato escolheu um novo horário; trocar só o
    // serviço viaja apenas com { servico } (item 1).
    const mandarHorario = escolheNovoHorario && Boolean(dataSel && horaSel);
    const patch =
      modo === 'remarcar'
        ? { data: dataSel ?? undefined, hora: horaSel ?? undefined }
        : {
            servico: servicoSel ?? undefined,
            ...(mandarHorario ? { data: dataSel ?? undefined, hora: horaSel ?? undefined } : {}),
          };

    editar.mutate(
      { eventId: agendamento.id, patch },
      {
        onSuccess: () => {
          toast.success(
            modo === 'remarcar'
              ? `Remarcado: ${formatDiaCurto(dataSel ?? '')} · ${horaSel}`
              : mandarHorario
                ? `Trocado: ${servicoSel} · ${formatDiaCurto(dataSel ?? '')} · ${horaSel}`
                : `Serviço trocado: ${servicoSel}`,
          );
          fechar();
        },
        onError: (err) => {
          if (err instanceof ApiError && err.status === 409) {
            // 409 NOVO: serviço mais longo bate no próximo horário → mostra a message
            // do backend inline, sem mexer na grade (não é corrida de slot).
            const msgLongo = conflitoHorarioMsg(err.body);
            if (msgLongo) {
              setAviso(msgLongo);
              return;
            }
            // Corrida com o robô: o slot some, recarrega a grade (só livres),
            // mantém dia/serviço. Invalidar a base força o SlotPicker a refetch.
            setHoraSel(null);
            setAviso(CONFLITO_MSG[conflitoReason(err.body)]);
            queryClient.invalidateQueries({ queryKey: qk.agendaSlotsBase(slot) });
            return;
          }
          if (err instanceof ApiError && err.status === 404) {
            toast.error('Esse horário não está mais na sua agenda.');
            fechar();
            return;
          }
          if (err instanceof ApiError && err.status === 422) {
            toast.error('Conecte sua agenda Google pra editar horários. Fale com o suporte.');
            return;
          }
          toast.error('Não foi possível salvar agora. Tente de novo.');
        },
      },
    );
  }

  function cancelarHorario() {
    if (!agendamento) return;
    excluir.mutate(agendamento.id, {
      onSuccess: (res) => {
        toast.success(
          res.already_gone ? 'Esse horário já não estava na agenda.' : 'Horário cancelado.',
        );
        fechar();
      },
      onError: (err) => {
        if (err instanceof ApiError && err.status === 404) {
          toast.success('Esse horário já não estava na agenda.');
          fechar();
          return;
        }
        toast.error('Não foi possível cancelar agora. Tente de novo.');
      },
    });
  }

  if (!open || !agendamento || !parsed) return null;

  const hora = formatAgendamentoHora(agendamento.inicio);
  const dia = formatAgendamentoDia(agendamento.inicio);
  const telefone = parsed.telefone ? formatPhoneDisplay(parsed.telefone) : null;

  return (
    <>
      <Overlay open={open} onClose={fechar} variant="detail" ariaLabelledBy={titleId}>
        <div className="flex min-h-0 flex-1 flex-col px-5 pt-3.5">
          {/* Cabeçalho: volta (em modo edição) + título do modo. */}
          <div className="mb-3 flex items-center gap-2">
            {modo !== 'detalhe' && (
              <button
                type="button"
                onClick={() => {
                  setModo('detalhe');
                  setAviso(null);
                }}
                aria-label="Voltar ao detalhe"
                className="flex size-9 shrink-0 items-center justify-center rounded-[10px] border border-line-strong bg-surface text-ink-soft outline-none transition-colors hover:bg-surface-hover hover:text-ink focus-visible:ring-2 focus-visible:ring-brand"
              >
                <IconChevronLeft size={18} />
              </button>
            )}
            <h2 id={titleId} className="font-display text-[17px] font-semibold text-ink">
              {modo === 'detalhe'
                ? 'Detalhe do horário'
                : modo === 'remarcar'
                  ? 'Remarcar horário'
                  : 'Trocar serviço'}
            </h2>
          </div>

          {modo === 'detalhe' ? (
            <DetalheView
              slot={slot}
              eventId={agendamento.id}
              // Edição de dinheiro só no clone do gate (atend_from_agenda) E se houver
              // linha (by-evento 200). No individual a flag é false -> nem consulta.
              mostrarValor={atendFromAgenda}
              nome={parsed.nome}
              servico={parsed.servico}
              hora={hora}
              dia={dia}
              telefone={telefone}
              // Só vem no estabelecimento (eventos agregados de N barbeiros). No
              // individual é undefined -> a linha "Profissional" não aparece e o
              // layout SOLO fica idêntico a hoje.
              profissional={agendamento.profissional_nome ?? null}
              onRemarcar={abrirRemarcar}
              onTrocar={abrirTrocar}
              onCancelar={() => setConfirmarCancelar(true)}
            />
          ) : (
            <div className="min-h-0 flex-1">
              {modo === 'trocar' && (
                <div className="mb-4">
                  <h3 className="mb-2 font-display text-[13.5px] font-semibold text-ink">
                    Serviço
                  </h3>
                  <ServicoRadioList
                    servicos={servicosQ.data ?? []}
                    selecionado={servicoSel}
                    onPick={selecionarServico}
                  />
                </div>
              )}

              {/* Trocar serviço: por padrão MANTÉM o horário. O dono só vê a grade se
                  optar por remarcar junto ("Escolher outro dia"). No remarcar a grade
                  é sempre visível (é o ponto do modo). */}
              {modo === 'trocar' && (
                <ManterHorarioToggle
                  manter={manterHorario}
                  onManter={() => {
                    setManterHorario(true);
                    setDataSel(null);
                    setHoraSel(null);
                    setAviso(null);
                  }}
                  onTrocar={() => {
                    setManterHorario(false);
                    setAviso(null);
                  }}
                />
              )}

              {escolheNovoHorario && (
                <SlotPicker
                  slot={slot}
                  servico={servicoSel}
                  dataSel={dataSel}
                  horaSel={horaSel}
                  onPickDia={selecionarDia}
                  onPickHora={(h) => {
                    setHoraSel(h);
                    setAviso(null);
                  }}
                  aviso={aviso}
                  // Estabelecimento: a grade de remarcação olha a agenda do MESMO profissional
                  // do evento (remarcar v1 não troca de profissional). null no individual.
                  colaboradorId={agendamento.colaborador_id ?? null}
                />
              )}

              {/* Aviso 409 (serviço mais longo) quando se mantém o horário — fora do
                  SlotPicker, que nem é montado nesse caminho. */}
              {modo === 'trocar' && manterHorario && aviso && (
                <p
                  role="status"
                  className="mt-3 rounded-card-sm border border-amber/40 bg-amber-soft px-3.5 py-2.5 text-[13px] font-medium text-amber"
                >
                  {aviso}
                </p>
              )}

              {/* Resumo + salvar (fixo no rodapé do painel). */}
              <div className="mt-5">
                {(servicoSel || dataSel || horaSel) && (
                  <div className="mb-3 rounded-card-sm border border-line bg-surface px-3.5 py-2.5">
                    <p className="font-display text-[13.5px] font-semibold text-ink">
                      {[
                        modo === 'trocar' ? servicoSel : parsed.servico || null,
                        dataSel ? formatDiaCurto(dataSel) : null,
                        horaSel ? horaSelLabel(horaSel, servicoSel, servicosQ.data) : null,
                      ]
                        .filter(Boolean)
                        .join(' · ')}
                    </p>
                  </div>
                )}
                <Button
                  disabled={!podeSalvar}
                  loading={editar.isPending}
                  loadingLabel="Salvando…"
                  onClick={salvar}
                >
                  {modo === 'remarcar' ? 'Confirmar remarcação' : 'Confirmar troca'}
                </Button>
              </div>
            </div>
          )}
        </div>
      </Overlay>

      {/* Confirmação destrutiva do cancelar (irreversível: apaga no GCal). */}
      <ConfirmDialog
        open={confirmarCancelar}
        title="Cancelar este horário?"
        description={`“${parsed.nome}${parsed.servico ? ` — ${parsed.servico}` : ''}” vai ser removido da sua agenda do Google. Isso não tem como desfazer.`}
        confirmLabel="Cancelar horário"
        cancelLabel="Voltar"
        confirmVariant="destructive"
        loading={excluir.isPending}
        icon={<IconTrash size={22} />}
        onConfirm={cancelarHorario}
        onCancel={() => {
          if (!excluir.isPending) setConfirmarCancelar(false);
        }}
      />
    </>
  );
}

/** "10:00–10:30" usando a duração do serviço escolhido (se conhecida). */
function horaSelLabel(hora: string, servicoNome: string | null, servicos?: Servico[]): string {
  const s = servicos?.find((x) => x.nome === servicoNome);
  return s ? `${hora}–${addMinutosHora(hora, s.duracao_min)}` : hora;
}

function DetalheView({
  slot,
  eventId,
  mostrarValor,
  nome,
  servico,
  hora,
  dia,
  telefone,
  profissional,
  onRemarcar,
  onTrocar,
  onCancelar,
}: {
  slot: string;
  eventId: string;
  /** Gate do front: só consulta/edita dinheiro no clone com atend_from_agenda. */
  mostrarValor: boolean;
  nome: string;
  servico: string;
  hora: string;
  dia: string;
  telefone: string | null;
  /** Estabelecimento: qual barbeiro. null no individual (não renderiza a linha). */
  profissional: string | null;
  onRemarcar: () => void;
  onTrocar: () => void;
  onCancelar: () => void;
}) {
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* Nome COMPLETO sempre visível (sem truncar — esse é o ponto do Bloco B). */}
      <p className="font-display text-[20px] font-bold leading-tight tracking-[-0.01em] text-ink">
        {nome}
      </p>

      <dl className="mt-4 space-y-3">
        {/* Profissional: só no estabelecimento. Desambigua eventos do mesmo
            horário (4 barbeiros) na hora de remarcar/cancelar. */}
        {profissional && (
          <LinhaInfo icon={<IconUser size={17} />} rotulo="Profissional" valor={profissional} />
        )}
        {servico && (
          <LinhaInfo icon={<IconScissors size={17} />} rotulo="Serviço" valor={servico} />
        )}
        <LinhaInfo icon={<IconCalendar size={17} />} rotulo="Dia" valor={dia || 'Sem data'} />
        {hora && <LinhaInfo icon={<IconClock size={17} />} rotulo="Horário" valor={hora} />}
        {telefone && (
          <LinhaInfo icon={<IconWhatsapp size={17} />} rotulo="WhatsApp" valor={telefone} />
        )}
      </dl>

      {/* Valor cobrado (item 3/6) — só aparece no clone do gate E quando há linha de
          atendimento pra esse evento (by-evento 200). No individual nem é montada. */}
      {mostrarValor && <AgendaValorSection slot={slot} eventId={eventId} />}

      {/* Ações. Remarcar (primária) + Trocar serviço (secundária) + Cancelar (destrutiva). */}
      <div className="mt-6 space-y-2.5">
        <Button onClick={onRemarcar}>
          <IconPencil size={17} />
          Remarcar
        </Button>
        <Button variant="secondary" onClick={onTrocar}>
          <IconScissors size={17} />
          Trocar serviço
        </Button>
        <Button variant="destructive" onClick={onCancelar}>
          <IconTrash size={17} />
          Cancelar horário
        </Button>
      </div>
    </div>
  );
}

/**
 * Toggle "Manter o mesmo horário" (default) vs "Escolher outro dia" no modo trocar.
 * Sem o segundo, o PATCH viaja só com o serviço (item 1). Acessível (radiogroup).
 */
function ManterHorarioToggle({
  manter,
  onManter,
  onTrocar,
}: {
  manter: boolean;
  onManter: () => void;
  onTrocar: () => void;
}) {
  return (
    <div
      role="radiogroup"
      aria-label="Horário do agendamento"
      className="mb-4 flex flex-wrap gap-2"
    >
      <ToggleChip ativo={manter} onClick={onManter} label="Manter o mesmo horário">
        <IconClock size={15} />
      </ToggleChip>
      <ToggleChip ativo={!manter} onClick={onTrocar} label="Escolher outro dia">
        <IconCalendar size={15} />
      </ToggleChip>
    </div>
  );
}

function ToggleChip({
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
      role="radio"
      aria-checked={ativo}
      onClick={onClick}
      className={cn(
        'inline-flex h-9 items-center gap-1.5 rounded-pill border px-3.5 font-display text-[13px] font-semibold outline-none transition-colors focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-2 focus-visible:ring-offset-bg',
        ativo
          ? 'border-brand bg-brand text-bg'
          : 'border-line bg-surface text-ink hover:bg-surface-hover',
      )}
    >
      {children}
      {label}
    </button>
  );
}

function LinhaInfo({
  icon,
  rotulo,
  valor,
}: {
  icon: React.ReactNode;
  rotulo: string;
  valor: string;
}) {
  return (
    <div className="flex items-center gap-3">
      <span
        aria-hidden
        className="flex size-9 shrink-0 items-center justify-center rounded-[10px] border border-line-strong bg-brand-soft text-brand"
      >
        {icon}
      </span>
      <div className="min-w-0">
        <dt className="text-[11.5px] uppercase tracking-[0.04em] text-ink-faint">{rotulo}</dt>
        <dd className="font-display text-[14.5px] font-semibold text-ink">{valor}</dd>
      </div>
    </div>
  );
}

function ServicoRadioList({
  servicos,
  selecionado,
  onPick,
}: {
  servicos: Servico[];
  selecionado: string | null;
  onPick: (nome: string) => void;
}) {
  if (servicos.length === 0) {
    return (
      <p className="rounded-card-sm border border-line bg-surface px-3.5 py-3 text-[13px] text-ink-soft">
        Nenhum serviço cadastrado. Cadastre um em Serviços primeiro.
      </p>
    );
  }
  return (
    <div
      role="radiogroup"
      aria-label="Escolha o serviço"
      className="overflow-hidden rounded-card-sm border border-line bg-surface"
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
              'flex min-h-[48px] w-full items-center gap-3 border-b border-line-soft px-3.5 py-2.5 text-left outline-none transition-colors last:border-b-0 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand',
              ativo ? 'bg-brand-soft' : 'hover:bg-surface-hover',
            )}
          >
            <span
              aria-hidden
              className={cn(
                'flex size-[16px] shrink-0 items-center justify-center rounded-full border-[1.5px]',
                ativo ? 'border-brand' : 'border-line-strong',
              )}
            >
              {ativo && <span className="size-2 rounded-full bg-brand" />}
            </span>
            <span
              className={cn(
                'min-w-0 flex-1 truncate font-display text-[14px] font-semibold',
                ativo ? 'text-brand' : 'text-ink',
              )}
            >
              {s.nome}
            </span>
          </button>
        );
      })}
    </div>
  );
}
