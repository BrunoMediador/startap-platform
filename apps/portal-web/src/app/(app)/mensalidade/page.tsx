'use client';

/**
 * Mensalidade (ADR 0013 F3). O dono do negocio paga a mensalidade por PIX, sem
 * sair do portal. O PIX aparece PRONTO e VALIDO ao abrir a tela — sem botao
 * "Gerar PIX". Fluxo de estados (uma tela, um card focal):
 *
 *   1. CARREGANDO (GET pendente) -> Skeleton.
 *   2. PREPARANDO (POST /pix automatico em andamento, ainda sem QR) -> spinner
 *      "Preparando seu PIX…", sem botao.
 *   3. AGUARDANDO (charge.status === 'pending' valido) -> QR + copia-e-cola +
 *      validade + selo "Aguardando pagamento". A query faz POLL sozinha
 *      (useMensalidade) e a tela "vira pago" quando o webhook confirma.
 *   4. PAGO (charge.status === 'paid') -> selo "Pago" + proximo vencimento.
 *   5. ERRO -> mensagem amigavel + unico botao "Tentar de novo" (re-dispara POST).
 *
 * Auto-gerar: apos o GET, se ha billing configurado e o ciclo NAO esta pago, a tela
 * dispara POST /pix sozinha quando (charge == null) OU (pending E expirado). Um guard
 * (flag por ciclo) evita loop de chamadas — so dispara uma vez por carregamento.
 *
 * Dev-only: com dev_mode + cobranca pendente, aparece "Simular pagamento (Dev)"
 * que dispara o gateway de teste; o poll mostra virar pago. Tudo o que aparece na
 * tela vem mascarado do backend — nenhum segredo no front.
 */
import { IconCheck, IconCopy } from '@/components/icons';
import { useTenant } from '@/components/shell/session-context';
import { Button } from '@/components/ui/button';
import { PageHead } from '@/components/ui/page-head';
import { Skeleton } from '@/components/ui/skeleton';
import { ErrorState } from '@/components/ui/states';
import { useToast } from '@/components/ui/toast';
import { ApiError } from '@/lib/api';
import type { BillingStatus, ChargeView, MensalidadeResponse } from '@/lib/api-types';
import { type BillingTone, computeBillingView } from '@/lib/billing';
import { cn } from '@/lib/cn';
import { formatDueDate, formatPrecoCents } from '@/lib/format';
import { useGerarPix, useMensalidade, useSimularPagamento } from '@/lib/queries';
import Image from 'next/image';
import { useEffect, useRef } from 'react';

const PAGE_SUBTITLE =
  'Pague sua mensalidade por PIX, na hora, sem sair daqui. Assim seu atendimento no WhatsApp continua no ar.';

