'use client';

import { ParticleField } from '@/components/fx/particle-field';
import { Brandmark, IconEye, IconEyeOff, IconInfo, IconWhatsapp } from '@/components/icons';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useToast } from '@/components/ui/toast';
import { ApiError, apiFetch } from '@/lib/api';
import type { SignupResponse } from '@/lib/api-types';
import {
  type Area,
  type CadastroErrors,
  type SignupCardView,
  maskPhoneBR,
  signupCardFromError,
  validateCadastro,
} from '@/lib/cadastro';
import { SUPORTE_WHATSAPP_URL } from '@/lib/suporte';
/**
 * Cadastro self-service (spec A3.1 da Missao 020). Mesma identidade do login v2:
 * tema escuro forcado, constelacao + vinheta, split >=880px (marca | card), card
 * central no mobile. 3 campos, sem cartao, sem e-mail.
 *
 * Contrato REAL do POST /auth/signup (portal-signup.ts):
 *   - 201 ja seta o cookie de sessao (auto-login) -> toast + redirect /conectar
 *   - 409 trial_ja_usado  -> card amigavel (portao 1, soft check — A3.10)
 *   - 409 conta_ja_existe -> card "ja tem conta" com CTA Entrar
 *   - 404/403 (flag PORTAL_SIGNUP OFF) -> card "cadastro ainda nao disponivel"
 *   - 503 trial_lotado (teto TRIAL_MAX_ATIVOS) -> card "estamos lotados" + CTA WhatsApp
 *   - 400 telefone_invalido -> erro inline no campo
 *   - 500/502/503 generico/rede -> banner generico, form preservado
 * (mapa status+code -> card centralizado em lib/cadastro.ts: signupCardFromError)
 */
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { AreaSelector } from './area-selector';

type View = 'form' | SignupCardView;

function apiCode(err: ApiError): string | null {
  const body = err.body as { error?: unknown } | null;
  return body && typeof body.error === 'string' ? body.error : null;
}

