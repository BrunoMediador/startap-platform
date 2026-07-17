'use client';

/**
 * Registrar atendimento (App de gestão, Fase 1 — ADR 0026). O dono lança o
 * dinheiro de um atendimento feito (avulso ou coberto por pacote). É a fonte da
 * verdade do faturamento do cliente final, SEPARADA da nossa mensalidade B2B.
 *
 * Campos:
 *  - Profissional: SÓ no estabelecimento (EMPRESA). No SOLO, omite -> backend
 *    grava sem colaborador (sem comissão).
 *  - Serviço: radio dos /portal/servicos; escolher pré-preenche o Valor com o
 *    preço (editável). Pode lançar serviço "fora da lista" (texto livre).
 *  - Valor: input monetário obrigatório. forma='pacote' trava em R$0 (coberto).
 *  - Forma de pagamento: radios dinheiro/pix/crédito/débito/pacote/outro.
 *  - Desconto (recolhível) + Cliente (nome) + Data (default hoje).
 *
 * Gating: a página é gated pela flag atendimentos_enabled. Se a flag estiver OFF
 * (link direto ou rota acessada com a flag desligada), mostra "recurso
 * indisponível" antes de bater na API; um 404 do POST cai no mesmo estado.
 */
import { IconChevronLeft, IconWallet } from '@/components/icons';
import { useTenant } from '@/components/shell/session-context';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { SkeletonList } from '@/components/ui/skeleton';
import { EmptyState, ErrorState } from '@/components/ui/states';
import { useToast } from '@/components/ui/toast';
import { ApiError } from '@/lib/api';
import type { Colaborador, FormaPagamento, Servico } from '@/lib/api-types';
import {
  type Draft,
  FORMAS_PAGAMENTO,
  type FieldErrors,
  emptyDraft,
  validate,
} from '@/lib/atendimento';
import { cn } from '@/lib/cn';
import { formatDuracao, formatPrecoCents, toISODate } from '@/lib/format';
import { useCriarAtendimento, useEquipe, useServicos } from '@/lib/queries';
import Link from 'next/link';
import { useState } from 'react';

function is404(err: unknown): boolean {
  return err instanceof ApiError && err.status === 404;
}