export default function MensalidadePage() {
  const { slot } = useTenant();
  const toast = useToast();
  const mensalidadeQ = useMensalidade(slot);
  const gerarPix = useGerarPix(slot);
  const simular = useSimularPagamento(slot);

  const data = mensalidadeQ.data;
  const charge = data?.charge ?? null;
  // PIX exibivel = cobranca pendente E ainda valida (nao expirada).
  const aguardando = charge?.status === 'pending' && charge.is_expired !== true;
  const pago = charge?.status === 'paid';

  // Billing configurado (tem valor) e ciclo nao pago: precisamos de um PIX valido.
  const billingConfigurado = data != null && data.amount_cents !== null;
  // Falta um QR valido? null OU pending-expirado -> backend gera/reemite no POST.
  const precisaGerar =
    billingConfigurado &&
    !pago &&
    (charge === null || (charge.status === 'pending' && charge.is_expired === true));

  // Guard anti-loop: dispara o POST automatico no maximo UMA vez por ciclo carregado.
  // A flag guarda o cycle (ou um sentinela quando charge==null) ja disparado; ao
  // mudar de ciclo/charge a flag se reseta e permite um novo auto-disparo legitimo.
  const autoFiredFor = useRef<string | null>(null);
  const autoKey = charge?.cycle ?? (billingConfigurado ? '__no-charge__' : null);

  useEffect(() => {
    if (!precisaGerar || autoKey === null) return;
    if (autoFiredFor.current === autoKey) return; // ja disparou pra este ciclo/estado
    if (gerarPix.isPending) return; // POST em voo — nao reenfileira
    autoFiredFor.current = autoKey;
    gerarPix.mutate(undefined, {
      onError: (err) => toast.error(mensagemErroPix(err)),
    });
  }, [precisaGerar, autoKey, gerarPix, toast]);

  function onAtualizarQr() {
    gerarPix.mutate(undefined, {
      onSuccess: () => toast.success('PIX atualizado. Escaneie ou copie o código pra pagar.'),
      onError: (err) => toast.error(mensagemErroPix(err)),
    });
  }

  function onSimular() {
    toast.success('Simulando pagamento… aguarde a confirmação.');
    simular.mutate(undefined, {
      onError: (err) => toast.error(mensagemErroSimular(err)),
    });
  }

  async function onCopiar() {
    if (!charge?.br_code) return;
    try {
      await navigator.clipboard.writeText(charge.br_code);
      toast.success('Código PIX copiado. Cole no app do seu banco.');
    } catch {
      toast.error('Não foi possível copiar. Selecione o código manualmente.');
    }
  }

  // 1. Carregando o GET inicial.
  if (mensalidadeQ.isPending) {
    return (
      <>
        <PageHead title="Mensalidade" subtitle={PAGE_SUBTITLE} />
        <span className="sr-only">Carregando sua mensalidade…</span>
        <Skeleton className="h-[200px] w-full rounded-card" />
      </>
    );
  }

  // GET falhou de vez.
  if (mensalidadeQ.isError || !data) {
    return (
      <>
        <PageHead title="Mensalidade" subtitle={PAGE_SUBTITLE} />
        <ErrorState
          title="Não foi possível carregar sua mensalidade"
          onRetry={() => mensalidadeQ.refetch()}
        />
      </>
    );
  }

  // POST /pix falhou e nao temos um QR valido pra mostrar -> erro com "Tentar de novo".
  const erroGerar = gerarPix.isError && !aguardando && !pago;
  // Gerando: POST em voo (ou prestes a disparar) e ainda sem QR valido nem pago.
  const preparando = !erroGerar && !pago && !aguardando && (gerarPix.isPending || precisaGerar);

  return (
    <>
      <PageHead title="Mensalidade" subtitle={PAGE_SUBTITLE} />

      <div className="stagger stagger-2 space-y-3.5">
        <ResumoCard
          amountCents={data.amount_cents}
          nextDueDate={data.next_due_date}
          diasRestantes={data.dias_restantes}
          billingStatus={data.billing_status}
          pago={!!pago}
        />

        {pago && <PagoCard nextDueDate={data.next_due_date} />}

        {!pago && aguardando && charge && (
          <PixCard
            charge={charge}
            onCopiar={onCopiar}
            onAtualizar={onAtualizarQr}
            atualizando={gerarPix.isPending}
            onSimular={data.dev_mode ? onSimular : undefined}
            simulando={simular.isPending}
          />
        )}

        {!pago && !aguardando && preparando && <PreparandoCard />}

        {!pago && !aguardando && !preparando && erroGerar && (
          <ErroPixCard
            mensagem={mensagemErroPix(gerarPix.error)}
            onTentar={onAtualizarQr}
            tentando={gerarPix.isPending}
          />
        )}
      </div>
    </>
  );
}

// ── Mensagens de erro amigaveis (sem jargao tecnico na tela) ──────────────────

function mensagemErroPix(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.status === 409) return 'Sua mensalidade ainda não foi configurada. Fale com o suporte.';
    if (err.status === 503) return 'Pagamento indisponível no momento. Tente de novo em instantes.';
    if (err.status === 502)
      return 'Não conseguimos gerar o PIX agora. Tente novamente em alguns minutos.';
  }
  return 'Não foi possível gerar o PIX. Tente de novo.';
}

function mensagemErroSimular(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.status === 403) return 'Simulação disponível apenas no ambiente de testes.';
    if (err.status === 409) return 'Gere um PIX antes de simular o pagamento.';
  }
  return 'Não foi possível simular o pagamento.';
}

// ── Cards ─────────────────────────────────────────────────────────────────────

// Tons solidos (espelham o billing-card da Home): texto escuro no ambar (AA),
// branco no roxo/vermelho. Card de mensalidade e o ponto focal da tela.
const SURFACE: Record<BillingTone, string> = {
  brand: 'bg-brand-fill text-white',
  amber: 'bg-amber-fill text-amber-ink',
  danger: 'bg-danger-fill text-white',
  neutral: 'bg-brand-fill text-white',
};
const META: Record<BillingTone, string> = {
  brand: 'text-white/[0.82]',
  amber: 'text-amber-ink/85',
  danger: 'text-white/[0.85]',
  neutral: 'text-white/[0.82]',
};
const LABEL: Record<BillingTone, string> = {
  brand: 'text-white/70',
  amber: 'text-amber-ink/80',
  danger: 'text-white/75',
  neutral: 'text-white/70',
};

const STATUS_LABEL: Record<BillingStatus, string> = {
  active: 'Em dia',
  overdue: 'Vencida',
  suspended: 'Suspensa',
};

/**
 * Card focal: valor da mensalidade, vencimento e dias restantes (tom por
 * computeBillingView). Quando ja esta pago no ciclo, segura o tom roxo "em dia"
 * pra nao alarmar com o vencimento ainda em transicao (o webhook renova o due).
 */
