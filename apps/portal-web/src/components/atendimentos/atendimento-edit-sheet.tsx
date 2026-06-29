'use client';

/**
 * Detalhe + edição de uma linha de atendimento DERIVADA da agenda (ADR 0027 Fase
 * C). Bottom-sheet no mobile / painel lateral direito no desktop (Overlay
 * variant="detail"). O dono:
 *
 *   - EDITA valor / forma de pagamento / serviço / cliente -> PATCH (otimismo +
 *     invalidação). Após editar, a Row volta com `dirty_fields` -> a lista mostra o
 *     badge "Editado" (sticky). Editar ≠ excluir: a linha CONTINUA contando, só com
 *     o valor novo.
 *   - REMOVE a linha (o atendimento não rolou) -> DELETE com ConfirmDialog -> some
 *     da lista (soft-delete no backend).
 *
 * Só envia no PATCH o que MUDOU (validateEdit monta o body mínimo) e trava o
 * "Salvar" quando nada mudou (patchVazio). 'pacote' zera o valor (campo trava em
 * R$0). Erros tratados aqui: 400 (toast "confira os campos"), 404 (linha sumiu /
 * flag off -> fecha com aviso). O endpoint do backend está em construção em
 * paralelo; até live, a UI degrada com toast amigável sem travar.
 */
import { IconClock, IconTrash, IconUser, IconX } from '@/components/icons';
import { useTenantTz } from '@/components/shell/tenant-tz-context';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { Input } from '@/components/ui/input';
import { Overlay } from '@/components/ui/overlay';
import { useToast } from '@/components/ui/toast';
import { ApiError } from '@/lib/api';
import type {
  AtendimentoBalde,
  AtendimentoBaldeRow,
  FormaPagamento,
  Servico,
} from '@/lib/api-types';
import { FORMAS_PAGAMENTO } from '@/lib/atendimento';
import {
  type EditDraft,
  type EditFieldErrors,
  clienteLabel,
  draftFromRow,
  patchVazio,
  profissionalLabel,
  rowBadge,
  validateEdit,
} from '@/lib/atendimentos-balde';
import { cn } from '@/lib/cn';
import { formatAgendamentoDia, formatAgendamentoHora } from '@/lib/format';
import { useEditarAtendimento, useRemoverAtendimento, useServicos } from '@/lib/queries';
import { useEffect, useId, useState } from 'react';

function is404(err: unknown): boolean {
  return err instanceof ApiError && err.status === 404;
}

