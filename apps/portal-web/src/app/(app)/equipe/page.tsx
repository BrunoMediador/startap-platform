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
import { IconCheck, IconPlus, IconTrash, IconUser, IconUsers } from '@/components/icons';
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
import { cn } from '@/lib/cn';
import {
  type Draft,
  type FieldErrors,
  isServicoMarcado,
  servicosOrfaos,
  toDraft,
  toggleServico,
  validate,
} from '@/lib/equipe';
import {
  useCreateColaborador,
  useEquipe,
  useRemoveColaborador,
  useServicos,
  useUpdateColaborador,
} from '@/lib/queries';
import { useState } from 'react';

const EMPTY_DRAFT: Draft = { nome: '', servicos: [], ativo: true, comissao: '' };

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
  // Catálogo de serviços EXISTENTES do clone: fonte do checklist (o dono só marca
  // o que já existe; não dá pra digitar serviço inexistente). Mesma query da tela
  // de novo agendamento (GET /portal/servicos), isolada por slot no cache.
  const servicosQ = useServicos(slot);
  const catalogo = (servicosQ.data ?? []).map((s) => s.nome);
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
                  catalogo={catalogo}
                  catalogoLoading={servicosQ.isPending}
                  catalogoError={servicosQ.isError}
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
                catalogo={catalogo}
                catalogoLoading={servicosQ.isPending}
                catalogoError={servicosQ.isError}
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
    <div className="group flex min-h-16 items-center gap-2.5 border-b border-line-soft p-3 transition-colors last:border-b-0 hover:bg-surface-hover active:bg-surface-hover sm:gap-3.5 sm:p-[15px]">
      <span className="flex size-9 shrink-0 items-center justify-center rounded-[11px] bg-brand-soft text-brand sm:size-10">
        <IconUser size={18} className="sm:hidden" />
        <IconUser size={20} className="max-sm:hidden" />
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-center gap-2">
          <span className="truncate font-display text-[14px] font-semibold text-ink sm:text-[15px]">
            {colaborador.nome}
          </span>
          <span className="shrink-0">
            {colaborador.ativo ? (
              <Badge tone="ok">Ativo</Badge>
            ) : (
              <Badge tone="warn">Inativo</Badge>
            )}
          </span>
        </div>
        <div className="mt-0.5 truncate text-[12px] text-ink-soft sm:text-[12.5px]">
          {servicos.length > 0 ? servicos.join(' · ') : 'Atende todos os serviços'}
          {colaborador.comissao_pct > 0 && ` · ${colaborador.comissao_pct}% comissão`}
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-1 sm:gap-1.5">
        <Switch
          checked={colaborador.ativo}
          onChange={onToggle}
          disabled={toggling}
          label={`${colaborador.ativo ? 'Desativar' : 'Ativar'} ${colaborador.nome}`}
        />
        <div className="flex items-center gap-1.5 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100 max-md:opacity-100 sm:gap-2">
          <button
            type="button"
            aria-label={`Editar ${colaborador.nome}`}
            onClick={onEdit}
            className="flex size-9 items-center justify-center rounded-[11px] border border-line-strong text-ink-soft outline-none transition-[color,background-color] hover:bg-surface-elev-hover hover:text-brand focus-visible:ring-2 focus-visible:ring-brand sm:size-11"
          >
            <IconUser size={18} />
            <span className="sr-only">Editar</span>
          </button>
          <button
            type="button"
            aria-label={`Remover ${colaborador.nome}`}
            onClick={onDelete}
            className="flex size-9 items-center justify-center rounded-[11px] border border-line-strong text-ink-soft outline-none transition-[color,background-color] hover:border-danger/60 hover:bg-danger/12 hover:text-danger focus-visible:ring-2 focus-visible:ring-danger sm:size-11"
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
  catalogo,
  catalogoLoading,
  catalogoError,
  onChange,
  onSave,
  onCancel,
  saving,
  isNew,
}: {
  draft: Draft;
  errors: FieldErrors;
  /** Nomes dos serviços EXISTENTES do clone (catálogo). Fonte do checklist. */
  catalogo: string[];
  catalogoLoading: boolean;
  catalogoError: boolean;
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
      <ServicosChecklist
        catalogo={catalogo}
        loading={catalogoLoading}
        error={catalogoError}
        selecionados={draft.servicos}
        onToggle={(nome) => onChange({ ...draft, servicos: toggleServico(draft.servicos, nome) })}
      />
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

/**
 * Checklist dos serviços EXISTENTES do clone. O dono marca quais o profissional
 * atende — não dá pra digitar serviço inexistente (o backend rejeita; aqui a UX já
 * impede). Nada marcado = atende todos (regra antiga preservada). Serviços já
 * marcados que não existem mais no catálogo (órfãos) seguem visíveis como chip
 * "removido" pra não sumir a config sozinha — o dono decide manter ou desmarcar.
 *
 * `role=group` + cada chip é um checkbox (`aria-checked`). Mobile-first: chips que
 * quebram linha (flex-wrap), alvo de toque ~36px.
 */
function ServicosChecklist({
  catalogo,
  loading,
  error,
  selecionados,
  onToggle,
}: {
  catalogo: string[];
  loading: boolean;
  error: boolean;
  selecionados: string[];
  onToggle: (nome: string) => void;
}) {
  const orfaos = servicosOrfaos(selecionados, catalogo);

  return (
    <div className="flex flex-col gap-2">
      <span className="font-display text-[13px] font-semibold text-ink">Serviços que faz</span>

      {loading ? (
        <p className="text-[12.5px] text-ink-soft">Carregando seus serviços…</p>
      ) : error ? (
        <p className="text-[12.5px] text-danger">
          Não foi possível carregar seus serviços. Salve o nome e tente de novo, ou ajuste os
          serviços depois.
        </p>
      ) : catalogo.length === 0 && orfaos.length === 0 ? (
        <p className="text-[12.5px] text-ink-soft">
          Você ainda não cadastrou serviços. Cadastre na tela{' '}
          <span className="font-semibold text-ink">Serviços</span> para escolher aqui — por
          enquanto, este profissional atende todos.
        </p>
      ) : (
        <div
          role="group"
          aria-label="Serviços que o profissional faz"
          className="flex flex-wrap gap-2"
        >
          {catalogo.map((nome) => (
            <ServicoChip
              key={`cat-${nome}`}
              nome={nome}
              marcado={isServicoMarcado(selecionados, nome)}
              onToggle={() => onToggle(nome)}
            />
          ))}
          {orfaos.map((nome) => (
            <ServicoChip
              key={`orf-${nome}`}
              nome={nome}
              marcado
              removido
              onToggle={() => onToggle(nome)}
            />
          ))}
        </div>
      )}

      <p className="text-[12px] text-ink-soft">
        Sem marcar nenhum = atende <span className="font-semibold text-ink">todos</span> os
        serviços.
      </p>
    </div>
  );
}

/** Chip-checkbox de um serviço. `removido` = marcado mas fora do catálogo atual. */
function ServicoChip({
  nome,
  marcado,
  removido,
  onToggle,
}: {
  nome: string;
  marcado: boolean;
  removido?: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={marcado}
      onClick={onToggle}
      className={cn(
        'flex min-h-9 items-center gap-1.5 rounded-full border-[1.5px] px-3 py-1.5 text-left font-display text-[13px] font-semibold outline-none transition-colors focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-1 focus-visible:ring-offset-brand-soft',
        marcado
          ? 'border-brand bg-brand text-bg'
          : 'border-line-strong bg-surface text-ink hover:bg-surface-hover',
        removido && 'border-dashed',
      )}
    >
      <span
        aria-hidden
        className={cn(
          'flex size-[15px] shrink-0 items-center justify-center rounded-full border',
          marcado ? 'border-bg/60 bg-bg/15' : 'border-line-strong',
        )}
      >
        {marcado && <IconCheck size={11} />}
      </span>
      <span className="truncate">{nome}</span>
      {removido && <span className="text-[11px] font-medium opacity-80">(removido)</span>}
    </button>
  );
}