function ResumoCard({
  amountCents,
  nextDueDate,
  diasRestantes,
  billingStatus,
  pago,
}: {
  amountCents: number | null;
  nextDueDate: string | null;
  diasRestantes: number | null;
  billingStatus: BillingStatus | null;
  pago: boolean;
}) {
  const view = computeBillingView(
    nextDueDate !== null && diasRestantes !== null
      ? { next_due_date: nextDueDate, dias_restantes: diasRestantes, status: 'active' }
      : null,
  );
  const tone: BillingTone = pago ? 'brand' : view.tone;
  const due = formatDueDate(nextDueDate);

  return (
    <section
      aria-label="Sua mensalidade"
      className={cn(
        'hero-e2 billing-filete relative overflow-hidden rounded-card p-5',
        SURFACE[tone],
      )}
    >
      <span
        aria-hidden
        className="pointer-events-none absolute -bottom-[70px] -right-[60px] size-[170px] rounded-full bg-white/[0.07]"
      />

      <div className="relative z-10 flex items-start justify-between gap-3">
        <span className={cn('text-[11px] font-semibold uppercase tracking-[0.08em]', LABEL[tone])}>
          Sua mensalidade
        </span>
        {billingStatus && (
          <span
            className={cn(
              'rounded-pill px-2.5 py-[3px] text-[11px] font-semibold',
              tone === 'amber' ? 'bg-amber-ink/12 text-amber-ink' : 'bg-white/[0.16] text-white',
            )}
          >
            {STATUS_LABEL[billingStatus]}
          </span>
        )}
      </div>

      {amountCents !== null ? (
        <div
          className={cn(
            'relative z-10 mt-2 font-display text-[34px] font-bold leading-none tracking-[-0.02em]',
            tone === 'amber' ? 'text-amber-ink' : 'text-white',
          )}
        >
          {formatPrecoCents(amountCents)}
          <span className="text-[15px] font-medium opacity-90"> /mês</span>
        </div>
      ) : (
        <div className="relative z-10 mt-2 font-display text-[20px] font-bold text-white">
          Valor a combinar
        </div>
      )}

      {due ? (
        <p className={cn('relative z-10 mt-2.5 text-[13px]', META[tone])}>
          {view.vencido ? <>Venceu em {due}</> : <>Próximo vencimento em {due}</>}
          {!view.vencido && diasRestantes !== null && (
            <>
              {' · '}
              <b className="font-semibold">
                {diasRestantes === 0
                  ? 'vence hoje'
                  : diasRestantes === 1
                    ? 'falta 1 dia'
                    : `faltam ${diasRestantes} dias`}
              </b>
            </>
          )}
        </p>
      ) : (
        <p className={cn('relative z-10 mt-2.5 text-[13px]', META[tone])}>
          Vencimento controlado pelo suporte
        </p>
      )}
    </section>
  );
}

/**
 * Preparando: o PIX esta sendo gerado/reemitido automaticamente (POST /pix em voo).
 * Sem botao — o QR aparece sozinho assim que o gateway responde.
 */
function PreparandoCard() {
  return (
    <section
      className="rounded-card border border-line bg-surface p-5 shadow-card"
      aria-busy="true"
      aria-live="polite"
    >
      <div className="flex items-center gap-2.5">
        <span
          className="size-[18px] shrink-0 rounded-full border-2 border-brand border-t-transparent animate-spin-token"
          aria-hidden
        />
        <h2 className="font-display text-[16px] font-semibold text-ink">Preparando seu PIX…</h2>
      </div>
      <p className="mt-1.5 text-[13.5px] leading-snug text-ink-soft">
        Estamos gerando seu código PIX. Em instantes o QR Code aparece aqui — é só pagar pelo app do
        seu banco.
      </p>
      <div className="mt-4 space-y-2">
        <Skeleton className="mx-auto h-52 w-52 rounded-card-sm" />
        <Skeleton className="h-9 w-full rounded-card-sm" />
      </div>
    </section>
  );
}

/**
 * Erro ao gerar/reemitir o PIX. Mensagem amigavel + o UNICO botao de geração que a
 * tela permite ("Tentar de novo"), so neste caminho de erro.
 */
function ErroPixCard({
  mensagem,
  onTentar,
  tentando,
}: {
  mensagem: string;
  onTentar: () => void;
  tentando: boolean;
}) {
  return (
    <section
      className="rounded-card border border-danger/40 bg-surface p-5 shadow-card"
      role="alert"
    >
      <h2 className="font-display text-[16px] font-semibold text-ink">PIX indisponível agora</h2>
      <p className="mt-1.5 text-[13.5px] leading-snug text-ink-soft">{mensagem}</p>
      <div className="mt-4">
        <Button variant="secondary" onClick={onTentar} loading={tentando} loadingLabel="Gerando…">
          Tentar de novo
        </Button>
      </div>
    </section>
  );
}

