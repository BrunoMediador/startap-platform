'use client';

/**
 * "Meu atendente" / Testar (SCRUM-101 + SCRUM-157). Chat sandbox onde o dono conversa
 * com o PRÓPRIO assistente rodando a persona+tom+cartão REAIS do clone — o backend
 * (#542) já injeta serviços/horário de funcionamento reais, mas chama o LLM com
 * `tools: []`: o modelo PODE DIZER que marcou algo sem marcar nada de verdade. NADA é
 * agendado/pausado/gravado e NENHUMA mensagem sai por WhatsApp.
 *
 * Pedido explícito do Bruno: o dono pode chegar até o fim (mandar "sim"), mas o produto
 * tem que deixar INEQUÍVOCO — sem depender de detectar a confirmação por heurística de
 * texto — que nada foi marcado de verdade. Por isso 3 avisos redundantes e ROBUSTOS POR
 * CONSTRUÇÃO (aparecem sempre, não só quando o texto "parece" uma confirmação):
 *   1. banner STICKY no topo do log de conversa (visível durante todo o scroll);
 *   2. selo "Simulação" em CADA bolha do assistente (evita print fora de contexto);
 *   3. card FIXO abaixo do input, sempre visível, sem heurística de texto.
 *
 * Gating (byte-idêntico pros demais clientes): a seção PROBA o GET /portal/sandbox/status.
 * 404 (flag SANDBOX_ENABLED OFF) -> some (sem flash). Erro real -> ErrorState com retry.
 * Sem persona configurada -> estado vazio com link pra "Meu atendente" / Personalidade
 * (SCRUM-157; antes era um toast só na hora de enviar — agora a tela já avisa de cara,
 * usando o `personaConfigurada` que o GET /status já devolvia).
 *
 * ⚠️ Nada aqui instrui o modelo a se identificar como teste (isso é responsabilidade do
 * backend/prompt — contaminaria a fidelidade da simulação) nem enfraquece a garantia de
 * isolamento (`tools: []` seguem só no backend, provados por teste lá).
 */
import { IconInfo, IconPencil, IconRefresh, IconSend, IconSparkle } from '@/components/icons';
import { Button } from '@/components/ui/button';
import { EmptyState, ErrorState } from '@/components/ui/states';
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
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useRef, useState } from 'react';

export function TestarConversaSection() {
  const toast = useToast();
  const router = useRouter();
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
        'Configure a personalidade do seu assistente antes de testar (aba "Personalidade").',
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

  // Sem persona configurada: estado vazio com o caminho certo, não um toast que só
  // aparece depois que o dono já tentou mandar uma mensagem.
  if (status?.kind === 'available' && !status.personaConfigurada) {
    return (
      <SectionShell>
        <EmptyState
          icon={<IconSparkle size={26} />}
          title="Configure a personalidade primeiro"
          description="Pra testar uma conversa, o seu assistente precisa de uma personalidade configurada."
          action={{
            label: 'Ir pra Personalidade',
            onClick: () => router.push('/atendente/personalidade'),
          }}
        />
      </SectionShell>
    );
  }

  const over = remainingChars(input) < 0;

  return (
    <SectionShell>
      <div className="overflow-hidden rounded-[14px] border border-line bg-surface-sunken">
        {/* Banner STICKY: visível durante TODO o scroll do log, não só no topo da página. */}
        <div
          className="sticky top-0 z-10 flex items-start gap-2.5 border-b border-brand/30 bg-brand-soft px-3.5 py-3"
          role="note"
        >
          <span className="mt-0.5 shrink-0 text-brand" aria-hidden>
            <IconSparkle size={16} />
          </span>
          <p className="text-[12.5px] leading-normal text-ink-soft">
            <span className="font-semibold text-ink">É uma simulação.</span> Você conversa com o seu
            assistente exatamente como ele está configurado (personalidade, tom e cartão), mas{' '}
            <span className="font-semibold text-ink">nada é enviado a ninguém</span> e nenhum
            horário é marcado de verdade — os horários mostrados aqui são só exemplo.
          </p>
        </div>

        <div
          ref={logRef}
          role="log"
          aria-live="polite"
          aria-label="Simulação de conversa com o seu assistente"
          className="flex max-h-[340px] min-h-[160px] flex-col gap-2.5 overflow-y-auto px-3.5 py-4"
        >
          {messages.length === 0 && (
            <p className="m-auto max-w-[85%] text-center text-[13px] leading-normal text-ink-faint">
              Mande um "oi" como se fosse um cliente e veja como o seu assistente responde.
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

      {/* Card FIXO, sempre visível — robusto por construção (não depende de detectar
          "sim"/confirmação no texto do assistente). Requisito explícito do Bruno. */}
      <div className="mt-3 flex items-start gap-2.5 rounded-[12px] border border-line-strong bg-surface px-3.5 py-3">
        <span className="mt-0.5 shrink-0 text-ink-soft" aria-hidden>
          <IconInfo size={16} />
        </span>
        <p className="text-[12.5px] leading-normal text-ink-soft">
          <span className="font-semibold text-ink">Este teste nunca marca nada na sua agenda.</span>{' '}
          Se o assistente disser que marcou, foi só a simulação.
        </p>
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-2">
        {messages.length > 0 && (
          <Button size="inline" variant="ghost" onClick={recomecar} disabled={pending}>
            <IconRefresh size={16} />
            Recomeçar
          </Button>
        )}
        <Link
          href="/atendente/personalidade"
          className="inline-flex h-11 items-center gap-1.5 rounded-btn px-3.5 font-display text-[13px] font-semibold text-brand outline-none transition-colors hover:bg-brand-soft focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-2 focus-visible:ring-offset-bg"
        >
          <IconPencil size={15} />
          Ajustar a personalidade
        </Link>
        <Link
          href="/atendente/mensagens"
          className="inline-flex h-11 items-center gap-1.5 rounded-btn px-3.5 font-display text-[13px] font-semibold text-brand outline-none transition-colors hover:bg-brand-soft focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-2 focus-visible:ring-offset-bg"
        >
          <IconPencil size={15} />
          Mudar cartão
        </Link>
      </div>
      {messages.length > 0 && (
        <p className="mt-2 text-[12px] leading-normal text-ink-faint">
          Ajustou a personalidade ou o cartão? O histórico acima fica desatualizado — recomece a
          conversa pra testar a versão nova.
        </p>
      )}
    </SectionShell>
  );
}

/** Cabeçalho + card da seção. */
function SectionShell({ children }: { children: React.ReactNode }) {
  return (
    <section aria-labelledby="testar-conversa-title" className="flex flex-col gap-3">
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

/** Bolha de chat (assistente = esquerda/surface + selo "Simulação"; dono = direita/brand-soft). */
function Bubble({ role, text }: { role: SandboxMessage['role']; text: string }) {
  const own = role === 'user';
  return (
    <div className={cn('flex flex-col', own ? 'items-end' : 'items-start')}>
      {!own && (
        <span className="mb-1 inline-flex items-center gap-1 rounded-full border border-line-strong bg-surface px-2 py-0.5 text-[10.5px] font-semibold uppercase tracking-[0.04em] text-ink-faint">
          <IconSparkle size={10} aria-hidden />
          Simulação
        </span>
      )}
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
