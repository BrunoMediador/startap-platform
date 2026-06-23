'use client';

/**
 * Equipe (Fatia 1 do painel de estabelecimento). Só aparece pro DONO de
 * estabelecimento (gating na nav por product_type; defesa em profundidade no
 * backend: rota responde 404/409 fora do estabelecimento). O dono LISTA / ADICIONA
 * / EDITA / REMOVE colaboradores (nome, serviços, ativo) e vê o uso de vagas
 * (seat_cap). NÃO gerencia agenda/calendarId (assistido pelo operador, ADR 0024).
 *
 * Defesa extra no client: se um INDIVIDUAL chegar nesta rota (ex.: link direto), a
 * página mostra "recurso indisponível" em vez de tentar a API — productType vem da
 * sessão (useTenant). O backend ainda assim recusa (404/409); isto é só UX.
 *
 * UX: padrão da tela /servicos — lista editável com EditRow/ReadRow + ConfirmDialog
 * + Toast. As mutations invalidam a lista (o backend é a fonte de verdade do
 * seat_cap/uso), não editam o cache otimista — assim o card de vagas nunca diverge.
 */
import { IconPlus, IconTrash, IconUser, IconUsers } from '@/components/icons';
import { useTenant } from '@/components/shell/session-context';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { Input } from '@/components/ui/input';
import { PageHead } from '@/components/ui/page-head';
import { SkeletonList } from '@/components/ui/skeleton';
import { EmptyState, ErrorState } from '@/components/ui/states';
import { Switch } from '@/components/ui/switch';
import { useToast } from '@/components/ui/toast';
import { ApiError } from '@/lib/api';
import type { Colaborador } from '@/lib/api-types';
import { type Draft, type FieldErrors, toDraft, validate } from '@/lib/equipe';
import {
  useCreateColaborador,
  useEquipe,
  useRemoveColaborador,
  useUpdateColaborador,
} from '@/lib/queries';
import { useState } from 'react';

const EMPTY_DRAFT: Draft = { nome: '', servicos: '', ativo: true, comissao: '' };

/** Extrai a mensagem amigável de um ApiError (409 seat_cap/homônimo) ou um fallback. */
function errMsg(e: unknown, fallback: string): string {
  if (e instanceof ApiError && e.body && typeof e.body === 'object' && 'error' in e.body) {
    const m = (e.body as { error?: unknown }).error;
    if (typeof m === 'string' && m) return m;
  }
  return fallback;
}

