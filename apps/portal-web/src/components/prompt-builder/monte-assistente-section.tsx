'use client';

import {
  IconChevronRight,
  IconPencil,
  IconRefresh,
  IconSend,
  IconSparkle,
} from '@/components/icons';
/**
 * Seção "Monte seu atendente" (SCRUM-92) dentro de "Meu negócio".
 *
 * O dono conversa com um assistente de configuração (meta-agente no DeepSeek) que faz
 * 4-5 perguntas simples e PROPÕE a personalidade do assistente de WhatsApp dele. Ao aprovar, a
 * persona vira o prompt de produção do clone — a mecânica de agendamento (confirmação)
 * é garantida por CÓDIGO no servidor e NUNCA depende do que a IA gerar (o dono só cuida
 * da personalidade/tom/nome/regras). Ver design SCRUM-92.
 *
 * Gating (byte-idêntico pros demais clientes): a seção PROBA o GET /portal/prompt-builder/
 * draft (useBuilderDraft). 404 (flag PROMPT_BUILDER_ENABLED OFF) -> {status:'indisponivel'}
 * -> renderiza null (some, sem flash). Erro real (rede/500) -> ErrorState com retry. O
 * <section> carrega seu próprio divisor (mt-8/border-t) — null não deixa spacer órfão.
 *
 * A conversa é estado LOCAL efêmero (o back guarda no Redis com TTL); o único artefato
 * durável é o prompt APROVADO. Sem PII logada no client.
 */
import { useTenant } from '@/components/shell/session-context';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { ErrorState } from '@/components/ui/states';
import { useToast } from '@/components/ui/toast';
import { cn } from '@/lib/cn';
import {
  BUILDER_MAX_INPUT,
  type BuilderMessage,
  PERSONA_MAX_CHARS,
  appendMessage,
  approveBuilder,
  generateNowContent,
  isPersonaSavable,
  isSendable,
  personaCharsLeft,
  remainingChars,
  resetBuilder,
  sendBuilderMessage,
  startBuilder,
} from '@/lib/prompt-builder';
import { qk, useBuilderDraft } from '@/lib/queries';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';

const GARANTIA =
  'A parte técnica (a confirmação antes de marcar um horário) é garantida automaticamente. Você só cuida da personalidade dele.';

