'use client';

import { IconAlert, IconPlus, IconTrash } from '@/components/icons';
/**
 * Seção "Frases de comando" na tela Pausas (modo atendente, SCRUM-59).
 *
 * Cenário: a IA e o atendente humano usam o MESMO número de WhatsApp. Quando alguém da
 * equipe quer assumir a conversa, digita uma "frase de pausa" no próprio chat — o
 * assistente para de responder aquele cliente. A "frase de retomada" devolve o
 * atendimento pro assistente. Como a frase APARECE na conversa (o cliente final vê), o
 * dono personaliza o texto com a cara da marca dele.
 *
 * Gating (byte-idêntico pros demais clientes): a seção só aparece com
 * `features.modo_atendente === true` (por-clone no backend, NÃO flag global) — lido via
 * useAgendaConfig (deriva do /portal/perfil, já cacheado). Durante o load renderiza null
 * (sem flash pra quem não tem a feature). Defesa em profundidade: 404 no GET
 * /portal/frases-pausa = feature off -> some (mesmo critério do lembrete #368). O próprio
 * <section> carrega seu divisor/espaçamento (mt-8/border-t) — nunca num wrapper de página
 * (lição #415: null não pode deixar spacer órfão).
 *
 * Edição em RASCUNHO + Salvar explícito (replace-set, PUT da lista completa). NÃO é
 * otimista: validação client-side espelha o backend (máx 10, keyword 2..80, sem duplicata
 * por (tipo, frase normalizada)); o 400 é rede de proteção. Sucesso -> toast + fixa a
 * resposta; falha -> toast, mantém o rascunho pro dono corrigir.
 */
import { useTenant } from '@/components/shell/session-context';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { ErrorState } from '@/components/ui/states';
import { Switch } from '@/components/ui/switch';
import { useToast } from '@/components/ui/toast';
import { cn } from '@/lib/cn';
import {
  COMMAND_FIELD_LABEL,
  COMMAND_LABEL,
  COMMAND_MATCH_HELP,
  COMMAND_PLACEHOLDER,
  FRASE_ERROR_MSG,
  type FraseCommand,
  type FraseError,
  type FrasePausaDraft,
  KEYWORD_MAX,
  MAX_FRASES,
  addFrase,
  atMaxFrases,
  isFrasesDirty,
  isFrasesFeatureOff,
  isFrasesRejeitadas,
  isFrasesValidas,
  removeFrase,
  setFraseCommand,
  setFraseKeyword,
  toFrasesDraft,
  toFrasesPayload,
  toggleFraseEnabled,
  validateFrases,
} from '@/lib/frases-pausa';
import { qk, useAgendaConfig, useFrasesPausa, useSaveFrasesPausa } from '@/lib/queries';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';

