'use client';

import { IconUser } from '@/components/icons';
import { useTenant } from '@/components/shell/session-context';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { PageHead } from '@/components/ui/page-head';
import { SkeletonList } from '@/components/ui/skeleton';
import { ErrorState } from '@/components/ui/states';
import { useToast } from '@/components/ui/toast';
import { cn } from '@/lib/cn';
import {
  type PerfilDraft,
  type PerfilErrors,
  isDirty,
  toPerfilDraft,
  validatePerfil,
} from '@/lib/perfil';
import { qk, usePerfil, useSavePerfil } from '@/lib/queries';
/**
 * Meu negócio / Perfil (Missão 023 W13). O cliente edita os dados do próprio
 * negócio sem depender do gestão: Nome do negócio, Nome do prestador, Telefone,
 * Endereço, Instagram e Formas de pagamento. Todos opcionais (preenche aos poucos).
 *
 * GET/PUT /portal/perfil compartilham o mesmo shape; o slot vem da sessão no
 * backend (nunca no body). Salvamento OTIMISTA com revert (padrão D5 das telas
 * servicos/horarios): escreve no cache, dispara o PUT; sucesso -> toast "Perfil
 * atualizado"; falha -> reverte ao snapshot anterior + toast danger.
 *
 * Validação no cliente espelha as regras do backend (campos opcionais, limites de
 * tamanho, Instagram aceito com/sem "@" e normalizado pra handle) — vive em
 * @/lib/perfil (testável) e dá erro inline antes de bater na API.
 */
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';

export default function PerfilPage() {
  const { slot } = useTenant();
  const toast = useToast();
  const client = useQueryClient();
  const perfilQ = usePerfil(slot);
  const save = useSavePerfil(slot);

  // `saved` = última versão confirmada (do servidor/cache); `draft` = edição em
  // andamento. `touched` marca que o usuário começou a editar — usado pra NÃO
  // estourar o rascunho dele num refetch em background (o effect não lê `draft`/
  // `saved`, só o ref, então não precisa entrar nas deps).
  const [draft, setDraft] = useState<PerfilDraft>(() => toPerfilDraft(perfilQ.data));
  const [saved, setSaved] = useState<PerfilDraft>(() => toPerfilDraft(perfilQ.data));
  const [errors, setErrors] = useState<PerfilErrors>({});
  const touched = useRef(false);

  useEffect(() => {
    if (!perfilQ.data) return;
    const next = toPerfilDraft(perfilQ.data);
    setSaved(next);
    // Só re-hidrata o rascunho enquanto o usuário não tocou no form.
    if (!touched.current) setDraft(next);
  }, [perfilQ.data]);

  const dirty = isDirty(draft, saved);

  function set(field: keyof PerfilDraft, value: string) {
    touched.current = true;
    setDraft((d) => ({ ...d, [field]: value }));
    if (errors[field]) setErrors((e) => ({ ...e, [field]: undefined }));
  }

  function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!dirty || save.isPending) return;

    const res = validatePerfil(draft);
    if (!res.ok) {
      setErrors(res.errors);
      return;
    }
    setErrors({});

    const value = res.value;
    const next = toPerfilDraft(value); // normalizado (ex.: Instagram sem "@")
    const prev = client.getQueryData(qk.perfil(slot));

    // Otimista (D5): aplica no cache + reflete normalização na tela na hora.
    client.setQueryData(qk.perfil(slot), value);
    setSaved(next);
    setDraft(next);
    touched.current = false; // sincronizado com o servidor a partir daqui

    save.mutate(value, {
      onSuccess: () => toast.success('Perfil atualizado'),
      onError: () => {
        if (prev !== undefined) client.setQueryData(qk.perfil(slot), prev);
        const back = toPerfilDraft(prev as Parameters<typeof toPerfilDraft>[0]);
        setSaved(back);
        setDraft(back);
        touched.current = false;
        toast.error('Não foi possível salvar. Tente de novo.');
      },
    });
  }

  return (
    <>
      <PageHead
        title="Meu negócio"
        subtitle="Os dados do seu negócio. O robô usa essas informações ao falar com seus clientes."
      />

      {perfilQ.isPending ? (
        <>
          <span className="sr-only">Carregando os dados do seu negócio…</span>
          <SkeletonList rows={6} />
        </>
      ) : perfilQ.isError ? (
        <ErrorState onRetry={() => perfilQ.refetch()} />
      ) : (
        <form onSubmit={onSubmit} className="stagger stagger-2 flex flex-col gap-4" noValidate>
          <div className="flex flex-col gap-4 rounded-card border border-line bg-surface p-[18px] shadow-card">
            <Input
              label="Nome do negócio"
              placeholder="Ex.: Barbearia do Zé"
              value={draft.nome_negocio}
              error={errors.nome_negocio}
              onChange={(e) => set('nome_negocio', e.target.value)}
              autoComplete="organization"
              enterKeyHint="next"
            />
            <Input
              label="Nome do prestador de serviço"
              placeholder="Ex.: José da Silva"
              value={draft.nome_prestador}
              error={errors.nome_prestador}
              onChange={(e) => set('nome_prestador', e.target.value)}
              autoComplete="name"
              enterKeyHint="next"
            />
            <Input
              label="Telefone"
              type="tel"
              inputMode="tel"
              placeholder="Ex.: (11) 99999-9999"
              value={draft.telefone_contato}
              error={errors.telefone_contato}
              onChange={(e) => set('telefone_contato', e.target.value)}
              autoComplete="tel"
            />
            <TextArea
              label="Endereço"
              placeholder="Rua, número, bairro, cidade"
              rows={2}
              value={draft.endereco}
              error={errors.endereco}
              onChange={(v) => set('endereco', v)}
            />
            <Input
              label="Instagram"
              prefix="@"
              placeholder="seu.perfil"
              value={draft.instagram}
              error={errors.instagram}
              onChange={(e) => set('instagram', e.target.value)}
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
            />
            <TextArea
              label="Formas de pagamento"
              placeholder="Ex.: Pix, dinheiro, cartão"
              hint="Separe por vírgula. Aparece pro cliente quando ele pergunta."
              rows={2}
              value={draft.formas_pagamento}
              error={errors.formas_pagamento}
              onChange={(v) => set('formas_pagamento', v)}
            />
          </div>

          <div className="flex items-center gap-3">
            <Button type="submit" className="flex-1" loading={save.isPending} disabled={!dirty}>
              Salvar
            </Button>
          </div>

          <p aria-live="polite" className="px-0.5 text-[12.5px] leading-normal text-ink-soft">
            {save.isPending
              ? 'Salvando…'
              : dirty
                ? 'Você tem alterações não salvas.'
                : 'Tudo salvo. Você pode editar quando quiser — é tudo opcional.'}
          </p>
        </form>
      )}
    </>
  );
}

