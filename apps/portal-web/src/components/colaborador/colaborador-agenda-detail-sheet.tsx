'use client';

import { SlotPicker } from '@/components/agenda/slot-picker';
import { useColaborador } from '@/components/colaborador/colaborador-session-context';
import { IconCalendar, IconClock, IconPencil, IconTrash, IconWhatsapp, IconX } from '@/components/icons';
import { useTenantTz } from '@/components/shell/tenant-tz-context';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { Overlay } from '@/components/ui/overlay';
import { useToast } from '@/components/ui/toast';
import { parseTitulo } from '@/lib/agenda-titulo';
import { ApiError } from '@/lib/api';
import type { Agendamento } from '@/lib/api-types';
import { formatAgendamentoDia, formatAgendamentoHora, formatPhoneDisplay } from '@/lib/format';
import { formatDiaCurto } from '@/lib/novo-agendamento';
import {
  useEditarAgendamentoColaborador,
  useExcluirAgendamentoColaborador,
} from '@/lib/queries';
import { useId, useState } from 'react';

type Modo = 'detalhe' | 'remarcar';

function mensagemErro(error: unknown): string {
  if (error instanceof ApiError && error.status === 409) return 'Esse horário acabou de ser ocupado. Escolha outro.';
  if (error instanceof ApiError && error.status === 404) return 'Esse horário não está mais na sua agenda.';
  if (error instanceof ApiError && error.status === 422) return 'Sua agenda ainda não está pronta para alterar horários.';
  return 'Não foi possível salvar agora. Tente de novo.';
}