export function AtendimentoEditSheet({
  slot,
  balde,
  de,
  ate,
  row,
  onClose,
  /** Notifica a página quando a linha sumiu (404/flag off) pra exibir indisponível. */
  onFlagOff,
}: {
  slot: string;
  balde: AtendimentoBalde;
  de: string;
  ate: string;
  /** Linha em foco. null = fechado. */
  row: AtendimentoBaldeRow | null;
  onClose: () => void;
  onFlagOff: () => void;
}) {
  const titleId = useId();
  const tz = useTenantTz();
  const toast = useToast();
  const editar = useEditarAtendimento(slot, balde, de, ate);
  const remover = useRemoverAtendimento(slot, balde, de, ate);
  // Catálogo do clone pra trocar o serviço por SELEÇÃO (evita digitar errado um
  // nome que já existe). Cache quente — a lista de atendimentos já vive ao lado.
  const servicosQ = useServicos(slot);

  const [draft, setDraft] = useState<EditDraft | null>(null);
  const [errors, setErrors] = useState<EditFieldErrors>({});
  const [confirmarRemover, setConfirmarRemover] = useState(false);

  // Recarrega o rascunho sempre que a linha em foco muda (abrir outra linha).
  // biome-ignore lint/correctness/useExhaustiveDependencies: rehidrata o draft ao trocar de linha (id), não a cada render da row
  useEffect(() => {
    setDraft(row ? draftFromRow(row) : null);
    setErrors({});
    setConfirmarRemover(false);
  }, [row?.id]);

  const open = row !== null;
  if (!open || !row || !draft) return null;

  const isPacote = draft.forma === 'pacote';

  function escolherForma(forma: FormaPagamento) {
    setDraft((d) => (d ? { ...d, forma, valor: forma === 'pacote' ? '' : d.valor } : d));
  }

  function fechar() {
    onClose();
  }

  function salvar() {
    if (!row || !draft) return;
    const res = validateEdit(row, draft);
    if (!res.ok) {
      setErrors(res.errors);
      return;
    }
    setErrors({});
    if (patchVazio(res.patch)) {
      // Nada mudou — botão já estaria travado, mas defende contra corrida.
      fechar();
      return;
    }
    editar.mutate(
      { id: row.id, patch: res.patch },
      {
        onSuccess: () => {
          toast.success('Atendimento atualizado');
          fechar();
        },
        onError: (err) => {
          if (is404(err)) {
            onFlagOff();
            toast.error('Esse atendimento não está mais disponível.');
            fechar();
            return;
          }
          if (err instanceof ApiError && err.status === 400) {
            toast.error('Confira os campos e tente de novo.');
            return;
          }
          toast.error('Não foi possível salvar agora. Tente de novo.');
        },
      },
    );
  }

  function removerLinha() {
    if (!row) return;
    remover.mutate(row.id, {
      onSuccess: () => {
        toast.success('Atendimento removido');
        fechar();
      },
      onError: (err) => {
        if (is404(err)) {
          // Já removido (ou flag off): o objetivo do dono foi alcançado.
          toast.success('Esse atendimento já não estava na lista.');
          fechar();
          return;
        }
        toast.error('Não foi possível remover agora. Tente de novo.');
      },
    });
  }

  // Trava o "Salvar" quando o rascunho atual não muda nada vs a Row.
  const resAtual = validateEdit(row, draft);
  const podeSalvar = resAtual.ok && !patchVazio(resAtual.patch);

  const badge = rowBadge(row);
  const dia = formatAgendamentoDia(row.inicio_at ?? row.data, undefined, tz);
  const hora = formatAgendamentoHora(row.inicio_at, tz);

  return (
    <>
      <Overlay open={open} onClose={fechar} variant="detail" ariaLabelledBy={titleId}>
        <div className="flex min-h-0 flex-1 flex-col px-5 pt-3.5">
          {/* Cabeçalho STICKY com botão Fechar (X) sempre presente: no mobile o sheet
              é alto (forma+valor+desconto+serviço+cliente) e o usuário não pode rolar
              e perder a referência/saída. -mx-5 px-5 faz o bg cobrir o conteúdo. */}
          <div className="sticky top-0 z-10 -mx-5 mb-3 flex items-center gap-2 bg-surface-elev px-5 pb-3 pt-[max(2px,env(safe-area-inset-top))]">
            <button
              type="button"
              onClick={fechar}
              aria-label="Fechar"
              className="flex size-9 shrink-0 items-center justify-center rounded-[10px] border border-line-strong bg-surface text-ink-soft outline-none transition-colors hover:bg-surface-hover hover:text-ink focus-visible:ring-2 focus-visible:ring-brand"
            >
              <IconX size={18} />
            </button>
            <h2 id={titleId} className="font-display text-[17px] font-semibold text-ink">
              Editar atendimento
            </h2>
            <span className="ml-auto">
              <BadgeOrigem badge={badge} />
            </span>
          </div>

          {/* Resumo read-only (cliente / dia·hora / profissional). */}
          <p className="font-display text-[19px] font-bold leading-tight tracking-[-0.01em] text-ink">
            {clienteLabel(row.cliente_nome)}
          </p>
          <dl className="mt-3 space-y-2.5">
            <LinhaInfo
              icon={<IconClock size={16} />}
              rotulo="Quando"
              valor={[dia, hora].filter(Boolean).join(' · ') || 'Sem data'}
            />
            {row.profissional_nome !== null && (
              <LinhaInfo
                icon={<IconUser size={16} />}
                rotulo="Profissional"
                valor={profissionalLabel(row.profissional_nome)}
              />
            )}
          </dl>

          {/* Forma de pagamento */}
          <section aria-labelledby="ed-forma" className="mt-5">
            <SectionTitle id="ed-forma">Forma de pagamento</SectionTitle>
            <div role="radiogroup" aria-label="Forma de pagamento" className="flex flex-wrap gap-2">
              {FORMAS_PAGAMENTO.map((f) => {
                const ativo = f.value === draft.forma;
                return (
                  <button
                    key={f.value}
                    type="button"
                    role="radio"
                    aria-checked={ativo}
                    onClick={() => escolherForma(f.value)}
                    className={cn(
                      'h-9 rounded-pill border px-3.5 font-display text-[13px] font-semibold outline-none transition-colors focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-2 focus-visible:ring-offset-bg',
                      ativo
                        ? 'border-brand bg-brand text-bg'
                        : 'border-line bg-surface text-ink hover:bg-surface-hover',
                    )}
                  >
                    {f.label}
                  </button>
                );
              })}
            </div>
          </section>

          {/* Valor + desconto */}
          <section aria-labelledby="ed-valor" className="mt-5 space-y-3">
            <SectionTitle id="ed-valor">Valor</SectionTitle>
            <Input
              label="Valor cobrado"
              type="text"
              inputMode="decimal"
              prefix="R$"
              placeholder="0,00"
              value={isPacote ? '0,00' : draft.valor}
              error={errors.valor}
              disabled={isPacote}
              onChange={(e) => setDraft((d) => (d ? { ...d, valor: e.target.value } : d))}
            />
            {isPacote && (
              <p className="-mt-1 rounded-card-sm border border-brand/40 bg-brand-soft px-3.5 py-2.5 text-[13px] font-medium text-brand">
                Coberto pelo pacote — entra como R$ 0,00.
              </p>
            )}
            <Input
              label="Desconto (opcional)"
              type="text"
              inputMode="decimal"
              prefix="R$"
              placeholder="0,00"
              value={draft.desconto}
              error={errors.desconto}
              onChange={(e) => setDraft((d) => (d ? { ...d, desconto: e.target.value } : d))}
            />
          </section>

          {/* Serviço + cliente */}
          <section aria-labelledby="ed-extra" className="mt-5 space-y-3">
            <SectionTitle id="ed-extra">Detalhes</SectionTitle>
            <ServicoField
              servicos={servicosQ.data ?? []}
              carregando={servicosQ.isPending}
              value={draft.servicoNome}
              onChange={(servicoNome) => setDraft((d) => (d ? { ...d, servicoNome } : d))}
            />
            <Input
              label="Cliente"
              placeholder="Quem foi atendido"
              autoComplete="off"
              value={draft.clienteNome}
              onChange={(e) => setDraft((d) => (d ? { ...d, clienteNome: e.target.value } : d))}
            />
          </section>

          {/* Ações: salvar (primária) + remover (destrutiva). */}
          <div className="mt-6 space-y-2.5">
            <Button
              disabled={!podeSalvar}
              loading={editar.isPending}
              loadingLabel="Salvando…"
              onClick={salvar}
            >
              Salvar alterações
            </Button>
            <Button variant="destructive" onClick={() => setConfirmarRemover(true)}>
              <IconTrash size={17} />
              Remover atendimento
            </Button>
          </div>
        </div>
      </Overlay>

      <ConfirmDialog
        open={confirmarRemover}
        title="Remover este atendimento?"
        description={`“${clienteLabel(row.cliente_nome)}” sai do seu faturamento. Use isso quando o atendimento não aconteceu — não dá pra desfazer.`}
        confirmLabel="Remover"
        cancelLabel="Voltar"
        confirmVariant="destructive"
        loading={remover.isPending}
        icon={<IconTrash size={22} />}
        onConfirm={removerLinha}
        onCancel={() => {
          if (!remover.isPending) setConfirmarRemover(false);
        }}
      />
    </>
  );
}