export default function NovoAtendimentoPage() {
  const { slot, productType, atendimentosEnabled } = useTenant();
  const toast = useToast();
  const isEstabelecimento = productType === 'estabelecimento';

  const servicosQ = useServicos(slot);
  // Só busca a equipe quando é estabelecimento (no SOLO não há profissional a escolher).
  const equipeQ = useEquipe(isEstabelecimento ? slot : '');

  const [draft, setDraft] = useState<Draft>(() => emptyDraft(toISODate()));
  const [errors, setErrors] = useState<FieldErrors>({});
  const [mostrarDesconto, setMostrarDesconto] = useState(false);
  /** 404 no POST = flag desligada no backend; vira o estado "indisponível". */
  const [flagOff, setFlagOff] = useState(false);

  const criar = useCriarAtendimento(slot);

  // Gating em profundidade: flag OFF mostra "recurso indisponível" sem chamar a API.
  if (!atendimentosEnabled || flagOff) {
    return <Indisponivel />;
  }

  const servicos = servicosQ.data ?? [];
  const colaboradores = (equipeQ.data?.colaboradores ?? []).filter((c) => c.ativo);
  const isPacote = draft.forma === 'pacote';

  function escolherServico(s: Servico) {
    setDraft((d) => ({
      ...d,
      servicoNome: s.nome,
      // Pré-preenche o valor com o preço do serviço (editável). Não mexe no pacote.
      valor: d.forma === 'pacote' ? d.valor : formatValor(s.preco_cents),
    }));
  }

  function escolherForma(forma: FormaPagamento) {
    setDraft((d) => ({
      ...d,
      forma,
      // Ao virar pacote, limpa o valor (vai 0 no backend). Saindo do pacote, fica vazio.
      valor: forma === 'pacote' ? '' : d.valor,
    }));
  }

  function onSubmit() {
    const res = validate(draft);
    if (!res.ok) {
      setErrors(res.errors);
      return;
    }
    setErrors({});
    criar.mutate(res.value, {
      onSuccess: () => {
        toast.success('Atendimento registrado');
        // Limpa o form preservando data e forma (lançamento em sequência é comum).
        setDraft((d) => ({ ...emptyDraft(d.data), forma: d.forma }));
        setMostrarDesconto(false);
      },
      onError: (err) => {
        if (is404(err)) {
          setFlagOff(true);
          return;
        }
        if (err instanceof ApiError && err.status === 400) {
          toast.error('Confira os campos e tente de novo.');
          return;
        }
        toast.error('Não foi possível registrar. Tente de novo.');
      },
    });
  }

  return (
    <>
      <div className="mb-[18px] flex items-start gap-3">
        <Link
          href="/billing"
          aria-label="Voltar pro Faturamento"
          className="mt-0.5 flex size-11 shrink-0 items-center justify-center rounded-[11px] border border-line-strong bg-surface text-ink-soft outline-none transition-colors hover:bg-surface-hover hover:text-ink focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-2 focus-visible:ring-offset-bg"
        >
          <IconChevronLeft size={20} />
        </Link>
        <div>
          <h1 className="font-display text-[22px] font-bold tracking-[-0.01em] text-ink">
            Registrar atendimento
          </h1>
          <p className="mt-1 text-[13.5px] leading-snug text-ink-soft">
            Lance o valor de um atendimento feito. Entra no seu faturamento.
          </p>
        </div>
      </div>

      <div className="space-y-6">
        {/* 1. Profissional (só estabelecimento) */}
        {isEstabelecimento && (
          <section aria-labelledby="sec-profissional">
            <SectionTitle id="sec-profissional">Profissional</SectionTitle>
            {equipeQ.isPending ? (
              <SkeletonList rows={2} />
            ) : equipeQ.isError ? (
              <ErrorState
                title="Não foi possível carregar a equipe"
                onRetry={() => equipeQ.refetch()}
              />
            ) : colaboradores.length === 0 ? (
              <p className="mx-0.5 text-[13.5px] text-ink-soft">
                Nenhum profissional ativo. Cadastre um em Equipe pra calcular comissão — sem ele, o
                atendimento entra só no faturamento.
              </p>
            ) : (
              <ProfissionalRadioList
                colaboradores={colaboradores}
                selecionado={draft.colaboradorId}
                onPick={(id) => setDraft((d) => ({ ...d, colaboradorId: id }))}
              />
            )}
          </section>
        )}

        {/* 2. Serviço */}
        <section aria-labelledby="sec-servico">
          <SectionTitle id="sec-servico">Serviço</SectionTitle>
          {servicosQ.isPending ? (
            <SkeletonList rows={2} />
          ) : servicosQ.isError ? (
            <ErrorState
              title="Não foi possível carregar os serviços"
              onRetry={() => servicosQ.refetch()}
            />
          ) : servicos.length === 0 ? (
            <p className="mx-0.5 text-[13.5px] text-ink-soft">
              Você ainda não cadastrou serviços — sem problema, é só preencher o valor abaixo.
            </p>
          ) : (
            <ServicoRadioList
              servicos={servicos}
              selecionado={draft.servicoNome}
              onPick={escolherServico}
            />
          )}
        </section>

        {/* 3. Forma de pagamento */}
        <section aria-labelledby="sec-forma">
          <SectionTitle id="sec-forma">Forma de pagamento</SectionTitle>
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
                    'h-10 rounded-pill border px-4 font-display text-[13.5px] font-semibold outline-none transition-colors focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-2 focus-visible:ring-offset-bg',
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

        {/* 4. Valor */}
        <section aria-labelledby="sec-valor" className="space-y-3">
          <SectionTitle id="sec-valor">Valor</SectionTitle>
          <Input
            label="Valor do atendimento"
            hideLabel
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
              Coberto pelo pacote — o valor entra como R$ 0,00.
            </p>
          )}

          {/* Desconto recolhível (secundário, pra não poluir). */}
          {mostrarDesconto ? (
            <Input
              label="Desconto (opcional)"
              type="text"
              inputMode="decimal"
              prefix="R$"
              placeholder="0,00"
              value={draft.desconto}
              error={errors.desconto}
              onChange={(e) => setDraft((d) => ({ ...d, desconto: e.target.value }))}
            />
          ) : (
            <button
              type="button"
              onClick={() => setMostrarDesconto(true)}
              className="text-[13px] font-semibold text-brand underline-offset-2 outline-none hover:underline focus-visible:underline"
            >
              + Adicionar desconto
            </button>
          )}
        </section>

        {/* 5. Cliente + Data */}
        <section aria-labelledby="sec-extra" className="space-y-3">
          <SectionTitle id="sec-extra">Detalhes (opcional)</SectionTitle>
          <Input
            label="Cliente (nome)"
            placeholder="Quem foi atendido"
            autoComplete="off"
            value={draft.clienteNome}
            onChange={(e) => setDraft((d) => ({ ...d, clienteNome: e.target.value }))}
          />
          <Input
            label="Data"
            type="date"
            value={draft.data}
            error={errors.data}
            max={toISODate()}
            onChange={(e) => setDraft((d) => ({ ...d, data: e.target.value }))}
          />
        </section>

        <Button loading={criar.isPending} loadingLabel="Registrando…" onClick={onSubmit}>
          Registrar atendimento
        </Button>
      </div>
    </>
  );
}

