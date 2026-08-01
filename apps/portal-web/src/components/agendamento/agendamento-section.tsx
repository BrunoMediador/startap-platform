'use client';

import { IconCalendar, IconHeadset } from '@/components/icons';
/**
 * Seção "Agendamento" dentro de "Meu negócio" (modo atendente, SCRUM-59).
 *
 * O dono liga/desliga o "agendamento automático pela agenda (Google)". DESLIGADO =
 * modo atendente: o assistente atende, tira dúvidas e — se houver — manda um link
 * externo pro cliente agendar (sem link, coleta os dados e avisa a equipe). Ligado =
 * comportamento atual (o bot marca pela agenda do Google).
 *
 * Gating: a seção só aparece quando `features.modo_atendente === true` (calculado
 * POR-CLONE no backend via MODO_ATENDENTE_SLOTS — NÃO é flag global). Clone sem a
 * feature -> nada renderiza (byte-idêntico pros clientes atuais). Durante o load
 * renderiza null (sem flash) — se a feature estiver off, o cliente nunca vê nem
 * esqueleto.
 *
 * O "WhatsApp da recepção" (destino do alerta ao dono) NÃO vive mais aqui: Onda 1
 * (SCRUM-68) o extraiu pra RecepcaoSection, editável por TODOS os formatos (não só modo
 * atendente). Esta seção segue gateada por modo_atendente — o toggle de agenda automática
 * muda o comportamento do bot e não faz parte do de-gate desta onda.
 *
 * Dados isolados do formulário principal do perfil: query própria (qk.agendaConfig)
 * derivada do mesmo /portal/perfil, salvamento parcial. Edição OTIMISTA com revert
 * (padrão D5 das telas servicos/horarios/perfil/lembretes).
 *
 * O link é OPCIONAL mesmo com o automático desligado (o piloto insere depois). Só
 * validamos o formato quando preenchido. Desligar o toggle pede confirmação (muda o
 * comportamento do bot).
 */
import { useTenant } from '@/components/shell/session-context';
import { useRegistrarNaoSalvo } from '@/components/shell/unsaved-changes-context';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { useToast } from '@/components/ui/toast';
import {
  type AgendaConfigDraft,
  ajudaLink,
  isAgendaDirty,
  isAgendaNaoConfigurada,
  toAgendaDraft,
  validateAgenda,
} from '@/lib/agenda-config';
import { qk, useAgendaConfig, useSaveAgendaConfig } from '@/lib/queries';
import { SUPORTE_AGENDA_URL } from '@/lib/suporte';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';

const TOGGLE_LABEL = 'Agendamento automático pela agenda (Google)';

