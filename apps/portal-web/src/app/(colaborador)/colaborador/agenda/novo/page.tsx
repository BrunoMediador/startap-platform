'use client';

import { SlotPicker } from '@/components/agenda/slot-picker';
import { useColaborador } from '@/components/colaborador/colaborador-session-context';
import { IconCalendar, IconCheck, IconScissors } from '@/components/icons';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { SkeletonList } from '@/components/ui/skeleton';
import { EmptyState, ErrorState } from '@/components/ui/states';
import { Switch } from '@/components/ui/switch';
import { useToast } from '@/components/ui/toast';
import { ApiError } from '@/lib/api';
import { podeGerenciarAgendaColaborador } from '@/lib/colaborador-agenda-write';
import { formatDiaCurto, formatPhoneBR, validateNovoAgendamento } from '@/lib/novo-agendamento';
import {
  useColaboradorAgenda,
  useColaboradorAgendaServicos,
  useCriarAgendamentoColaborador,
} from '@/lib/queries';
import { useRouter } from 'next/navigation';
import { useState } from 'react';

function mensagemErro(error: unknown): string {
  if (error instanceof ApiError && error.status === 409) {
    return 'Esse horário acabou de ser ocupado. Escolha outro.';
  }
  if (error instanceof ApiError && error.status === 422) {
    return 'Sua agenda ainda não está pronta para receber horários.';
  }
  return 'Não foi possível marcar agora. Tente de novo.';
}

