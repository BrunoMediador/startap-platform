'use client';

import { ParticleField } from '@/components/fx/particle-field';
import { Brandmark, IconEye, IconEyeOff, IconInfo, IconLock, IconUser } from '@/components/icons';
import { ApiError, apiFetch } from '@/lib/api';
import type { LoginErrorBody, LoginResponse } from '@/lib/api-types';
import { SUPORTE_WHATSAPP_URL } from '@/lib/suporte';
/**
 * Login v2 (spec 1.B + login-v2.html). Split full-bleed no desktop (marca/tagline
 * sobre as particulas | card com glow), card central no mobile com particulas
 * atras. SEMPRE escuro (1.C.6): o wrapper força data-theme="dark" — o toggle de
 * tema so vale no app autenticado.
 *
 * Logica de login PRESERVADA: POST /auth/login -> cookie httpOnly de sessao.
 *   - 401/403/400: "Usuário ou senha incorretos"
 *   - 429 / locked: lockout do portal-api
 *   - rede (status 0): "Não conseguimos entrar agora..."
 *   - must_change_password: aviso pra falar com o suporte (sem fluxo de troca v1)
 *   - sucesso -> redirect /inicio.
 */
import { useRouter } from 'next/navigation';
import { useState } from 'react';

export function LoginForm() {
  const router = useRouter();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
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
    // Login SEMPRE escuro (1.C.6): força o token-set escuro neste subtree,
    // independente do tema escolhido no app.
    <div data-theme="dark" className="relative min-h-dvh overflow-hidden bg-bg text-ink">
      <ParticleField />
      <div className="login-vignette pointer-events-none fixed inset-0 z-[1]" aria-hidden />

      <div className="relative z-[2] grid min-h-dvh w-full grid-cols-1 min-[880px]:grid-cols-[1.05fr_0.95fr]">
        {/* COLUNA MARCA (>=880px — corte local do login, spec 1.B.2) */}
        <section className="hidden flex-col justify-between p-10 min-[880px]:flex lg:p-16">
          <Wordmark />

          <div className="max-w-[30ch]">
            <span className="mb-4 inline-flex items-center gap-2.5 text-[11px] font-semibold uppercase tracking-[0.14em] text-ink-faint before:inline-block before:h-px before:w-[26px] before:bg-brand">
              Atendimento no automático
            </span>
            <h1 className="font-display text-[clamp(30px,3.4vw,44px)] font-bold leading-[1.1] tracking-[-0.025em] text-ink">
              Seu negócio
              <br />
              no <span className="text-brand">piloto automático.</span>
            </h1>
            <p className="mt-[18px] max-w-[34ch] text-[clamp(14px,1.1vw,16px)] leading-[1.6] text-ink-soft">
              Gerencie serviços, horários e o atendimento do seu robô no WhatsApp. Tudo num lugar
              só.
            </p>
          </div>

          <div className="flex items-center gap-2.5 text-[12.5px] text-ink-faint">
            <span className="login-live-dot size-2 shrink-0 rounded-full bg-ok" aria-hidden />
            Robôs atendendo agora, sem parar.
          </div>
        </section>

        {/* COLUNA CARD */}
        <main className="flex items-center justify-center p-6 sm:p-10 lg:p-14">
          <div className="w-full max-w-[392px]">
            {/* marca compacta SO no mobile (<880px) */}
            <div className="mb-6 flex flex-col items-center gap-4 text-center min-[880px]:hidden">
              <Wordmark />
              <p className="max-w-[30ch] text-[13.5px] leading-normal text-ink-soft">
                <b className="font-semibold text-ink">Seu negócio no piloto automático.</b>{' '}
                Serviços, horários e o robô do WhatsApp, num lugar só.
              </p>
            </div>

            <form
              onSubmit={onSubmit}
              noValidate
              className="login-card-glow relative rounded-[22px] border border-line-strong bg-surface px-[30px] pb-7 pt-[34px] max-[380px]:px-[22px]"
            >
              <div className="mb-[22px]">
                <h2 className="font-display text-[21px] font-bold tracking-[-0.01em] text-ink">
                  Entrar
                </h2>
                <p className="mt-1.5 text-[13.5px] leading-normal text-ink-soft">
                  Acesse o painel do seu atendimento.
                </p>
              </div>

              {error && (
                <div
                  role="alert"
                  className="mb-3.5 flex items-center gap-2 rounded-[11px] border border-danger/30 bg-danger-soft px-3 py-2.5 text-[13px] text-danger"
                >
                  <IconInfo size={16} className="shrink-0" />
                  <span>{error}</span>
                </div>
              )}
              {notice && (
                <div
                  role="status"
                  className="mb-3.5 rounded-[11px] border border-line-strong bg-surface-sunken px-3 py-2.5 text-[13px] text-ink-soft"
                >
                  {notice}
                </div>
              )}

              <Field label="Usuário" htmlFor="login-user" icon={<IconUser size={18} />}>
                <input
                  id="login-user"
                  type="text"
                  autoComplete="username"
                  autoCapitalize="none"
                  autoCorrect="off"
                  required
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  placeholder="seu usuário"
                  className="h-[52px] w-full rounded-field border-[1.5px] border-line-strong bg-surface-sunken pl-[42px] pr-3.5 text-[15px] text-ink outline-none transition-[border-color,box-shadow] duration-[120ms] placeholder:text-ink-faint hover:border-[var(--c-input-hover-border)] focus:border-brand focus:shadow-focus focus:ring-[3px] focus:ring-brand/35"
                />
              </Field>

              <Field label="Senha" htmlFor="login-pw" icon={<IconLock size={18} />}>
                <input
                  id="login-pw"
                  type={showPassword ? 'text' : 'password'}
                  autoComplete="current-password"
                  required
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="sua senha"
                  className="h-[52px] w-full rounded-field border-[1.5px] border-line-strong bg-surface-sunken pl-[42px] pr-[46px] text-[15px] text-ink outline-none transition-[border-color,box-shadow] duration-[120ms] placeholder:text-ink-faint hover:border-[var(--c-input-hover-border)] focus:border-brand focus:shadow-focus focus:ring-[3px] focus:ring-brand/35"
                />
                <PasswordToggle shown={showPassword} onToggle={() => setShowPassword((v) => !v)} />
              </Field>

              <button
                type="submit"
                disabled={pending}
                aria-busy={pending || undefined}
                className="login-btn-glow mt-4 flex h-[52px] w-full items-center justify-center gap-2.5 rounded-btn bg-brand font-display text-[15px] font-semibold text-[#14121c] outline-none transition-[transform,background-color,box-shadow] duration-[120ms] hover:bg-brand-600 active:scale-[0.985] active:bg-brand-700 focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-2 focus-visible:ring-offset-bg disabled:cursor-not-allowed disabled:opacity-80"
              >
                {pending && (
                  <span
                    className="size-[18px] shrink-0 rounded-full border-[2.5px] border-[#14121c]/35 border-t-[#14121c] animate-spin-token"
                    aria-hidden
                  />
                )}
                {pending ? 'Entrando…' : 'Entrar'}
              </button>

              <p className="mt-[18px] text-center text-[13px] text-ink-soft">
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
      </div>
    </div>
  );
}