export function MonteAssistenteSection() {
  const { slot } = useTenant();
  const toast = useToast();
  const client = useQueryClient();
  const draftQ = useBuilderDraft(slot);

  const [messages, setMessages] = useState<BuilderMessage[]>([]);
  const [input, setInput] = useState('');
  const [pending, setPending] = useState(false);
  // Texto da última mensagem que falhou por erro transitório -> botão "tentar de novo".
  const [erroRetry, setErroRetry] = useState<string | null>(null);
  const [approving, setApproving] = useState(false);
  const [confirmReset, setConfirmReset] = useState(false);
  // Rascunho ficou pronto NESTE turno (antes do refetch do draft confirmar) — snappy.
  const [localDraftReady, setLocalDraftReady] = useState(false);
  // Persona aplicada com sucesso (pós-approve) -> card de confirmação.
  const [aplicada, setAplicada] = useState(false);
  // Caminho "Editar": textarea aberta + texto da persona sendo ajustado pelo dono.
  const [editing, setEditing] = useState(false);
  const [editText, setEditText] = useState('');

  const logRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const editRef = useRef<HTMLTextAreaElement>(null);
  const previewRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  // Rola pra prévia só 1x por geração (rearma quando a prévia deixa de estar pronta).
  const scrolledRef = useRef(false);

  const draft = draftQ.data;
  const started = messages.length > 0;
  const previewReady = localDraftReady || draft?.status === 'pronto';
  // Prévia REALMENTE renderizável (não só o snappy local): texto final chegou do servidor.
  const previewPronto = draft?.status === 'pronto' && !!draft.previewFinal;

  // Auto-scroll pro fim quando entra bolha ou aparece/some o "digitando".
  const totalMsgs = messages.length;
  useEffect(() => {
    void totalMsgs;
    void pending;
    const el = logRef.current;
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
  }, [totalMsgs, pending]);

  // UX mobile: quando a persona fica pronta, traz a área de prévia+botões pra dentro da
  // viewport (o dono pode estar lendo o topo do chat e não ver os botões lá embaixo).
  useEffect(() => {
    if (previewPronto && !editing && !scrolledRef.current) {
      scrolledRef.current = true;
      requestAnimationFrame(() =>
        previewRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }),
      );
    }
    if (!previewPronto) scrolledRef.current = false; // rearma pra próxima geração
  }, [previewPronto, editing]);

  useEffect(() => () => abortRef.current?.abort(), []);

  // ── Ações ─────────────────────────────────────────────────────────────────
  /** Inicia (ou retoma, idempotente) a entrevista via /start. */
  async function iniciar() {
    if (pending) return;
    setErroRetry(null);
    setAplicada(false);
    setPending(true);
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    const out = await startBuilder(ctrl.signal);
    setPending(false);
    if (out.kind === 'ok') {
      setMessages([{ id: 1, role: 'assistant', text: out.pergunta }]);
      setLocalDraftReady(out.draftReady);
      requestAnimationFrame(() => inputRef.current?.focus());
      return;
    }
    if (out.kind === 'unavailable') {
      toast.error('O assistente de configuração está indisponível agora. Tente mais tarde.');
      return;
    }
    toast.error('Não foi possível começar agora. Tente de novo.');
  }

  /**
   * Envia 1 turno. `generateNow` (botão "Gerar agora") pode ser disparado a QUALQUER momento —
   * inclusive sem o dono ter digitado nada: manda um texto curto padrão e o backend FORÇA a
   * geração da persona neste turno. No fluxo normal, exige texto enviável (isSendable).
   */
  async function enviar(texto: string, opts?: { generateNow?: boolean }) {
    const generateNow = opts?.generateNow === true;
    const digitado = texto.trim();
    if (generateNow) {
      if (pending) return; // "Gerar agora" só barra se já há um envio em andamento.
    } else if (!isSendable(texto, pending)) {
      return;
    }
    const conteudo = generateNow ? generateNowContent(texto) : digitado;
    setErroRetry(null);
    setInput('');
    // Bolha do dono só quando ele REALMENTE escreveu algo (evita bolha fantasma do texto padrão).
    if (digitado.length > 0) setMessages((m) => appendMessage(m, 'user', digitado));
    setPending(true);
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    const out = await sendBuilderMessage(conteudo, { signal: ctrl.signal, generateNow });
    setPending(false);

    if (out.kind === 'ok') {
      setMessages((m) => appendMessage(m, 'assistant', out.reply));
      if (out.draftReady) {
        setLocalDraftReady(true);
        // Busca o preview_final (não volta no /message) pro painel de prévia.
        client.invalidateQueries({ queryKey: qk.promptBuilder(slot) });
      }
      return;
    }
    if (out.kind === 'not_started') {
      toast.error('A conversa expirou. Vamos recomeçar do zero.');
      setMessages([]);
      setLocalDraftReady(false);
      client.invalidateQueries({ queryKey: qk.promptBuilder(slot) });
      return;
    }
    if (out.kind === 'invalid') {
      setMessages((m) => appendMessage(m, 'assistant', 'Não peguei bem. Pode reescrever?'));
      return;
    }
    if (out.kind === 'unavailable') {
      toast.error('O assistente de configuração está indisponível agora. Tente mais tarde.');
      return;
    }
    // erro transitório -> guarda pra reenviar
    setErroRetry(conteudo);
  }

  /** "Pedir ajuste": sem conversa aberta abre um bubble-guia; em conversa, foca o campo. */
  function pedirAjuste() {
    if (!started) {
      setMessages([
        {
          id: 1,
          role: 'assistant',
          text: 'Combinado! O que você quer mudar? Escreva com suas palavras — ex.: "mais formal", "chama de Léo", "tira a piada".',
        },
      ]);
    }
    requestAnimationFrame(() => inputRef.current?.focus());
  }

  /**
   * Aprova a persona. Sem argumento => aprova o RASCUNHO do servidor (botão "Aprovar e ativar").
   * Com `personaEditada` => aprova o TEXTO editado pelo dono (botão "Salvar e ativar" do editor).
   * Em ambos, o BLOCO_ESTRUTURAL (confirmação) é colado por código no backend.
   */
  async function aprovar(personaEditada?: string) {
    if (approving) return;
    setApproving(true);
    const out = await approveBuilder(personaEditada);
    setApproving(false);
    if (out.kind === 'ok') {
      toast.success('Pronto! Seu assistente já está com a nova personalidade.');
      setMessages([]);
      setInput('');
      setLocalDraftReady(false);
      setEditing(false);
      setEditText('');
      setAplicada(true);
      client.invalidateQueries({ queryKey: qk.promptBuilder(slot) });
      client.invalidateQueries({ queryKey: qk.perfil(slot) });
      return;
    }
    if (out.kind === 'no_draft') {
      toast.error('O rascunho expirou. Vamos recomeçar.');
      setMessages([]);
      setLocalDraftReady(false);
      setEditing(false);
      client.invalidateQueries({ queryKey: qk.promptBuilder(slot) });
      return;
    }
    if (out.kind === 'invalid') {
      toast.error(
        editing
          ? 'Esse texto não pôde ser salvo — ficou curto demais ou sem personalidade suficiente. Ajuste e tente de novo.'
          : 'O rascunho ainda está curto. Conte mais uns detalhes no chat e tente de novo.',
      );
      return;
    }
    if (out.kind === 'unavailable') {
      toast.error('Recurso indisponível agora. Tente mais tarde.');
      return;
    }
    toast.error('Não foi possível ativar. Tente de novo.');
  }

  /** Abre o editor da persona SEMEADO com o rascunho (persona pura, SEM o bloco estrutural). */
  function editar() {
    const seed = previewPronto ? (draft?.personaRascunho ?? '') : '';
    setEditText(seed);
    setEditing(true);
    requestAnimationFrame(() => {
      editRef.current?.focus();
      previewRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
  }

  /** Salva o texto editado (= approve com persona_editada). Gate de tamanho no front. */
  function salvarEdicao() {
    if (!isPersonaSavable(editText)) return;
    void aprovar(editText);
  }

  function cancelarEdicao() {
    setEditing(false);
    setEditText('');
  }

  async function recomecar() {
    setConfirmReset(false);
    await resetBuilder();
    setMessages([]);
    setInput('');
    setErroRetry(null);
    setLocalDraftReady(false);
    setAplicada(false);
    setEditing(false);
    setEditText('');
    client.invalidateQueries({ queryKey: qk.promptBuilder(slot) });
  }

  function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    void enviar(input);
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    // Enter envia; Shift+Enter quebra linha (padrão de chat).
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void enviar(input);
    }
  }

  // ── Render ──────────────────────────────────────────────────────────────────
  // Load inicial: nada renderiza (sem flash pra quem não tem a feature).
  if (draftQ.isPending) return null;
  // Feature OFF (404 -> indisponivel): some (byte-idêntico pros clientes atuais).
  if (draft?.status === 'indisponivel') return null;
  // Erro real (rede/500): a seção existe -> mostra retry (não some silenciosamente).
  if (draftQ.isError || !draft) {
    return (
      <SectionShell>
        <ErrorState onRetry={() => draftQ.refetch()} />
      </SectionShell>
    );
  }

  return (
    <SectionShell>
      {aplicada ? (
        <AplicadaCard onReconfigurar={iniciar} pending={pending} />
      ) : (
        <div className="flex flex-col gap-4">
          {!started && !previewReady && draft.status === 'sem_rascunho' && (
            <RetomarCard
              onContinuar={iniciar}
              onRecomecar={() => setConfirmReset(true)}
              pending={pending}
            />
          )}
          {!started && !previewReady && draft.status !== 'sem_rascunho' && (
            <IntroCard onStart={iniciar} pending={pending} />
          )}

          {started && (
            <ChatView
              messages={messages}
              pending={pending}
              input={input}
              erroRetry={erroRetry}
              logRef={logRef}
              inputRef={inputRef}
              onInput={setInput}
              onSubmit={onSubmit}
              onKeyDown={onKeyDown}
              onRetry={() => erroRetry && void enviar(erroRetry)}
              onGerarAgora={() => void enviar(input, { generateNow: true })}
            />
          )}

          {previewReady && (
            <>
              {previewPronto && !editing && (
                <PreviewAviso
                  onIrParaPrevia={() =>
                    previewRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })
                  }
                />
              )}
              <div ref={previewRef} className="scroll-mt-4">
                {editing ? (
                  <EditPersonaPanel
                    value={editText}
                    saving={approving}
                    textareaRef={editRef}
                    onChange={setEditText}
                    onSalvar={salvarEdicao}
                    onCancelar={cancelarEdicao}
                  />
                ) : (
                  <PreviewPanel
                    status={draft.status}
                    resumo={draft.resumo}
                    nomeBot={draft.nomeBot}
                    previewFinal={draft.previewFinal}
                    approving={approving}
                    onAprovar={() => void aprovar()}
                    onEditar={editar}
                    onRejeitar={() => setConfirmReset(true)}
                    onAjustarConversa={pedirAjuste}
                  />
                )}
              </div>
            </>
          )}
        </div>
      )}

      <ConfirmDialog
        open={confirmReset}
        title="Recomeçar do zero?"
        description="A conversa atual será descartada e o assistente de configuração começa uma entrevista nova. Isto não altera o assistente que já está no ar."
        confirmLabel="Recomeçar"
        cancelLabel="Voltar"
        onConfirm={() => void recomecar()}
        onCancel={() => setConfirmReset(false)}
        icon={<IconRefresh size={22} />}
      />
    </SectionShell>
  );
}

