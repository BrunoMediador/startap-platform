'use client';

import { AgendamentoSection } from '@/components/agendamento/agendamento-section';
import { GoogleAgendaSection } from '@/components/google-agenda/google-agenda-section';
import { IconCheck } from '@/components/icons';
import { LembretesSection } from '@/components/lembretes/lembretes-section';
import { useTenant } from '@/components/shell/session-context';
import { useTenantTz } from '@/components/shell/tenant-tz-context';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { PageHead } from '@/components/ui/page-head';
import { SkeletonList } from '@/components/ui/skeleton';
import { ErrorState } from '@/components/ui/states';
import { TimezoneCombobox } from '@/components/ui/timezone-combobox';
import { useToast } from '@/components/ui/toast';
import { FORMAS_PAGAMENTO_OPCOES, type FormaPagamentoOpcao } from '@/lib/api-types';
import { cn } from '@/lib/cn';
import { showPrestadorField } from '@/lib/google-conta';
import {
  type PerfilDraft,
  type PerfilErrors,
  isDirty,
  toPerfilDraft,
  toggleFormaPagamento,
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
  const { slot, atendFromAgenda, productType } = useTenant();
  const toast = useToast();
  // ESTABELECIMENTO: o "prestador" são os COLABORADORES (geridos na Equipe), então o
  // campo único de prestador some. SOLO/individual mantém o campo. Esconder NÃO muda
  // o submit: o valor atual segue no draft e vai pro PUT (mesmo shape PerfilNegocio).
  const showPrestador = showPrestadorField(productType);
  const client = useQueryClient();
  const perfilQ = usePerfil(slot);
  const save = useSavePerfil(slot);
  // Fuso atual do clone (= flow_clones.timezone) vindo do /portal/status. É a FONTE
  // do fuso pra pré-seleção: o GET /portal/perfil devolve timezone TOP-LEVEL, mas o
  // hook usePerfil desembrulha só `r.perfil` no cache — então o tz vive à parte, no
  // status. O PUT também manda timezone TOP-LEVEL (irmão de `perfil`), nunca dentro dele.
  const tenantTz = useTenantTz();

  // `saved` = última versão confirmada (do servidor/cache); `draft` = edição em
  // andamento. `touched` marca que o usuário começou a editar — usado pra NÃO
  // estourar o rascunho dele num refetch em background (o effect não lê `draft`/
  // `saved`, só o ref, então não precisa entrar nas deps).
  const [draft, setDraft] = useState<PerfilDraft>(() => toPerfilDraft(perfilQ.data));
  const [saved, setSaved] = useState<PerfilDraft>(() => toPerfilDraft(perfilQ.data));
  const [errors, setErrors] = useState<PerfilErrors>({});
  const touched = useRef(false);

  // Fuso gerido À PARTE do PerfilDraft (é campo TOP-LEVEL da request/response, não do
  // objeto perfil). Semente = tenantTz (status = flow_clones.timezone). Nunca chumba São
  // Paulo sobre o fuso real num save que não tocou no campo.
  const [timezone, setTimezone] = useState<string>(tenantTz);
  const [savedTz, setSavedTz] = useState<string>(tenantTz);
  const tzTouched = useRef(false);

  useEffect(() => {
    if (!perfilQ.data) return;
    const next = toPerfilDraft(perfilQ.data);
    setSaved(next);
    // Só re-hidrata o rascunho enquanto o usuário não tocou no form.
    if (!touched.current) setDraft(next);
  }, [perfilQ.data]);

  useEffect(() => {
    setSavedTz(tenantTz);
    if (!tzTouched.current) setTimezone(tenantTz);
  }, [tenantTz]);

  const dirty = isDirty(draft, saved) || timezone !== savedTz;

  // Campos de texto: keyof PerfilDraft menos `formas_pagamento` (que e checklist).
  function set(field: Exclude<keyof PerfilDraft, 'formas_pagamento'>, value: string) {
    touched.current = true;
    setDraft((d) => ({ ...d, [field]: value }));
    if (errors[field]) setErrors((e) => ({ ...e, [field]: undefined }));
  }

  function toggleForma(forma: FormaPagamentoOpcao) {
    touched.current = true;
    setDraft((d) => ({ ...d, formas_pagamento: toggleFormaPagamento(d.formas_pagamento, forma) }));
  }

  function onTimezoneChange(tz: string) {
    tzTouched.current = true;
    setTimezone(tz);
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

    // O perfil (envelope `perfil`) e o fuso (campo TOP-LEVEL) viajam SEPARADOS no PUT:
    // body = { perfil, timezone }. O backend grava perfil na personalizacao e o timezone
    // na coluna flow_clones.timezone. O cache de perfil guarda SÓ o perfil (sem tz), igual
    // ao shape do GET (r.perfil) — o tz mora no estado dedicado + no /portal/status.
    const perfil = res.value;
    const next = toPerfilDraft(perfil); // normalizado (ex.: Instagram sem "@")
    const prev = client.getQueryData(qk.perfil(slot));
    const prevTz = savedTz;

    // Otimista (D5): aplica no cache + reflete normalização na tela na hora.
    client.setQueryData(qk.perfil(slot), perfil);
    setSaved(next);
    setDraft(next);
    setSavedTz(timezone);
    touched.current = false; // sincronizado com o servidor a partir daqui
    tzTouched.current = false;

    save.mutate(
      { perfil, timezone },
      {
        onSuccess: () => {
          toast.success('Perfil atualizado');
          // O fuso alimenta o display da agenda (useTenantTz lê /portal/status): revalida.
          client.invalidateQueries({ queryKey: qk.status(slot) });
        },
        onError: () => {
          if (prev !== undefined) client.setQueryData(qk.perfil(slot), prev);
          const back = toPerfilDraft(prev as Parameters<typeof toPerfilDraft>[0]);
          setSaved(back);
          setDraft(back);
          setSavedTz(prevTz);
          setTimezone(prevTz);
          touched.current = false;
          tzTouched.current = false;
          toast.error('Não foi possível salvar. Tente de novo.');
        },
      },
    );
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
            {showPrestador && (
              <Input
                label="Nome do prestador de serviço"
                placeholder="Ex.: José da Silva"
                value={draft.nome_prestador}
                error={errors.nome_prestador}
                onChange={(e) => set('nome_prestador', e.target.value)}
                autoComplete="name"
                enterKeyHint="next"
              />
            )}
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
            <TimezoneCombobox
              id="perfil-tz"
              label="Fuso horário"
              hint="O robô usa esse fuso pra agendar no horário certo da sua cidade."
              value={timezone || tenantTz}
              onChange={onTimezoneChange}
            />
            <FormasPagamentoChecklist
              selecionadas={draft.formas_pagamento}
              onToggle={toggleForma}
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

      {/* Agendamento (modo atendente, SCRUM-59): toggle "agenda automática (Google)" +
          link externo. A seção SE AUTO-GATEIA por features.modo_atendente (por-clone,
          MODO_ATENDENTE_SLOTS) e traz o próprio divisor — some INTEIRA (sem divisor
          órfão) pros clientes atuais (byte-idêntico). */}
      <AgendamentoSection />

      {/* Lembretes: seção da própria "Meu negócio" (config self-service do lembrete
          automático). Só aparece pra quem tem agenda ativa (atend_from_agenda) —
          sem agenda não há agendamento pra lembrar. O componente cuida do próprio
          loading/erro/gating. */}
      {atendFromAgenda && (
        <div className="mt-8 border-t border-line pt-6">
          <LembretesSection />
        </div>
      )}

      {/* Google Agenda: credencial da conta Google + guia pra instalar o app e ser
          notificado no celular/computador. Bloco gateado por
          GOOGLE_ACCOUNT_PORTAL_ENABLED (404 -> some) e por credencial cadastrada — o
          componente cuida do próprio loading/erro/gating e some quando não há o que
          mostrar (degrada limpo). */}
      <div className="mt-8 border-t border-line pt-6">
        <GoogleAgendaSection />
      </div>
    </>
  );
}

