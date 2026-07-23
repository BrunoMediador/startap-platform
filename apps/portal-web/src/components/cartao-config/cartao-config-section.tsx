'use client';

/**
 * Seção "Cartão de confirmação" (SCRUM-92, increment 2 / ADR 0032) dentro de "Meu
 * negócio", irmã de "Monte seu atendente".
 *
 * O dono escolhe o TEMPLATE e os EMOJIS do cartão que o bot manda ANTES de marcar um
 * horário, com preview ao vivo. A etapa de confirmação em si NÃO pode ser desativada
 * (aviso fixo) — ela protege a agenda.
 *
 * ── UI PARA TODOS (contrato novo #475/#476) ─────────────────────────────────────────
 * A seção aparece pra TODO cliente elegível, já seedada com o cartão ATUAL. O GET decide:
 *   - editable -> formulário completo (picker seedado da config); salvar flipa SÓ este clone
 *   - locked   -> read-only + nota gentil + "Falar com o suporte" (migração supervisionada)
 *   - hidden   -> a seção SOME inteira (flag global OFF / 404 / erro): degradação graciosa,
 *                 byte-idêntico pros clientes atuais. Também some no modo atendente (sem cartão).
 *
 * O emoji sai de um catálogo FECHADO por slot (picker, nunca campo aberto) — espelha a
 * allowlist do backend. O `preview` do endpoint é o bloco INTERNO do runtime e nunca é
 * exibido: a prévia amigável é montada aqui (buildCartaoPreview). Sem PII no client.
 *
 * Copy: TODA string que o cliente vê vem de CARTAO_COPY (lib/cartao-config) — DRAFT, o PM
 * confirma com o Bruno antes do ar.
 */
import { IconAlert, IconBrush, IconCheck, IconHeadset, IconLock } from '@/components/icons';
import { useTenant } from '@/components/shell/session-context';
import { Button } from '@/components/ui/button';
import { useToast } from '@/components/ui/toast';
import {
  CARTAO_COPY,
  CARTAO_SLOTS,
  type CartaoDraft,
  type CartaoEditableState,
  type CartaoLockedState,
  type CartaoSlot,
  type CartaoTemplate,
  EMOJI_CATALOG,
  buildCartaoPreview,
  isCartaoDirty,
  isCartaoEditable,
  isCartaoLocked,
  previewLines,
  setEmoji,
  setTemplate,
  toCartaoDraft,
  toCartaoPayload,
} from '@/lib/cartao-config';
import { cn } from '@/lib/cn';
import { useAgendaConfig, useCartaoConfig, useSaveCartaoConfig } from '@/lib/queries';
import { SUPORTE_CARTAO_URL } from '@/lib/suporte';
import { useEffect, useRef, useState } from 'react';

export function CartaoConfigSection() {
  const { slot } = useTenant();
  const q = useCartaoConfig(slot);
  // Modo do clone: reusa o GET /portal/perfil já lido pela página (dedup por key). O
  // cartão só existe onde o bot MARCA horário — atendente puro (pré-venda que escala)
  // não tem cartão de confirmação. Esconde por robustez, mesmo que o backend não trave.
  const agendaCfg = useAgendaConfig(slot).data;
  const isAtendente = agendaCfg?.modo_atendente === true && agendaCfg?.agenda_automatica !== true;

  // Load inicial / hidden / atendente: nada renderiza (sem flash pra quem não tem a feature).
  if (q.isPending) return null;
  if (isAtendente) return null;
  if (isCartaoLocked(q.data)) return <CartaoLocked state={q.data} />;
  if (isCartaoEditable(q.data)) return <CartaoConfigForm slot={slot} state={q.data} />;
  return null; // status: 'hidden'
}

// ── Estado 1: editável (formulário completo) ─────────────────────────────────────

