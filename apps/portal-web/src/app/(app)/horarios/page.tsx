'use client';

import { IconCopy } from '@/components/icons';
import { useTenant } from '@/components/shell/session-context';
import { PageHead } from '@/components/ui/page-head';
import { Skeleton } from '@/components/ui/skeleton';
import { ErrorState } from '@/components/ui/states';
import { Switch } from '@/components/ui/switch';
import { useToast } from '@/components/ui/toast';
import { DIAS_SEMANA, type DiaSemana, type Horarios } from '@/lib/api-types';
import { cn } from '@/lib/cn';
import {
  DIA_LABEL,
  abreAntesDeFecha,
  diaAberto,
  diaFechado,
  normalizarSemana,
  timeOptions,
} from '@/lib/horarios';
import { qk, useHorarios, useSaveHorarios } from '@/lib/queries';
/**
 * Horários / grade semanal (spec 6.8 + 3.4). 7 linhas seg-dom: switch roxo
 * Aberto/Fechado (D4) + 2 seletores de hora (30 min). Salvamento OTIMISTA (D5):
 * toda mudanca aplica no cache e dispara PUT; falha reverte + toast danger.
 *
 * "Aplicar a todos os dias" copia a config do primeiro dia ABERTO pros demais,
 * com toast de desfazer (undo restaura o snapshot anterior).
 *
 * Validacao: fecha > abre (senao erro inline na linha; nao salva aquele dia).
 */
import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';

const TIMES = timeOptions();