/** Cabeçalho + card da seção (reutilizado por todos os estados). */
function SectionShell({ children }: { children: React.ReactNode }) {
  return (
    <section
      aria-labelledby="monte-assistente-title"
      className="mt-8 flex flex-col gap-3 border-t border-line pt-6"
    >
      <div>
        <h2
          id="monte-assistente-title"
          className="flex items-center gap-2 font-display text-[17px] font-semibold text-ink"
        >
          <span className="text-brand" aria-hidden>
            <IconSparkle size={18} />
          </span>
          Monte seu atendente
        </h2>
        <p className="mt-0.5 text-[13px] leading-snug text-ink-soft">
          Converse com nosso assistente e defina a personalidade do seu atendente — nome, tom e
          regras.
        </p>
      </div>
      <div className="rounded-card border border-line bg-surface p-[18px] shadow-card">
        {children}
      </div>
    </section>
  );
}

/** Estado inicial: explica o que é + botão "Começar". */
function IntroCard({ onStart, pending }: { onStart: () => void; pending: boolean }) {
  return (
    <div className="flex flex-col gap-4">
      <p className="text-[13.5px] leading-normal text-ink-soft">
        Em 4 ou 5 perguntas rápidas, deixamos o seu atendente com a cara do seu negócio: como ele
        fala, se tem nome, e o que ele nunca deve fazer. Sem termos técnicos — é só conversar.
      </p>
      <GarantiaNota />
      <div>
        <Button size="inline" onClick={onStart} loading={pending} loadingLabel="Abrindo…">
          <IconSparkle size={17} />
          Começar
        </Button>
      </div>
    </div>
  );
}