/** Sentinela do `<select>` que troca pro modo "digitar um serviço fora da lista". */
const SERVICO_OUTRO = '__outro__';

/**
 * Campo Serviço: SELEÇÃO do catálogo do clone (mesmo dado da tela Registrar e do
 * Novo agendamento) em vez de texto livre — evita digitar um nome que já existe e
 * não casar com o catálogo. Comportamento preservado:
 *   - catálogo vazio (ou ainda carregando sem dados) -> cai no input de texto, como antes;
 *   - serviço atual fora do catálogo (linha antiga / serviço removido) -> entra como
 *     opção "Manter: «valor»" pra NÃO se perder no save;
 *   - "Outro (digitar)" reabre o texto livre quando o dono quer um nome avulso.
 * Não mexe no Valor (diferente do Registrar): aqui o valor já foi lançado e é edição
 * independente — trocar o serviço não deve sobrescrever o dinheiro do dono.
 */
function ServicoField({
  servicos,
  carregando,
  value,
  onChange,
}: {
  servicos: Servico[];
  carregando: boolean;
  value: string;
  onChange: (servicoNome: string) => void;
}) {
  const id = useId();
  const trimmed = value.trim();
  const noCatalogo = servicos.some((s) => s.nome === trimmed);
  // Texto livre quando: não há catálogo, ou o dono optou por "Outro", ou o valor
  // atual está vazio e não há catálogo pra escolher.
  const [digitando, setDigitando] = useState(false);

  // Sem catálogo (vazio ou ainda sem dados) = comportamento antigo: texto livre.
  if (servicos.length === 0) {
    return (
      <Input
        label="Serviço"
        placeholder={carregando ? 'Carregando serviços…' : 'Ex.: Corte'}
        autoComplete="off"
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
    );
  }

  if (digitando) {
    return (
      <div className="flex w-full flex-col gap-[7px]">
        <Input
          label="Serviço"
          placeholder="Ex.: Corte"
          autoComplete="off"
          autoFocus
          value={value}
          onChange={(e) => onChange(e.target.value)}
        />
        <button
          type="button"
          onClick={() => setDigitando(false)}
          className="self-start text-[12.5px] font-semibold text-brand underline-offset-2 outline-none hover:underline focus-visible:underline"
        >
          Escolher da lista
        </button>
      </div>
    );
  }

  // Valor selecionado no <select>: o serviço do catálogo, ou o sentinela de
  // "manter o valor atual fora-do-catálogo" (string vazia também cai aqui).
  const selectValue = noCatalogo ? trimmed : `__keep__${trimmed}`;

  return (
    <div className="flex w-full flex-col gap-[7px]">
      <label htmlFor={id} className="text-[13px] font-semibold text-ink">
        Serviço
      </label>
      <select
        id={id}
        value={selectValue}
        onChange={(e) => {
          const v = e.target.value;
          if (v === SERVICO_OUTRO) {
            setDigitando(true);
            return;
          }
          // Opção "manter" devolve o valor original; serviço do catálogo, o nome dele.
          onChange(v.startsWith('__keep__') ? v.slice('__keep__'.length) : v);
        }}
        className="h-[46px] w-full cursor-pointer appearance-none rounded-field border-[1.5px] border-line-strong bg-surface-sunken px-3.5 text-[15px] text-ink outline-none transition-colors hover:border-[var(--c-input-hover-border)] focus:border-brand focus:ring-[3px] focus:ring-brand/35 focus:shadow-focus"
      >
        {/* Valor atual fora do catálogo (linha antiga ou serviço removido) ou vazio:
            opção no topo pra não perder o que já estava gravado. */}
        {!noCatalogo && (
          <option value={`__keep__${trimmed}`}>
            {trimmed === '' ? 'Sem serviço' : `Manter: ${trimmed}`}
          </option>
        )}
        {servicos.map((s) => (
          <option key={s.nome} value={s.nome}>
            {s.nome}
          </option>
        ))}
        <option value={SERVICO_OUTRO}>Outro (digitar)…</option>
      </select>
    </div>
  );
}

