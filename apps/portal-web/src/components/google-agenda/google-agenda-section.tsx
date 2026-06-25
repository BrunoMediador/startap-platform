'use client';

/**
 * Seção "Google Agenda" dentro de "Meu negócio". Mostra a CREDENCIAL da conta
 * Google do clone (e-mail + senha) pro dono instalar o app Google Agenda no
 * celular/computador e LOGAR — assim ele é NOTIFICADO no aparelho quando chega um
 * agendamento. Tudo já dá pra ver/marcar no próprio painel; o app é o extra de
 * notificação + sincronização.
 *
 * Gated em duas camadas (degrada limpo, sem card vermelho):
 *   - GOOGLE_ACCOUNT_PORTAL_ENABLED OFF -> GET 404 -> isGoogleContaFeatureOff -> some;
 *   - feature ON mas sem credencial cadastrada (campos null) -> hasCredencial false -> some.
 * Outros erros (rede/500) caem no ErrorState com "tentar de novo".
 *
 * A senha vem `no-store` do backend (já DECRIPTADA) e é sensível: o hook não
 * cacheia agressivo e NADA aqui loga o segredo. NÃO sugerimos trocar a senha
 * (decisão do Bruno: mantém a senha que ele definiu) — é só leitura + copiar.
 *
 * NÃO toca nas colunas gcal_* (Service Account do BOT) — escopo diferente. Aqui é
 * só a conta Google que o DONO usa no app do celular dele.
 */
import {
  IconCalendar,
  IconCheck,
  IconCopy,
  IconEye,
  IconEyeOff,
  IconInfo,
} from '@/components/icons';
import { useTenant } from '@/components/shell/session-context';
import { Skeleton } from '@/components/ui/skeleton';
import { ErrorState } from '@/components/ui/states';
import { useToast } from '@/components/ui/toast';
import { cn } from '@/lib/cn';
import {
  type GuiaPlataforma,
  isGoogleContaFeatureOff,
  toGoogleContaState,
} from '@/lib/google-conta';
import { useGoogleConta } from '@/lib/queries';
import { type ReactNode, useState } from 'react';

export function GoogleAgendaSection() {
  const { slot } = useTenant();
  const contaQ = useGoogleConta(slot);

  if (contaQ.isPending) {
    return (
      <SectionShell>
        <span className="sr-only">Carregando os dados da sua conta Google…</span>
        <div className="flex flex-col gap-3">
          <Skeleton className="h-12 w-full" />
          <Skeleton className="h-12 w-full" />
        </div>
      </SectionShell>
    );
  }

  // Feature OFF (GOOGLE_ACCOUNT_PORTAL_ENABLED desligado): GET devolve 404. NÃO é
  // erro do cliente — a seção some graciosamente (igual lembretes/atendimentos).
  if (isGoogleContaFeatureOff(contaQ.error)) return null;

  if (contaQ.isError) {
    return (
      <SectionShell>
        <ErrorState onRetry={() => contaQ.refetch()} />
      </SectionShell>
    );
  }

  const state = toGoogleContaState(contaQ.data);
  // Feature ON mas sem credencial cadastrada (campos null) -> nada a mostrar, some.
  if (!state.hasCredencial) return null;

  return (
    <SectionShell>
      <div className="flex flex-col gap-5">
        <Credencial email={state.email} password={state.password} />
        <Guia />
      </div>
    </SectionShell>
  );
}

// ── Credencial (e-mail + senha mascarada com olho + copiar) ───────────────────

function Credencial({ email, password }: { email: string; password: string }) {
  const [showPass, setShowPass] = useState(false);

  return (
    <div className="flex flex-col gap-3">
      <CredField label="E-mail da conta Google" value={email} autoComplete="username" />
      <CredField
        label="Senha"
        value={password}
        masked={!showPass}
        sensitive
        autoComplete="off"
        onToggleMask={() => setShowPass((v) => !v)}
        toggling={showPass}
      />
      <p className="text-[12.5px] leading-snug text-ink-soft">
        Use esse e-mail e senha pra entrar no app Google Agenda. É a sua senha — não precisa trocar.
      </p>
    </div>
  );
}