/** Há uma entrevista em andamento (Redis vivo) mas sem rascunho -> continuar/recomeçar. */
function RetomarCard({
  onContinuar,
  onRecomecar,
  pending,
}: {
  onContinuar: () => void;
  onRecomecar: () => void;
  pending: boolean;
}) {
  return (
    <div className="flex flex-col gap-4">
      <p className="text-[13.5px] leading-normal text-ink-soft">
        Você tem uma conversa de configuração em andamento. Quer continuar de onde parou?
      </p>
      <div className="flex flex-wrap items-center gap-2.5">
        <Button size="inline" onClick={onContinuar} loading={pending} loadingLabel="Abrindo…">
          Continuar
        </Button>
        <Button size="inline" variant="ghost" onClick={onRecomecar} disabled={pending}>
          Recomeçar do zero
        </Button>
      </div>
    </div>
  );
}

/** Confirmação pós-approve. */
function AplicadaCard({
  onReconfigurar,
  pending,
}: {
  onReconfigurar: () => void;
  pending: boolean;
}) {
  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-start gap-2.5 rounded-[12px] border border-brand/30 bg-brand-soft px-3.5 py-3">
        <span className="mt-0.5 shrink-0 text-brand" aria-hidden>
          <IconSparkle size={17} />
        </span>
        <div>
          <p className="font-display text-[13.5px] font-semibold text-ink">
            Personalidade ativada!
          </p>
          <p className="mt-0.5 text-[12.5px] leading-normal text-ink-soft">
            Seu assistente já responde com a nova personalidade. Você pode reconfigurar quando
            quiser.
          </p>
        </div>
      </div>
      <div>
        <Button size="inline" variant="secondary" onClick={onReconfigurar} disabled={pending}>
          Reconfigurar
        </Button>
      </div>
    </div>
  );
}

