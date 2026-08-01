'use client';

/**
 * Seção "Lembretes" dentro de "Meu negócio". O dono liga/desliga o lembrete
 * automático de agendamento e escolhe QUANDO enviar (uma ou mais janelas: 24h, 3h,
 * 2h, 1h antes). O worker que ENVIA é backend (PR companheiro) — aqui é só a config.
 *
 * Por que mora em "Meu negócio" (e não num item de menu novo): é uma configuração
 * do negócio, gated por `atend_from_agenda` (sem agenda ativa não há o que lembrar).
 * Pôr aqui evita lotar a bottom nav mobile (já com 7+ itens) e some pra quem não
 * tem agenda — sem rota morta.
 *
 * Edição OTIMISTA (padrão D5 das telas servicos/horarios/perfil): toggle e chips
 * mexem só no draft local; "Salvar" aplica no cache + dispara o PATCH; sucesso ->
 * toast; falha -> reverte ao snapshot do servidor + toast danger.
 *
 * Gating: a seção só aparece com `atend_from_agenda` true (o pai já filtra). Aqui o
 * gating é defesa em profundidade — se for renderizada sem agenda, mostra o aviso
 * "disponível quando a agenda estiver ativa".
 */
import { useTenant } from '@/components/shell/session-context';
import { useRegistrarNaoSalvo } from '@/components/shell/unsaved-changes-context';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { ErrorState } from '@/components/ui/states';
import { Switch } from '@/components/ui/switch';
import { useToast } from '@/components/ui/toast';
import { cn } from '@/lib/cn';
import {
  JANELAS_PERMITIDAS,
  JANELA_LABEL,
  type LembretesDraft,
  isLembretesDirty,
  isLembretesFeatureOff,
  isLembretesValido,
  setEnabled,
  toLembretesDraft,
  toLembretesPatch,
  toggleWindow,
} from '@/lib/lembretes';
import { qk, useLembretes, useSaveLembretes } from '@/lib/queries';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';