/**
 * Formas de pagamento: CHECKLIST de opções FIXAS (SCRUM-23, "selecionar, não
 * digitar" — #365/#367). O dono marca as que aceita; não dá pra digitar uma forma
 * inexistente (o backend também valida → 400). Mesmo padrão visual do checklist de
 * serviços da Equipe (chip = checkbox, `role=checkbox`/`aria-checked`, alvo ~36px).
 * Nada marcado = não aparece pro cliente quando ele pergunta.
 */
function FormasPagamentoChecklist({
  selecionadas,
  onToggle,
}: {
  selecionadas: FormaPagamentoOpcao[];
  onToggle: (forma: FormaPagamentoOpcao) => void;
}) {
  return (
    <div className="flex flex-col gap-2">
      <span className="text-[13px] font-semibold text-ink">Formas de pagamento</span>
      <div
        role="group"
        aria-label="Formas de pagamento que você aceita"
        className="flex flex-wrap gap-2"
      >
        {FORMAS_PAGAMENTO_OPCOES.map((forma) => (
          <FormaChip
            key={forma}
            label={forma}
            marcada={selecionadas.includes(forma)}
            onToggle={() => onToggle(forma)}
          />
        ))}
      </div>
      <p className="text-[12px] text-ink-soft">
        Marque as que você aceita. O robô avisa o cliente quando ele pergunta.
      </p>
    </div>
  );
}

/** Chip-checkbox de uma forma de pagamento (mesmo visual do chip de serviço da Equipe). */
function FormaChip({
  label,
  marcada,
  onToggle,
}: {
  label: string;
  marcada: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={marcada}
      onClick={onToggle}
      className={cn(
        'flex min-h-9 items-center gap-1.5 rounded-full border-[1.5px] px-3 py-1.5 text-left font-display text-[13px] font-semibold outline-none transition-colors focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-1 focus-visible:ring-offset-brand-soft',
        marcada
          ? 'border-brand bg-brand text-bg'
          : 'border-line-strong bg-surface text-ink hover:bg-surface-hover',
      )}
    >
      <span
        aria-hidden
        className={cn(
          'flex size-[15px] shrink-0 items-center justify-center rounded-full border',
          marcada ? 'border-bg/60 bg-bg/15' : 'border-line-strong',
        )}
      >
        {marcada && <IconCheck size={11} />}
      </span>
      <span className="truncate">{label}</span>
    </button>
  );
}

/** Campo de texto multi-linha (Endereço) no padrão visual do Input. */
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