/** Nota que reforça a garantia da mecânica de agendamento (não vira responsabilidade do dono). */
function GarantiaNota() {
  return (
    <div className="flex items-start gap-2.5 rounded-[12px] border border-line bg-surface-sunken px-3.5 py-3 text-ink-soft">
      <span className="mt-0.5 shrink-0 text-brand" aria-hidden>
        <IconSparkle size={15} />
      </span>
      <p className="text-[12.5px] leading-normal">{GARANTIA}</p>
    </div>
  );
}

/** Widget de chat: log de bolhas + "digitando" + composer com contador. */
function ChatView({
  messages,
  pending,
  input,
  erroRetry,
  logRef,
  inputRef,
  onInput,
  onSubmit,
  onKeyDown,
  onRetry,
  onGerarAgora,
}: {
  messages: BuilderMessage[];
  pending: boolean;
  input: string;
  erroRetry: string | null;
  logRef: React.RefObject<HTMLDivElement | null>;
  inputRef: React.RefObject<HTMLTextAreaElement | null>;
  onInput: (v: string) => void;
  onSubmit: (e: React.FormEvent) => void;
  onKeyDown: (e: React.KeyboardEvent<HTMLTextAreaElement>) => void;
  onRetry: () => void;
  onGerarAgora: () => void;
}) {
  const over = remainingChars(input) < 0;
  return (
    <div className="overflow-hidden rounded-[14px] border border-line bg-surface-sunken">
      <div
        ref={logRef}
        role="log"
        aria-live="polite"
        aria-relevant="additions"
        aria-label="Conversa com o assistente de configuração"
        className="flex max-h-[340px] min-h-[180px] flex-col gap-2.5 overflow-y-auto px-3.5 py-4"
      >
        {messages.map((m) => (
          <Bubble key={m.id} role={m.role} text={m.text} />
        ))}
        {pending && <TypingBubble />}
        {erroRetry && (
          <div className="flex flex-col items-center gap-2 py-1 text-center">
            <p className="text-[12.5px] text-ink-faint">Tive um probleminha aqui. Tente de novo?</p>
            <button
              type="button"
              onClick={onRetry}
              className="rounded-pill border border-line-strong bg-surface px-4 py-1.5 text-[12.5px] font-semibold text-brand outline-none transition-colors hover:bg-surface-hover focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-2 focus-visible:ring-offset-bg"
            >
              Tentar de novo
            </button>
          </div>
        )}
      </div>

      <form onSubmit={onSubmit} className="border-t border-line bg-surface px-2.5 py-2.5">
        <div className="flex items-end gap-2">
          <label htmlFor="monte-assistente-input" className="sr-only">
            Sua resposta
          </label>
          <textarea
            id="monte-assistente-input"
            ref={inputRef}
            value={input}
            onChange={(e) => onInput(e.target.value)}
            onKeyDown={onKeyDown}
            rows={1}
            maxLength={BUILDER_MAX_INPUT + 200}
            disabled={pending}
            enterKeyHint="send"
            placeholder="Escreva sua resposta…"
            className="max-h-28 min-h-[42px] min-w-0 flex-1 resize-none rounded-field border border-line-strong bg-surface-sunken px-3.5 py-2.5 text-[15px] leading-snug text-ink outline-none transition-colors placeholder:text-ink-faint focus:border-brand focus:ring-[3px] focus:ring-brand/35 disabled:opacity-60"
          />
          <button
            type="submit"
            disabled={!isSendable(input, pending)}
            aria-label="Enviar resposta"
            className="inline-flex size-11 shrink-0 items-center justify-center rounded-full bg-brand text-bg outline-none transition-[transform,background-color] duration-[120ms] hover:bg-brand-600 active:scale-95 focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-2 focus-visible:ring-offset-bg disabled:cursor-not-allowed disabled:bg-brand/35 disabled:text-ink-faint"
          >
            <IconSend size={18} />
          </button>
        </div>
        <div className="mt-1 flex items-center justify-between px-1">
          <span className="text-[11.5px] text-ink-faint">
            Enter envia · Shift+Enter quebra linha
          </span>
          <span
            aria-live="polite"
            className={cn('tabular-nums text-[11.5px]', over ? 'text-danger' : 'text-ink-faint')}
          >
            {input.length}/{BUILDER_MAX_INPUT}
          </span>
        </div>
      </form>

      {/*
       * "Gerar agora" (SCRUM-92 v3): o dono pode gerar a persona A QUALQUER MOMENTO, sem
       * responder tudo. O backend força a geração neste turno (não depende de o modelo
       * decidir). Fica sempre visível abaixo do composer; depois de gerar, a conversa
       * continua ajustando o rascunho.
       */}
      <div className="border-t border-line bg-surface px-2.5 pb-2.5 pt-2">
        <Button
          size="inline"
          variant="secondary"
          className="w-full"
          onClick={onGerarAgora}
          disabled={pending}
          aria-label="Gerar a personalidade agora com o que você já contou"
        >
          <IconSparkle size={16} />
          Gerar agora
        </Button>
        <p className="mt-1.5 px-1 text-center text-[11.5px] leading-snug text-ink-faint">
          Pode gerar quando quiser — monto com o que você já contou e você continua ajustando
          depois.
        </p>
      </div>
    </div>
  );
}

