'use client';

/**
 * Modal "Gerar senha" de um colaborador, na tela de Equipe (SCRUM-32 follow-up).
 *
 * O DONO gera/regenera a senha de login de um profissional dele no portal, sem depender
 * do painel de gestão interno. Dois passos:
 *   1. INTENÇÃO — explica que cria/SUBSTITUI a senha de login do profissional e avisa que,
 *      se já houver uma, ela para de valer na hora (a rota é idempotente — regenerar).
 *   2. REVELAÇÃO — mostra usuário + senha UMA vez (copiar cada um) com aviso "anote/repasse
 *      agora, não será mostrada de novo" (o backend só guarda o hash). Permite "Gerar outra".
 *
 * Espelha o ColabCredUI do gestão (painel-admin), adaptado ao portal (Next.js + Overlay).
 * A senha em claro vive só no estado deste componente e some ao fechar (a mutation não
 * cacheia). Reusa o Overlay (modal centralizado, trap de foco, Esc fecha). Responsivo.
 */
import { IconAlert, IconCheck, IconCopy, IconLock } from '@/components/icons';
import { Button } from '@/components/ui/button';
import { Overlay } from '@/components/ui/overlay';
import { useToast } from '@/components/ui/toast';
import { ApiError } from '@/lib/api';
import type { Colaborador, GerarSenhaColaboradorResponse } from '@/lib/api-types';
import { useGerarSenhaColaborador } from '@/lib/queries';
import { useId, useState } from 'react';

/** Extrai a mensagem amigável de um ApiError (409/404) ou um fallback. */
function errMsg(e: unknown, fallback: string): string {
  if (e instanceof ApiError && e.body && typeof e.body === 'object' && 'error' in e.body) {
    const m = (e.body as { error?: unknown }).error;
    if (typeof m === 'string' && m) return m;
  }
  return fallback;
}

export function GerarSenhaModal({
  colaborador,
  onClose,
}: {
  colaborador: Colaborador;
  onClose: () => void;
}) {
  const toast = useToast();
  const titleId = useId();
  const gerar = useGerarSenhaColaborador();
  const [cred, setCred] = useState<GerarSenhaColaboradorResponse | null>(null);

  function executar() {
    gerar.mutate(
      { id: colaborador.id },
      {
        onSuccess: (res) => setCred(res),
        onError: (e) => toast.error(errMsg(e, 'Não foi possível gerar a senha. Tente de novo.')),
      },
    );
  }

  return (
    <Overlay open onClose={onClose} variant="modal" ariaLabelledBy={titleId}>
      {cred ? (
        <RevealStep
          titleId={titleId}
          nome={colaborador.nome}
          cred={cred}
          regenerating={gerar.isPending}
          onRegenerar={executar}
          onClose={onClose}
        />
      ) : (
        <IntentStep
          titleId={titleId}
          nome={colaborador.nome}
          loading={gerar.isPending}
          onConfirm={executar}
          onCancel={onClose}
        />
      )}
    </Overlay>
  );
}

/** Passo 1 — confirma a ação (regenerar SUBSTITUI a senha anterior). */
function IntentStep({
  titleId,
  nome,
  loading,
  onConfirm,
  onCancel,
}: {
  titleId: string;
  nome: string;
  loading: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <>
      <div className="mb-3.5 flex size-12 items-center justify-center rounded-[14px] bg-brand-soft text-brand">
        <IconLock size={22} />
      </div>
      <h3
        id={titleId}
        className="font-display text-[18px] font-semibold tracking-[-0.01em] text-ink"
      >
        Senha de acesso de {nome}
      </h3>
      <p className="mt-2 text-[14px] leading-normal text-ink-soft">
        Cria a senha de login de <span className="font-semibold text-ink">{nome}</span> no portal.
        Lá ele vê — só leitura — a agenda e a comissão dele.
      </p>
      <div className="mt-3 flex items-start gap-2 rounded-field border border-warn-line bg-warn-soft px-3.5 py-2.5">
        <span className="mt-0.5 shrink-0 text-warn">
          <IconAlert size={15} />
        </span>
        <p className="text-[12.5px] leading-snug text-ink-soft">
          Se este profissional já tiver uma senha, ela será{' '}
          <span className="font-semibold text-ink">substituída</span> — a anterior para de funcionar
          na hora.
        </p>
      </div>
      <div className="mt-5 flex gap-2.5">
        <Button variant="secondary" onClick={onCancel} disabled={loading}>
          Cancelar
        </Button>
        <Button loading={loading} loadingLabel="Gerando…" onClick={onConfirm}>
          Gerar senha
        </Button>
      </div>
    </>
  );
}

