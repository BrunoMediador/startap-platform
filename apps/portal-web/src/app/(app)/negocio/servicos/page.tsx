'use client';

import { IconAlert, IconPencil, IconPlus, IconScissors, IconTrash } from '@/components/icons';
import { useTenant } from '@/components/shell/session-context';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { Input } from '@/components/ui/input';
import { SkeletonList } from '@/components/ui/skeleton';
import { EmptyState, ErrorState } from '@/components/ui/states';
import { useToast } from '@/components/ui/toast';
import type { Servico } from '@/lib/api-types';
import { formatDuracao, formatPrecoCents } from '@/lib/format';
import { qk, useSaveServicos, useServicos } from '@/lib/queries';
import {
  type ConflitoPersona,
  type Draft,
  type FieldErrors,
  isConflitoPersona,
  isValidacaoIndisponivel,
  toDraft,
  validate,
} from '@/lib/servicos';
/**
 * Serviços (spec 6.7 + 3.3). Lista editavel: nome · duracao · preco. PUT envia o
 * array INTEIRO (contrato /portal/servicos).
 *
 * Salvamento de ADD/EDIÇÃO é PESSIMISTA (ADR 0035 §D6): o backend pode rodar uma
 * validação cruzada serviço↔persona (flag SERVICO_VALIDACAO_CRUZADA_ENABLED, hoje
 * OFF em prod) que bloqueia com 409 quando o mesmo preço já está no texto do
 * assistente. Com save otimista o item apareceria na lista e sumiria 1-2s depois
 * — o "sumiu sozinho" que a SCRUM-158 combateu. Por isso o item só entra no cache
 * em onSuccess; enquanto pende, o botão mostra "Verificando…".
 *
 * REMOÇÃO continua OTIMISTA — deletar nunca aciona a validação (não há preço novo
 * pra conflitar) e reverte ao snapshot em qualquer erro, como antes.
 *
 * Tratamento de erro do save pessimista (§D6/§D2):
 *   409 conflito_persona -> PERMANENTE. Erro fica INLINE no EditRow (não é toast —
 *     o dono precisa ler a frase citada da persona e decidir o que fazer), o editor
 *     continua aberto com os dados dele intactos.
 *   503 validacao_indisponivel -> RETRIABLE. Toast com ação "Tentar de novo", editor
 *     continua aberto, nada no campo é marcado como inválido.
 *   qualquer outro erro -> toast genérico de sempre.
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
  // 409 conflito_persona do save em curso (ADR 0035 §D6) — some ao editar de novo.
  const [conflito, setConflito] = useState<ConflitoPersona | null>(null);

  const servicos = servicosQ.data ?? [];

  function startEdit(idx: number) {
    setEditing(idx);
    setDraft(toDraft(servicos[idx]));
    setErrors({});
    setConflito(null);
  }
  function startAdd() {
    setEditing('new');
    setDraft({ nome: '', duracao: '', preco: '' });
    setErrors({});
    setConflito(null);
  }
  function cancel() {
    setEditing(null);
    setErrors({});
    setConflito(null);
  }

  /**
   * Add/edição: PESSIMISTA (§D6). Só entra no cache em onSuccess — o editor some
   * só quando o save de fato passou. Em erro, o editor CONTINUA ABERTO com o draft
   * intacto (nunca beco sem saída): 409 vira erro inline citando a persona, 503
   * vira toast retriable, qualquer outro erro cai no toast genérico de sempre.
   */
  function commitPessimista(next: Servico[], successMsg: string) {
    setConflito(null);
    save.mutate(next, {
      onSuccess: () => {
        client.setQueryData(qk.servicos(slot), next);
        setEditing(null);
        toast.success(successMsg);
      },
      onError: (err) => {
        const conflitoPersona = isConflitoPersona(err);
        if (conflitoPersona) {
          setConflito(conflitoPersona);
          return;
        }
        if (isValidacaoIndisponivel(err)) {
          toast.error('Não consegui validar agora. Tente de novo em instantes.', {
            label: 'Tentar de novo',
            onClick: () => commitPessimista(next, successMsg),
          });
          return;
        }
        toast.error('Não foi possível salvar. Tente de novo.');
      },
    });
  }

  /** Remoção: continua OTIMISTA — nunca aciona a validação cruzada (§D6). */
  function commitRemocaoOtimista(next: Servico[], successMsg: string) {
    const prev = client.getQueryData<Servico[]>(qk.servicos(slot)) ?? servicos;
    client.setQueryData(qk.servicos(slot), next);
    save.mutate(next, {
      onSuccess: () => toast.success(successMsg),
      onError: () => {
        client.setQueryData(qk.servicos(slot), prev); // revert
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
      commitPessimista([...servicos, res.value], 'Serviços atualizados');
    } else if (typeof editing === 'number') {
      const next = servicos.map((s, i) => (i === editing ? res.value : s));
      commitPessimista(next, 'Serviços atualizados');
    }
  }

  function confirmRemove() {
    if (removeIdx === null) return;
    const next = servicos.filter((_, i) => i !== removeIdx);
    setRemoveIdx(null);
    commitRemocaoOtimista(next, 'Serviço removido');
  }

  return (
    <>
      <p className="mb-4 text-[13.5px] leading-snug text-ink-soft">
        O que sua barbearia oferece e por quanto. O assistente usa essa lista pra agendar.
      </p>

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
          description="Adicione os serviços que o assistente pode agendar. O assistente usa essa lista pra marcar atendimentos no WhatsApp."
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
                  conflito={conflito}
                  onChange={(d) => {
                    setConflito(null); // stale: dono já está corrigindo
                    setDraft(d);
                  }}
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
                conflito={conflito}
                onChange={(d) => {
                  setConflito(null);
                  setDraft(d);
                }}
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
        description="O assistente deixa de oferecer esse serviço. Você pode adicioná-lo de novo depois."
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
  conflito,
  onChange,
  onSave,
  onCancel,
  saving,
  isNew,
}: {
  draft: Draft;
  errors: FieldErrors;
  conflito?: ConflitoPersona | null;
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
      {conflito && <ConflitoPersonaAlerta conflito={conflito} />}
      <div className="flex gap-2.5">
        <Button variant="secondary" size="inline" onClick={onCancel} disabled={saving}>
          Cancelar
        </Button>
        <Button
          size="inline"
          className="flex-1"
          loading={saving}
          loadingLabel="Verificando…"
          onClick={onSave}
        >
          Salvar
        </Button>
      </div>
    </div>
  );
}

/**
 * 409 conflito_persona (ADR 0035 §D2/§D6): o preço deste serviço já está escrito
 * no texto do assistente. Mostra a frase EXATA citada da persona (aspas +
 * destaque, não é "mensagem de erro" — é texto que o próprio dono escreveu) e o
 * porquê, com saída clara pro dono resolver (editar o texto do assistente ou
 * ajustar este serviço) sem ficar travado.
 */
function ConflitoPersonaAlerta({ conflito }: { conflito: ConflitoPersona }) {
  return (
    <div className="rounded-card-sm border border-danger/40 bg-danger-soft p-3.5" role="alert">
      <div className="flex items-start gap-2.5">
        <span className="mt-[1px] flex size-6 shrink-0 items-center justify-center rounded-full bg-danger text-white">
          <IconAlert size={14} />
        </span>
        <div className="min-w-0 flex-1">
          <h3 className="font-display text-[13.5px] font-semibold text-danger">
            Preço já está no texto do assistente
          </h3>
          <p className="mt-1 text-[13px] leading-snug text-ink-soft">{conflito.mensagem}</p>
          <blockquote className="mt-2 rounded-field border border-danger/30 bg-surface px-3 py-2 text-[13px] italic leading-snug text-ink">
            “{conflito.trecho}”
          </blockquote>
        </div>
      </div>
    </div>
  );
}
