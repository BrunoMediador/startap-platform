'use client';

/**
 * Seção "WhatsApp da recepção" dentro de "Meu negócio".
 *
 * Número que recebe os avisos ao dono (`alert_owner_phone`): pedidos de agendamento que
 * precisam de uma pessoa, novos contatos e escalações. Se ficar vazio, os avisos saem
 * pelo próprio WhatsApp conectado do negócio (fallback SCRUM-62 — o número da sessão).
 *
 * Onda 1 (SCRUM-68) — DE-GATE: antes esse campo vivia na AgendamentoSection (gateada por
 * modo atendente). O número já é usado por TODOS os kinds de alerta, então aqui ele vira
 * seção PRÓPRIA, editável por TODOS os formatos (inclusive quem usa agenda). Mudança
 * ADITIVA/byte-segura: o comportamento do bot não muda; só destravamos a edição no portal.
 *
 * Reusa a query qk.agendaConfig (deriva do /portal/perfil, já cacheado — zero request a
 * mais) e a lógica pura de agenda-config (recepcaoPayload/máscara/validação). Salva SÓ o
 * top-level `recepcao_telefone` (useSaveRecepcao — sem tocar agenda_automatica/link, que
 * seguem gated no backend). Edição OTIMISTA com revert. O <section> traz o próprio divisor.
 */
import { useTenant } from '@/components/shell/session-context';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useToast } from '@/components/ui/toast';
import {
  AJUDA_RECEPCAO,
  RECEPCAO_TELEFONE_ERRO,
  isRecepcaoIndisponivel,
  isRecepcaoVisivel,
  isTelefoneInvalido,
  recepcaoPayload,
} from '@/lib/agenda-config';
import type { AgendaConfig } from '@/lib/api-types';
import { maskPhoneBR, phoneDigits } from '@/lib/cadastro';
import { qk, useAgendaConfig, useSaveRecepcao } from '@/lib/queries';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';

/** Valor de EXIBIÇÃO mascarado do telefone salvo (backend guarda RAW E.164 "55DDD..."). */
function displayFrom(cfg: Pick<AgendaConfig, 'recepcao_telefone'> | undefined): string {
  return maskPhoneBR(cfg?.recepcao_telefone ?? '');
}

export function RecepcaoSection() {
  const { slot } = useTenant();
  const toast = useToast();
  const client = useQueryClient();
  const cfgQ = useAgendaConfig(slot);
  const save = useSaveRecepcao(slot);

  const [draft, setDraft] = useState<string>(() => displayFrom(cfgQ.data));
  const [saved, setSaved] = useState<string>(() => displayFrom(cfgQ.data));
  const [error, setError] = useState<string | undefined>(undefined);
  // Evita estourar o rascunho num refetch em background (padrão perfil/lembretes).
  const touched = useRef(false);

  useEffect(() => {
    if (!cfgQ.data) return;
    const next = displayFrom(cfgQ.data);
    setSaved(next);
    if (!touched.current) setDraft(next);
  }, [cfgQ.data]);

  const dirty = phoneDigits(draft) !== phoneDigits(saved);

  function onChange(v: string) {
    touched.current = true;
    // Máscara progressiva BR na digitação (mesmo padrão do signup).
    setDraft(maskPhoneBR(v));
    if (error) setError(undefined);
  }

  function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!dirty || save.isPending) return;

    // SCRUM-62: preenchido+inválido -> erro; preenchido+mudado -> E.164; ESVAZIADO (tinha
    // número, o dono apagou) -> "" pra LIMPAR (avisos voltam ao WhatsApp do negócio);
    // sem mudança -> não deveria chegar aqui (dirty=false).
    const recep = recepcaoPayload(draft, saved);
    if (recep.kind === 'invalid') {
      setError(RECEPCAO_TELEFONE_ERRO);
      return;
    }
    if (recep.kind === 'omit') return;
    setError(undefined);

    const recepValue = recep.kind === 'set' ? recep.value : '';
    const nextDisplay = recep.kind === 'set' ? maskPhoneBR(recep.value) : '';
    const prev = client.getQueryData(qk.agendaConfig(slot));

    // Otimista: só o recepcao_telefone no cache (os demais campos ficam intactos).
    client.setQueryData(qk.agendaConfig(slot), (p: AgendaConfig | undefined) =>
      p ? { ...p, recepcao_telefone: recepValue } : p,
    );
    setSaved(nextDisplay);
    setDraft(nextDisplay);
    touched.current = false;

    save.mutate(
      { recepcao_telefone: recepValue },
      {
        onSuccess: () =>
          toast.success(
            recepValue === ''
              ? 'Avisos voltam pro WhatsApp do negócio'
              : 'WhatsApp da recepção salvo',
          ),
        onError: (err) => {
          if (prev !== undefined) client.setQueryData(qk.agendaConfig(slot), prev);
          const back = displayFrom(prev as AgendaConfig | undefined);
          setSaved(back);
          setDraft(back);
          touched.current = false;
          if (isTelefoneInvalido(err)) {
            toast.error('Não foi possível salvar o telefone da recepção. Confere o número.');
          } else if (isRecepcaoIndisponivel(err)) {
            toast.error('O telefone da recepção não está disponível agora.');
          } else {
            toast.error('Não foi possível salvar. Tente de novo.');
          }
        },
      },
    );
  }

  // Load: não renderiza nada (sem flash). Onda 1 (SCRUM-68): visível pra TODOS os formatos
  // assim que o perfil carrega — não gateia por modo_atendente.
  if (cfgQ.isPending || cfgQ.isError) return null;
  if (!isRecepcaoVisivel(cfgQ.data)) return null;

  const vazio = phoneDigits(draft).length === 0;

  return (
    <section
      aria-labelledby="recepcao-title"
      className="mt-8 flex flex-col gap-3 border-t border-line pt-6"
    >
      <div>
        <h2 id="recepcao-title" className="font-display text-[17px] font-semibold text-ink">
          WhatsApp da recepção
        </h2>
        <p className="mt-0.5 text-[13px] leading-snug text-ink-soft">
          Para onde o assistente manda os avisos de novos contatos e o que precisa de uma pessoa.
        </p>
      </div>

      <div className="rounded-card border border-line bg-surface p-[18px] shadow-card">
        <form onSubmit={onSubmit} className="flex flex-col gap-4" noValidate>
          <div className="flex flex-col gap-2">
            <Input
              label="WhatsApp da recepção (opcional)"
              type="tel"
              inputMode="tel"
              autoComplete="tel"
              placeholder="(11) 99999-9999"
              value={draft}
              error={error}
              onChange={(e) => onChange(e.target.value)}
            />
            <p className="text-[12.5px] leading-normal text-ink-soft">{AJUDA_RECEPCAO}</p>
          </div>

          <div className="flex items-center gap-3">
            <Button
              type="submit"
              size="inline"
              className="flex-1"
              loading={save.isPending}
              disabled={!dirty}
            >
              Salvar
            </Button>
          </div>

          <p aria-live="polite" className="px-0.5 text-[12.5px] leading-normal text-ink-soft">
            {save.isPending
              ? 'Salvando…'
              : dirty
                ? 'Você tem alterações não salvas.'
                : vazio
                  ? 'Sem número — os avisos saem pelo próprio WhatsApp do seu negócio.'
                  : 'Tudo salvo. Os avisos ao dono vão pra este número.'}
          </p>
        </form>
      </div>
    </section>
  );
}