/** Campo de credencial só-leitura: label + valor (mascarável) + olho + copiar. */
function CredField({
  label,
  value,
  masked = false,
  sensitive = false,
  autoComplete,
  onToggleMask,
  toggling = false,
}: {
  label: string;
  value: string;
  masked?: boolean;
  sensitive?: boolean;
  autoComplete?: string;
  onToggleMask?: () => void;
  toggling?: boolean;
}) {
  const id = `cred-${label.toLowerCase().replace(/[^a-z]+/g, '-')}`;
  // Mascara visual: pontos do mesmo comprimento. NÃO derivamos nada do segredo num
  // log — só renderizamos a máscara. O valor real só aparece ao clicar no olho.
  const shown = masked ? '•'.repeat(Math.min(value.length, 24)) : value;

  return (
    <div className="flex flex-col gap-[7px]">
      <label htmlFor={id} className="text-[13px] font-semibold text-ink">
        {label}
      </label>
      <div className="flex items-stretch gap-2">
        <input
          id={id}
          readOnly
          value={shown}
          autoComplete={autoComplete}
          // type=text sempre (a máscara é por • render, não por type=password): garante
          // que o "mostrar" funcione e o gerenciador de senhas do navegador não capture.
          type="text"
          aria-label={label}
          className="min-w-0 flex-1 rounded-field border-[1.5px] border-line-strong bg-surface-sunken px-3.5 py-2.5 text-[14px] text-ink outline-none [font-variant-ligatures:none] tabular-nums"
        />
        {sensitive && onToggleMask && (
          <IconButton
            label={toggling ? `Ocultar ${label.toLowerCase()}` : `Mostrar ${label.toLowerCase()}`}
            onClick={onToggleMask}
          >
            {toggling ? <IconEyeOff size={18} /> : <IconEye size={18} />}
          </IconButton>
        )}
        <CopyButton value={value} label={`Copiar ${label.toLowerCase()}`} />
      </div>
    </div>
  );
}

/** Botão quadrado de ícone (olho/copiar), alvo >=44px, foco visível. */
function IconButton({
  label,
  onClick,
  children,
}: {
  label: string;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      onClick={onClick}
      className="flex size-11 shrink-0 items-center justify-center rounded-field border-[1.5px] border-line-strong bg-surface text-ink-soft outline-none transition-colors hover:bg-surface-hover hover:text-ink focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-2 focus-visible:ring-offset-bg"
    >
      {children}
    </button>
  );
}

/** Copiar pro clipboard com feedback textual + aria-live (mesmo padrão do conectar). */
function CopyButton({ value, label }: { value: string; label: string }) {
  const toast = useToast();
  const [copied, setCopied] = useState(false);

  async function onCopy() {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      // NÃO incluir o valor no toast (segredo). Mensagem genérica.
      toast.error('Não foi possível copiar. Selecione e copie manualmente.');
    }
  }

  return (
    <>
      <IconButton label={copied ? 'Copiado' : label} onClick={onCopy}>
        {copied ? <IconCheck size={18} className="text-ok" /> : <IconCopy size={18} />}
      </IconButton>
      <span className="sr-only" aria-live="polite">
        {copied ? `${label.replace(/^Copiar/, 'Copiado')} para a área de transferência.` : ''}
      </span>
    </>
  );
}

// ── Guia "Como conectar sua agenda" (Celular / Computador) ────────────────────

type Passo = { key: string; texto: ReactNode };