export default function EquipePage() {
  const { slot, productType, seatCap } = useTenant();
  const toast = useToast();
  const equipeQ = useEquipe(slot);
  const create = useCreateColaborador(slot);
  const update = useUpdateColaborador(slot);
  const remove = useRemoveColaborador(slot);

  const [editing, setEditing] = useState<number | 'new' | null>(null);
  const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT);
  const [errors, setErrors] = useState<FieldErrors>({});
  const [removeTarget, setRemoveTarget] = useState<Colaborador | null>(null);

  // Defesa de UX: individual não tem painel de equipe (o backend recusa de toda
  // forma). Mostra estado claro em vez de bater na API e levar 409.
  if (productType !== 'estabelecimento') {
    return (
      <>
        <PageHead title="Equipe" subtitle="Gerencie os profissionais do seu estabelecimento." />
        <EmptyState
          icon={<IconUsers size={26} />}
          title="Recurso indisponível"
          description="A gestão de equipe está disponível apenas para contas de estabelecimento. Fale com o suporte para saber mais."
        />
      </>
    );
  }

  const colaboradores = equipeQ.data?.colaboradores ?? [];
  const usados = equipeQ.data?.usados ?? 0;
  const cap = equipeQ.data?.seat_cap ?? seatCap;
  const semVaga = cap !== null && usados >= cap;

  function startEdit(c: Colaborador) {
    setEditing(c.id);
    setDraft(toDraft(c));
    setErrors({});
  }
  function startAdd() {
    setEditing('new');
    setDraft(EMPTY_DRAFT);
    setErrors({});
  }
  function cancel() {
    setEditing(null);
    setErrors({});
  }

  function onSave() {
    const res = validate(draft);
    if (!res.ok) {
      setErrors(res.errors);
      return;
    }
    if (editing === 'new') {
      create.mutate(
        {
          nome: res.value.nome,
          servicos: res.value.servicos,
          ativo: res.value.ativo,
          comissao_pct: res.value.comissao_pct,
        },
        {
          onSuccess: () => {
            toast.success('Profissional adicionado');
            setEditing(null);
          },
          onError: (e) => toast.error(errMsg(e, 'Não foi possível adicionar. Tente de novo.')),
        },
      );
    } else if (typeof editing === 'number') {
      update.mutate(
        {
          id: editing,
          patch: {
            nome: res.value.nome,
            servicos: res.value.servicos,
            ativo: res.value.ativo,
            comissao_pct: res.value.comissao_pct,
          },
        },
        {
          onSuccess: () => {
            toast.success('Profissional atualizado');
            setEditing(null);
          },
          onError: (e) => toast.error(errMsg(e, 'Não foi possível salvar. Tente de novo.')),
        },
      );
    }
  }

  /** Toggle ativo/inativo direto da linha (sem abrir o editor). */
  function toggleAtivo(c: Colaborador) {
    update.mutate(
      { id: c.id, patch: { ativo: !c.ativo } },
      {
        onSuccess: () =>
          toast.success(c.ativo ? 'Profissional desativado' : 'Profissional ativado'),
        onError: (e) => toast.error(errMsg(e, 'Não foi possível alterar. Tente de novo.')),
      },
    );
  }

  function confirmRemove() {
    if (!removeTarget) return;
    const target = removeTarget;
    setRemoveTarget(null);
    remove.mutate(target.id, {
      onSuccess: () => toast.success('Profissional removido'),
      onError: (e) => toast.error(errMsg(e, 'Não foi possível remover. Tente de novo.')),
    });
  }

  const saving = create.isPending || update.isPending;

  return (
    <>
      <PageHead
        title="Equipe"
        subtitle="Os profissionais do seu estabelecimento. O robô usa essa lista pra agendar com cada um."
      />

      {/* Card de vagas (read-only): X de Y vagas em uso. Sem upsell self-service
          (seat_cap é teto contratual — mudar faixa é decisão do operador). */}
      {cap !== null && (
        <div className="mb-4 flex items-center gap-3.5 rounded-card border border-line bg-surface p-4 shadow-card">
          <span className="flex size-10 shrink-0 items-center justify-center rounded-[11px] bg-brand-soft text-brand">
            <IconUsers size={20} />
          </span>
          <div className="min-w-0 flex-1">
            <div className="font-display text-[15px] font-semibold text-ink">
              {usados} de {cap} {cap === 1 ? 'vaga' : 'vagas'} em uso
            </div>
            <p className="mt-0.5 text-[12.5px] text-ink-soft">
              {semVaga
                ? 'Você atingiu o limite do plano. Desative um profissional ou fale com o suporte para aumentar.'
                : 'Cada profissional ativo ocupa uma vaga do seu plano.'}
            </p>
          </div>
        </div>
      )}

      {equipeQ.isPending ? (
        <>
          <span className="sr-only">Carregando sua equipe…</span>
          <SkeletonList rows={3} />
        </>
      ) : equipeQ.isError ? (
        <ErrorState onRetry={() => equipeQ.refetch()} />
      ) : colaboradores.length === 0 && editing !== 'new' ? (
        <EmptyState
          icon={<IconUsers size={26} />}
          title="Nenhum profissional cadastrado"
          description="Adicione os profissionais do seu estabelecimento. O robô usa essa lista pra agendar atendimentos com cada um."
          action={{ label: 'Adicionar profissional', onClick: startAdd }}
        />
      ) : (
        <>
          <div className="stagger stagger-2 mb-3.5 overflow-hidden rounded-card border border-line bg-surface shadow-card">
            {colaboradores.map((c) =>
              editing === c.id ? (
                <EditRow
                  key={`row-${c.id}`}
                  draft={draft}
                  errors={errors}
                  onChange={setDraft}
                  onSave={onSave}
                  onCancel={cancel}
                  saving={saving}
                />
              ) : (
                <ReadRow
                  key={`row-${c.id}`}
                  colaborador={c}
                  onEdit={() => startEdit(c)}
                  onToggle={() => toggleAtivo(c)}
                  onDelete={() => setRemoveTarget(c)}
                  toggling={update.isPending}
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
                saving={saving}
              />
            )}
          </div>

          {editing !== 'new' && (
            <button
              type="button"
              onClick={startAdd}
              disabled={semVaga}
              className="flex h-[52px] w-full items-center justify-center gap-2 rounded-card border-[1.5px] border-dashed border-line-strong bg-surface font-display text-[15px] font-semibold text-brand outline-none transition-colors hover:border-brand hover:bg-surface-hover focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-2 focus-visible:ring-offset-bg disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:border-line-strong disabled:hover:bg-surface"
            >
              <IconPlus size={20} />
              Adicionar profissional
            </button>
          )}
        </>
      )}

      <ConfirmDialog
        open={removeTarget !== null}
        title={removeTarget ? `Remover "${removeTarget.nome}"?` : 'Remover profissional?'}
        description="O robô deixa de agendar com esse profissional. Você pode adicioná-lo de novo depois."
        confirmLabel="Remover"
        confirmVariant="destructive"
        loading={remove.isPending}
        onConfirm={confirmRemove}
        onCancel={() => setRemoveTarget(null)}
      />
    </>
  );
}