export function FrasesPausaSection({ slot }: { slot: string }) {
  const toast = useToast();
  const client = useQueryClient();
  // modo_atendente vem do /portal/perfil (derivado em qk.agendaConfig, já cacheado).
  const cfgQ = useAgendaConfig(slot);
  const modoAtendente = cfgQ.data?.modo_atendente === true;
  // Só busca as frases quando a feature está ligada -> clone sem a feature nunca chama a rota.
  const frasesQ = useFrasesPausa(slot, modoAtendente);
  const save = useSaveFrasesPausa(slot);

  // `saved` = última versão confirmada; `draft` = edição em andamento. `touched` evita
  // estourar o rascunho num refetch em background (mesmo padrão de perfil/lembretes).
  const [draft, setDraft] = useState<FrasePausaDraft[]>(() => toFrasesDraft(frasesQ.data?.frases));
  const [saved, setSaved] = useState<FrasePausaDraft[]>(() => toFrasesDraft(frasesQ.data?.frases));
  const touched = useRef(false);

  useEffect(() => {
    if (!frasesQ.data) return;
    const next = toFrasesDraft(frasesQ.data.frases);
    setSaved(next);
    if (!touched.current) setDraft(next);
  }, [frasesQ.data]);

  const errors = validateFrases(draft);
  const dirty = isFrasesDirty(draft, saved);
  const valido = isFrasesValidas(draft);
  const noLimite = atMaxFrases(draft);

  function onAdd() {
    touched.current = true;
    setDraft((d) => addFrase(d));
  }
  function onRemove(id: number) {
    touched.current = true;
    setDraft((d) => removeFrase(d, id));
  }
  function onKeyword(id: number, v: string) {
    touched.current = true;
    setDraft((d) => setFraseKeyword(d, id, v));
  }
  function onCommand(id: number, c: FraseCommand) {
    touched.current = true;
    setDraft((d) => setFraseCommand(d, id, c));
  }
  function onToggle(id: number) {
    touched.current = true;
    setDraft((d) => toggleFraseEnabled(d, id));
  }

  function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!dirty || !valido || save.isPending) return;

    const payload = toFrasesPayload(draft);
    save.mutate(payload, {
      onSuccess: (res) => {
        const next = toFrasesDraft(res.frases);
        client.setQueryData(qk.frasesPausa(slot), res);
        setSaved(next);
        setDraft(next);
        touched.current = false;
        toast.success('Frases salvas');
      },
      onError: (err) => {
        // O rascunho FICA na tela pro dono corrigir (não reverte). 400 = backend recusou.
        if (isFrasesRejeitadas(err)) {
          toast.error('Não foi possível salvar. Revise as frases e tente de novo.');
        } else {
          toast.error('Não foi possível salvar. Tente de novo.');
        }
      },
    });
  }

  // Load: nada renderiza (sem flash pra quem não tem a feature).
  if (cfgQ.isPending || cfgQ.isError) return null;
  // Feature OFF pro clone -> some (byte-idêntico pros clientes atuais).
  if (!modoAtendente) return null;

  if (frasesQ.isPending) {
    return (
      <SectionShell>
        <span className="sr-only">Carregando as frases de comando…</span>
        <div className="flex flex-col gap-3">
          <Skeleton className="h-7 w-full" />
          <Skeleton className="h-9 w-2/3" />
        </div>
      </SectionShell>
    );
  }
  // 404 = feature off no backend (defesa em profundidade): some sem card vermelho.
  if (isFrasesFeatureOff(frasesQ.error)) return null;
  if (frasesQ.isError) {
    return (
      <SectionShell>
        <ErrorState onRetry={() => frasesQ.refetch()} />
      </SectionShell>
    );
  }

  return (
    <SectionShell>
      <p className="text-[13px] leading-normal text-ink-soft">
        Quando alguém da equipe quiser responder um cliente à mão, é só digitar sua frase de pausa
        na conversa do WhatsApp — o assistente para de responder aquela pessoa. Quando terminar,
        digite a frase de retomada e o assistente volta a atender. Vale só para aquela conversa; os
        outros clientes seguem no automático.
      </p>

      {/* Aviso (P0 da seção): a frase aparece pro cliente final. Rótulo textual
          "Atenção:" + ícone — não depende só de cor (WCAG). */}
      <div className="mt-3 flex items-start gap-2.5 rounded-[12px] border border-warn/30 bg-warn-soft px-3.5 py-3 text-warn">
        <span className="mt-0.5 shrink-0" aria-hidden="true">
          <IconAlert size={17} />
        </span>
        <p className="text-[12.5px] leading-normal">
          <span className="font-semibold">Atenção:</span> a frase que você digitar aparece na
          conversa e o cliente lê. Escolha algo com a cara do seu negócio — ex.:{' '}
          <span className="font-semibold">"Oi! Aqui é a equipe Meduzza 👋"</span>. Evite frases que
          pareçam comando de robô ("/pausar", "ativar humano").
        </p>
      </div>

      <form onSubmit={onSubmit} className="mt-4 flex flex-col gap-3" noValidate>
        {draft.length === 0 ? (
          <p className="rounded-[12px] border border-dashed border-line-strong bg-surface-sunken px-4 py-6 text-center text-[13px] text-ink-soft">
            Defina suas frases para poder assumir uma conversa quando quiser. Comece adicionando uma
            frase de pausa abaixo.
          </p>
        ) : (
          <ul className="flex flex-col gap-3">
            {draft.map((f) => (
              <FraseCard
                key={f.id}
                frase={f}
                error={errors.get(f.id)}
                onKeyword={(v) => onKeyword(f.id, v)}
                onCommand={(c) => onCommand(f.id, c)}
                onToggle={() => onToggle(f.id)}
                onRemove={() => onRemove(f.id)}
              />
            ))}
          </ul>
        )}

        <button
          type="button"
          onClick={onAdd}
          disabled={noLimite}
          className="flex h-11 items-center justify-center gap-2 rounded-field border-[1.5px] border-dashed border-line-strong bg-surface-sunken font-display text-[13.5px] font-semibold text-ink-soft outline-none transition-colors hover:border-brand/50 hover:text-ink focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-2 focus-visible:ring-offset-bg disabled:cursor-not-allowed disabled:opacity-50"
        >
          <IconPlus size={17} />
          Adicionar frase
        </button>
        {noLimite && (
          <p className="text-[12px] leading-normal text-ink-soft">
            Você chegou ao limite de {MAX_FRASES} frases.
          </p>
        )}

        <div className="mt-1 flex items-center gap-3">
          <Button
            type="submit"
            size="inline"
            className="flex-1"
            loading={save.isPending}
            disabled={!dirty || !valido}
          >
            Salvar minhas frases
          </Button>
        </div>

        <p aria-live="polite" className="px-0.5 text-[12.5px] leading-normal text-ink-soft">
          {save.isPending
            ? 'Salvando…'
            : dirty
              ? !valido
                ? 'Revise as frases destacadas pra poder salvar.'
                : 'Você tem alterações não salvas.'
              : draft.length === 0
                ? 'Nenhuma frase configurada.'
                : 'Tudo salvo.'}
        </p>
      </form>
    </SectionShell>
  );
}

