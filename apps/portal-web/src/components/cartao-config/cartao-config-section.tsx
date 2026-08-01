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
import { useRegistrarNaoSalvo } from '@/components/shell/unsaved-changes-context';
import { Button } from '@/components/ui/button';
import { Overlay } from '@/components/ui/overlay';
import { useToast } from '@/components/ui/toast';
import {
  CARTAO_COPY,
  CARTAO_SLOTS,
  type CartaoDraft,
  type CartaoEditableState,
  type CartaoEmojis,
  type CartaoExemploSegmento,
  type CartaoLockedState,
  type CartaoPreviews,
  type CartaoSlot,
  type CartaoTemplate,
  buildCartaoPreview,
  disableEmoji,
  isCartaoDirty,
  isCartaoEditable,
  isCartaoLocked,
  isEmojiDisabled,
  isSingleValidEmoji,
  setEmoji,
  toCartaoDraft,
  toCartaoPayload,
} from '@/lib/cartao-config';
import { cn } from '@/lib/cn';
import {
  useAgendaConfig,
  useCartaoConfig,
  useCartaoPreview,
  useSaveCartaoConfig,
} from '@/lib/queries';
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

  // Prévia FIEL (SCRUM-99): a MESMA função do runtime renderiza o cartão no backend (o dono vê o
  // que o cliente recebe). Ao vivo pelos emojis do rascunho; enquanto carrega usa a prévia da
  // config salva (state.previews). DEGRADAÇÃO GRACIOSA: sem prévia do servidor → fallback client.
  const live = useCartaoPreview(slot, draft.emojis).data;
  const previews = live?.previews ?? state.previews;
  const segmentados = live?.previewsSegmentados ?? state.previewsSegmentados;
  const preview = previewFor(previews, draft.template, draft.emojis);
  const segmentos = segmentados?.[draft.template] ?? null;

  /** Slot cujo menu (editar/desabilitar) está aberto; null = nenhum. */
  const [menuSlot, setMenuSlot] = useState<CartaoSlot | null>(null);

  function onEmoji(s: CartaoSlot, emoji: string) {
    touched.current = true;
    setDraft((d) => setEmoji(d, s, emoji));
  }

  function onDesabilitar(s: CartaoSlot) {
    touched.current = true;
    setDraft((d) => disableEmoji(d, s));
  }

  /**
   * Núcleo do submit (save otimista). Extraído de `onSubmit` pra também
   * poder ser chamado pelo guard global de "alterações não salvas"
   * (SCRUM-158, "Salvar e sair"), que precisa da Promise pra decidir se
   * navega. Não há validação client-side aqui (picker fechado, sempre
   * válido) — só resolve/rejeita conforme o resultado do save.
   */
  function submitCartao(): Promise<void> {
    return new Promise((resolve, reject) => {
      if (!dirty || save.isPending) {
        resolve();
        return;
      }

      const prev = saved;
      setSaved(draft); // otimista
      touched.current = false;

      save.mutate(toCartaoPayload(draft), {
        onSuccess: () => {
          toast.success(CARTAO_COPY.toastSucesso);
          resolve();
        },
        onError: (err) => {
          setSaved(prev);
          toast.error(CARTAO_COPY.toastErro);
          reject(err instanceof Error ? err : new Error('save-falhou'));
        },
      });
    });
  }

  function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    submitCartao().catch(() => {
      // erro já tratado (toast) dentro de submitCartao — aqui só evita
      // unhandled rejection quando o disparo vem do <form>.
    });
  }

  // Guarda de navegação GLOBAL (SCRUM-158): registra esta seção no registry
  // central. Este componente (`CartaoConfigForm`) só monta quando o estado é
  // 'editable' (o pai `CartaoConfigSection` já filtrou hidden/locked/loading
  // antes), então não há early-return concorrendo com este hook aqui dentro.
  useRegistrarNaoSalvo('Cartão de confirmação', dirty, submitCartao);

  return (
    <SectionShell>
      <form onSubmit={onSubmit} className="flex flex-col gap-5">
        <FixedWarning />

        <PreviewCard
          segmentos={segmentos}
          textoFallback={preview}
          emojis={draft.emojis}
          onEditar={(slot) => setMenuSlot(slot)}
        />

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

      {menuSlot && (
        <EmojiActionSheet
          slot={menuSlot}
          emojis={draft.emojis}
          onClose={() => setMenuSlot(null)}
          onEmoji={(emoji) => {
            onEmoji(menuSlot, emoji);
            setMenuSlot(null);
          }}
          onDesabilitar={() => {
            onDesabilitar(menuSlot);
            setMenuSlot(null);
          }}
        />
      )}
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
  // Prévia FIEL do cartão atual vinda do backend (SCRUM-99); fallback client se não veio.
  const preview = previewFor(state.previews, state.template, state.emojis);
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
    <section aria-labelledby="cartao-config-title" className="flex flex-col gap-3">
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

/**
 * Prévia FIEL do cartão pro template pedido (SCRUM-99): usa a STRING renderizada pelo backend
 * (mesma função do runtime) quando disponível; senão cai no fallback client `buildCartaoPreview`
 * (degradação graciosa — a seção nunca fica sem prévia). `emojis` só alimenta o fallback.
 */
function previewFor(
  previews: CartaoPreviews | null | undefined,
  template: CartaoTemplate,
  emojis: CartaoEmojis,
): string {
  return previews?.[template] ?? buildCartaoPreview(template, emojis);
}

/**
 * Prévia AO VIVO que também é o EDITOR (decisão do Bruno 31/07): o cartão aparece no
 * "quadradinho" e os EMOJIS dentro dele são clicáveis; o texto é inerte. A nota acima
 * avisa que os emojis são editáveis.
 *
 * Sem segmentos (backend antigo/erro) → cai no texto puro, não-clicável: degradação
 * graciosa, a seção nunca fica sem prévia.
 */
function PreviewCard({
  segmentos,
  textoFallback,
  emojis,
  onEditar,
}: {
  segmentos: CartaoExemploSegmento[] | null;
  textoFallback: string;
  emojis: CartaoEmojis;
  onEditar: (slot: CartaoSlot) => void;
}) {
  return (
    <div className="flex flex-col gap-2">
      <span className="text-[13px] font-semibold text-ink">{CARTAO_COPY.previaLabel}</span>
      <p className="text-[12px] text-ink-soft">{CARTAO_COPY.editorAjuda}</p>
      {segmentos ? (
        <EditorBubble segmentos={segmentos} emojis={emojis} onEditar={onEditar} />
      ) : (
        <PreviewBubble text={textoFallback} />
      )}
      <p className="text-[12px] text-ink-soft">{CARTAO_COPY.previaRodape}</p>
    </div>
  );
}

/**
 * Bolha estilo WhatsApp em que cada segmento `tipo:'emoji'` vira um <button> destacado.
 * Os segmentos vêm PRONTOS do backend (mesma construção da string do runtime) — nunca
 * localizamos emoji por busca na string, senão o slot errado casaria quando dois campos
 * usam o mesmo emoji (Samuel tem marca === servico === ✂️).
 *
 * Slot desabilitado não emite segmento de emoji (o backend já o rende vazio), então o
 * botão de REABILITAR aparece na régua abaixo da bolha, não dentro do texto.
 */
function EditorBubble({
  segmentos,
  emojis,
  onEditar,
}: {
  segmentos: CartaoExemploSegmento[];
  emojis: CartaoEmojis;
  onEditar: (slot: CartaoSlot) => void;
}) {
  const desligados = CARTAO_SLOTS.filter((s) => isEmojiDisabled(emojis, s));
  return (
    <div className="flex flex-col gap-2 rounded-[14px] border border-line bg-surface-sunken p-3">
      <div className="max-w-[85%] whitespace-pre-wrap break-words rounded-[16px] rounded-bl-[5px] border border-line bg-surface px-3.5 py-2.5 text-[14px] leading-[1.7] text-ink">
        {segmentos.map((seg, i) =>
          seg.tipo === 'emoji' && seg.slot ? (
            <EmojiBotao
              // Índice no key: o mesmo slot pode aparecer 2x no cartão e o valor repete.
              key={`${seg.slot}-${i}`}
              slot={seg.slot}
              emoji={seg.valor}
              onClick={() => seg.slot && onEditar(seg.slot)}
            />
          ) : (
            // biome-ignore lint/suspicious/noArrayIndexKey: segmentos de texto são posicionais e imutáveis
            <span key={`t-${i}`}>{seg.valor}</span>
          ),
        )}
      </div>
      {desligados.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-[11.5px] text-ink-soft">{CARTAO_COPY.desligadosLabel}</span>
          {desligados.map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => onEditar(s)}
              className="rounded-[8px] border border-dashed border-line-strong bg-surface px-2 py-1 text-[11.5px] text-ink-soft outline-none transition-colors hover:bg-surface-hover focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-1 focus-visible:ring-offset-bg"
            >
              {CARTAO_COPY.slotLabels[s]}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/** Um emoji do cartão, clicável e visualmente destacado (sinaliza "dá pra editar"). */
function EmojiBotao({
  slot,
  emoji,
  onClick,
}: {
  slot: CartaoSlot;
  emoji: string;
  onClick: () => void;
}) {
  const label = CARTAO_COPY.slotLabels[slot];
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={CARTAO_COPY.emojiBotaoAria(label, emoji)}
      className="mx-[1px] inline-flex items-center justify-center rounded-[7px] border-[1.5px] border-dashed border-brand/45 bg-brand-soft px-[3px] align-baseline leading-none outline-none transition-colors hover:border-brand hover:bg-brand-soft focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-1 focus-visible:ring-offset-bg"
    >
      <span aria-hidden>{emoji}</span>
    </button>
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

// ── Menu de ação do emoji (editar / desabilitar) ─────────────────────────────────

/**
 * Sheet que abre ao tocar num emoji do cartão. Duas ações (decisão do Bruno): EDITAR —
 * abre o campo pro teclado do aparelho — e DESABILITAR (ou REABILITAR, quando o slot já
 * está desligado).
 *
 * ⚠️ Teclado emoji: NÃO existe API web que force o teclado a abrir na aba de emoji (nem
 * iOS nem Android expõem isso). O campo abre o teclado normal, de onde o usuário toca no
 * ícone de emoji — por isso a ajuda diz "cole ou digite", sem prometer o que não dá.
 *
 * `Overlay variant="sheet"` já traz trap de foco, Esc pra fechar e portal pro body
 * (não é cortado por ancestral com transform — lição da #538 no mobile).
 */
function EmojiActionSheet({
  slot,
  emojis,
  onClose,
  onEmoji,
  onDesabilitar,
}: {
  slot: CartaoSlot;
  emojis: CartaoEmojis;
  onClose: () => void;
  onEmoji: (emoji: string) => void;
  onDesabilitar: () => void;
}) {
  const label = CARTAO_COPY.slotLabels[slot];
  const desligado = isEmojiDisabled(emojis, slot);
  const [editando, setEditando] = useState(false);
  const [valor, setValor] = useState(desligado ? '' : emojis[slot]);
  const inputRef = useRef<HTMLInputElement>(null);

  // Erro só depois de digitar algo (não nasce vermelho); vazio ainda não é erro.
  const vazio = valor.trim() === '';
  const invalido = !vazio && !isSingleValidEmoji(valor);
  const podeUsar = !vazio && !invalido;

  function confirmar() {
    if (!podeUsar) return;
    onEmoji(valor);
  }

  return (
    <Overlay open onClose={onClose} variant="sheet" ariaLabel={CARTAO_COPY.menuTitulo(label)}>
      <div className="flex flex-col gap-4 p-5">
        <div>
          <h3 className="font-display text-[16px] font-semibold text-ink">
            {CARTAO_COPY.menuTitulo(label)}
          </h3>
          {!desligado && (
            <p className="mt-0.5 text-[13px] text-ink-soft">
              {CARTAO_COPY.menuAtual} <span aria-hidden>{emojis[slot]}</span>
            </p>
          )}
        </div>

        {editando ? (
          <div className="flex flex-col gap-2">
            <label htmlFor="cartao-emoji-input" className="text-[13px] font-semibold text-ink">
              {CARTAO_COPY.editorCampoLabel}
            </label>
            <input
              id="cartao-emoji-input"
              ref={inputRef}
              value={valor}
              onChange={(e) => setValor(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  confirmar();
                }
              }}
              // inputMode="text": o teclado do aparelho abre normal e o usuário acessa o
              // emoji por ele. Não há como forçar a aba de emoji via web.
              inputMode="text"
              autoComplete="off"
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              // biome-ignore lint/a11y/noAutofocus: sheet dedicado a um único campo; foco imediato é o comportamento esperado no mobile
              autoFocus
              aria-invalid={invalido}
              aria-describedby="cartao-emoji-ajuda"
              className={cn(
                'h-12 rounded-[10px] border-[1.5px] bg-surface px-3 text-[20px] leading-none text-ink outline-none transition-colors focus-visible:ring-2 focus-visible:ring-offset-1 focus-visible:ring-offset-bg',
                invalido
                  ? 'border-danger focus-visible:ring-danger'
                  : 'border-line-strong focus-visible:ring-brand',
              )}
            />
            <p
              id="cartao-emoji-ajuda"
              aria-live="polite"
              className={cn('text-[12px]', invalido ? 'text-danger' : 'text-ink-soft')}
            >
              {invalido ? CARTAO_COPY.editorErroInvalido : CARTAO_COPY.editorCampoAjuda}
            </p>
            <div className="mt-1 flex flex-col gap-2 sm:flex-row">
              <Button type="button" onClick={confirmar} disabled={!podeUsar}>
                {CARTAO_COPY.editorSalvar}
              </Button>
              <Button type="button" variant="secondary" onClick={() => setEditando(false)}>
                {CARTAO_COPY.editorCancelar}
              </Button>
            </div>
          </div>
        ) : (
          <div className="flex flex-col gap-2">
            <Button type="button" onClick={() => setEditando(true)}>
              {CARTAO_COPY.menuEditar}
            </Button>
            <Button
              type="button"
              variant={desligado ? 'secondary' : 'destructive'}
              onClick={desligado ? () => setEditando(true) : onDesabilitar}
            >
              {desligado ? CARTAO_COPY.menuReabilitar : CARTAO_COPY.menuDesabilitar}
            </Button>
            <Button type="button" variant="ghost" onClick={onClose}>
              {CARTAO_COPY.menuFechar}
            </Button>
          </div>
        )}
      </div>
    </Overlay>
  );
}
