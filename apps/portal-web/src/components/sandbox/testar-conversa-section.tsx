'use client';

/**
 * Seção "Testar conversa" (SCRUM-101) dentro de "Meu negócio".
 *
 * O dono conversa com o PRÓPRIO assistente rodando a persona+tom+cartão REAIS do clone, em
 * SANDBOX: o backend chama o LLM com `tools: []` — NADA é agendado/pausado/gravado e NENHUMA
 * mensagem sai por WhatsApp. É um espelho de teste, não o bot de verdade.
 *
 * Gating (byte-idêntico pros demais clientes): a seção PROBA o GET /portal/sandbox/status.
 * 404 (flag SANDBOX_ENABLED OFF) -> some (sem flash). Erro real -> ErrorState com retry. O
 * <section> carrega o próprio divisor (mt-8/border-t) — some inteira, sem spacer órfão.
 *
 * ⚠️ UI MÍNIMA (SCRUM-101): entregue junto ao endpoint (a garantia de isolamento/no-side-effect
 * mora no backend e está provada por teste). Precisa de um follow-up de UX (polish, a11y,
 * auto-scroll refinado, "digitando", mobile) — ver o card. Nenhuma PII é logada no client.
 */
import { IconRefresh, IconSend, IconSparkle } from '@/components/icons';
import { Button } from '@/components/ui/button';
import { ErrorState } from '@/components/ui/states';
import { useToast } from '@/components/ui/toast';
import { cn } from '@/lib/cn';
import {
  SANDBOX_MAX_INPUT,
  type SandboxMessage,
  type SandboxStatus,
  appendMessage,
  fetchSandboxStatus,
  isSendable,
  remainingChars,
  sendSandboxMessage,
  toApiMessages,
} from '@/lib/sandbox';
import { useCallback, useEffect, useRef, useState } from 'react';