function Wordmark() {
  return (
    <div className="inline-flex items-center gap-[10px] font-display text-[20px] font-bold tracking-[-0.01em] text-ink md:text-[22px]">
      {/* Opcao A: simbolo Constelacao-S solto (sem quadrado roxo). */}
      <Brandmark size={36} />
      <span>
        Start<span className="text-brand">ap</span>
      </span>
    </div>
  );
}

function Field({
  label,
  htmlFor,
  icon,
  children,
}: {
  label: string;
  htmlFor: string;
  icon: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="mb-[15px]">
      <label htmlFor={htmlFor} className="mb-[7px] block text-[13px] font-semibold text-ink">
        {label}
      </label>
      <div className="group relative flex items-center">
        <span className="pointer-events-none absolute left-[14px] flex text-ink-faint transition-colors group-focus-within:text-brand">
          {icon}
        </span>
        {children}
      </div>
    </div>
  );
}

function PasswordToggle({ shown, onToggle }: { shown: boolean; onToggle: () => void }) {
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-pressed={shown}
      aria-label={shown ? 'Ocultar senha' : 'Mostrar senha'}
      className="absolute right-2 flex size-9 items-center justify-center rounded-[9px] text-ink-faint outline-none transition-colors hover:bg-surface-hover hover:text-ink focus-visible:ring-2 focus-visible:ring-brand"
    >
      {shown ? <IconEyeOff size={18} /> : <IconEye size={18} />}
    </button>
  );
}
