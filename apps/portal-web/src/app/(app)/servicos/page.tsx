'use client';

import { IconPencil, IconPlus, IconScissors } from '@/components/icons';
import { useTenant } from '@/components/shell/session-context';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { Input } from '@/components/ui/input';
import { PageHead } from '@/components/ui/page-head';
import { SkeletonList } from '@/components/ui/skeleton';
import { EmptyState, ErrorState } from '@/components/ui/states';
import { useToast } from '@/components/ui/toast';
import type { Servico } from '@/lib/api-types';
import { formatDuracao, formatPrecoCents, parsePrecoToCents } from '@/lib/format';
import { qk, useSaveServicos, useServicos } from '@/lib/queries';
/**
 * Serviços (spec 6.7 + 3.3). Lista editavel: nome · duracao · preco. PUT envia o
 * array INTEIRO (contrato /portal/servicos). Salvamento OTIMISTA (D5): a UI
 * aplica na hora, dispara o PUT; sucesso -> toast "Serviços atualizados"; falha ->
 * reverte ao snapshot anterior + toast danger.
 *
 * Validacao no cliente espelha o servicoSchema do backend (nome>=1, duracao>0,
 * preco>=0) pra dar erro inline antes de bater na API.
 */
import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';

interface Draft {
  nome: string;
  duracao: string;
  preco: string;
}

interface FieldErrors {
  nome?: string;
  duracao?: string;
  preco?: string;
}

function toDraft(s: Servico): Draft {
  return {
    nome: s.nome,
    duracao: String(s.duracao_min),
    preco: (s.preco_cents / 100).toFixed(2).replace('.', ','),
  };
}

function validate(d: Draft): { ok: true; value: Servico } | { ok: false; errors: FieldErrors } {
  const errors: FieldErrors = {};
  const nome = d.nome.trim();
  if (nome.length === 0) errors.nome = 'Informe um nome para o serviço';
  const duracao = Number(d.duracao);
  if (!Number.isInteger(duracao) || duracao <= 0)
    errors.duracao = 'Duração deve ser maior que zero';
  const cents = parsePrecoToCents(d.preco);
  if (cents === null) errors.preco = 'Informe o preço';
  if (Object.keys(errors).length > 0) return { ok: false, errors };
  return { ok: true, value: { nome, duracao_min: duracao, preco_cents: cents as number } };
}

export default function ServicosPage() {
  const { slot } = useTenant();
  const toast = useToast();
  const client = useQueryClient();
  const servicosQ = useServicos(slot);
  const save = useSaveServicos(slot);

  // indice em edicao (ou 'new' pra linha nova). null = nenhum.
  const [editing, setEditing] = useState<number | 'new' | null>(null);
  const [draft, setDraft] = useState<Draft>({ nome: '', duracao: '', preco: '' });
  const [errors, setErrors] = useState<FieldErrors>({});
  const [removeIdx, setRemoveIdx] = useState<number | null>(null);

  const servicos = servicosQ.data ?? [];

  function startEdit(idx: number) {
    setEditing(idx);
    setDraft(toDraft(servicos[idx]));
    setErrors({});
  }
  function startAdd() {
    setEditing('new');
    setDraft({ nome: '', duracao: '', preco: '' });
    setErrors({});
  }
  function cancel() {
    setEditing(null);
    setErrors({});
  }

  /** Aplica `next` no cache na hora (otimista); reverte pro snapshot em falha. */
  function commit(next: Servico[], successMsg: string) {
    const prev = client.getQueryData<Servico[]>(qk.servicos(slot)) ?? servicos;
    client.setQueryData(qk.servicos(slot), next); // otimista — UI atualiza ja
    setEditing(null);
    save.mutate(next, {
      onSuccess: () => toast.success(successMsg),
      onError: () => {
        client.setQueryData(qk.servicos(slot), prev); // revert (D5)
        toast.error('Não foi possível salvar. Tente de novo.');
      },
    });
  }

  function onSave() {
    const res = validate(draft);
    if (!res.ok) {
      setErrors(res.errors);
      return;
    }
    if (editing === 'new') {
      commit([...servicos, res.value], 'Serviços atualizados');
    } else if (typeof editing === 'number') {
      const next = servicos.map((s, i) => (i === editing ? res.value : s));
      commit(next, 'Serviços atualizados');
    }
  }

  function confirmRemove() {
    if (removeIdx === null) return;
    const next = servicos.filter((_, i) => i !== removeIdx);
    setRemoveIdx(null);
    commit(next, 'Serviço removido');
  }

  return (
    <>
      <PageHead
        title="Serviços"
        subtitle="O que sua barbearia oferece e por quanto. O robô usa essa lista pra agendar."
      />

      {servicosQ.isPending ? (
        <>
          <span className="sr-only">Carregando seus serviços…</span>
          <SkeletonList rows={4} />
        </>
      ) : servicosQ.isError ? (
        <ErrorState onRetry={() => servicosQ.refetch()} />
      ) : servicos.length === 0 && editing !== 'new' ? (
        <EmptyState
          icon={<IconScissors size={48} />}
          title="Nenhum serviço cadastrado"
          description="Adicione os serviços que o robô pode agendar."
          action={{ label: 'Adicionar serviço', onClick: startAdd }}
        />
      ) : (
        <>
          <div className="mb-3.5 overflow-hidden rounded-card border border-line bg-surface">
            {servicos.map((s, idx) =>
              editing === idx ? (
                <EditRow
                  key={`row-${s.nome}`}
                  draft={draft}
                  errors={errors}
                  onChange={setDraft}
                  onSave={onSave}
                  onRemove={() => setRemoveIdx(idx)}
                  saving={save.isPending}
                />
              ) : (
                <ReadRow key={`row-${s.nome}`} servico={s} onEdit={() => startEdit(idx)} />
              ),
            )}
            {editing === 'new' && (
              <EditRow
                isNew
                draft={draft}
                errors={errors}
                onChange={setDraft}
                onSave={onSave}
                onCancel={cancel}
                saving={save.isPending}
              />
            )}
          </div>

          {editing !== 'new' && (
            <button
              type="button"
              onClick={startAdd}
              className="flex h-[52px] w-full items-center justify-center gap-2 rounded-card border-[1.5px] border-dashed border-line bg-surface font-display text-[15px] font-semibold text-brand outline-none transition-colors hover:border-brand hover:bg-brand-50 focus-visible:ring-2 focus-visible:ring-brand"
            >
              <IconPlus size={20} />
              Adicionar serviço
            </button>
          )}
        </>
      )}

      <ConfirmDialog
        open={removeIdx !== null}
        title={removeIdx !== null ? `Remover "${servicos[removeIdx]?.nome}"?` : 'Remover serviço?'}
        description="O robô deixa de oferecer esse serviço. Você pode adicioná-lo de novo depois."
        confirmLabel="Remover"
        confirmVariant="destructive"
        loading={save.isPending}
        onConfirm={confirmRemove}
        onCancel={() => setRemoveIdx(null)}
      />
    </>
  );
}

