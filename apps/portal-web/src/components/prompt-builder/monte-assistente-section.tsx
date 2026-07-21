'use client';

import { IconRefresh, IconSend, IconSparkle } from '@/components/icons';
/**
 * Seção "Monte seu atendente" (SCRUM-92) dentro de "Meu negócio".
 *
 * O dono conversa com um assistente de configuração (meta-agente no DeepSeek) que faz
 * 4-5 perguntinhas e PROPÕE a personalidade do robô de WhatsApp dele. Ao aprovar, a
 * persona vira o prompt de produção do clone — a mecânica de agendamento (confirmação)
 * é garantida por CÓDIGO no servidor e NUNCA depende do que a IA gerar (o dono só cuida
 * do jeitão/tom/nome/regras). Ver design SCRUM-92.
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
  appendMessage,
  approveBuilder,
  isSendable,
  remainingChars,
  resetBuilder,
  sendBuilderMessage,
  startBuilder,
} from '@/lib/prompt-builder';
import { qk, useBuilderDraft } from '@/lib/queries';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';

const GARANTIA =
  'A parte técnica (a confirmação antes de marcar um horário) é garantida automaticamente. Você só cuida do jeitão dele.';

export function MonteAssistenteSection() {
  const { slot } = useTenant();
  const toast = useToast();
  const client = useQueryClient();
  const draftQ = useBuilderDraft(slot);

  const [messages, setMessages] = useState<BuilderMessage[]>([]);
  const [input, setInput] = useState('');
  const [pending, setPending] = useState(false);
  // Texto da última mensagem que falhou por soluço transitório -> botão "tentar de novo".
  const [erroRetry, setErroRetry] = useState<string | null>(null);
  const [approving, setApproving] = useState(false);
  const [confirmReset, setConfirmReset] = useState(false);
  // Rascunho ficou pronto NESTE turno (antes do refetch do draft confirmar) — snappy.
  const [localDraftReady, setLocalDraftReady] = useState(false);
  // Persona aplicada com sucesso (pós-approve) -> card de confirmação.
  const [aplicada, setAplicada] = useState(false);

  const logRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const abortRef = useRef<AbortController | null>(null);

  const draft = draftQ.data;
  const started = messages.length > 0;
  const previewReady = localDraftReady || draft?.status === 'pronto';

  // Auto-scroll pro fim quando entra bolha ou aparece/some o "digitando".
  const totalMsgs = messages.length;
  useEffect(() => {
    void totalMsgs;
    void pending;
    const el = logRef.current;
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
  }, [totalMsgs, pending]);

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

  async function enviar(texto: string) {
    const limpo = texto.trim();
    if (!isSendable(texto, pending)) return;
    setErroRetry(null);
    setInput('');
    setMessages((m) => appendMessage(m, 'user', limpo));
    setPending(true);
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    const out = await sendBuilderMessage(limpo, ctrl.signal);
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
    // soluço transitório -> guarda pra reenviar
    setErroRetry(limpo);
  }

  /** "Pedir ajuste": sem conversa aberta abre um bubble-guia; em conversa, foca o campo. */
  function pedirAjuste() {
    if (!started) {
      setMessages([
        {
          id: 1,
          role: 'assistant',
          text: 'Beleza! O que você quer mudar? Escreve do seu jeito — ex.: "mais formal", "chama de Léo", "tira a piada".',
        },
      ]);
    }
    requestAnimationFrame(() => inputRef.current?.focus());
  }

  async function aprovar() {
    if (approving) return;
    setApproving(true);
    const out = await approveBuilder();
    setApproving(false);
    if (out.kind === 'ok') {
      toast.success('Pronto! Seu assistente já está com a nova personalidade.');
      setMessages([]);
      setInput('');
      setLocalDraftReady(false);
      setAplicada(true);
      client.invalidateQueries({ queryKey: qk.promptBuilder(slot) });
      client.invalidateQueries({ queryKey: qk.perfil(slot) });
      return;
    }
    if (out.kind === 'no_draft') {
      toast.error('O rascunho expirou. Vamos recomeçar.');
      setMessages([]);
      setLocalDraftReady(false);
      client.invalidateQueries({ queryKey: qk.promptBuilder(slot) });
      return;
    }
    if (out.kind === 'invalid') {
      toast.error('O rascunho ainda está curto. Conte mais uns detalhes no chat e tente de novo.');
      return;
    }
    if (out.kind === 'unavailable') {
      toast.error('Recurso indisponível agora. Tente mais tarde.');
      return;
    }
    toast.error('Não foi possível ativar. Tente de novo.');
  }

  async function recomecar() {
    setConfirmReset(false);
    await resetBuilder();
    setMessages([]);
    setInput('');
    setErroRetry(null);
    setLocalDraftReady(false);
    setAplicada(false);
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
            />
          )}

          {previewReady && (
            <PreviewPanel
              status={draft.status}
              resumo={draft.resumo}
              nomeBot={draft.nomeBot}
              previewFinal={draft.previewFinal}
              approving={approving}
              onAprovar={aprovar}
              onAjustar={pedirAjuste}
              onRecomecar={() => setConfirmReset(true)}
            />
          )}
        </div>
      )}

      <ConfirmDialog
        open={confirmReset}
        title="Recomeçar do zero?"
        description="A conversa atual será descartada e o assistente de configuração começa uma entrevista nova. Isto não altera o robô que já está no ar."
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
          Converse com nosso assistente e defina o jeitão do seu robô — nome, tom e regras.
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
        Em 4 ou 5 perguntinhas rápidas, a gente deixa o seu robô com a cara do seu negócio: como ele
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
            Seu robô já responde com o novo jeitão. Você pode reconfigurar quando quiser.
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
            <p className="text-[12.5px] text-ink-faint">Tive um soluço aqui. Tenta de novo?</p>
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

/** Painel de prévia: resumo + nome + (texto completo colapsado) + Aprovar/Ajustar/Recomeçar. */
function PreviewPanel({
  status,
  resumo,
  nomeBot,
  previewFinal,
  approving,
  onAprovar,
  onAjustar,
  onRecomecar,
}: {
  status: 'nao_iniciado' | 'sem_rascunho' | 'pronto';
  resumo: string | null;
  nomeBot: string | null;
  previewFinal: string | null;
  approving: boolean;
  onAprovar: () => void;
  onAjustar: () => void;
  onRecomecar: () => void;
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

      <div className="mt-1 flex flex-wrap items-center gap-2.5">
        <Button
          size="inline"
          onClick={onAprovar}
          loading={approving}
          loadingLabel="Ativando…"
          disabled={montando}
        >
          Aprovar e ativar
        </Button>
        <Button size="inline" variant="secondary" onClick={onAjustar} disabled={approving}>
          Pedir ajuste
        </Button>
        <Button size="inline" variant="ghost" onClick={onRecomecar} disabled={approving}>
          Recomeçar
        </Button>
      </div>
    </div>
  );
}