/** Detalhe mutante da agenda PRÓPRIA. Nunca recebe nem escolhe outro colaborador. */
export function ColaboradorAgendaDetailSheet({
  agendamento,
  onClose,
}: {
  agendamento: Agendamento | null;
  onClose: () => void;
}) {
  const { slot, colaboradorId } = useColaborador();
  const tz = useTenantTz();
  const toast = useToast();
  const titleId = useId();
  const editar = useEditarAgendamentoColaborador(slot, colaboradorId);
  const excluir = useExcluirAgendamentoColaborador(slot, colaboradorId);
  const [modo, setModo] = useState<Modo>('detalhe');
  const [data, setData] = useState<string | null>(null);
  const [hora, setHora] = useState<string | null>(null);
  const [aviso, setAviso] = useState<string | null>(null);
  const [confirmarCancelar, setConfirmarCancelar] = useState(false);

  const aberto = agendamento !== null;
  const titulo = agendamento ? parseTitulo(agendamento.titulo) : null;
  const podeRemarcar = Boolean(titulo?.servico);

  function fechar() {
    setModo('detalhe');
    setData(null);
    setHora(null);
    setAviso(null);
    setConfirmarCancelar(false);
    onClose();
  }

  function abrirRemarcar() {
    setData(null);
    setHora(null);
    setAviso(null);
    setModo('remarcar');
  }

  function salvarRemarcacao() {
    if (!agendamento || !data || !hora || editar.isPending) return;
    editar.mutate(
      { eventId: agendamento.id, patch: { data, hora } },
      {
        onSuccess: () => {
          toast.success(`Remarcado: ${formatDiaCurto(data)} · ${hora}`);
          fechar();
        },
        onError: (error) => {
          if (error instanceof ApiError && error.status === 409) setHora(null);
          setAviso(mensagemErro(error));
        },
      },
    );
  }

  function cancelar() {
    if (!agendamento || excluir.isPending) return;
    excluir.mutate(agendamento.id, {
      onSuccess: (res) => {
        toast.success(res.already_gone ? 'Esse horário já não estava na agenda.' : 'Horário cancelado.');
        fechar();
      },
      onError: (error) => toast.error(mensagemErro(error)),
    });
  }

  const dia = formatAgendamentoDia(agendamento?.inicio ?? null, undefined, tz);
  const horario = formatAgendamentoHora(agendamento?.inicio ?? null, tz);

  return (
    <>
      <Overlay open={aberto} onClose={fechar} variant="detail" ariaLabelledBy={titleId}>
        {agendamento && titulo ? (
          <div className="flex min-h-0 flex-1 flex-col px-5 pb-2 pt-3 sm:px-6">
            <div className="flex items-start justify-between gap-4">
              <div>
                <p className="text-[12px] font-semibold uppercase tracking-[0.06em] text-ink-faint">Meu horário</p>
                <h2 id={titleId} className="mt-1 font-display text-[21px] font-bold leading-tight text-ink">{titulo.nome}</h2>
              </div>
              <button
                type="button"
                aria-label="Fechar detalhes do horário"
                onClick={fechar}
                className="flex size-11 shrink-0 items-center justify-center rounded-full text-ink-soft outline-none hover:bg-surface-hover focus-visible:ring-2 focus-visible:ring-brand"
              >
                <IconX size={20} />
              </button>
            </div>

            {modo === 'detalhe' ? (
              <>
                <dl className="mt-6 space-y-3 text-[14px]">
                  {titulo.servico ? <Linha icon={<IconPencil size={17} />} label="Serviço" value={titulo.servico} /> : null}
                  <Linha icon={<IconCalendar size={17} />} label="Dia" value={dia || 'Sem data'} />
                  {horario ? <Linha icon={<IconClock size={17} />} label="Horário" value={horario} /> : null}
                  {titulo.telefone ? <Linha icon={<IconWhatsapp size={17} />} label="WhatsApp" value={formatPhoneDisplay(titulo.telefone)} /> : null}
                </dl>
                <div className="mt-7 space-y-2.5">
                  <Button disabled={!podeRemarcar} onClick={abrirRemarcar}>
                    <IconPencil size={17} />
                    Remarcar
                  </Button>
                  {!podeRemarcar ? <p className="text-center text-[12px] text-ink-soft">Esse evento não informa o serviço e não pode ser remarcado por aqui.</p> : null}
                  <Button variant="destructive" onClick={() => setConfirmarCancelar(true)}>
                    <IconTrash size={17} />
                    Cancelar horário
                  </Button>
                </div>
              </>
            ) : (
              <div className="mt-6">
                <button
                  type="button"
                  onClick={() => setModo('detalhe')}
                  className="mb-4 text-[13px] font-semibold text-brand outline-none hover:underline focus-visible:ring-2 focus-visible:ring-brand"
                >
                  ← Ver detalhes
                </button>
                <SlotPicker
                  slot={slot}
                  colaboradorId={colaboradorId}
                  scope="colaborador"
                  servico={titulo.servico}
                  dataSel={data}
                  horaSel={hora}
                  aviso={aviso}
                  onPickDia={(proximaData) => {
                    setData(proximaData);
                    setHora(null);
                    setAviso(null);
                  }}
                  onPickHora={(proximaHora) => {
                    setHora(proximaHora);
                    setAviso(null);
                  }}
                />
                <div className="mt-6">
                  <Button loading={editar.isPending} loadingLabel="Remarcando…" disabled={!data || !hora} onClick={salvarRemarcacao}>
                    Confirmar remarcação
                  </Button>
                </div>
              </div>
            )}
          </div>
        ) : null}
      </Overlay>

      <ConfirmDialog
        open={confirmarCancelar}
        title="Cancelar este horário?"
        description={`“${titulo?.nome ?? 'Este cliente'}” será removido da sua agenda. Isso não pode ser desfeito.`}
        confirmLabel="Cancelar horário"
        cancelLabel="Voltar"
        confirmVariant="destructive"
        loading={excluir.isPending}
        icon={<IconTrash size={22} />}
        onConfirm={cancelar}
        onCancel={() => !excluir.isPending && setConfirmarCancelar(false)}
      />
    </>
  );
}

function Linha({ icon, label, value }: { icon: React.ReactNode; label: string; value: string }) {
  return (
    <div className="flex items-center gap-3 text-ink-soft">
      <span className="text-brand" aria-hidden>{icon}</span>
      <dt className="sr-only">{label}</dt>
      <dd><span className="font-medium text-ink">{label}: </span>{value}</dd>
    </div>
  );
}