/** PIX pendente valido: QR + copia-e-cola + validade + selo "aguardando". */
function PixCard({
  charge,
  onCopiar,
  onAtualizar,
  atualizando,
  onSimular,
  simulando,
}: {
  charge: ChargeView;
  onCopiar: () => void;
  onAtualizar: () => void;
  atualizando: boolean;
  onSimular?: () => void;
  simulando: boolean;
}) {
  const validade = formatValidade(charge.expires_at);

  return (
    <section className="rounded-card border border-line bg-surface p-5 shadow-card">
      <div className="flex items-center gap-2.5">
        <span className="flex size-6 items-center justify-center rounded-full bg-amber-soft">
          <span className="size-2 animate-pulse rounded-full bg-amber" aria-hidden />
        </span>
        <h2 className="font-display text-[16px] font-semibold text-ink">Aguardando pagamento</h2>
      </div>
      <p className="mt-1 text-[13.5px] leading-snug text-ink-soft">
        Escaneie o QR Code ou copie o código no app do seu banco. Assim que o pagamento cair, sua
        mensalidade é renovada automaticamente.
      </p>

      {charge.br_code_base64 && (
        <div className="mt-4 flex justify-center">
          {/* QR e um data-URI base64 pronto do gateway: next/image com unoptimized
              (nao da pra otimizar/redimensionar um data-URI no servidor do Next). */}
          <Image
            src={charge.br_code_base64}
            alt="QR Code do PIX da sua mensalidade"
            width={208}
            height={208}
            unoptimized
            className="size-52 rounded-card-sm border border-line bg-white p-2"
          />
        </div>
      )}

      {charge.br_code && (
        <div className="mt-4">
          <span className="text-[11px] font-semibold uppercase tracking-[0.06em] text-ink-faint">
            PIX copia e cola
          </span>
          <p className="mt-1.5 break-all rounded-card-sm border border-line bg-bg px-3 py-2.5 font-mono text-[12px] leading-relaxed text-ink-soft">
            {charge.br_code}
          </p>
          <div className="mt-3">
            <Button variant="secondary" onClick={onCopiar}>
              <IconCopy size={18} />
              Copiar código
            </Button>
          </div>
        </div>
      )}

      {validade && (
        <p className="mt-3 text-center text-[12.5px] text-ink-faint">Válido até {validade}</p>
      )}

      {/* Fallback discreto: forca uma reemissao do QR (nao e o "Gerar PIX" de antes). */}
      <div className="mt-3 text-center">
        <button
          type="button"
          onClick={onAtualizar}
          disabled={atualizando}
          className="text-[12.5px] font-medium text-brand underline-offset-2 hover:underline disabled:opacity-50"
        >
          {atualizando ? 'Atualizando QR…' : 'Atualizar QR'}
        </button>
      </div>

      {onSimular && (
        <div className="mt-4 border-t border-line-soft pt-4">
          <span className="text-[11px] font-semibold uppercase tracking-[0.06em] text-ink-faint">
            Ambiente de testes
          </span>
          <div className="mt-2">
            <Button
              variant="ghost"
              onClick={onSimular}
              loading={simulando}
              loadingLabel="Simulando…"
            >
              Simular pagamento (Dev)
            </Button>
          </div>
        </div>
      )}
    </section>
  );
}

/** PIX pago: confirmacao + proximo vencimento. */
function PagoCard({ nextDueDate }: { nextDueDate: string | null }) {
  const due = formatDueDate(nextDueDate);
  return (
    <section className="rounded-card border border-ok/40 bg-ok-soft p-5 shadow-card">
      <div className="flex items-center gap-2.5">
        <span className="flex size-7 items-center justify-center rounded-full bg-ok">
          <IconCheck size={15} className="text-white" />
        </span>
        <h2 className="font-display text-[16px] font-semibold text-ink">Pagamento confirmado</h2>
      </div>
      <p className="mt-1.5 text-[14px] leading-normal text-ink-soft">
        {due ? (
          <>
            Mensalidade renovada — seu próximo vencimento é em <b className="text-ink">{due}</b>.
            Obrigado!
          </>
        ) : (
          'Mensalidade renovada. Seu atendimento no WhatsApp segue ativo. Obrigado!'
        )}
      </p>
    </section>
  );
}

// ── Helpers locais ────────────────────────────────────────────────────────────

/** ISO -> "13/07 às 10:00" pra validade do PIX. Retorna null se invalido. */
function formatValidade(iso: string | null): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  const dia = d.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' });
  const hora = d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
  return `${dia} às ${hora}`;
}