/** Bolha de chat (assistente = esquerda/surface; dono = direita/brand-soft). */
function Bubble({ role, text }: { role: 'assistant' | 'user'; text: string }) {
  const own = role === 'user';
  return (
    <div className={cn('flex', own ? 'justify-end' : 'justify-start')}>
      <div
        className={cn(
          'chat-bubble-in max-w-[85%] whitespace-pre-wrap break-words rounded-[16px] px-3.5 py-2.5 text-[14px] leading-[1.5]',
          own
            ? 'rounded-br-[5px] bg-brand-soft text-ink'
            : 'rounded-bl-[5px] border border-line bg-surface text-ink',
        )}
      >
        {text}
      </div>
    </div>
  );
}

/** "Digitando…" — 3 pontos com pulso (gated por reduced-motion no globals.css). */
function TypingBubble() {
  return (
    <div className="flex justify-start">
      <div
        className="chat-bubble-in flex items-center gap-1.5 rounded-[16px] rounded-bl-[5px] border border-line bg-surface px-3.5 py-3"
        aria-label="assistente está digitando"
      >
        <span className="typing-dot inline-block size-1.5 rounded-full bg-ink-soft" />
        <span className="typing-dot inline-block size-1.5 rounded-full bg-ink-soft" />
        <span className="typing-dot inline-block size-1.5 rounded-full bg-ink-soft" />
      </div>
    </div>
  );
}

/**
 * Aviso mobile (melhoria 5): quando a persona fica pronta, sinaliza que os botões estão
 * logo abaixo — o dono no celular pode estar lendo o topo do chat. Clicável = rola até a
 * prévia. O wrapper é region `status`/aria-live (anuncia ao leitor de tela sem roubar o
 * foco); o alvo de toque é o <button> interno (a11y: role não vai no elemento interativo).
 */