export function CadastroForm() {
  const router = useRouter();
  const toast = useToast();
  const [view, setView] = useState<View>('form');
  const [nome, setNome] = useState('');
  const [area, setArea] = useState<Area | null>(null);
  const [whatsapp, setWhatsapp] = useState('');
  const [senha, setSenha] = useState('');
  const [showSenha, setShowSenha] = useState(false);
  // Aceite dos Termos + Política de Privacidade (checkbox obrigatório — SCRUM-1).
  const [aceite, setAceite] = useState(false);
  const [errors, setErrors] = useState<CadastroErrors>({});
  const [banner, setBanner] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  // >3s provisionando (clone + sessao WAHA rodam no submit) -> troca o label.
  const [slowHint, setSlowHint] = useState(false);
  const slowTimer = useRef<number | null>(null);

  useEffect(() => {
    return () => {
      if (slowTimer.current !== null) window.clearTimeout(slowTimer.current);
    };
  }, []);

  function clearSlowTimer() {
    if (slowTimer.current !== null) {
      window.clearTimeout(slowTimer.current);
      slowTimer.current = null;
    }
    setSlowHint(false);
  }

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setBanner(null);
    const res = validateCadastro({ nome, area, whatsapp, senha, aceite });
    if (!res.ok) {
      setErrors(res.errors);
      return;
    }
    setErrors({});
    setPending(true);
    slowTimer.current = window.setTimeout(() => setSlowHint(true), 3000);
    try {
      await apiFetch<SignupResponse>('/auth/signup', { method: 'POST', body: res.value });
      // 201 ja veio com o cookie de sessao (auto-login do backend).
      toast.success('Conta criada! Agora conecte seu WhatsApp pra começar seus 10 dias grátis.');
      router.replace('/conectar');
      router.refresh();
    } catch (err) {
      clearSlowTimer();
      if (err instanceof ApiError) {
        const code = apiCode(err);
        const card = signupCardFromError(err.status, code);
        if (card) {
          setView(card);
        } else if (err.status === 400 && code === 'telefone_invalido') {
          setErrors({ whatsapp: 'Confere o número? Ele não parece válido' });
        } else {
          setBanner('Não conseguimos criar sua conta agora. Tente de novo em instantes.');
        }
      } else {
        setBanner('Não conseguimos criar sua conta agora. Tente de novo em instantes.');
      }
      setPending(false);
    }
  }

  return (
    // Cadastro SEMPRE escuro, igual ao login (1.C.6).
    <div data-theme="dark" className="relative min-h-dvh overflow-hidden bg-bg text-ink">
      <ParticleField />
      <div className="login-vignette pointer-events-none fixed inset-0 z-[1]" aria-hidden />

      <div className="relative z-[2] grid min-h-dvh w-full grid-cols-1 min-[880px]:grid-cols-[1.05fr_0.95fr]">
        {/* COLUNA MARCA (>=880px — mesmo corte do login) */}
        <section className="hidden flex-col justify-between p-10 min-[880px]:flex lg:p-16">
          <Wordmark />

          <div className="max-w-[30ch]">
            <span className="mb-4 inline-flex items-center gap-2.5 text-[11px] font-semibold uppercase tracking-[0.14em] text-ink-faint before:inline-block before:h-px before:w-[26px] before:bg-brand">
              Teste grátis · 10 dias
            </span>
            <h1 className="font-display text-[clamp(30px,3.4vw,44px)] font-bold leading-[1.1] tracking-[-0.025em] text-ink">
              Seu WhatsApp
              <br />
              atendendo <span className="text-brand">sozinho.</span>
            </h1>
            <p className="mt-[18px] max-w-[34ch] text-[clamp(14px,1.1vw,16px)] leading-[1.6] text-ink-soft">
              Crie sua conta em um minuto. Sem cartão, sem compromisso — seus 10 dias só começam
              quando o WhatsApp conectar.
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
                <b className="font-semibold text-ink">10 dias grátis pra testar.</b> Sem cartão, sem
                compromisso.
              </p>
            </div>

            {view === 'form' && (
              <form
                onSubmit={onSubmit}
                noValidate
                className="login-card-glow relative rounded-[22px] border border-line-strong bg-surface px-[30px] pb-7 pt-[34px] max-[380px]:px-[22px]"
              >
                <div className="mb-[22px]">
                  <h2 className="font-display text-[24px] font-bold tracking-[-0.01em] text-ink">
                    Crie sua conta
                  </h2>
                  <p className="mt-1.5 text-[13.5px] leading-normal text-ink-soft">
                    10 dias grátis. Sem cartão.
                  </p>
                </div>

                {banner && (
                  <div
                    role="alert"
                    className="mb-3.5 flex items-center gap-2 rounded-[11px] border border-danger/30 bg-danger-soft px-3 py-2.5 text-[13px] text-danger"
                  >
                    <IconInfo size={16} className="shrink-0" />
                    <span>{banner}</span>
                  </div>
                )}

                <div className="flex flex-col gap-[15px]">
                  <Input
                    id="cad-nome"
                    label="Nome do seu negócio"
                    placeholder="ex: Barbearia do João"
                    autoComplete="organization"
                    value={nome}
                    error={errors.nome}
                    onChange={(e) => {
                      setNome(e.target.value);
                      if (errors.nome) setErrors((prev) => ({ ...prev, nome: undefined }));
                    }}
                  />

                  <AreaSelector
                    value={area}
                    error={errors.area}
                    onChange={(a) => {
                      setArea(a);
                      if (errors.area) setErrors((prev) => ({ ...prev, area: undefined }));
                    }}
                  />

                  <div>
                    <Input
                      id="cad-wa"
                      label="WhatsApp do seu negócio"
                      placeholder="(11) 99999-9999"
                      type="tel"
                      inputMode="tel"
                      autoComplete="tel-national"
                      value={whatsapp}
                      error={errors.whatsapp}
                      aria-describedby={errors.whatsapp ? 'cad-wa-err cad-wa-help' : 'cad-wa-help'}
                      onChange={(e) => {
                        setWhatsapp(maskPhoneBR(e.target.value));
                        if (errors.whatsapp) {
                          setErrors((prev) => ({ ...prev, whatsapp: undefined }));
                        }
                      }}
                    />
                    {/* Helper SEMPRE visivel (spec A5) — nao some quando ha erro. */}
                    <p
                      id="cad-wa-help"
                      className="mt-[7px] flex items-start gap-1.5 text-[12.5px] leading-normal text-ink-faint"
                    >
                      <IconInfo size={14} className="mt-px shrink-0" />
                      <span>
                        É esse número que o robô vai usar pra atender. O teste grátis vale 1 vez por
                        número.
                      </span>
                    </p>
                  </div>

                  <SenhaField
                    value={senha}
                    shown={showSenha}
                    error={errors.senha}
                    onChange={(v) => {
                      setSenha(v);
                      if (errors.senha) setErrors((prev) => ({ ...prev, senha: undefined }));
                    }}
                    onToggle={() => setShowSenha((v) => !v)}
                  />
                </div>

                <AceiteTermos
                  checked={aceite}
                  error={errors.aceite}
                  onChange={(v) => {
                    setAceite(v);
                    if (errors.aceite) setErrors((prev) => ({ ...prev, aceite: undefined }));
                  }}
                />

                <Button
                  type="submit"
                  loading={pending}
                  loadingLabel={slowHint ? 'Preparando seu robô…' : 'Criando sua conta…'}
                  className="login-btn-glow mt-3"
                >
                  Começar meu teste grátis
                </Button>

                <p className="mt-[18px] text-center text-[12.5px] leading-normal text-ink-faint">
                  Seus 10 dias só começam quando o WhatsApp conectar. Sem pressa.
                </p>
              </form>
            )}

            {view === 'trial-usado' && <TrialJaUsadoCard onVoltar={() => setView('form')} />}
            {view === 'conta-existe' && <ContaExisteCard onVoltar={() => setView('form')} />}
            {view === 'indisponivel' && <IndisponivelCard />}
            {view === 'lotado' && <LotadoCard onVoltar={() => setView('form')} />}

            <p className="mt-5 text-center text-[13px] text-ink-soft">
              Já tem conta?{' '}
              <Link
                href="/login"
                className="font-semibold text-brand outline-none focus-visible:underline"
              >
                Entrar
              </Link>
            </p>
          </div>
        </main>
      </div>
    </div>
  );
}