export default function HorariosPage() {
  const { slot } = useTenant();
  const toast = useToast();
  const client = useQueryClient();
  const horariosQ = useHorarios(slot);
  const save = useSaveHorarios(slot);
  const [erroDia, setErroDia] = useState<Partial<Record<DiaSemana, string>>>({});

  if (horariosQ.isPending) {
    return (
      <>
        <PageHead title="Horários" subtitle="Quando o robô pode marcar atendimentos." />
        <span className="sr-only">Carregando seus horários…</span>
        <div className="overflow-hidden rounded-card border border-line bg-surface">
          {DIAS_SEMANA.map((dia) => (
            <div
              key={`sk-${dia}`}
              className="flex items-center gap-3 border-b border-line p-4 last:border-b-0"
            >
              <Skeleton className="h-4 w-16" />
              <Skeleton className="ml-auto h-7 w-11 rounded-pill" />
            </div>
          ))}
        </div>
      </>
    );
  }

  if (horariosQ.isError || !horariosQ.data) {
    return (
      <>
        <PageHead title="Horários" subtitle="Quando o robô pode marcar atendimentos." />
        <ErrorState onRetry={() => horariosQ.refetch()} />
      </>
    );
  }

  const semana = normalizarSemana(horariosQ.data);

  /** Aplica `next` no cache (otimista) e dispara PUT; reverte em falha. */
  function commit(next: Horarios, successMsg: string) {
    const prev = client.getQueryData<Horarios>(qk.horarios(slot)) ?? horariosQ.data ?? {};
    client.setQueryData(qk.horarios(slot), next);
    save.mutate(next, {
      onSuccess: () => toast.success(successMsg),
      onError: () => {
        client.setQueryData(qk.horarios(slot), prev);
        toast.error('Não foi possível salvar. Tente de novo.');
      },
    });
  }

  function toggleDia(dia: DiaSemana, aberto: boolean) {
    const next: Horarios = { ...semana, [dia]: aberto ? diaAberto() : diaFechado() };
    setErroDia((e) => ({ ...e, [dia]: undefined }));
    commit(next, 'Horários atualizados');
  }

  function changeHora(dia: DiaSemana, campo: 'abre' | 'fecha', valor: string) {
    const atual = semana[dia];
    const candidato = { ...atual, [campo]: valor };
    if (candidato.abre && candidato.fecha && !abreAntesDeFecha(candidato.abre, candidato.fecha)) {
      setErroDia((e) => ({ ...e, [dia]: 'O fechamento deve ser depois da abertura' }));
      // ainda reflete no input localmente, mas nao salva o dia invalido
      client.setQueryData(qk.horarios(slot), { ...semana, [dia]: candidato });
      return;
    }
    setErroDia((e) => ({ ...e, [dia]: undefined }));
    commit({ ...semana, [dia]: candidato }, 'Horários atualizados');
  }

  function aplicarTodos() {
    const modelo = DIAS_SEMANA.map((d) => semana[d]).find((d) => !d.fechado) ?? diaAberto();
    const snapshot = horariosQ.data ?? {};
    const next: Horarios = {};
    for (const d of DIAS_SEMANA) {
      next[d] = { ...modelo };
    }
    const prev = snapshot;
    client.setQueryData(qk.horarios(slot), next);
    save.mutate(next, {
      onSuccess: () => {
        toast.error('Aplicado a todos os dias', {
          label: 'Desfazer',
          onClick: () => {
            client.setQueryData(qk.horarios(slot), prev);
            save.mutate(prev, {
              onError: () => toast.error('Não foi possível desfazer. Tente de novo.'),
            });
          },
        });
      },
      onError: () => {
        client.setQueryData(qk.horarios(slot), prev);
        toast.error('Não foi possível salvar. Tente de novo.');
      },
    });
  }

  return (
    <>
      <PageHead
        title="Horários"
        subtitle="Quando o robô pode marcar atendimentos. Toque no dia pra abrir ou fechar."
      />

      <button
        type="button"
        onClick={aplicarTodos}
        className="mb-3.5 inline-flex items-center gap-1.5 rounded-pill bg-brand-soft px-3.5 py-2 text-[13px] font-semibold text-brand outline-none transition-colors hover:bg-brand-soft-hover focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-2 focus-visible:ring-offset-bg"
      >
        <IconCopy size={15} />
        Aplicar a todos os dias
      </button>

      <div className="stagger stagger-2 overflow-hidden rounded-card border border-line bg-surface">
        {DIAS_SEMANA.map((dia) => {
          const d = semana[dia];
          const fechado = d.fechado;
          return (
            <div
              key={dia}
              className={cn(
                'flex min-h-16 flex-wrap items-center gap-x-3 gap-y-1 border-b border-line-soft px-[15px] py-3.5 transition-colors last:border-b-0 hover:bg-surface-hover',
                fechado && 'opacity-60',
              )}
            >
              <span
                className={cn(
                  'w-[74px] shrink-0 font-display text-[15px] font-semibold',
                  fechado ? 'text-ink-faint' : 'text-ink',
                )}
              >
                {DIA_LABEL[dia]}
              </span>
              <Switch
                checked={!fechado}
                onChange={(open) => toggleDia(dia, open)}
                label={`${DIA_LABEL[dia]} ${fechado ? 'fechado' : 'aberto'}`}
              />
              {fechado ? (
                <span className="ml-auto font-display text-[13px] font-semibold text-ink-faint">
                  Fechado
                </span>
              ) : (
                <div className="ml-auto flex items-center gap-2">
                  <TimeSelect
                    label={`${DIA_LABEL[dia]} abre`}
                    value={d.abre ?? '09:00'}
                    onChange={(v) => changeHora(dia, 'abre', v)}
                  />
                  <span aria-hidden className="text-[14px] text-ink-faint">
                    –
                  </span>
                  <TimeSelect
                    label={`${DIA_LABEL[dia]} fecha`}
                    value={d.fecha ?? '19:00'}
                    onChange={(v) => changeHora(dia, 'fecha', v)}
                  />
                </div>
              )}
              {erroDia[dia] && (
                <p role="alert" className="w-full text-[12.5px] font-medium text-danger">
                  {erroDia[dia]}
                </p>
              )}
            </div>
          );
        })}
      </div>

      <p className="mt-3.5 px-0.5 text-[12.5px] leading-normal text-ink-soft">
        As alterações são salvas automaticamente. O robô só agenda dentro desses horários.
      </p>
    </>
  );
}

function TimeSelect({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <select
      aria-label={label}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className="h-[42px] min-w-[78px] cursor-pointer appearance-none rounded-[10px] border-[1.5px] border-line-strong bg-surface-sunken px-2.5 text-center font-display text-[15px] font-semibold text-ink outline-none transition-colors hover:border-[#534b70] focus:border-brand focus:ring-[3px] focus:ring-brand/35 focus:shadow-focus"
    >
      {TIMES.map((t) => (
        <option key={t} value={t}>
          {t}
        </option>
      ))}
    </select>
  );
}