function Guia() {
  const [plataforma, setPlataforma] = useState<GuiaPlataforma>('celular');

  const passos: Record<GuiaPlataforma, Passo[]> = {
    celular: [
      {
        key: 'instalar',
        texto: (
          <>
            Instale o app <b className="text-ink">Google Agenda</b> (Google Calendar) na loja de
            apps do seu celular.
          </>
        ),
      },
      { key: 'abrir', texto: 'Abra o app Google Agenda.' },
      {
        key: 'adicionar',
        texto: (
          <>
            Toque na sua foto/inicial no canto, depois em{' '}
            <b className="text-ink">Adicionar outra conta</b>.
          </>
        ),
      },
      {
        key: 'logar',
        texto: (
          <>
            Entre com o <b className="text-ink">e-mail e a senha</b> que estão aqui em cima.
          </>
        ),
      },
      {
        key: 'notificar',
        texto: 'Pronto! Os agendamentos aparecem e você é avisado no celular.',
      },
    ],
    computador: [
      {
        key: 'abrir',
        texto: (
          <>
            No navegador, abra <b className="text-ink">calendar.google.com</b>.
          </>
        ),
      },
      {
        key: 'logar',
        texto: (
          <>
            Entre com o <b className="text-ink">e-mail e a senha</b> que estão aqui em cima.
          </>
        ),
      },
      {
        key: 'notificar',
        texto: (
          <>
            Deixe a aba aberta (ou ative as notificações do Google Agenda) pra ser avisado no
            computador.
          </>
        ),
      },
    ],
  };

  return (
    <div className="border-t border-line pt-5">
      <h3 className="font-display text-[15px] font-semibold text-ink">Como conectar sua agenda</h3>
      <p className="mt-1 text-[13px] leading-snug text-ink-soft">
        Onde você quer receber os agendamentos?
      </p>

      <PlataformaSwitch value={plataforma} onChange={setPlataforma} />
      <StepList passos={passos[plataforma]} />

      {/* Nota em destaque: o painel já basta; o app é o extra de notificação. */}
      <div className="mt-4 flex items-start gap-3 rounded-card-sm border border-brand/30 bg-brand-soft p-4">
        <span
          aria-hidden
          className="mt-px flex size-7 shrink-0 items-center justify-center rounded-full bg-brand text-bg"
        >
          <IconInfo size={16} />
        </span>
        <p className="text-[13px] leading-snug text-ink-soft">
          Dá pra ver e marcar tudo aqui no painel. Mas instalar o app{' '}
          <b className="text-ink">Google Agenda</b> no celular e logar com esses dados sincroniza e
          te <b className="text-ink">notifica</b> no celular e no computador quando chega um
          agendamento.
        </p>
      </div>
    </div>
  );
}

/** Lista numerada de passos (mesmo molde do PassoAPasso de conectar). */
function StepList({ passos }: { passos: Passo[] }) {
  return (
    <ol className="mt-4 space-y-2.5">
      {passos.map((p, i) => (
        <li key={p.key} className="flex items-start gap-3">
          <span
            aria-hidden
            className="mt-px flex size-6 shrink-0 items-center justify-center rounded-full bg-brand-soft font-display text-[12px] font-bold text-brand"
          >
            {i + 1}
          </span>
          <span className="text-[13.5px] leading-snug text-ink-soft">
            <span className="sr-only">Passo {i + 1}: </span>
            {p.texto}
          </span>
        </li>
      ))}
    </ol>
  );
}

/** Toggle Celular/Computador (aria-pressed; sem lib nova). Default Celular. */
function PlataformaSwitch({
  value,
  onChange,
}: {
  value: GuiaPlataforma;
  onChange: (p: GuiaPlataforma) => void;
}) {
  const opcoes: { id: GuiaPlataforma; label: string }[] = [
    { id: 'celular', label: 'Celular' },
    { id: 'computador', label: 'Computador' },
  ];
  return (
    <div role="group" aria-label="Onde conectar a agenda?" className="mt-3 grid grid-cols-2 gap-2">
      {opcoes.map((op) => (
        <button
          key={op.id}
          type="button"
          aria-pressed={value === op.id}
          onClick={() => onChange(op.id)}
          className={cn(
            'h-11 rounded-btn font-display text-[14px] font-semibold outline-none transition-colors focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-2 focus-visible:ring-offset-bg',
            value === op.id
              ? 'bg-brand text-bg'
              : 'border border-line-strong bg-surface text-ink-soft hover:bg-surface-hover',
          )}
        >
          {op.label}
        </button>
      ))}
    </div>
  );
}

/** Cabeçalho + card da seção (reutilizado por todos os estados). */
function SectionShell({ children }: { children: ReactNode }) {
  return (
    <section aria-labelledby="google-agenda-title" className="flex flex-col gap-3">
      <div className="flex items-center gap-2.5">
        <span
          aria-hidden
          className="flex size-7 items-center justify-center rounded-full bg-brand-soft text-brand"
        >
          <IconCalendar size={16} />
        </span>
        <div>
          <h2 id="google-agenda-title" className="font-display text-[17px] font-semibold text-ink">
            Google Agenda
          </h2>
          <p className="mt-0.5 text-[13px] leading-snug text-ink-soft">
            Receba os agendamentos no seu celular e computador.
          </p>
        </div>
      </div>
      <div className="rounded-card border border-line bg-surface p-[18px] shadow-card">
        {children}
      </div>
    </section>
  );
}