function CartaoConfigForm({ slot, state }: { slot: string; state: CartaoEditableState }) {
  const toast = useToast();
  const save = useSaveCartaoConfig(slot);

  const [saved, setSaved] = useState<CartaoDraft>(() => toCartaoDraft(state));
  const [draft, setDraft] = useState<CartaoDraft>(() => toCartaoDraft(state));
  const touched = useRef(false);

  // Re-hidrata do servidor só enquanto o dono não tocou (não estoura edição em refetch).
  useEffect(() => {
    if (touched.current) return;
    const next = toCartaoDraft(state);
    setSaved(next);
    setDraft(next);
  }, [state]);

  const dirty = isCartaoDirty(draft, saved);
  // Prévia amigável montada no client (NUNCA o bloco interno do servidor).
  const preview = buildCartaoPreview(draft.template, draft.emojis);

  function onTemplate(template: CartaoTemplate) {
    touched.current = true;
    setDraft((d) => setTemplate(d, template));
  }

  function onEmoji(s: CartaoSlot, emoji: string) {
    touched.current = true;
    setDraft((d) => setEmoji(d, s, emoji));
  }

  function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!dirty || save.isPending) return;

    const prev = saved;
    setSaved(draft); // otimista
    touched.current = false;

    save.mutate(toCartaoPayload(draft), {
      onSuccess: () => {
        toast.success(CARTAO_COPY.toastSucesso);
      },
      onError: () => {
        setSaved(prev);
        toast.error(CARTAO_COPY.toastErro);
      },
    });
  }

  return (
    <SectionShell>
      <form onSubmit={onSubmit} className="flex flex-col gap-5">
        <FixedWarning />

        <TemplateSelector value={draft.template} emojis={draft.emojis} onChange={onTemplate} />

        <EmojiEditor emojis={draft.emojis} onPick={onEmoji} />

        <PreviewCard text={preview} />

        <div className="flex flex-col gap-2">
          <Button
            type="submit"
            className="w-full sm:w-auto"
            loading={save.isPending}
            loadingLabel={CARTAO_COPY.salvando}
            disabled={!dirty}
          >
            {CARTAO_COPY.salvar}
          </Button>
          <p aria-live="polite" className="text-[12.5px] leading-normal text-ink-soft">
            {save.isPending
              ? CARTAO_COPY.salvando
              : dirty
                ? CARTAO_COPY.statusSujo
                : CARTAO_COPY.statusSalvo}
          </p>
        </div>
      </form>
    </SectionShell>
  );
}

// ── Estados 2/3: travado (read-only) ─────────────────────────────────────────────

/**
 * Cartão gerenciado pela equipe (persona à mão / template que exige revisão supervisionada).
 * Sem controles: prévia ILUSTRATIVA (defaults da área — o bloco real do backend é interno e
 * não se exibe) + nota gentil por motivo + CTA de suporte.
 */
function CartaoLocked({ state }: { state: CartaoLockedState }) {
  const preview = buildCartaoPreview(state.template, state.emojis);
  return (
    <SectionShell>
      <div className="flex flex-col gap-4">
        <div className="flex items-start gap-2.5 rounded-[12px] border border-line bg-surface-sunken px-3.5 py-3">
          <span className="mt-0.5 shrink-0 text-brand" aria-hidden>
            <IconLock size={16} />
          </span>
          <p className="text-[12.5px] leading-normal text-ink-soft">
            {CARTAO_COPY.lockNota[state.reason]}
          </p>
        </div>

        <div className="flex flex-col gap-2">
          <span className="text-[13px] font-semibold text-ink">{CARTAO_COPY.lockPreviaLabel}</span>
          <PreviewBubble text={preview} />
        </div>

        <a
          href={SUPORTE_CARTAO_URL}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex h-10 items-center justify-center gap-2 self-start rounded-btn border border-line-strong bg-surface px-4 font-display text-[13.5px] font-semibold text-brand outline-none transition-colors hover:bg-surface-hover focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-2 focus-visible:ring-offset-bg"
        >
          <IconHeadset size={16} aria-hidden />
          {CARTAO_COPY.lockCta}
        </a>
      </div>
    </SectionShell>
  );
}

// ── Chrome compartilhado ─────────────────────────────────────────────────────────

/** Cabeçalho + card da seção (traz o próprio divisor mt-8/border-t). */
function SectionShell({ children }: { children: React.ReactNode }) {
  return (
    <section
      aria-labelledby="cartao-config-title"
      className="mt-8 flex flex-col gap-3 border-t border-line pt-6"
    >
      <div>
        <h2
          id="cartao-config-title"
          className="flex items-center gap-2 font-display text-[17px] font-semibold text-ink"
        >
          <span className="text-brand" aria-hidden>
            <IconBrush size={18} />
          </span>
          {CARTAO_COPY.titulo}
        </h2>
        <p className="mt-0.5 text-[13px] leading-snug text-ink-soft">{CARTAO_COPY.subtitulo}</p>
      </div>
      <div className="rounded-card border border-line bg-surface p-[18px] shadow-card">
        {children}
      </div>
    </section>
  );
}

/** Aviso fixo, não-removível: a confirmação em si não pode ser desativada. */
function FixedWarning() {
  return (
    <div className="flex items-start gap-2.5 rounded-[12px] border border-line bg-surface-sunken px-3.5 py-3">
      <span className="mt-0.5 shrink-0 text-brand" aria-hidden>
        <IconAlert size={16} />
      </span>
      <p className="text-[12.5px] leading-normal text-ink-soft">{CARTAO_COPY.avisoFixo}</p>
    </div>
  );
}