export function LembretesSection() {
  const { slot, atendFromAgenda } = useTenant();
  const toast = useToast();
  const client = useQueryClient();
  const lembretesQ = useLembretes(slot);
  const save = useSaveLembretes(slot);

  // `saved` = última versão confirmada; `draft` = edição em andamento. `touched`
  // evita estourar o rascunho num refetch em background (mesmo padrão do perfil).
  const [draft, setDraft] = useState<LembretesDraft>(() => toLembretesDraft(lembretesQ.data));
  const [saved, setSaved] = useState<LembretesDraft>(() => toLembretesDraft(lembretesQ.data));
  const touched = useRef(false);

  useEffect(() => {
    if (!lembretesQ.data) return;
    const next = toLembretesDraft(lembretesQ.data);
    setSaved(next);
    if (!touched.current) setDraft(next);
  }, [lembretesQ.data]);

  const dirty = isLembretesDirty(draft, saved);
  const valido = isLembretesValido(draft);

  function onToggle(enabled: boolean) {
    touched.current = true;
    setDraft((d) => setEnabled(d, enabled));
  }

  function onToggleJanela(janela: (typeof JANELAS_PERMITIDAS)[number]) {
    touched.current = true;
    setDraft((d) => toggleWindow(d, janela));
  }

  /**
   * Núcleo do submit (save otimista). Extraído de `onSubmit` pra também
   * poder ser chamado pelo guard global de "alterações não salvas"
   * (SCRUM-158). Resolve assim que o cache aplica o otimista; o `mutate`
   * segue em background com revert no erro.
   */
  function submitLembretes(): Promise<void> {
    return new Promise((resolve) => {
      if (!dirty || !valido) {
        resolve();
        return;
      }
      if (save.isPending) {
        resolve();
        return;
      }

      const patch = toLembretesPatch(draft);
      const prev = client.getQueryData(qk.lembretes(slot));

      // Otimista: aplica no cache + fixa o draft como salvo na hora.
      client.setQueryData(qk.lembretes(slot), {
        enabled: patch.enabled,
        windows_min: patch.windows_min,
      });
      setSaved(draft);
      touched.current = false;

      save.mutate(patch, {
        onSuccess: () => toast.success('Lembretes atualizados'),
        onError: () => {
          if (prev !== undefined) client.setQueryData(qk.lembretes(slot), prev);
          const back = toLembretesDraft(prev as Parameters<typeof toLembretesDraft>[0]);
          setSaved(back);
          setDraft(back);
          touched.current = false;
          toast.error('Não foi possível salvar. Tente de novo.');
        },
      });
      resolve();
    });
  }

  function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    submitLembretes().catch(() => {
      // erro já tratado (toast) dentro de submitLembretes.
    });
  }

  // Guarda de navegação GLOBAL (SCRUM-158): registra esta seção no registry
  // central. Precisa rodar ANTES dos early-returns abaixo (Rules of Hooks).
  // Sem agenda ativa/loading/feature off, `dirty` nasce sempre `false`
  // (draft/saved partem do mesmo valor), então o registro nunca dispara o
  // guard à toa.
  useRegistrarNaoSalvo('Lembretes', dirty, submitLembretes);

  // Gating (defesa em profundidade): sem agenda ativa, nada a lembrar.
  if (!atendFromAgenda) {
    return (
      <SectionShell>
        <p className="text-[13.5px] leading-normal text-ink-soft">
          Os lembretes ficam disponíveis quando a sua agenda estiver ativa. Conecte a agenda no
          painel pra liberar.
        </p>
      </SectionShell>
    );
  }

  if (lembretesQ.isPending) {
    return (
      <SectionShell>
        <span className="sr-only">Carregando a configuração de lembretes…</span>
        <div className="flex flex-col gap-3">
          <Skeleton className="h-7 w-full" />
          <Skeleton className="h-9 w-2/3" />
        </div>
      </SectionShell>
    );
  }

  // Feature OFF no backend (REMINDERS_ENABLED desligado): GET /portal/lembretes
  // devolve 404. Isso NÃO é erro do cliente — a seção some graciosamente, sem card
  // vermelho nem botão de "tentar de novo" que falharia pra sempre. Outros erros
  // (rede real, 500…) caem no ErrorState abaixo. Mesmo critério de atendimentos/novo.
  if (isLembretesFeatureOff(lembretesQ.error)) return null;

  if (lembretesQ.isError) {
    return (
      <SectionShell>
        <ErrorState onRetry={() => lembretesQ.refetch()} />
      </SectionShell>
    );
  }

  return (
    <SectionShell>
      <form onSubmit={onSubmit} className="flex flex-col gap-4" noValidate>
        {/* Toggle principal */}
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            <p className="text-[14px] font-semibold text-ink">
              Enviar lembrete automático de agendamento
            </p>
            <p className="mt-0.5 text-[12.5px] leading-normal text-ink-soft">
              Mandamos um lembrete no WhatsApp do seu número pro cliente não esquecer o horário.
            </p>
          </div>
          <Switch
            checked={draft.enabled}
            onChange={onToggle}
            label="Enviar lembrete automático de agendamento"
          />
        </div>

        {/* Quando enviar (só com o lembrete ligado) */}
        {draft.enabled && (
          <fieldset className="flex flex-col gap-2.5 border-t border-line pt-4">
            <legend className="mb-1 text-[13px] font-semibold text-ink">Quando enviar</legend>
            <div
              className="flex flex-wrap gap-2"
              role="group"
              aria-label="Quando enviar o lembrete"
            >
              {JANELAS_PERMITIDAS.map((janela) => {
                const ativo = draft.windows.includes(janela);
                return (
                  <button
                    key={janela}
                    type="button"
                    role="checkbox"
                    aria-checked={ativo}
                    onClick={() => onToggleJanela(janela)}
                    className={cn(
                      'inline-flex h-10 items-center rounded-pill border px-4 font-display text-[13.5px] font-semibold outline-none transition-colors duration-[120ms] focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-2 focus-visible:ring-offset-bg',
                      ativo
                        ? 'border-brand bg-brand-soft text-brand'
                        : 'border-line-strong bg-surface-sunken text-ink-soft hover:border-brand/50 hover:text-ink',
                    )}
                  >
                    {JANELA_LABEL[janela]}
                  </button>
                );
              })}
            </div>
            <p
              aria-live="polite"
              className={cn(
                'text-[12.5px] leading-normal',
                valido ? 'text-ink-soft' : 'text-danger',
              )}
            >
              {valido
                ? 'Você pode escolher mais de um horário.'
                : 'Escolha pelo menos um horário pra enviar o lembrete.'}
            </p>
          </fieldset>
        )}

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
              : draft.enabled
                ? 'Lembrete ligado. Você pode mudar quando quiser.'
                : 'Lembrete desligado.'}
        </p>
      </form>
    </SectionShell>
  );
}

/** Cabeçalho + card da seção (reutilizado por todos os estados). */
function SectionShell({ children }: { children: React.ReactNode }) {
  return (
    <section aria-labelledby="lembretes-title" className="flex flex-col gap-3">
      <div>
        <h2 id="lembretes-title" className="font-display text-[17px] font-semibold text-ink">
          Lembretes
        </h2>
        <p className="mt-0.5 text-[13px] leading-snug text-ink-soft">
          Lembrete automático de agendamento pro cliente.
        </p>
      </div>
      <div className="rounded-card border border-line bg-surface p-[18px] shadow-card">
        {children}
      </div>
    </section>
  );
}
