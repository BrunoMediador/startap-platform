'use client';

import { IconCheck } from '@/components/icons';
import { cn } from '@/lib/cn';
/**
 * Toast (spec 6.12 / 1.A.8). Sucesso = surface-elev role=status; erro =
 * danger-fill role=alert, com acao opcional "Tentar de novo". Posicao: inferior
 * acima da bottom nav (mobile) / canto inferior direito (desktop). Sucesso 2.5s,
 * erro 4s.
 *
 * Implementacao propria (zero dependencia runtime) via context + portal simples.
 */
import { createContext, useCallback, useContext, useMemo, useState } from 'react';

type ToastKind = 'success' | 'error';

interface ToastItem {
  id: number;
  kind: ToastKind;
  message: string;
  action?: { label: string; onClick: () => void };
}

interface ToastApi {
  success: (message: string) => void;
  error: (message: string, action?: ToastItem['action']) => void;
}

const ToastContext = createContext<ToastApi | null>(null);

let counter = 0;

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);

  const remove = useCallback((id: number) => {
    setItems((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const push = useCallback(
    (kind: ToastKind, message: string, action?: ToastItem['action']) => {
      const id = ++counter;
      setItems((prev) => [...prev, { id, kind, message, action }]);
      const ttl = kind === 'success' ? 2500 : 4000;
      window.setTimeout(() => remove(id), ttl);
    },
    [remove],
  );

  const api = useMemo<ToastApi>(
    () => ({
      success: (message) => push('success', message),
      error: (message, action) => push('error', message, action),
    }),
    [push],
  );

  return (
    <ToastContext.Provider value={api}>
      {children}
      <div
        className="pointer-events-none fixed inset-x-0 bottom-[88px] z-50 flex flex-col items-center gap-2 px-5 md:bottom-6 md:left-auto md:right-6 md:items-end md:px-0"
        aria-live="polite"
      >
        {items.map((t) => (
          <div
            key={t.id}
            role={t.kind === 'success' ? 'status' : 'alert'}
            className={cn(
              // Escuro (spec 6.12 / 1.A.8): sucesso = surface-elev + tinta clara;
              // erro = vermelho solido (danger-fill) + texto branco AA.
              'pointer-events-auto flex w-full max-w-[360px] items-center gap-2.5 rounded-card-sm border px-4 py-3 text-[14px] font-medium shadow-elev',
              t.kind === 'success'
                ? 'border-line-strong bg-surface-elev text-ink'
                : 'border-transparent bg-danger-fill text-white',
            )}
          >
            {t.kind === 'success' && (
              <span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-ok-soft">
                <IconCheck size={12} className="text-ok" />
              </span>
            )}
            <span className="flex-1">{t.message}</span>
            {t.action && (
              <button
                type="button"
                onClick={() => {
                  t.action?.onClick();
                  remove(t.id);
                }}
                className="shrink-0 font-display text-[13px] font-semibold text-white/80 underline-offset-2 hover:underline"
              >
                {t.action.label}
              </button>
            )}
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast(): ToastApi {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error('useToast precisa de <ToastProvider>');
  return ctx;
}
