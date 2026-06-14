import { IconCheckDouble, IconInfo } from '@/components/icons';
import { cn } from '@/lib/cn';
/**
 * Peças visuais da demo "celular" (W6) — todas presentational (sem estado).
 * O chrome do telefone é DECORATIVO (aria-hidden); só o conteúdo do chat é
 * semântico (o container DemoCelular marca role="log" + aria-live). Recriamos o
 * PADRÃO do WhatsApp (bolhas esq/dir, header avatar+online, composer) com a
 * paleta Startap — sem clonar cor/ícone oficiais (guarda anti-cópia da spec).
 */
import type { ReactNode } from 'react';

/** Moldura do smartphone: bezel escuro, status bar fake, radius 36, glow contido. */
export function PhoneFrame({ children }: { children: ReactNode }) {
  return (
    <div className="hero-e1 mx-auto w-full max-w-[360px] rounded-[40px] border border-line-strong bg-surface-sunken p-2.5">
      <div className="overflow-hidden rounded-[32px] border border-line bg-chat-bg">
        {/* Status bar decorativa — hora fake + glifos de sinal/bateria. */}
        <div
          className="flex items-center justify-between px-5 pb-1 pt-2.5 text-[11px] font-semibold text-ink-faint"
          aria-hidden
        >
          <span>9:41</span>
          <span className="flex items-center gap-1.5">
            <span className="inline-block h-2.5 w-3.5 rounded-[2px] border border-current" />
            <span className="inline-block h-2.5 w-2 rounded-[1px] bg-current opacity-70" />
          </span>
        </div>
        {children}
      </div>
    </div>
  );
}

/** Header do chat: avatar (iniciais), nome do salão fictício + "online" verde. */
export function ChatHeader({ nome, iniciais }: { nome: string; iniciais: string }) {
  return (
    <div className="flex items-center gap-3 border-b border-line bg-surface px-4 py-3">
      <span
        className="inline-flex size-9 shrink-0 items-center justify-center rounded-full bg-brand-soft font-display text-[13px] font-bold text-brand"
        aria-hidden
      >
        {iniciais}
      </span>
      <span className="min-w-0">
        <span className="block truncate font-display text-[14.5px] font-semibold leading-tight text-ink">
          {nome}
        </span>
        <span className="flex items-center gap-1.5 text-[11.5px] leading-tight text-ok">
          <span className="inline-block size-1.5 rounded-full bg-ok" aria-hidden />
          online
        </span>
      </span>
    </div>
  );
}

/**
 * Bolha de chat. `recebida` (esquerda, surface) | `enviada` (direita, verde
 * dedicado). Timestamp + check decorativo só na enviada. A animação de entrada
 * é gated por reduced-motion (.chat-bubble-in).
 */
export function ChatBubble({
  variant,
  children,
  hora,
}: {
  variant: 'recebida' | 'enviada';
  children: ReactNode;
  hora: string;
}) {
  const enviada = variant === 'enviada';
  return (
    <div className={cn('flex', enviada ? 'justify-end' : 'justify-start')}>
      <div
        className={cn(
          'chat-bubble-in max-w-[80%] rounded-[16px] px-3 py-2 text-[13.5px] leading-[1.45] text-ink',
          enviada
            ? 'rounded-br-[5px] bg-chat-bubble-out'
            : 'rounded-bl-[5px] border border-line bg-chat-bubble-in',
        )}
      >
        <span className="whitespace-pre-wrap break-words">{children}</span>
        <span className="mt-0.5 flex items-center justify-end gap-1 text-[10px] text-ink-faint">
          {hora}
          {enviada && <IconCheckDouble size={14} className="text-ink-faint" />}
        </span>
      </div>
    </div>
  );
}

/** "Digitando…" — 3 pontos com pulso escalonado (gated por reduced-motion). */
export function TypingDots() {
  return (
    <div className="flex justify-start">
      <div
        className="chat-bubble-in flex items-center gap-1.5 rounded-[16px] rounded-bl-[5px] border border-line bg-chat-bubble-in px-3.5 py-3"
        aria-label="assistente está digitando"
      >
        <span className="typing-dot inline-block size-1.5 rounded-full bg-ink-soft" />
        <span className="typing-dot inline-block size-1.5 rounded-full bg-ink-soft" />
        <span className="typing-dot inline-block size-1.5 rounded-full bg-ink-soft" />
      </div>
    </div>
  );
}

/** Rodapé permanente do frame: "é uma demonstração". Sempre visível. */
export function DemoBanner() {
  return (
    <div className="flex items-start gap-2 border-t border-line bg-surface-sunken px-4 py-2.5 text-[11px] leading-snug text-ink-faint">
      <IconInfo size={13} className="mt-px shrink-0" />
      <span>Demonstração — conversa com uma IA. Nada é agendado de verdade aqui.</span>
    </div>
  );
}