function ReadRow({
  colaborador,
  onEdit,
  onToggle,
  onDelete,
  toggling,
}: {
  colaborador: Colaborador;
  onEdit: () => void;
  onToggle: () => void;
  onDelete: () => void;
  toggling: boolean;
}) {
  const servicos = colaborador.servicos;
  return (
    <div className="group flex min-h-16 items-center gap-3.5 border-b border-line-soft p-[15px] transition-colors last:border-b-0 hover:bg-surface-hover active:bg-surface-hover">
      <span className="flex size-10 shrink-0 items-center justify-center rounded-[11px] bg-brand-soft text-brand">
        <IconUser size={20} />
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate font-display text-[15px] font-semibold text-ink">
            {colaborador.nome}
          </span>
          {colaborador.ativo ? <Badge tone="ok">Ativo</Badge> : <Badge tone="warn">Inativo</Badge>}
        </div>
        <div className="mt-0.5 truncate text-[12.5px] text-ink-soft">
          {servicos.length > 0 ? servicos.join(' · ') : 'Atende todos os serviços'}
          {colaborador.comissao_pct > 0 && ` · ${colaborador.comissao_pct}% comissão`}
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-1.5">
        <Switch
          checked={colaborador.ativo}
          onChange={onToggle}
          disabled={toggling}
          label={`${colaborador.ativo ? 'Desativar' : 'Ativar'} ${colaborador.nome}`}
        />
        <div className="flex items-center gap-2 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100 max-md:opacity-100">
          <button
            type="button"
            aria-label={`Editar ${colaborador.nome}`}
            onClick={onEdit}
            className="flex size-11 items-center justify-center rounded-[11px] border border-line-strong text-ink-soft outline-none transition-[color,background-color] hover:bg-surface-elev-hover hover:text-brand focus-visible:ring-2 focus-visible:ring-brand"
          >
            <IconUser size={18} />
            <span className="sr-only">Editar</span>
          </button>
          <button
            type="button"
            aria-label={`Remover ${colaborador.nome}`}
            onClick={onDelete}
            className="flex size-11 items-center justify-center rounded-[11px] border border-line-strong text-ink-soft outline-none transition-[color,background-color] hover:border-danger/60 hover:bg-danger/12 hover:text-danger focus-visible:ring-2 focus-visible:ring-danger"
          >
            <IconTrash size={18} />
          </button>
        </div>
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
        {isNew ? 'Novo profissional' : 'Editando profissional'}
      </span>
      <Input
        label="Nome do profissional"
        value={draft.nome}
        error={errors.nome}
        onChange={(e) => onChange({ ...draft, nome: e.target.value })}
        autoFocus
      />
      <Input
        label="Serviços que faz (separe por vírgula)"
        placeholder="Ex.: Corte, Barba"
        value={draft.servicos}
        onChange={(e) => onChange({ ...draft, servicos: e.target.value })}
      />
      <p className="-mt-1 text-[12px] text-ink-soft">
        Deixe em branco se ele atende todos os serviços.
      </p>
      <Input
        label="% de comissão (sobre o valor do atendimento)"
        type="text"
        inputMode="decimal"
        suffix="%"
        placeholder="0"
        value={draft.comissao}
        error={errors.comissao}
        onChange={(e) => onChange({ ...draft, comissao: e.target.value })}
      />
      <p className="-mt-1 text-[12px] text-ink-soft">
        Usada nos relatórios de comissão. Deixe 0 se não houver comissão.
      </p>
      {/* Switch é auto-rotulado (aria-label próprio); o <span> só dá contexto
          visual. Não usamos <label> (sem controle nativo dentro) — mesmo padrão
          da tela /horarios. */}
      <div className="flex items-center justify-between gap-3 rounded-field border border-line-strong bg-surface-sunken px-3.5 py-2.5">
        <span className="text-[13px] font-semibold text-ink">Profissional ativo</span>
        <Switch
          checked={draft.ativo}
          onChange={(ativo) => onChange({ ...draft, ativo })}
          label="Profissional ativo"
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
