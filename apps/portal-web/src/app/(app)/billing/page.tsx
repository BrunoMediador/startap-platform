'use client';

/**
 * Billing — tela ÚNICA do dinheiro do cliente final (consolidação Faturamento +
 * Comissão; decisão do Bruno). Acabou a separação de menus/telas: um seletor
 * Previsão | Faturado no topo controla a PÁGINA INTEIRA (total + lista de
 * atendimentos + comissão por profissional).
 *
 *   - Previsão = eventos FUTUROS (receita esperada). Período default e limites
 *     miram o FUTURO; o calendário PERMITE datas futuras (corrige o bug do seletor).
 *   - Faturado = eventos PASSADOS (realizado). Período mira o passado (1º do mês →
 *     hoje); `ate` não passa de hoje.
 *
 * Blocos (todos seguem o balde selecionado):
 *   1. Total do balde (dentro do BaldeList).
 *   2. Atendimentos — lista EDITÁVEL (editar valor/forma/serviço/cliente com badge
 *      sticky "Editado"; remover = soft-delete; badges Auto/Editado/Manual;
 *      fallbacks de null). Reusa BaldeList (já testado).
 *   3. Comissão por profissional — SÓ estabelecimento (bruto · % · comissão).
 *   + Botão "Registrar" (atendimento manual/walk-in) -> /atendimentos/novo.
 *
 * Gating: a página é gated por atendimentos_enabled (flag do backend). Com a flag
 * OFF (link direto), mostra "recurso indisponível". O billing-da-agenda
 * (atend_from_agenda) liga as abas + a lista editável; sem ele, mostra o relatório
 * agregado legado (idêntico ao de hoje pro SOLO Cirilo/Samuel — sem regressão).
 */
import { BaldeList } from '@/components/atendimentos/balde-list';
import { BillingTabs } from '@/components/atendimentos/billing-tabs';
import { ComissaoBalde } from '@/components/atendimentos/comissao-balde';
import { ResumoFaturamento } from '@/components/atendimentos/resumo-faturamento';
import { IconPlus, IconWallet } from '@/components/icons';
import { PeriodSelector } from '@/components/relatorios/period-selector';
import { useTenant } from '@/components/shell/session-context';
import { PageHead } from '@/components/ui/page-head';
import { EmptyState } from '@/components/ui/states';
import type { AtendimentoBalde } from '@/lib/api-types';
import { periodoLimites, periodoPadrao, periodoPresets } from '@/lib/billing-periodo';
import Link from 'next/link';
import { useMemo, useState } from 'react';

export default function BillingPage() {
  const { atendimentosEnabled, atendFromAgenda } = useTenant();

  // Com o billing-da-agenda ON: abas Previsão/Faturado. Default = Faturado
  // (realizado é o foco do dia a dia). Cada troca de aba re-aplica o período padrão
  // daquele balde (futuro vs passado) — é isso que corrige a Previsão "vazia".
  const [balde, setBalde] = useState<AtendimentoBalde>('faturado');
  const [periodo, setPeriodo] = useState(() => periodoPadrao('faturado'));

  function trocarBalde(novo: AtendimentoBalde) {
    setBalde(novo);
    // Reseta o período pro padrão do balde (Previsão -> futuro, Faturado -> passado).
    // Sem isso, sair de Faturado (passado) pra Previsão herdaria a janela do passado
    // e a lista de futuros nasceria vazia — exatamente o bug que estamos corrigindo.
    setPeriodo(periodoPadrao(novo));
  }

  const presets = useMemo(() => periodoPresets(balde), [balde]);
  const limites = useMemo(() => periodoLimites(balde, periodo), [balde, periodo]);

  if (!atendimentosEnabled) return <Indisponivel />;

  return (
    <>
      <div className="mb-[18px] flex items-start justify-between gap-3">
        <PageHead
          title="Billing"
          subtitle="O dinheiro do seu negócio: o que está previsto e o que já foi faturado."
        />
        <Link
          href="/atendimentos/novo"
          className="mt-1 inline-flex h-10 shrink-0 items-center gap-2 rounded-pill border border-brand bg-brand px-4 font-display text-[13.5px] font-semibold text-bg outline-none transition-colors hover:bg-brand-600 focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-2 focus-visible:ring-offset-bg"
        >
          <IconPlus size={17} />
          Registrar
        </Link>
      </div>

      {atendFromAgenda ? (
        <>
          <BillingTabs value={balde} onChange={trocarBalde} />
          <PeriodSelector
            value={periodo}
            onChange={setPeriodo}
            presets={presets}
            limites={limites}
          />

          <div className="space-y-8">
            <BaldeList balde={balde} de={periodo.de} ate={periodo.ate} />
            <ComissaoBalde balde={balde} de={periodo.de} ate={periodo.ate} />
          </div>
        </>
      ) : (
        // Billing-da-agenda OFF (SOLO Cirilo/Samuel): relatório agregado legado.
        // Sem abas — só Faturado faz sentido (não há eventos futuros derivados).
        <>
          <PeriodSelector
            value={periodo}
            onChange={setPeriodo}
            presets={periodoPresets('faturado')}
            limites={periodoLimites('faturado', periodo)}
          />
          <ResumoFaturamento de={periodo.de} ate={periodo.ate} />
        </>
      )}
    </>
  );
}

/** Página inteira indisponível (flag atendimentos OFF na sessão). */
function Indisponivel() {
  return (
    <>
      <PageHead title="Billing" subtitle="O dinheiro do seu negócio: previsto e faturado." />
      <EmptyState
        icon={<IconWallet size={26} />}
        title="Recurso indisponível"
        description="O Billing ainda não está liberado pra sua conta. Fale com o suporte pra ativar."
      />
    </>
  );
}