/**
 * Checkbox OBRIGATÓRIO de aceite (SCRUM-1). "Termos de Uso" e "Política de Privacidade"
 * são LINKS pras rotas públicas (/termos, /privacidade) — abrem em nova aba pra não
 * perder o cadastro digitado. O submit é bloqueado enquanto não marcado (validação em
 * validateCadastro; o gate autoritativo é o backend). Acessível: input nativo, label
 * associada, erro via aria-describedby.
 */
function AceiteTermos({
  checked,
  error,
  onChange,
}: {
  checked: boolean;
  error?: string;
  onChange: (v: boolean) => void;
}) {
  return (
    <div className="mt-4">
      <label htmlFor="cad-aceite" className="flex items-start gap-2.5 text-left">
        <input
          id="cad-aceite"
          type="checkbox"
          checked={checked}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? 'cad-aceite-err' : undefined}
          onChange={(e) => onChange(e.target.checked)}
          className={`mt-0.5 size-[18px] shrink-0 cursor-pointer rounded-[5px] border-[1.5px] bg-surface-sunken accent-brand outline-none focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-2 focus-visible:ring-offset-bg ${error ? 'border-danger' : 'border-line-strong'}`}
        />
        <span className="text-[12.5px] leading-snug text-ink-soft">
          Li e aceito os{' '}
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
          .
        </span>
      </label>
      {error && (
        <p id="cad-aceite-err" className="mt-1.5 text-[12.5px] text-danger">
          {error}
        </p>
      )}
    </div>
  );
}