export default function NovoAgendamentoColaboradorPage() {
  const { slot, colaboradorId } = useColaborador();
  const router = useRouter();
  const toast = useToast();
  // A rota pode ser aberta diretamente; revalida a capability no servidor antes
  // de buscar dados/escrever. Ausência do campo mantém o comportamento read-only.
  const agendaQ = useColaboradorAgenda(slot, colaboradorId, 0, 1);
  const habilitado = agendaQ.data ? podeGerenciarAgendaColaborador(agendaQ.data) : false;
  const servicosQ = useColaboradorAgendaServicos(slot, colaboradorId, habilitado);
  const criar = useCriarAgendamentoColaborador(slot, colaboradorId);

  const [servico, setServico] = useState<string | null>(null);
  const [data, setData] = useState<string | null>(null);
  const [hora, setHora] = useState<string | null>(null);
  const [nome, setNome] = useState('');
  const [telefone, setTelefone] = useState('');
  const [semWhatsapp, setSemWhatsapp] = useState(false);
  const [erroNome, setErroNome] = useState<string | undefined>();
  const [erroTelefone, setErroTelefone] = useState<string | undefined>();
  const [aviso, setAviso] = useState<string | null>(null);

  function selecionarServico(nomeServico: string) {
    if (nomeServico === servico) return;
    setServico(nomeServico);
    if (hora) {
      setHora(null);
      setAviso('A duração mudou — escolha o horário de novo.');
    }
  }

  function confirmar() {
    if (criar.isPending || !servico || !data || !hora) return;
    const validacao = validateNovoAgendamento({ nome, telefone, semWhatsapp });
    if (!validacao.ok) {
      setErroNome(validacao.errors.nome);
      setErroTelefone(validacao.errors.telefone);
      return;
    }
    setErroNome(undefined);
    setErroTelefone(undefined);
    setAviso(null);
    criar.mutate(
      { servico, data, hora, ...validacao.value },
      {
        onSuccess: () => {
          toast.success(`Horário marcado: ${formatDiaCurto(data)} · ${hora}`);
          router.replace('/colaborador/agenda');
        },
        onError: (error) => {
          if (error instanceof ApiError && error.status === 409) setHora(null);
          setAviso(mensagemErro(error));
        },
      },
    );
  }

  if (agendaQ.isPending) {
    return <SkeletonList rows={5} />;
  }
  if (agendaQ.isError || !agendaQ.data) {
    return (
      <ErrorState title="Não foi possível verificar sua agenda" onRetry={() => agendaQ.refetch()} />
    );
  }
  if (!habilitado) {
    return (
      <EmptyState
        icon={<IconCalendar size={26} />}
        title="Marcação de horários indisponível"
        description="Você continua vendo sua agenda. A empresa libera a marcação quando este recurso estiver pronto."
        action={{
          label: 'Voltar para minha agenda',
          onClick: () => router.replace('/colaborador/agenda'),
        }}
      />
    );
  }
  if (!agendaQ.data.gcal_configured) {
    return (
      <EmptyState
        icon={<IconCalendar size={26} />}
        title="Agenda ainda não conectada"
        description="Assim que sua agenda do Google estiver ligada, você poderá marcar horários por aqui."
        action={{
          label: 'Voltar para minha agenda',
          onClick: () => router.replace('/colaborador/agenda'),
        }}
      />
    );
  }

  return (
    <div className="mx-auto max-w-2xl">
      <button
        type="button"
        onClick={() => router.back()}
        className="mb-4 text-[13px] font-semibold text-brand outline-none hover:underline focus-visible:ring-2 focus-visible:ring-brand"
      >
        ← Minha agenda
      </button>
      <h1 className="font-display text-[24px] font-bold tracking-[-0.02em] text-ink">
        Novo horário
      </h1>
      <p className="mt-1 text-[14px] text-ink-soft">Marque um cliente somente na sua agenda.</p>

      {servicosQ.isPending ? (
        <div className="mt-6">
          <SkeletonList rows={4} />
        </div>
      ) : servicosQ.isError ? (
        <div className="mt-6">
          <ErrorState
            title="Não foi possível carregar seus serviços"
            onRetry={() => servicosQ.refetch()}
          />
        </div>
      ) : (servicosQ.data?.length ?? 0) === 0 ? (
        <div className="mt-6">
          <EmptyState
            icon={<IconScissors size={26} />}
            title="Sem serviços disponíveis"
            description="Peça para a empresa vincular os serviços que você realiza antes de marcar um horário."
          />
        </div>
      ) : (
        <div className="mt-6 space-y-7 rounded-card border border-line bg-surface p-4 sm:p-6">
          <section aria-labelledby="servico-titulo">
            <h2 id="servico-titulo" className="font-display text-[15px] font-semibold text-ink">
              Serviço
            </h2>
            <div
              role="radiogroup"
              aria-label="Escolha o serviço"
              className="mt-3 grid gap-2 sm:grid-cols-2"
            >
              {servicosQ.data?.map((item) => {
                const ativo = item.nome === servico;
                return (
                  <button
                    key={item.nome}
                    type="button"
                    role="radio"
                    aria-checked={ativo}
                    onClick={() => selecionarServico(item.nome)}
                    className={`min-h-11 rounded-card-sm border px-3.5 py-3 text-left outline-none transition-colors focus-visible:ring-2 focus-visible:ring-brand ${ativo ? 'border-brand bg-brand-soft text-brand' : 'border-line bg-surface-sunken text-ink hover:bg-surface-hover'}`}
                  >
                    <span className="block font-display text-[14px] font-semibold">
                      {item.nome}
                    </span>
                    <span className="mt-0.5 block text-[12px] opacity-75">
                      {item.duracao_min} min
                    </span>
                  </button>
                );
              })}
            </div>
          </section>

          <section aria-labelledby="horario-titulo">
            <h2 id="horario-titulo" className="sr-only">
              Data e horário
            </h2>
            <SlotPicker
              slot={slot}
              colaboradorId={colaboradorId}
              scope="colaborador"
              servico={servico}
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
          </section>

          <section className="space-y-3" aria-labelledby="cliente-titulo">
            <h2 id="cliente-titulo" className="font-display text-[15px] font-semibold text-ink">
              Cliente
            </h2>
            <Input
              label="Nome"
              value={nome}
              error={erroNome}
              maxLength={80}
              onChange={(event) => setNome(event.target.value)}
              autoComplete="name"
            />
            <Input
              label="WhatsApp"
              value={telefone}
              error={erroTelefone}
              inputMode="tel"
              autoComplete="tel"
              placeholder="(11) 99999-9999"
              onChange={(event) => setTelefone(formatPhoneBR(event.target.value))}
            />
            <div className="flex items-start gap-2.5">
              <Switch
                checked={semWhatsapp}
                onChange={setSemWhatsapp}
                label="Não tenho o WhatsApp deste cliente"
              />
              <div className="pt-1">
                <p className="text-[13px] font-semibold text-ink">
                  Não tenho o WhatsApp deste cliente
                </p>
                <p className="mt-0.5 text-[12px] text-ink-soft">
                  Sem número, o cliente não recebe lembrete automático.
                </p>
              </div>
            </div>
          </section>

          <Button
            loading={criar.isPending}
            loadingLabel="Marcando…"
            disabled={!servico || !data || !hora || !nome.trim()}
            onClick={confirmar}
          >
            <IconCheck size={18} />
            Marcar horário
          </Button>
        </div>
      )}
    </div>
  );
}