export function TestarConversaSection() {
  const toast = useToast();
  const [status, setStatus] = useState<SandboxStatus | null>(null);
  const [statusError, setStatusError] = useState(false);
  const [messages, setMessages] = useState<SandboxMessage[]>([]);
  const [input, setInput] = useState('');
  const [pending, setPending] = useState(false);
  const logRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const abortRef = useRef<AbortController | null>(null);

  const loadStatus = useCallback(async () => {
    setStatusError(false);
    try {
      setStatus(await fetchSandboxStatus());
    } catch {
      setStatusError(true);
    }
  }, []);

  useEffect(() => {
    void loadStatus();
    return () => abortRef.current?.abort();
  }, [loadStatus]);

  // Auto-scroll pro fim quando entra bolha ou aparece o "enviando".
  const totalMsgs = messages.length;
  useEffect(() => {
    void totalMsgs;
    void pending;
    const el = logRef.current;
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
  }, [totalMsgs, pending]);

  async function enviar() {
    if (!isSendable(input, pending)) return;
    const texto = input.trim();
    setInput('');
    const withUser = appendMessage(messages, 'user', texto);
    setMessages(withUser);
    setPending(true);
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    const out = await sendSandboxMessage(toApiMessages(withUser), ctrl.signal);
    setPending(false);

    if (out.kind === 'ok') {
      setMessages((m) => appendMessage(m, 'assistant', out.reply));
      requestAnimationFrame(() => inputRef.current?.focus());
      return;
    }
    if (out.kind === 'no_persona') {
      toast.error(
        'Configure a personalidade do seu assistente antes de testar (seção "Monte seu atendente").',
      );
      return;
    }
    if (out.kind === 'unavailable') {
      toast.error('O modo de teste está indisponível agora. Tente mais tarde.');
      return;
    }
    toast.error('Não consegui responder agora. Tente de novo.');
  }

  function recomecar() {
    abortRef.current?.abort();
    setMessages([]);
    setInput('');
    setPending(false);
    requestAnimationFrame(() => inputRef.current?.focus());
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void enviar();
    }
  }

  // Load inicial: nada renderiza (sem flash pra quem não tem a feature).
  if (status === null && !statusError) return null;
  // Feature OFF (404): some (byte-idêntico pros clientes atuais).
  if (status?.kind === 'off') return null;
  // Erro real (rede/500): a seção existe -> mostra retry (não some silenciosamente).
  if (statusError) {
    return (
      <SectionShell>
        <ErrorState onRetry={() => void loadStatus()} />
      </SectionShell>
    );
  }

  const over = remainingChars(input) < 0;

  return (
    <SectionShell>
      {/* Requisito 4 do card: deixa CLARO que é simulação — nada é enviado de verdade. */}
      <div className="flex items-start gap-2.5 rounded-[12px] border border-brand/30 bg-brand-soft px-3.5 py-3">
        <span className="mt-0.5 shrink-0 text-brand" aria-hidden>
          <IconSparkle size={16} />
        </span>
        <p className="text-[12.5px] leading-normal text-ink-soft">
          <span className="font-semibold text-ink">É uma simulação.</span> Você conversa com o seu
          assistente exatamente como ele está configurado (personalidade, tom e cartão), mas{' '}
          <span className="font-semibold text-ink">nada é enviado a ninguém</span> e nenhum horário
          é marcado — é só pra você testar.
        </p>
      </div>

      <div className="mt-3 overflow-hidden rounded-[14px] border border-line bg-surface-sunken">
        <div
          ref={logRef}
          role="log"
          aria-live="polite"
          aria-label="Simulação de conversa com o seu assistente"
          className="flex max-h-[340px] min-h-[160px] flex-col gap-2.5 overflow-y-auto px-3.5 py-4"
        >
          {messages.length === 0 && (
            <p className="m-auto max-w-[85%] text-center text-[13px] leading-normal text-ink-faint">
              Mande um “oi” como se fosse um cliente e veja como o seu assistente responde.
            </p>
          )}
          {messages.map((m) => (
            <Bubble key={m.id} role={m.role} text={m.text} />
          ))}
          {pending && (
            <p className="text-[12.5px] text-ink-faint" aria-live="polite">
              O assistente está respondendo…
            </p>
          )}
        </div>

        <form
          onSubmit={(e) => {
            e.preventDefault();
            void enviar();
          }}
          className="border-t border-line bg-surface px-2.5 py-2.5"
        >
          <div className="flex items-end gap-2">
            <label htmlFor="sandbox-input" className="sr-only">
              Sua mensagem de teste
            </label>
            <textarea
              id="sandbox-input"
              ref={inputRef}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={onKeyDown}
              rows={1}
              maxLength={SANDBOX_MAX_INPUT + 100}
              disabled={pending}
              enterKeyHint="send"
              placeholder="Escreva como um cliente escreveria…"
              className="max-h-28 min-h-[42px] min-w-0 flex-1 resize-none rounded-field border border-line-strong bg-surface-sunken px-3.5 py-2.5 text-[15px] leading-snug text-ink outline-none transition-colors placeholder:text-ink-faint focus:border-brand focus:ring-[3px] focus:ring-brand/35 disabled:opacity-60"
            />
            <button
              type="submit"
              disabled={!isSendable(input, pending)}
              aria-label="Enviar mensagem de teste"
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
              {input.length}/{SANDBOX_MAX_INPUT}
            </span>
          </div>
        </form>
      </div>

      {messages.length > 0 && (
        <div className="mt-3">
          <Button size="inline" variant="ghost" onClick={recomecar} disabled={pending}>
            <IconRefresh size={16} />
            Recomeçar
          </Button>
        </div>
      )}
    </SectionShell>
  );
}

/** Cabeçalho + card da seção. */
function SectionShell({ children }: { children: React.ReactNode }) {
  return (
    <section
      aria-labelledby="testar-conversa-title"
      className="mt-8 flex flex-col gap-3 border-t border-line pt-6"
    >
      <div>
        <h2
          id="testar-conversa-title"
          className="flex items-center gap-2 font-display text-[17px] font-semibold text-ink"
        >
          <span className="text-brand" aria-hidden>
            <IconSparkle size={18} />
          </span>
          Testar conversa
        </h2>
        <p className="mt-0.5 text-[13px] leading-snug text-ink-soft">
          Converse com o seu assistente do jeito que ele está agora — sem enviar nada a ninguém.
        </p>
      </div>
      <div className="rounded-card border border-line bg-surface p-[18px] shadow-card">
        {children}
      </div>
    </section>
  );
}

/** Bolha de chat (assistente = esquerda/surface; dono = direita/brand-soft). */
function Bubble({ role, text }: { role: SandboxMessage['role']; text: string }) {
  const own = role === 'user';
  return (
    <div className={cn('flex', own ? 'justify-end' : 'justify-start')}>
      <div
        className={cn(
          'max-w-[85%] whitespace-pre-wrap break-words rounded-[16px] px-3.5 py-2.5 text-[14px] leading-[1.5]',
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