/** Cabeçalho + card da seção (reutilizado por todos os estados). */
function SectionShell({ children }: { children: React.ReactNode }) {
  return (
    <section
      aria-labelledby="frases-title"
      className="mt-8 flex flex-col gap-3 border-t border-line pt-6"
    >
      <div>
        <h2 id="frases-title" className="font-display text-[17px] font-semibold text-ink">
          Responder você mesmo quando quiser
        </h2>
        <p className="mt-0.5 text-[13px] leading-snug text-ink-soft">
          Frases que sua equipe digita no WhatsApp pra assumir ou devolver o atendimento.
        </p>
      </div>
      <div className="rounded-card border border-line bg-surface p-[18px] shadow-card">
        {children}
      </div>
    </section>
  );
}

const COMMANDS: FraseCommand[] = ['pause', 'resume'];

/** Uma frase editável: tipo (select) + ativa (switch) + remover + campo de texto. */
function FraseCard({
  frase,
  error,
  onKeyword,
  onCommand,
  onToggle,
  onRemove,
}: {
  frase: FrasePausaDraft;
  error: FraseError | undefined;
  onKeyword: (v: string) => void;
  onCommand: (c: FraseCommand) => void;
  onToggle: () => void;
  onRemove: () => void;
}) {
  const tipoLabel = COMMAND_LABEL[frase.command];
  return (
    <li className="flex flex-col gap-2.5 rounded-[12px] border border-line bg-surface-sunken p-3">
      <div className="flex items-center gap-2">
        <label className="sr-only" htmlFor={`frase-tipo-${frase.id}`}>
          Tipo da frase
        </label>
        <select
          id={`frase-tipo-${frase.id}`}
          value={frase.command}
          onChange={(e) => onCommand(e.target.value as FraseCommand)}
          className="h-10 cursor-pointer appearance-none rounded-[10px] border-[1.5px] border-line-strong bg-surface px-3 pr-8 font-display text-[13.5px] font-semibold text-ink outline-none transition-colors hover:border-[var(--c-input-hover-border)] focus:border-brand focus:ring-[3px] focus:ring-brand/35 focus:shadow-focus"
        >
          {COMMANDS.map((c) => (
            <option key={c} value={c}>
              {COMMAND_LABEL[c]}
            </option>
          ))}
        </select>

        <div className="ml-auto flex items-center gap-2.5">
          <Switch
            checked={frase.enabled}
            onChange={onToggle}
            label={`Frase de ${tipoLabel.toLowerCase()} ativa`}
          />
          <button
            type="button"
            onClick={onRemove}
            aria-label={`Remover frase de ${tipoLabel.toLowerCase()}`}
            className="flex size-10 shrink-0 items-center justify-center rounded-[10px] border border-line-strong bg-surface text-ink-soft outline-none transition-colors hover:border-danger/40 hover:bg-danger-soft hover:text-danger focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-2 focus-visible:ring-offset-bg"
          >
            <IconTrash size={17} />
          </button>
        </div>
      </div>

      <Input
        label={COMMAND_FIELD_LABEL[frase.command]}
        hideLabel
        value={frase.keyword}
        onChange={(e) => onKeyword(e.target.value)}
        error={error ? FRASE_ERROR_MSG[error] : undefined}
        placeholder={COMMAND_PLACEHOLDER[frase.command]}
        maxLength={KEYWORD_MAX}
        autoComplete="off"
        className={cn(!frase.enabled && 'opacity-60')}
      />
      <p className="text-[12px] leading-normal text-ink-soft">
        {COMMAND_MATCH_HELP[frase.command]}
      </p>
    </li>
  );
}