/** Campo de senha com show/hide (mesmo padrao do login; toggle e interativo,
 *  entao nao da pra usar o slot `suffix` do Input, que e decorativo). */
function SenhaField({
  value,
  shown,
  error,
  onChange,
  onToggle,
}: {
  value: string;
  shown: boolean;
  error?: string;
  onChange: (v: string) => void;
  onToggle: () => void;
}) {
  return (
    <div className="flex w-full flex-col gap-[7px]">
      <label htmlFor="cad-senha" className="text-[13px] font-semibold text-ink">
        Crie uma senha
      </label>
      <div className="relative flex items-center">
        <input
          id="cad-senha"
          type={shown ? 'text' : 'password'}
          autoComplete="new-password"
          placeholder="mínimo de 8 caracteres"
          value={value}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? 'cad-senha-err' : undefined}
          onChange={(e) => onChange(e.target.value)}
          className={`h-[50px] w-full rounded-field border-[1.5px] bg-surface-sunken pl-3.5 pr-[46px] text-[15px] text-ink outline-none transition-[border-color,box-shadow] duration-[120ms] placeholder:text-ink-faint hover:border-[var(--c-input-hover-border)] focus:border-brand focus:shadow-focus focus:ring-[3px] focus:ring-brand/35 ${error ? 'border-danger' : 'border-line-strong'}`}
        />
        <button
          type="button"
          onClick={onToggle}
          aria-pressed={shown}
          aria-label={shown ? 'Ocultar senha' : 'Mostrar senha'}
          className="absolute right-2 flex size-9 items-center justify-center rounded-[9px] text-ink-faint outline-none transition-colors hover:bg-surface-hover hover:text-ink focus-visible:ring-2 focus-visible:ring-brand"
        >
          {shown ? <IconEyeOff size={18} /> : <IconEye size={18} />}
        </button>
      </div>
      {error && (
        <p id="cad-senha-err" className="text-[13px] text-danger">
          {error}
        </p>
      )}
    </div>
  );
}

/** Wrapper visual comum dos cards que SUBSTITUEM o form (spec A3.10: beco com saida). */
function StateCard({ children }: { children: React.ReactNode }) {
  return (
    <div className="login-card-glow relative rounded-[22px] border border-line-strong bg-surface px-[30px] pb-7 pt-[34px] max-[380px]:px-[22px]">
      {children}
    </div>
  );
}

function CtaWhatsApp({ children }: { children: React.ReactNode }) {
  return (
    <a
      href={SUPORTE_WHATSAPP_URL}
      target="_blank"
      rel="noopener noreferrer"
      className="login-btn-glow inline-flex h-[52px] w-full items-center justify-center gap-2.5 rounded-btn bg-brand px-5 font-display text-[15px] font-semibold text-bg outline-none transition-[transform,background-color] duration-[120ms] hover:bg-brand-600 active:scale-[0.985] active:bg-brand-700 focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-2 focus-visible:ring-offset-bg"
    >
      <IconWhatsapp size={18} />
      {children}
    </a>
  );
}

/** Portao 1 (soft check): numero ja consumiu o trial. Tom amigavel, nunca acusatorio. */
function TrialJaUsadoCard({ onVoltar }: { onVoltar: () => void }) {
  return (
    <StateCard>
      <h2 className="font-display text-[21px] font-bold leading-snug tracking-[-0.01em] text-ink">
        Esse WhatsApp já aproveitou o teste grátis 😉
      </h2>
      <p className="mt-2.5 text-[14px] leading-[1.6] text-ink-soft">
        O período de 10 dias vale uma vez por número. Mas a gente ativa seu plano rapidinho:
      </p>
      <div className="mt-5">
        <CtaWhatsApp>Falar com a gente no WhatsApp</CtaWhatsApp>
      </div>
      <button
        type="button"
        onClick={onVoltar}
        className="mt-3 h-11 w-full rounded-btn font-display text-[14px] font-semibold text-brand outline-none transition-colors hover:bg-brand-soft focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-2 focus-visible:ring-offset-bg"
      >
        Usar outro número
      </button>
    </StateCard>
  );
}

