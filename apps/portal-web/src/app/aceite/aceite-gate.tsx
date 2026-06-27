'use client';

import { Brandmark, IconInfo } from '@/components/icons';
import { Button } from '@/components/ui/button';
import { apiFetch } from '@/lib/api';
import type { AceiteResponse } from '@/lib/api-types';
import { useLogout } from '@/lib/use-logout';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';

/**
 * Tela BLOQUEANTE de aceite pós-login (SCRUM-1, fluxo 2). Único caminho pra frente é
 * marcar "Li e aceito" -> POST /portal/aceite (grava a prova versionada). Sucesso ->
 * /inicio (o guard do (app) revalida e libera). Saída alternativa: "Sair" (logout) —
 * o cliente não fica preso, mas sem aceitar não usa o app.
 *
 * Os Termos/Privacidade são LINKS (nova aba) — pode ler, não é obrigatório ler.
 */
export function AceiteGate() {
  const router = useRouter();
  const { logout, pending: loggingOut } = useLogout();
  const [pending, setPending] = useState(false);
  const [banner, setBanner] = useState<string | null>(null);

  async function onAceitar() {
    setBanner(null);
    setPending(true);
    try {
      await apiFetch<AceiteResponse>('/portal/aceite', { method: 'POST' });
      router.replace('/inicio');
      router.refresh();
    } catch {
      setBanner('Não conseguimos registrar seu aceite agora. Tente de novo em instantes.');
      setPending(false);
    }
  }

  return (
    <div
      data-theme="dark"
      className="flex min-h-dvh flex-col items-center justify-center bg-bg px-6 py-10 text-ink"
    >
      <div className="w-full max-w-[440px]">
        <div className="mb-7 flex items-center gap-[10px] font-display text-[20px] font-bold tracking-[-0.01em] text-ink">
          <Brandmark size={34} />
          <span>
            Start<span className="text-brand">ap</span>
          </span>
        </div>

        <div className="rounded-[22px] border border-line-strong bg-surface px-7 pb-7 pt-8 max-[380px]:px-5">
          <h1 className="font-display text-[22px] font-bold leading-snug tracking-[-0.01em] text-ink">
            Antes de continuar, aceite nossos termos
          </h1>
          <p className="mt-2.5 text-[14px] leading-[1.6] text-ink-soft">
            Para seguir usando o portal, você precisa ler e aceitar os{' '}
            <Link
              href="/termos"
              target="_blank"
              rel="noopener noreferrer"
              className="font-semibold text-brand outline-none focus-visible:underline"
            >
              Termos de Uso
            </Link>{' '}
            e a{' '}
            <Link
              href="/privacidade"
              target="_blank"
              rel="noopener noreferrer"
              className="font-semibold text-brand outline-none focus-visible:underline"
            >
              Política de Privacidade
            </Link>
            . É rápido — abrem em uma nova aba.
          </p>

          {banner && (
            <div
              role="alert"
              className="mt-4 flex items-center gap-2 rounded-[11px] border border-danger/30 bg-danger-soft px-3 py-2.5 text-[13px] text-danger"
            >
              <IconInfo size={16} className="shrink-0" />
              <span>{banner}</span>
            </div>
          )}

          <Button
            onClick={onAceitar}
            loading={pending}
            loadingLabel="Registrando…"
            className="mt-6"
          >
            Li e aceito
          </Button>

          <button
            type="button"
            onClick={logout}
            disabled={loggingOut || pending}
            className="mt-3 h-11 w-full rounded-btn font-display text-[14px] font-semibold text-ink-faint outline-none transition-colors hover:bg-surface-hover hover:text-ink focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-2 focus-visible:ring-offset-bg disabled:opacity-50"
          >
            Sair
          </button>
        </div>
      </div>
    </div>
  );
}