/** Campo de texto multi-linha (Endereço, Formas de pagamento) no padrão visual do Input. */
function TextArea({
  label,
  value,
  error,
  hint,
  rows = 2,
  placeholder,
  onChange,
}: {
  label: string;
  value: string;
  error?: string;
  hint?: string;
  rows?: number;
  placeholder?: string;
  onChange: (v: string) => void;
}) {
  const id = `ta-${label.toLowerCase().replace(/[^a-z]+/g, '-')}`;
  const errId = `${id}-err`;
  const hintId = `${id}-hint`;
  return (
    <div className="flex w-full flex-col gap-[7px]">
      <label htmlFor={id} className="text-[13px] font-semibold text-ink">
        {label}
      </label>
      <textarea
        id={id}
        rows={rows}
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        aria-invalid={error ? true : undefined}
        aria-describedby={cn(error && errId, hint && hintId) || undefined}
        className={cn(
          'w-full resize-y rounded-field border-[1.5px] border-line-strong bg-surface-sunken px-3.5 py-3 text-[15px] leading-snug text-ink outline-none transition-[border-color,box-shadow] duration-[120ms] placeholder:text-ink-faint',
          'hover:border-[var(--c-input-hover-border)]',
          'focus:border-brand focus:ring-[3px] focus:ring-brand/35 focus:shadow-focus',
          error && 'border-danger',
        )}
      />
      {hint && !error && (
        <p id={hintId} className="text-[12px] text-ink-soft">
          {hint}
        </p>
      )}
      {error && (
        <p id={errId} className="text-[13px] text-danger">
          {error}
        </p>
      )}
    </div>
  );
}