export function AgendamentoSection() {
  const { slot } = useTenant();
  const toast = useToast();
  const client = useQueryClient();
  const cfgQ = useAgendaConfig(slot);
  const save = useSaveAgendaConfig(slot);

  const [draft, setDraft] = useState<AgendaConfigDraft>(() => toAgendaDraft(cfgQ.data));
  const [saved, setSaved] = useState<AgendaConfigDraft>(() => toAgendaDraft(cfgQ.data));
  const [linkError, setLinkError] = useState<string | undefined>(undefined);
  const [confirmOff, setConfirmOff] = useState(false);
  // Evita estourar o rascunho do usuário num refetch em background (mesmo padrão do
  // perfil/lembretes): o effect só re-hidrata enquanto não houve edição.
  const touched = useRef(false);
  // A11y: quando o campo de link APARECE por ação do usuário (ligou->desligou), move
  // o foco pra ele. `prevAutomatico` evita roubar foco/rolar a página no mount inicial
  // de um clone que já está com o automático desligado.
  const linkRef = useRef<HTMLInputElement>(null);
  const prevAutomatico = useRef(draft.agenda_automatica);

  useEffect(() => {
    if (!cfgQ.data) return;
    const next = toAgendaDraft(cfgQ.data);
    setSaved(next);
    if (!touched.current) setDraft(next);
  }, [cfgQ.data]);

  useEffect(() => {
    if (prevAutomatico.current && !draft.agenda_automatica) linkRef.current?.focus();
    prevAutomatico.current = draft.agenda_automatica;
  }, [draft.agenda_automatica]);

  const dirty = isAgendaDirty(draft, saved);

  function onToggle(next: boolean) {
    // Desligar muda o comportamento do bot -> confirmar antes.
    if (!next && draft.agenda_automatica) {
      setConfirmOff(true);
      return;
    }
    touched.current = true;
    setDraft((d) => ({ ...d, agenda_automatica: next }));
    if (next) setLinkError(undefined);
  }

  function confirmarDesligar() {
    touched.current = true;
    setDraft((d) => ({ ...d, agenda_automatica: false }));
    setConfirmOff(false);
  }

  function onLinkChange(v: string) {
    touched.current = true;
    setDraft((d) => ({ ...d, link_agendamento: v }));
    if (linkError) setLinkError(undefined);
  }

  /**
   * Núcleo do submit (validação + save otimista). Extraído de `onSubmit`
   * pra também poder ser chamado pelo guard global de "alterações não
   * salvas" (SCRUM-158). Rejeita em validação inválida (nunca navega com
   * erro pendente); resolve assim que o cache aplica o otimista.
   */
  function submitAgendamento(): Promise<void> {
    return new Promise((resolve, reject) => {
      if (!dirty) {
        resolve();
        return;
      }
      if (save.isPending) {
        resolve();
        return;
      }

      const res = validateAgenda(draft);
      if (!res.ok) {
        setLinkError(res.error);
        reject(new Error('validacao'));
        return;
      }
      setLinkError(undefined);

      // Só os campos da agenda (o "WhatsApp da recepção" saiu pra RecepcaoSection). Mantém o
      // recepcao_telefone que já estava no rascunho — esta seção não o edita.
      const value = res.value;
      const nextSaved: AgendaConfigDraft = {
        ...value,
        recepcao_telefone: saved.recepcao_telefone,
      };
      const prev = client.getQueryData(qk.agendaConfig(slot));

      // Otimista: aplica no cache + fixa o draft normalizado na tela.
      client.setQueryData(qk.agendaConfig(slot), (p: typeof cfgQ.data) => ({
        modo_atendente: p?.modo_atendente ?? true,
        ...value,
        recepcao_telefone: p?.recepcao_telefone ?? '',
        // SCRUM-74: salvar não muda o estado da agenda — preserva (default TRUE).
        agenda_configurada: p?.agenda_configurada ?? true,
      }));
      setSaved(nextSaved);
      setDraft(nextSaved);
      touched.current = false;

      save.mutate(value, {
        onSuccess: () => {
          toast.success('Agendamento atualizado');
          resolve();
        },
        onError: (err) => {
          if (prev !== undefined) client.setQueryData(qk.agendaConfig(slot), prev);
          const back = toAgendaDraft(prev as Parameters<typeof toAgendaDraft>[0]);
          setSaved(back);
          setDraft(back);
          touched.current = false;
          // 409 agenda_nao_configurada (rede de proteção): religar o automático não é
          // self-service — aponta pro suporte em vez do erro genérico.
          toast.error(
            isAgendaNaoConfigurada(err)
              ? 'O agendamento automático é habilitado pela nossa equipe. Fale com o suporte para ativar.'
              : 'Não foi possível salvar. Tente de novo.',
          );
          reject(err instanceof Error ? err : new Error('save-falhou'));
        },
      });
    });
  }

  function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    submitAgendamento().catch(() => {
      // erro já tratado (inline/toast) dentro de submitAgendamento.
    });
  }

  // Guarda de navegação GLOBAL (SCRUM-158): registra esta seção no registry
  // central. Precisa rodar ANTES dos early-returns abaixo (Rules of Hooks).
  // Enquanto carrega/feature OFF, `draft`/`saved` nascem iguais -> `dirty` é
  // sempre `false`, então o registro nunca dispara o guard à toa.
  useRegistrarNaoSalvo('Agendamento pela agenda', dirty, submitAgendamento);

  // Load: não renderiza nada (sem flash pra quem não tem a feature).
  if (cfgQ.isPending || cfgQ.isError) return null;
  // Feature OFF pro clone -> some (byte-idêntico pros clientes atuais).
  if (!cfgQ.data?.modo_atendente) return null;

  const automatico = draft.agenda_automatica;
  const linkPreenchido = draft.link_agendamento.trim() !== '';
  // SCRUM-74: agenda conectada pelo time (default TRUE via retrocompat no hook). Sem
  // ela, NÃO oferecemos o Switch de auto-habilitar — vira CTA de suporte.
  const configurada = cfgQ.data.agenda_configurada;
  // O link (operação do modo atendente) segue editável independentemente do toggle:
  // sempre com o automático desligado E sempre quando a agenda não está configurada.
  const mostrarLink = !automatico || !configurada;

  return (
    <section
      aria-labelledby="agendamento-title"
      className="mt-8 flex flex-col gap-3 border-t border-line pt-6"
    >
      <div>
        <h2 id="agendamento-title" className="font-display text-[17px] font-semibold text-ink">
          Agendamento
        </h2>
        <p className="mt-0.5 text-[13px] leading-snug text-ink-soft">
          Como o assistente lida com marcações no WhatsApp.
        </p>
      </div>

      <div className="rounded-card border border-line bg-surface p-[18px] shadow-card">
        <form onSubmit={onSubmit} className="flex flex-col gap-4" noValidate>
          {/* Toggle principal — só quando a agenda está configurada pelo time (SCRUM-74). */}
          {configurada ? (
            <div className="flex items-center justify-between gap-3">
              <div className="min-w-0">
                <p className="text-[14px] font-semibold text-ink">{TOGGLE_LABEL}</p>
                <p className="mt-0.5 text-[12.5px] leading-normal text-ink-soft">
                  {automatico
                    ? 'O assistente marca os horários dos clientes sozinho no WhatsApp.'
                    : 'O assistente não marca sozinho — ele atende e direciona o cliente.'}
                </p>
              </div>
              <Switch checked={automatico} onChange={onToggle} label={TOGGLE_LABEL} />
            </div>
          ) : (
            /* Sem agenda configurada: sem Switch self-service — CTA de suporte (SCRUM-74). */
            <div className="rounded-card-sm border border-line bg-brand-soft p-3.5">
              <p className="text-[14px] font-semibold text-ink">{TOGGLE_LABEL}</p>
              <p className="mt-1 text-[12.5px] leading-normal text-ink-soft">
                O agendamento automático não faz parte do seu plano atual e é habilitado pela nossa
                equipe: nós configuramos a agenda do seu negócio (Google) e liberamos a função para
                você.
              </p>
              <a
                href={SUPORTE_AGENDA_URL}
                target="_blank"
                rel="noopener noreferrer"
                className="mt-3 inline-flex h-10 items-center justify-center gap-2 rounded-btn border border-line-strong bg-surface px-4 font-display text-[13.5px] font-semibold text-brand outline-none transition-colors hover:bg-surface-hover focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-2 focus-visible:ring-offset-bg"
              >
                <IconHeadset size={16} aria-hidden />
                Falar com o suporte
              </a>
            </div>
          )}

          {/* Link externo (com o automático desligado OU sem agenda configurada) */}
          {mostrarLink && (
            <div className="flex flex-col gap-2 border-t border-line pt-4">
              <Input
                ref={linkRef}
                label="Link de agendamento"
                type="url"
                inputMode="url"
                placeholder="https://... (Booksy, Trinks, seu site...)"
                value={draft.link_agendamento}
                error={linkError}
                onChange={(e) => onLinkChange(e.target.value)}
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
              />
              <p className="text-[12.5px] leading-normal text-ink-soft">
                {ajudaLink(linkPreenchido)}
              </p>
            </div>
          )}

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
                : configurada && automatico
                  ? 'Agendamento automático ligado.'
                  : 'Modo atendente ligado — o assistente atende sem marcar sozinho.'}
          </p>
        </form>
      </div>

      <ConfirmDialog
        open={confirmOff}
        icon={<IconCalendar size={22} />}
        title="Parar de marcar horários sozinho?"
        description="O assistente vai parar de marcar horários sozinho. Ele continua atendendo seus clientes no WhatsApp normalmente: quando alguém quiser agendar, envia seu link ou avisa sua equipe pra confirmar o horário. Você pode religar quando quiser."
        confirmLabel="Desligar"
        cancelLabel="Manter ligado"
        onConfirm={confirmarDesligar}
        onCancel={() => setConfirmOff(false)}
      />
    </section>
  );
}