/** Badge da origem/edição — texto sempre presente (acessibilidade). */
function BadgeOrigem({ badge }: { badge: ReturnType<typeof rowBadge> }) {
  if (badge === 'editado') return <Badge tone="amber">Editado</Badge>;
  if (badge === 'manual') return <Badge tone="info">Manual</Badge>;
  return <Badge tone="ok">Auto</Badge>;
}

function SectionTitle({ id, children }: { id: string; children: React.ReactNode }) {
  return (
    <h3 id={id} className="mx-0.5 mb-2.5 font-display text-[13.5px] font-semibold text-ink">
      {children}
    </h3>
  );
}

function LinhaInfo({
  icon,
  rotulo,
  valor,
}: {
  icon: React.ReactNode;
  rotulo: string;
  valor: string;
}) {
  return (
    <div className="flex items-center gap-3">
      <span
        aria-hidden
        className="flex size-8 shrink-0 items-center justify-center rounded-[9px] border border-line-strong bg-brand-soft text-brand"
      >
        {icon}
      </span>
      <div className="min-w-0">
        <dt className="text-[11px] uppercase tracking-[0.04em] text-ink-faint">{rotulo}</dt>
        <dd className="font-display text-[14px] font-semibold text-ink">{valor}</dd>
      </div>
    </div>
  );
}