function ReadRow({ servico, onEdit }: { servico: Servico; onEdit: () => void }) {
  return (
    <div className="flex min-h-16 items-center gap-3.5 border-b border-line p-[15px] last:border-b-0">
      <span className="flex size-10 shrink-0 items-center justify-center rounded-[11px] bg-brand-50 text-brand">
        <IconScissors size={20} />
      </span>
      <div className="min-w-0 flex-1">
        <div className="font-display text-[15px] font-semibold text-ink">{servico.nome}</div>
        <div className="mt-0.5 text-[12.5px] text-ink-soft">
          <b className="font-semibold text-ink">{formatDuracao(servico.duracao_min)}</b> ·{' '}
          <b className="font-semibold text-ink">{formatPrecoCents(servico.preco_cents)}</b>
        </div>
      </div>
      <button
        type="button"
        aria-label={`Editar ${servico.nome}`}
        onClick={onEdit}
        className="flex size-11 shrink-0 items-center justify-center rounded-[11px] border border-line text-ink-soft outline-none transition-colors hover:border-transparent hover:bg-brand-50 hover:text-brand focus-visible:ring-2 focus-visible:ring-brand"
      >
        <IconPencil size={18} />
      </button>
    </div>
  );
}

function EditRow({
  draft,
  errors,
  onChange,
  onSave,
  onRemove,
  onCancel,
  saving,
  isNew,
}: {
  draft: Draft;
  errors: FieldErrors;
  onChange: (d: Draft) => void;
  onSave: () => void;
  onRemove?: () => void;
  onCancel?: () => void;
  saving: boolean;
  isNew?: boolean;
}) {
  return (
    <div className="flex animate-[rowIn_180ms_var(--ease-out-soft)] flex-col gap-3 border-b border-line bg-brand-50 p-[15px] last:border-b-0">
      <span className="font-display text-[12px] font-bold uppercase tracking-[0.06em] text-brand">
        {isNew ? 'Novo serviço' : 'Editando serviço'}
      </span>
      <Input
        label="Nome do serviço"
        value={draft.nome}
        error={errors.nome}
        onChange={(e) => onChange({ ...draft, nome: e.target.value })}
        autoFocus
      />
      <div className="grid grid-cols-2 gap-2.5">
        <Input
          label="Duração"
          type="number"
          inputMode="numeric"
          suffix="min"
          value={draft.duracao}
          error={errors.duracao}
          onChange={(e) => onChange({ ...draft, duracao: e.target.value })}
        />
        <Input
          label="Preço"
          inputMode="decimal"
          prefix="R$"
          value={draft.preco}
          error={errors.preco}
          onChange={(e) => onChange({ ...draft, preco: e.target.value })}
        />
      </div>
      <div className="flex gap-2.5">
        {isNew ? (
          <Button variant="secondary" size="inline" onClick={onCancel} disabled={saving}>
            Cancelar
          </Button>
        ) : (
          <Button variant="destructive" size="inline" onClick={onRemove} disabled={saving}>
            Remover
          </Button>
        )}
        <Button size="inline" className="flex-1" loading={saving} onClick={onSave}>
          Salvar
        </Button>
      </div>
    </div>
  );
}
