'use client';

/**
 * Seção "Planos e assinaturas" dentro de "Meu negócio" (modo atendente, SCRUM-59).
 *
 * O dono descreve, em texto livre, os planos/assinaturas/benefícios da barbearia. O
 * texto cai no contexto do bot pela personalização existente — o assistente passa a
 * responder sobre planos usando exatamente o que estiver aqui.
 *
 * Onda 1 (SCRUM-68) — DE-GATE: a seção aparece pra TODOS os formatos (não só modo
 * atendente). O bot já renderiza planos em [NEGOCIO] pra todos SEM gate; aqui só
 * destravamos a EDIÇÃO no portal — mudança ADITIVA/byte-segura (o bloco de contexto do
 * bot não muda). Durante o load renderiza null (sem flash), e a seção traz o próprio
 * divisor -> some INTEIRA (sem divisor órfão) enquanto carrega.
 *
 * Dados isolados do formulário principal do perfil: query própria (qk.planosConfig)
 * derivada do mesmo /portal/perfil, salvamento parcial (só planos_beneficios; '' limpa).
 * Edição OTIMISTA com revert (padrão D5 das telas servicos/horarios/perfil/lembretes).
 */
import { useTenant } from '@/components/shell/session-context';
import { Button } from '@/components/ui/button';
import { useToast } from '@/components/ui/toast';
import { cn } from '@/lib/cn';
import {
  PLANOS_MAX,
  type PlanosDraft,
  isPlanosDirty,
  isPlanosValido,
  isPlanosVisivel,
  planosRestante,
  toPlanosDraft,
  toPlanosValue,
} from '@/lib/planos';
import { qk, usePlanosConfig, useSavePlanos } from '@/lib/queries';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useId, useRef, useState } from 'react';

const PLACEHOLDER = 'Ex.: Plano Barba Premium — R$99/mês: 4 barbas + 10% off em produtos...';
const AJUDA =
  'O assistente responde sobre planos usando exatamente o que estiver aqui. Deixe em branco se não tiver planos — ele encaminha a pergunta pra sua equipe.';

export function PlanosSection() {
  const { slot } = useTenant();
  const toast = useToast();
  const client = useQueryClient();
  const cfgQ = usePlanosConfig(slot);
  const save = useSavePlanos(slot);
  const fieldId = useId();
  const helpId = `${fieldId}-help`;
  const countId = `${fieldId}-count`;

  const [draft, setDraft] = useState<PlanosDraft>(() => toPlanosDraft(cfgQ.data));
  const [saved, setSaved] = useState<PlanosDraft>(() => toPlanosDraft(cfgQ.data));
  // Evita estourar o rascunho num refetch em background (mesmo padrão do perfil/lembretes).
  const touched = useRef(false);

  useEffect(() => {
    if (!cfgQ.data) return;
    const next = toPlanosDraft(cfgQ.data);
    setSaved(next);
    if (!touched.current) setDraft(next);
  }, [cfgQ.data]);

  const dirty = isPlanosDirty(draft, saved);
  const valido = isPlanosValido(draft.planos_beneficios);
  const restante = planosRestante(draft.planos_beneficios);

  function onChange(v: string) {
    touched.current = true;
    setDraft({ planos_beneficios: v });
  }

  function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!dirty || !valido || save.isPending) return;

    const value = toPlanosValue(draft);
    const nextSaved: PlanosDraft = { planos_beneficios: value };
    const prev = client.getQueryData(qk.planosConfig(slot));

    // Otimista: aplica no cache + fixa o draft normalizado (aparado) na tela.
    client.setQueryData(qk.planosConfig(slot), (p: typeof cfgQ.data) => ({
      modo_atendente: p?.modo_atendente ?? true,
      planos_beneficios: value,
    }));
    setSaved(nextSaved);
    setDraft(nextSaved);
    touched.current = false;

    save.mutate(
      { planos_beneficios: value },
      {
        onSuccess: () => toast.success('Planos atualizados'),
        onError: () => {
          if (prev !== undefined) client.setQueryData(qk.planosConfig(slot), prev);
          const back = toPlanosDraft(prev as Parameters<typeof toPlanosDraft>[0]);
          setSaved(back);
          setDraft(back);
          touched.current = false;
          toast.error('Não foi possível salvar. Tente de novo.');
        },
      },
    );
  }

  // Load: não renderiza nada (sem flash). Onda 1 (SCRUM-68): visível pra TODOS os
  // formatos assim que o perfil carrega — não gateia mais por modo_atendente.
  if (cfgQ.isPending || cfgQ.isError) return null;
  if (!isPlanosVisivel(cfgQ.data)) return null;

  return (
    <section
      aria-labelledby="planos-title"
      className="mt-8 flex flex-col gap-3 border-t border-line pt-6"
    >
      <div>
        <h2 id="planos-title" className="font-display text-[17px] font-semibold text-ink">
          Planos e assinaturas
        </h2>
        <p className="mt-0.5 text-[13px] leading-snug text-ink-soft">
          Descreva seus planos e o assistente responde sobre eles.
        </p>
      </div>

      <div className="rounded-card border border-line bg-surface p-[18px] shadow-card">
        <form onSubmit={onSubmit} className="flex flex-col gap-4" noValidate>
          <div className="flex flex-col gap-[7px]">
            <label htmlFor={fieldId} className="text-[13px] font-semibold text-ink">
              Planos e benefícios
            </label>
            <textarea
              id={fieldId}
              rows={5}
              value={draft.planos_beneficios}
              placeholder={PLACEHOLDER}
              onChange={(e) => onChange(e.target.value)}
              aria-invalid={valido ? undefined : true}
              aria-describedby={cn(helpId, countId)}
              className={cn(
                'w-full resize-y rounded-field border-[1.5px] border-line-strong bg-surface-sunken px-3.5 py-3 text-[15px] leading-snug text-ink outline-none transition-[border-color,box-shadow] duration-[120ms] placeholder:text-ink-faint',
                'hover:border-[var(--c-input-hover-border)]',
                'focus:border-brand focus:ring-[3px] focus:ring-brand/35 focus:shadow-focus',
                !valido && 'border-danger',
              )}
            />
            <div className="flex items-start justify-between gap-3">
              <p id={helpId} className="text-[12px] leading-normal text-ink-soft">
                {AJUDA}
              </p>
              <span
                id={countId}
                aria-live="polite"
                className={cn(
                  'shrink-0 tabular-nums text-[12px]',
                  valido ? 'text-ink-soft' : 'text-danger',
                )}
              >
                {draft.planos_beneficios.length}/{PLANOS_MAX}
              </span>
            </div>
            {!valido && (
              <p className="text-[13px] text-danger">
                Passou do limite em {Math.abs(restante)} caractere
                {Math.abs(restante) === 1 ? '' : 's'}. Encurte o texto pra salvar.
              </p>
            )}
          </div>

          <div className="flex items-center gap-3">
            <Button
              type="submit"
              size="inline"
              className="flex-1"
              loading={save.isPending}
              disabled={!dirty || !valido}
            >
              Salvar
            </Button>
          </div>

          <p aria-live="polite" className="px-0.5 text-[12.5px] leading-normal text-ink-soft">
            {save.isPending
              ? 'Salvando…'
              : dirty
                ? 'Você tem alterações não salvas.'
                : draft.planos_beneficios.trim() === ''
                  ? 'Sem planos cadastrados — o assistente encaminha a pergunta pra sua equipe.'
                  : 'Tudo salvo. O assistente já responde sobre seus planos.'}
          </p>
        </form>
      </div>
    </section>
  );
}
