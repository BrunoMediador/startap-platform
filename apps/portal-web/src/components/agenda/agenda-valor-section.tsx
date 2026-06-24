'use client';

/**
 * Seção "Valor" do card da agenda (itens 3/6 — ADR 0027 Fase C). Permite editar o
 * VALOR cobrado / DESCONTO / FORMA de pagamento direto do detalhe do agendamento,
 * refletindo no /billing automaticamente (a edição é STICKY — pina dirty_fields).
 *
 * GATING (defesa em camadas):
 *   - O pai só monta esta seção quando atend_from_agenda (flag do /auth/me) é true.
 *   - Aqui consultamos GET /portal/atendimentos/by-evento/:eventId. 404 = não há
 *     linha pra esse evento (clone individual / evento sem atendimento) -> a seção
 *     fica INVISÍVEL (return null). Só renderiza com 200 (linha existe).
 *
 * O save chama o MESMO PATCH /portal/atendimentos/:id do billing (useEditarAtendimento
 * PorEvento), NUNCA o PATCH de agendamento — assim o dinheiro entra pela rota que
 * pina dirty_fields e reflete nos dois lados. 'pacote' trava o valor em R$0 (e zera
 * desconto), respeitando o ADR 0027 (nunca dobra pacote / nunca R$0 espúrio).
 */
import { IconWallet } from '@/components/icons';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Skeleton, skeletonKeys } from '@/components/ui/skeleton';
import { useToast } from '@/components/ui/toast';
import { ApiError } from '@/lib/api';
import type { AtendimentoBaldeRow, FormaPagamento } from '@/lib/api-types';
import { FORMAS_PAGAMENTO } from '@/lib/atendimento';
import {
  type EditDraft,
  type EditFieldErrors,
  draftFromRow,
  patchVazio,
  rowBadge,
  validateEdit,
} from '@/lib/atendimentos-balde';
import { cn } from '@/lib/cn';
import { useAtendimentoByEvento, useEditarAtendimentoPorEvento } from '@/lib/queries';
import { useEffect, useId, useState } from 'react';

function is404(err: unknown): boolean {
  return err instanceof ApiError && err.status === 404;
}

export function AgendaValorSection({ slot, eventId }: { slot: string; eventId: string }) {
  const q = useAtendimentoByEvento(slot, eventId);

  // 404 (sem linha / individual fora do gate) ou erro -> a seção some por completo:
  // o card da agenda continua idêntico ao de hoje pros clones individuais.
  if (is404(q.error)) return null;

  if (q.isPending) {
    return (
      <section aria-labelledby="agv-titulo" className="mt-6">
        <Titulo />
        <span className="sr-only">Carregando o valor do atendimento…</span>
        <div aria-hidden className="space-y-2">
          {skeletonKeys(2).map((k) => (
            <Skeleton key={k} className="h-[50px] rounded-field" />
          ))}
        </div>
      </section>
    );
  }

  // Erro não-404 (rede/5xx): degrada silencioso — não trava o resto do card.
  if (q.isError || !q.data) return null;

  return <ValorForm slot={slot} eventId={eventId} row={q.data.atendimento} />;
}

function Titulo() {
  return (
    <div className="mb-3 flex items-center gap-2">
      <span
        aria-hidden
        className="flex size-8 shrink-0 items-center justify-center rounded-[9px] border border-line-strong bg-brand-soft text-brand"
      >
        <IconWallet size={16} />
      </span>
      <h3 id="agv-titulo" className="font-display text-[15px] font-semibold text-ink">
        Valor cobrado
      </h3>
    </div>
  );
}

function ValorForm({
  slot,
  eventId,
  row,
}: {
  slot: string;
  eventId: string;
  row: AtendimentoBaldeRow;
}) {
  const toast = useToast();
  const editar = useEditarAtendimentoPorEvento(slot, eventId);

  const [draft, setDraft] = useState<EditDraft>(() => draftFromRow(row));
  const [errors, setErrors] = useState<EditFieldErrors>({});

  // Re-hidrata o rascunho quando a linha muda (outro evento / refetch trouxe valor novo).
  // biome-ignore lint/correctness/useExhaustiveDependencies: rehidrata ao trocar de linha (id), não a cada render da row
  useEffect(() => {
    setDraft(draftFromRow(row));
    setErrors({});
  }, [row.id]);

  const isPacote = draft.forma === 'pacote';
  const badge = rowBadge(row);

  function escolherForma(forma: FormaPagamento) {
    // 'pacote' zera valor E desconto (ADR 0027 — nunca cobra por cima do pacote).
    setDraft((d) => ({
      ...d,
      forma,
      valor: forma === 'pacote' ? '' : d.valor,
      desconto: forma === 'pacote' ? '' : d.desconto,
    }));
  }

  function salvar() {
    const res = validateEdit(row, draft);
    if (!res.ok) {
      setErrors(res.errors);
      return;
    }
    setErrors({});
    if (patchVazio(res.patch)) return; // nada mudou — botão já estaria travado.
    editar.mutate(
      { id: row.id, patch: res.patch },
      {
        onSuccess: () => toast.success('Valor atualizado'),
        onError: (err) => {
          if (is404(err)) {
            toast.error('Esse atendimento não está mais disponível.');
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

  const resAtual = validateEdit(row, draft);
  const podeSalvar = resAtual.ok && !patchVazio(resAtual.patch);

  return (
    <section aria-labelledby="agv-titulo" className="mt-6">
      <div className="mb-3 flex items-center gap-2">
        <span
          aria-hidden
          className="flex size-8 shrink-0 items-center justify-center rounded-[9px] border border-line-strong bg-brand-soft text-brand"
        >
          <IconWallet size={16} />
        </span>
        <h3 id="agv-titulo" className="font-display text-[15px] font-semibold text-ink">
          Valor cobrado
        </h3>
        {badge === 'editado' && (
          <span className="ml-auto rounded-pill border border-amber/40 bg-amber-soft px-2 py-0.5 text-[11px] font-semibold text-amber">
            Editado
          </span>
        )}
      </div>

      {/* Forma de pagamento */}
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

      {/* Valor + desconto */}
      <div className="mt-3 space-y-3">
        <Input
          label="Valor cobrado"
          type="text"
          inputMode="decimal"
          prefix="R$"
          placeholder="0,00"
          value={isPacote ? '0,00' : draft.valor}
          error={errors.valor}
          disabled={isPacote}
          onChange={(e) => setDraft((d) => ({ ...d, valor: e.target.value }))}
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
          value={isPacote ? '' : draft.desconto}
          error={errors.desconto}
          disabled={isPacote}
          onChange={(e) => setDraft((d) => ({ ...d, desconto: e.target.value }))}
        />
      </div>

      <div className="mt-4">
        <Button
          variant="secondary"
          disabled={!podeSalvar}
          loading={editar.isPending}
          loadingLabel="Salvando…"
          onClick={salvar}
        >
          Salvar valor
        </Button>
      </div>
    </section>
  );
}
