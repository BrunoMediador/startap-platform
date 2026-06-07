'use client';

import { Brandmark } from '@/components/icons';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { ApiError, apiFetch } from '@/lib/api';
import type { LoginErrorBody, LoginResponse } from '@/lib/api-types';
import { SUPORTE_WHATSAPP_URL } from '@/lib/suporte';
/**
 * Login (spec 7 / direcao-1-cadencia.html). Painel roxo solido com hero + card
 * branco. POST /auth/login -> cookie httpOnly de sessao (setado pela API). Trata:
 *   - 401: "Usuário ou senha incorretos"
 *   - 429 / locked: mensagem de muitas tentativas (lockout do portal-api)
 *   - rede: "Não conseguimos entrar agora. Tente de novo em instantes."
 *   - must_change_password: exibe aviso pra falar com o suporte (sem fluxo de
 *     troca no portal v1 — criacao/senha sao geridas pelo painel de gestao).
 */
import { useRouter } from 'next/navigation';
import { useState } from 'react';

export function LoginForm() {
  const router = useRouter();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setNotice(null);
    setPending(true);
    try {
      const res = await apiFetch<LoginResponse>('/auth/login', {
        method: 'POST',
        body: { username: username.trim(), password },
      });
      if (res.user.must_change_password) {
        setNotice('Sua senha é provisória. Após entrar, fale com o suporte para defini-la.');
      }
      router.replace('/inicio');
      router.refresh();
    } catch (err) {
      if (err instanceof ApiError) {
        if (err.status === 429 || (err.body as LoginErrorBody | null)?.locked) {
          setError('Muitas tentativas. Aguarde alguns minutos e tente de novo.');
        } else if (err.status === 401 || err.status === 403 || err.status === 400) {
          setError('Usuário ou senha incorretos');
        } else if (err.status === 0) {
          setError('Não conseguimos entrar agora. Tente de novo em instantes.');
        } else {
          setError('Não conseguimos entrar agora. Tente de novo em instantes.');
        }
      } else {
        setError('Não conseguimos entrar agora. Tente de novo em instantes.');
      }
      setPending(false);
    }
  }

  return (
    <main className="flex min-h-dvh items-stretch justify-center bg-brand-fill md:items-center md:bg-bg md:p-6">
      <div className="relative flex w-full max-w-[440px] flex-col overflow-hidden bg-brand-fill px-6 pb-7 pt-8 text-white md:rounded-card md:px-7 md:shadow-elev">
        {/* anel decorativo (sem glassmorphism) */}
        <div
          aria-hidden
          className="pointer-events-none absolute -right-[120px] -top-[120px] size-[300px] rounded-full border border-white/10 shadow-[0_0_0_36px_rgba(255,255,255,0.05)]"
        />
        <div className="relative z-10 inline-flex items-center gap-2.5 font-display text-[19px] font-bold tracking-[-0.01em]">
          <span className="flex size-[26px] items-center justify-center rounded-[8px] bg-white">
            <Brandmark size={14} color="#6431D6" />
          </span>
          Startap
        </div>

        <div className="relative z-10 mt-12 md:mt-10">
          <h1 className="font-display text-[27px] font-bold leading-[1.18] tracking-[-0.02em]">
            Sua barbearia
            <br />
            no piloto automático.
          </h1>
          <p className="mt-2.5 text-[14px] leading-normal text-white/[0.78]">
            Gerencie serviços, horários e o atendimento do seu robô. Tudo num lugar só.
          </p>
        </div>

        <form
          onSubmit={onSubmit}
          className="relative z-10 mt-7 rounded-[22px] border border-line-strong bg-surface p-5 text-ink shadow-elev"
          noValidate
        >
          <div className="mb-3.5">
            <Input
              label="Usuário"
              type="text"
              autoComplete="username"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              autoCapitalize="none"
              autoCorrect="off"
              required
            />
          </div>
          <div className="mb-1">
            <Input
              label="Senha"
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
            />
          </div>

          {error && (
            <p role="alert" className="mb-3 mt-2 text-[13px] font-medium text-danger">
              {error}
            </p>
          )}
          {notice && (
            <p role="status" className="mb-3 mt-2 text-[13px] text-ink-soft">
              {notice}
            </p>
          )}

          <div className="mt-4">
            <Button type="submit" loading={pending} loadingLabel="Entrando…">
              Entrar
            </Button>
          </div>

          <p className="mt-3.5 text-center text-[13px] text-ink-soft">
            Esqueceu a senha?{' '}
            <a
              href={SUPORTE_WHATSAPP_URL}
              className="font-semibold text-brand outline-none focus-visible:underline"
            >
              Falar com o suporte
            </a>
          </p>
        </form>
      </div>
    </main>
  );
}