function PreviewAviso({ onIrParaPrevia }: { onIrParaPrevia: () => void }) {
  return (
    <div role="status" aria-live="polite">
      <button
        type="button"
        onClick={onIrParaPrevia}
        aria-label="Sua prévia está pronta. Ir para a área de aprovar, editar ou rejeitar."
        className="flex min-h-11 w-full items-center gap-2.5 rounded-[12px] border border-brand/40 bg-brand-soft px-3.5 py-2.5 text-left outline-none transition-colors hover:bg-brand-soft/70 focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-2 focus-visible:ring-offset-bg"
      >
        <span className="shrink-0 text-brand" aria-hidden>
          <IconSparkle size={17} />
        </span>
        <span className="flex-1 text-[13px] font-semibold leading-snug text-ink">
          Sua prévia está pronta! Role a tela para baixo para aprovar, editar ou rejeitar.
        </span>
        <span className="inline-flex shrink-0 rotate-90 text-brand" aria-hidden>
          <IconChevronRight size={18} />
        </span>
      </button>
    </div>
  );
}

/** Painel de prévia: resumo + nome + (texto completo colapsado) + Aprovar/Editar/Rejeitar. */
function PreviewPanel({
  status,
  resumo,
  nomeBot,
  previewFinal,
  approving,
  onAprovar,
  onEditar,
  onRejeitar,
  onAjustarConversa,
}: {
  status: 'nao_iniciado' | 'sem_rascunho' | 'pronto';
  resumo: string | null;
  nomeBot: string | null;
  previewFinal: string | null;
  approving: boolean;
  onAprovar: () => void;
  onEditar: () => void;
  onRejeitar: () => void;
  onAjustarConversa: () => void;
}) {
  // localDraftReady=true mas o draft do servidor ainda não voltou 'pronto' -> montando.
  const montando = status !== 'pronto' || !previewFinal;
  return (
    <div className="flex flex-col gap-3 rounded-[14px] border border-brand/30 bg-brand-soft/40 p-4">
      <div className="flex items-center gap-2">
        <span className="text-brand" aria-hidden>
          <IconSparkle size={17} />
        </span>
        <h3 className="font-display text-[14.5px] font-semibold text-ink">
          Prévia do seu assistente
        </h3>
      </div>

      {montando ? (
        <p className="text-[13px] text-ink-soft" aria-live="polite">
          Montando a prévia…
        </p>
      ) : (
        <>
          {nomeBot && (
            <p className="text-[13px] text-ink">
              <span className="text-ink-soft">Nome: </span>
              <span className="font-semibold">{nomeBot}</span>
            </p>
          )}
          {resumo && (
            <p className="whitespace-pre-wrap text-[13.5px] leading-normal text-ink">{resumo}</p>
          )}
          <details className="group">
            <summary className="cursor-pointer list-none text-[12.5px] font-semibold text-brand outline-none focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-2 focus-visible:ring-offset-brand-soft">
              Ver o texto completo
            </summary>
            <pre className="mt-2 max-h-56 overflow-y-auto whitespace-pre-wrap break-words rounded-[10px] border border-line bg-surface px-3 py-2.5 font-sans text-[12.5px] leading-normal text-ink-soft">
              {previewFinal}
            </pre>
          </details>
          <p className="text-[12px] leading-normal text-ink-faint">{GARANTIA}</p>
        </>
      )}

      {/* Full-width no mobile (touch-friendly, sem apertar), inline a partir de sm. */}
      <div className="mt-1 flex flex-col gap-2.5 sm:flex-row sm:flex-wrap sm:items-center">
        <Button
          size="inline"
          className="w-full sm:w-auto"
          onClick={onAprovar}
          loading={approving}
          loadingLabel="Ativando…"
          disabled={montando}
        >
          Aprovar e ativar
        </Button>
        <Button
          size="inline"
          variant="secondary"
          className="w-full sm:w-auto"
          onClick={onEditar}
          disabled={approving || montando}
        >
          <IconPencil size={16} />
          Editar
        </Button>
        <Button
          size="inline"
          variant="destructive"
          className="w-full sm:w-auto"
          onClick={onRejeitar}
          disabled={approving}
        >
          Rejeitar
        </Button>
      </div>

      {/*
       * Dica de refino pós-geração (SCRUM-92 v3): a conversa MELHORA o rascunho que já existe —
       * o dono não precisa recomeçar do zero pra incluir algo. Baixa ênfase, não some.
       */}
      <div className="mt-1 flex flex-col gap-1.5 border-t border-brand/20 pt-3">
        <p className="text-[12.5px] leading-normal text-ink-soft">
          Quer incluir mais alguma coisa? Continue a conversa que eu ajusto o seu atendente.
        </p>
        <button
          type="button"
          onClick={onAjustarConversa}
          disabled={approving}
          className="self-start text-[12.5px] font-semibold text-brand underline-offset-2 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-2 focus-visible:ring-offset-brand-soft disabled:opacity-50"
        >
          Continuar a conversa
        </button>
      </div>
    </div>
  );
}