/** Passo 2 — revela usuário + senha UMA vez (copiar + aviso + regenerar). */
function RevealStep({
  titleId,
  nome,
  cred,
  regenerating,
  onRegenerar,
  onClose,
}: {
  titleId: string;
  nome: string;
  cred: GerarSenhaColaboradorResponse;
  regenerating: boolean;
  onRegenerar: () => void;
  onClose: () => void;
}) {
  return (
    <>
      <div className="mb-3.5 flex size-12 items-center justify-center rounded-[14px] bg-ok-soft text-ok">
        <IconCheck size={24} />
      </div>
      <h3
        id={titleId}
        className="font-display text-[18px] font-semibold tracking-[-0.01em] text-ink"
      >
        Senha gerada
      </h3>
      <div className="mt-2 flex items-start gap-2 rounded-field border border-warn-line bg-warn-soft px-3.5 py-2.5">
        <span className="mt-0.5 shrink-0 text-warn">
          <IconAlert size={15} />
        </span>
        <p className="text-[12.5px] leading-snug text-ink-soft">
          <span className="font-semibold text-ink">Anote ou repasse agora</span> — por segurança a
          senha <span className="font-semibold text-ink">não será mostrada de novo</span>. Se
          perder, é só gerar outra.
        </p>
      </div>

      <div className="mt-4 flex flex-col gap-3">
        <CredField label="Usuário (login)" value={cred.username} copyLabel="Copiar usuário" />
        <CredField label="Senha" value={cred.generated_password} copyLabel="Copiar senha" />
      </div>

      <p className="mt-3 text-[12px] leading-snug text-ink-soft">
        Entregue para {nome} acessar o portal e entrar com esse usuário e senha.
      </p>

      <div className="mt-5 flex gap-2.5">
        <Button variant="secondary" onClick={onRegenerar} loading={regenerating}>
          Gerar outra
        </Button>
        <Button onClick={onClose}>Fechar</Button>
      </div>
    </>
  );
}

/** Campo read-only (mono) + botão copiar com feedback textual e aria-live. */
function CredField({
  label,
  value,
  copyLabel,
}: {
  label: string;
  value: string;
  copyLabel: string;
}) {
  const toast = useToast();
  const fieldId = useId();
  const [copied, setCopied] = useState(false);

  async function onCopy() {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      toast.error('Não foi possível copiar. Selecione e copie manualmente.');
    }
  }

  return (
    <div>
      <label
        htmlFor={fieldId}
        className="mb-1 block font-display text-[12.5px] font-semibold text-ink"
      >
        {label}
      </label>
      <div className="flex items-stretch gap-2">
        <input
          id={fieldId}
          type="text"
          readOnly
          value={value}
          aria-label={label}
          onFocus={(e) => e.target.select()}
          className="min-w-0 flex-1 rounded-field border border-line-strong bg-surface-sunken px-3 py-2.5 font-mono text-[14px] text-ink outline-none focus-visible:ring-2 focus-visible:ring-brand"
        />
        <Button
          variant="secondary"
          size="inline"
          onClick={onCopy}
          aria-label={copied ? 'Copiado' : copyLabel}
          className="shrink-0"
        >
          {copied ? <IconCheck size={16} /> : <IconCopy size={16} />}
          <span className="max-[360px]:sr-only">{copied ? 'Copiado' : 'Copiar'}</span>
        </Button>
      </div>
      <span className="sr-only" aria-live="polite">
        {copied ? `${label} copiado para a área de transferência.` : ''}
      </span>
    </div>
  );
}