/** Seletor de template (3 opções em radiogroup, cada uma com mini-preview). */
function TemplateSelector({
  value,
  emojis,
  onChange,
}: {
  value: CartaoTemplate;
  emojis: CartaoDraft['emojis'];
  onChange: (t: CartaoTemplate) => void;
}) {
  return (
    <div className="flex flex-col gap-2">
      <span className="text-[13px] font-semibold text-ink">{CARTAO_COPY.formatoLabel}</span>
      <div
        role="radiogroup"
        aria-label={CARTAO_COPY.formatoLabel}
        className="flex flex-col gap-2.5"
      >
        {CARTAO_COPY.templates.map((opt) => {
          const selected = value === opt.value;
          const mini = previewLines(buildCartaoPreview(opt.value, emojis)).slice(0, 2);
          return (
            <button
              key={opt.value}
              type="button"
              role="radio"
              aria-checked={selected}
              onClick={() => onChange(opt.value)}
              className={cn(
                'flex items-start gap-3 rounded-[12px] border-[1.5px] p-3 text-left outline-none transition-colors focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-1 focus-visible:ring-offset-bg',
                selected
                  ? 'border-brand bg-brand-soft'
                  : 'border-line-strong bg-surface hover:bg-surface-hover',
              )}
            >
              <span
                aria-hidden
                className={cn(
                  'mt-0.5 flex size-[18px] shrink-0 items-center justify-center rounded-full border',
                  selected ? 'border-brand bg-brand text-bg' : 'border-line-strong',
                )}
              >
                {selected && <IconCheck size={12} />}
              </span>
              <span className="flex min-w-0 flex-1 flex-col gap-1.5">
                <span className="flex flex-wrap items-baseline gap-x-2">
                  <span className="font-display text-[14px] font-semibold text-ink">
                    {opt.label}
                  </span>
                  <span className="text-[12px] text-ink-soft">{opt.hint}</span>
                </span>
                <span className="whitespace-pre-wrap break-words rounded-[8px] border border-line bg-surface-sunken px-2.5 py-1.5 text-[11.5px] leading-snug text-ink-soft">
                  {mini.join('\n')}
                </span>
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

/** Editor de emojis por campo do cartão (um picker de catálogo fechado por slot). */
function EmojiEditor({
  emojis,
  onPick,
}: {
  emojis: CartaoDraft['emojis'];
  onPick: (slot: CartaoSlot, emoji: string) => void;
}) {
  return (
    <div className="flex flex-col gap-2">
      <span className="text-[13px] font-semibold text-ink">{CARTAO_COPY.emojisLabel}</span>
      <p className="text-[12px] text-ink-soft">{CARTAO_COPY.emojisAjuda}</p>
      <div className="flex flex-col gap-3">
        {CARTAO_SLOTS.map((slot) => (
          <EmojiRow
            key={slot}
            slot={slot}
            selected={emojis[slot]}
            onPick={(emoji) => onPick(slot, emoji)}
          />
        ))}
      </div>
    </div>
  );
}

/** Uma linha do editor: rótulo do campo + os emojis do catálogo daquele slot. */
function EmojiRow({
  slot,
  selected,
  onPick,
}: {
  slot: CartaoSlot;
  selected: string;
  onPick: (emoji: string) => void;
}) {
  const label = CARTAO_COPY.slotLabels[slot];
  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-[12.5px] font-medium text-ink-soft">{label}</span>
      <div
        role="radiogroup"
        aria-label={`Emoji do campo ${label}`}
        className="flex flex-wrap gap-1.5"
      >
        {EMOJI_CATALOG[slot].map((emoji) => {
          const on = selected === emoji;
          return (
            <button
              key={emoji}
              type="button"
              role="radio"
              aria-checked={on}
              aria-label={`Usar ${emoji} no campo ${label}`}
              onClick={() => onPick(emoji)}
              className={cn(
                'flex size-11 items-center justify-center rounded-[10px] border-[1.5px] text-[19px] leading-none outline-none transition-colors focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-1 focus-visible:ring-offset-bg',
                on
                  ? 'border-brand bg-brand-soft'
                  : 'border-line-strong bg-surface hover:bg-surface-hover',
              )}
            >
              <span aria-hidden>{emoji}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

/** Prévia ao vivo do cartão, com rótulo + rodapé (usada no formulário editável). */
function PreviewCard({ text }: { text: string }) {
  return (
    <div className="flex flex-col gap-2">
      <span className="text-[13px] font-semibold text-ink">{CARTAO_COPY.previaLabel}</span>
      <PreviewBubble text={text} />
      <p className="text-[12px] text-ink-soft">{CARTAO_COPY.previaRodape}</p>
    </div>
  );
}

/** Bolha estilo WhatsApp com o texto do cartão renderizado (amigável, não o bloco interno). */
function PreviewBubble({ text }: { text: string }) {
  return (
    <div className="rounded-[14px] border border-line bg-surface-sunken p-3">
      <div className="max-w-[85%] whitespace-pre-wrap break-words rounded-[16px] rounded-bl-[5px] border border-line bg-surface px-3.5 py-2.5 text-[14px] leading-[1.5] text-ink">
        {text}
      </div>
    </div>
  );
}