/** "5000" centavos -> "50,00" pro input monetário. */
function formatValor(cents: number): string {
  return (cents / 100).toFixed(2).replace('.', ',');
}

function SectionTitle({ id, children }: { id: string; children: React.ReactNode }) {
  return (
    <h2 id={id} className="mx-0.5 mb-2.5 font-display text-[15px] font-semibold text-ink">
      {children}
    </h2>
  );
}

/** Radio inline de profissionais (estabelecimento). Mostra a comissão configurada. */
function ProfissionalRadioList({
  colaboradores,
  selecionado,
  onPick,
}: {
  colaboradores: Colaborador[];
  selecionado: number | null;
  onPick: (id: number) => void;
}) {
  return (
    <div
      role="radiogroup"
      aria-label="Escolha o profissional"
      className="overflow-hidden rounded-card border border-line bg-surface shadow-card"
    >
      {colaboradores.map((c) => {
        const ativo = c.id === selecionado;
        return (
          <button
            key={c.id}
            type="button"
            role="radio"
            aria-checked={ativo}
            onClick={() => onPick(c.id)}
            className={cn(
              'flex min-h-[52px] w-full items-center gap-3 border-b border-line-soft px-[15px] py-3 text-left outline-none transition-colors last:border-b-0 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand',
              ativo ? 'bg-brand-soft' : 'hover:bg-surface-hover',
            )}
          >
            <Bullet ativo={ativo} />
            <span
              className={cn(
                'min-w-0 flex-1 truncate font-display text-[15px] font-semibold',
                ativo ? 'text-brand' : 'text-ink',
              )}
            >
              {c.nome}
            </span>
            {c.comissao_pct > 0 && (
              <span className="shrink-0 text-[12.5px] text-ink-soft">
                {c.comissao_pct}% comissão
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}

/** Radio inline de serviços. Escolher pré-preenche o valor. */
function ServicoRadioList({
  servicos,
  selecionado,
  onPick,
}: {
  servicos: Servico[];
  selecionado: string;
  onPick: (s: Servico) => void;
}) {
  return (
    <div
      role="radiogroup"
      aria-label="Escolha o serviço"
      className="overflow-hidden rounded-card border border-line bg-surface shadow-card"
    >
      {servicos.map((s) => {
        const ativo = s.nome === selecionado;
        return (
          <button
            key={s.nome}
            type="button"
            role="radio"
            aria-checked={ativo}
            onClick={() => onPick(s)}
            className={cn(
              'flex min-h-[52px] w-full items-center gap-3 border-b border-line-soft px-[15px] py-3 text-left outline-none transition-colors last:border-b-0 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand',
              ativo ? 'bg-brand-soft' : 'hover:bg-surface-hover',
            )}
          >
            <Bullet ativo={ativo} />
            <span
              className={cn(
                'min-w-0 flex-1 truncate font-display text-[15px] font-semibold',
                ativo ? 'text-brand' : 'text-ink',
              )}
            >
              {s.nome}
            </span>
            <span className="shrink-0 text-[12.5px] text-ink-soft">
              {formatDuracao(s.duracao_min)} · {formatPrecoCents(s.preco_cents)}
            </span>
          </button>
        );
      })}
    </div>
  );
}

/** Bolinha de radio (selecionada/vazia), decorativa. */
function Bullet({ ativo }: { ativo: boolean }) {
  return (
    <span
      aria-hidden
      className={cn(
        'flex size-[18px] shrink-0 items-center justify-center rounded-full border-[1.5px]',
        ativo ? 'border-brand' : 'border-line-strong',
      )}
    >
      {ativo && <span className="size-2.5 rounded-full bg-brand" />}
    </span>
  );
}

/** Estado "recurso indisponível" (flag atendimentos OFF). */
function Indisponivel() {
  return (
    <>
      <div className="mb-[18px]">
        <h1 className="font-display text-[22px] font-bold tracking-[-0.01em] text-ink">
          Registrar atendimento
        </h1>
      </div>
      <EmptyState
        icon={<IconWallet size={26} />}
        title="Recurso indisponível"
        description="O registro de atendimentos ainda não está liberado pra sua conta. Fale com o suporte pra ativar."
      />
    </>
  );
}