/**
 * Editor da persona (caminho "Editar", melhoria 5): textarea SEMEADA com o rascunho (persona
 * pura, sem o bloco estrutural). Ao salvar => approve com { persona_editada }; o backend re-valida
 * e re-cola a mecânica de confirmação — o dono edita só a personalidade, nunca remove a garantia.
 */
function EditPersonaPanel({
  value,
  saving,
  textareaRef,
  onChange,
  onSalvar,
  onCancelar,
}: {
  value: string;
  saving: boolean;
  textareaRef: React.RefObject<HTMLTextAreaElement | null>;
  onChange: (v: string) => void;
  onSalvar: () => void;
  onCancelar: () => void;
}) {
  const left = personaCharsLeft(value);
  const over = left < 0;
  const savable = isPersonaSavable(value);
  return (
    <div className="flex flex-col gap-3 rounded-[14px] border border-brand/30 bg-brand-soft/40 p-4">
      <div className="flex items-center gap-2">
        <span className="text-brand" aria-hidden>
          <IconPencil size={16} />
        </span>
        <h3 className="font-display text-[14.5px] font-semibold text-ink">
          Editar a personalidade
        </h3>
      </div>
      <p className="text-[12.5px] leading-normal text-ink-soft">
        Ajuste o texto como preferir. A parte técnica (a confirmação antes de marcar) continua
        garantida automaticamente — não precisa escrevê-la aqui.
      </p>
      <label htmlFor="monte-assistente-editor" className="sr-only">
        Texto da personalidade do seu assistente
      </label>
      <textarea
        id="monte-assistente-editor"
        ref={textareaRef}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        rows={10}
        maxLength={PERSONA_MAX_CHARS + 200}
        disabled={saving}
        className="min-h-[220px] w-full resize-y rounded-field border border-line-strong bg-surface px-3.5 py-3 font-sans text-[14px] leading-[1.55] text-ink outline-none transition-colors placeholder:text-ink-faint focus:border-brand focus:ring-[3px] focus:ring-brand/35 disabled:opacity-60"
      />
      <div className="flex items-center justify-between">
        <span
          aria-live="polite"
          className={cn('tabular-nums text-[11.5px]', over ? 'text-danger' : 'text-ink-faint')}
        >
          {value.length}/{PERSONA_MAX_CHARS}
        </span>
        {over && (
          <span className="text-[11.5px] font-semibold text-danger">
            Passou do limite — encurte o texto.
          </span>
        )}
      </div>
      <div className="mt-1 flex flex-col gap-2.5 sm:flex-row sm:items-center">
        <Button
          size="inline"
          className="w-full sm:w-auto"
          onClick={onSalvar}
          loading={saving}
          loadingLabel="Salvando…"
          disabled={!savable}
        >
          Salvar e ativar
        </Button>
        <Button
          size="inline"
          variant="secondary"
          className="w-full sm:w-auto"
          onClick={onCancelar}
          disabled={saving}
        >
          Cancelar
        </Button>
      </div>
    </div>
  );
}
