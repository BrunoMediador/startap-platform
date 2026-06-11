'use client';

import { IconPencil, IconPlus, IconScissors, IconTrash } from '@/components/icons';
import { useTenant } from '@/components/shell/session-context';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { Input } from '@/components/ui/input';
import { PageHead } from '@/components/ui/page-head';
import { SkeletonList } from '@/components/ui/skeleton';
import { EmptyState, ErrorState } from '@/components/ui/states';
import { useToast } from '@/components/ui/toast';
import type { Servico } from '@/lib/api-types';
import { formatDuracao, formatPrecoCents } from '@/lib/format';
import { qk, useSaveServicos, useServicos } from '@/lib/queries';
import { type Draft, type FieldErrors, toDraft, validate } from '@/lib/servicos';
/**
 * Serviços (spec 6.7 + 3.3). Lista editavel: nome · duracao · preco. PUT envia o
 * array INTEIRO (contrato /portal/servicos). Salvamento OTIMISTA (D5): a UI
 * aplica na hora, dispara o PUT; sucesso -> toast "Serviços atualizados"; falha ->
 * reverte ao snapshot anterior + toast danger.
 *
 * Leva 2 (item 3):
 *  - FORA do modo edicao, cada linha tem botao DELETAR (lixeira) com confirmacao
 *    (ConfirmDialog) — deletar = remover do array + PUT da lista nova.
 *  - No modo edicao inline, dois botoes claros: SALVAR (PUT) e CANCELAR (descarta
 *    as mudancas daquele item, volta ao valor original, SEM PUT). cancel() so
 *    fecha o editor; nada e enviado.
 *
 * Validacao no cliente espelha o servicoSchema do backend (nome>=1, duracao>0
 * e multiplo de 5 min, preco>=0) — vive em @/lib/servicos (testavel) e da erro
 * inline antes de bater na API.
 */
import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';

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
          icon={<IconScissors size={26} />}
          title="Nenhum serviço cadastrado"
          description="Adicione os serviços que o robô pode agendar. O robô usa essa lista pra marcar atendimentos no WhatsApp."
          action={{ label: 'Adicionar serviço', onClick: startAdd }}
        />
      ) : (
        <>
          <div className="stagger stagger-2 mb-3.5 overflow-hidden rounded-card border border-line bg-surface shadow-card">
            {servicos.map((s, idx) =>
              editing === idx ? (
                <EditRow
                  key={`row-${s.nome}`}
                  draft={draft}
                  errors={errors}
                  onChange={setDraft}
                  onSave={onSave}
                  onCancel={cancel}
                  saving={save.isPending}
                />
              ) : (
                <ReadRow
                  key={`row-${s.nome}`}
                  servico={s}
                  onEdit={() => startEdit(idx)}
                  onDelete={() => setRemoveIdx(idx)}
                />
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
              className="flex h-[52px] w-full items-center justify-center gap-2 rounded-card border-[1.5px] border-dashed border-line-strong bg-surface font-display text-[15px] font-semibold text-brand outline-none transition-colors hover:border-brand hover:bg-surface-hover focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-2 focus-visible:ring-offset-bg"
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

function ReadRow({
  servico,
  onEdit,
  onDelete,
}: {
  servico: Servico;
  onEdit: () => void;
  onDelete: () => void;
}) {
  // Linha de lista (spec 1.A.8): hover "acende" a linha inteira (surface-hover) +
  // revela editar/deletar (opacity-0 -> 100). No mobile, sempre visiveis.
  return (
    <div className="group flex min-h-16 items-center gap-3.5 border-b border-line-soft p-[15px] transition-colors last:border-b-0 hover:bg-surface-hover active:bg-surface-hover">
      <span className="flex size-10 shrink-0 items-center justify-center rounded-[11px] bg-brand-soft text-brand">
        <IconScissors size={20} />
      </span>
      <div className="min-w-0 flex-1">
        <div className="font-display text-[15px] font-semibold text-ink">{servico.nome}</div>
        <div className="mt-0.5 text-[12.5px] text-ink-soft">
          <b className="font-semibold text-ink">{formatDuracao(servico.duracao_min)}</b> ·{' '}
          <b className="font-semibold text-ink">{formatPrecoCents(servico.preco_cents)}</b>
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-2 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100 max-md:opacity-100">
        <button
          type="button"
          aria-label={`Editar ${servico.nome}`}
          onClick={onEdit}
          className="flex size-11 items-center justify-center rounded-[11px] border border-line-strong text-ink-soft outline-none transition-[color,background-color] hover:bg-surface-elev-hover hover:text-brand focus-visible:ring-2 focus-visible:ring-brand"
        >
          <IconPencil size={18} />
        </button>
        <button
          type="button"
          aria-label={`Remover ${servico.nome}`}
          onClick={onDelete}
          className="flex size-11 items-center justify-center rounded-[11px] border border-line-strong text-ink-soft outline-none transition-[color,background-color] hover:border-danger/60 hover:bg-danger/12 hover:text-danger focus-visible:ring-2 focus-visible:ring-danger"
        >
          <IconTrash size={18} />
        </button>
      </div>
    </div>
  );
}

function EditRow({
  draft,
  errors,
  onChange,
  onSave,
  onCancel,
  saving,
  isNew,
}: {
  draft: Draft;
  errors: FieldErrors;
  onChange: (d: Draft) => void;
  onSave: () => void;
  onCancel: () => void;
  saving: boolean;
  isNew?: boolean;
}) {
  return (
    <div className="flex animate-[rowIn_180ms_var(--ease-out-soft)] flex-col gap-3 border-b border-line-soft bg-brand-soft p-[15px] last:border-b-0">
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
          step={5}
          min={5}
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
        <Button variant="secondary" size="inline" onClick={onCancel} disabled={saving}>
          Cancelar
        </Button>
        <Button size="inline" className="flex-1" loading={saving} onClick={onSave}>
          Salvar
        </Button>
      </div>
    </div>
  );
}