/** 409 conta_ja_existe: o numero ja tem login por aqui. */
function ContaExisteCard({ onVoltar }: { onVoltar: () => void }) {
  return (
    <StateCard>
      <h2 className="font-display text-[21px] font-bold leading-snug tracking-[-0.01em] text-ink">
        Esse número já tem conta por aqui
      </h2>
      <p className="mt-2.5 text-[14px] leading-[1.6] text-ink-soft">
        É só entrar com ele. Esqueceu a senha?{' '}
        <a
          href={SUPORTE_WHATSAPP_URL}
          target="_blank"
          rel="noopener noreferrer"
          className="font-semibold text-brand outline-none focus-visible:underline"
        >
          Fale com o suporte
        </a>
        .
      </p>
      <div className="mt-5">
        <Link
          href="/login"
          className="login-btn-glow inline-flex h-[52px] w-full items-center justify-center rounded-btn bg-brand px-5 font-display text-[15px] font-semibold text-bg outline-none transition-[transform,background-color] duration-[120ms] hover:bg-brand-600 active:scale-[0.985] active:bg-brand-700 focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-2 focus-visible:ring-offset-bg"
        >
          Entrar
        </Link>
      </div>
      <button
        type="button"
        onClick={onVoltar}
        className="mt-3 h-11 w-full rounded-btn font-display text-[14px] font-semibold text-brand outline-none transition-colors hover:bg-brand-soft focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-2 focus-visible:ring-offset-bg"
      >
        Usar outro número
      </button>
    </StateCard>
  );
}

/** 503 trial_lotado: teto global de trials simultaneos (TRIAL_MAX_ATIVOS) atingido.
 *  Lotacao reframada como coisa boa (🎉, precedente A3.10/spec item 8) — nunca
 *  culpa o visitante. Form fica preservado pro "Tentar de novo". */
function LotadoCard({ onVoltar }: { onVoltar: () => void }) {
  return (
    <StateCard>
      <h2 className="font-display text-[21px] font-bold leading-snug tracking-[-0.01em] text-ink">
        Estamos lotados no momento 🎉
      </h2>
      <p className="mt-2.5 text-[14px] leading-[1.6] text-ink-soft">
        Muita gente testando o robô ao mesmo tempo! A gente abre novas vagas aos poucos pra manter o
        atendimento redondo. Chama no WhatsApp que avisamos assim que abrir a sua:
      </p>
      <div className="mt-5">
        <CtaWhatsApp>Falar com a gente no WhatsApp</CtaWhatsApp>
      </div>
      <button
        type="button"
        onClick={onVoltar}
        className="mt-3 h-11 w-full rounded-btn font-display text-[14px] font-semibold text-brand outline-none transition-colors hover:bg-brand-soft focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-2 focus-visible:ring-offset-bg"
      >
        Tentar de novo
      </button>
    </StateCard>
  );
}

/** Flag PORTAL_SIGNUP OFF (backend devolve 404): cadastro ainda nao abriu. */
function IndisponivelCard() {
  return (
    <StateCard>
      <h2 className="font-display text-[21px] font-bold leading-snug tracking-[-0.01em] text-ink">
        O cadastro ainda não está disponível
      </h2>
      <p className="mt-2.5 text-[14px] leading-[1.6] text-ink-soft">
        Estamos abrindo as portas aos poucos. Chama a gente no WhatsApp que colocamos seu robô pra
        funcionar rapidinho.
      </p>
      <div className="mt-5">
        <CtaWhatsApp>Chamar no WhatsApp</CtaWhatsApp>
      </div>
    </StateCard>
  );
}

function Wordmark() {
  return (
    <div className="inline-flex items-center gap-[10px] font-display text-[20px] font-bold tracking-[-0.01em] text-ink md:text-[22px]">
      <Brandmark size={36} />
      <span>
        Start<span className="text-brand">ap</span>
      </span>
    </div>
  );
}
