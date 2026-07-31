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
 * Blocos (todos seguem o balde selecionado), no ramo atend_from_agenda dentro de
 * BillingAgendaSection (dono único da query — gráfico/filtros/lista compartilham o
 * mesmo fetch):
 *   1. Filtros (cliente/colaborador/serviço) — client-side sobre o array carregado.
 *   2. Gráfico (3 visões: dia / profissional / forma de pagamento).
 *   3. Total do balde + lista EDITÁVEL (editar valor/forma/serviço/cliente com badge
 *      sticky "Editado"; remover = soft-delete; badges Auto/Editado/Manual).
 *   4. Comissão por profissional — SÓ estabelecimento (bruto · % · comissão),
 *      recomputada do array filtrado (live-compute).
 *   + Botão "Registrar" (atendimento manual/walk-in) -> /atendimentos/novo.
 *
 * Gating: a página é gated por atendimentos_enabled (flag do backend). Com a flag
 * OFF (link direto), mostra "recurso indisponível". O billing-da-agenda
 * (atend_from_agenda) liga as abas + a lista editável; sem ele (clones FORA do gate
 * de agenda — ex.: modo atendente/Ingrid/Meduzza), mostra o relatório agregado
 * legado, que só exibe o FATURADO — por isso o subtítulo desse ramo NÃO promete
 * previsão (billingSubtitle, SCRUM-88).
 */
import { BillingAgendaSection } from '@/components/atendimentos/billing-agenda-section';
import { BillingTabs } from '@/components/atendimentos/billing-tabs';
import { ResumoFaturamento } from '@/components/atendimentos/resumo-faturamento';
import { IconPlus, IconWallet } from '@/components/icons';
import { PeriodSelector } from '@/components/relatorios/period-selector';
import { useTenant } from '@/components/shell/session-context';
import { PageHead } from '@/components/ui/page-head';
import { EmptyState } from '@/components/ui/states';
import type { AtendimentoBalde } from '@/lib/api-types';
import { billingSubtitle } from '@/lib/atendimentos-balde';
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
      {/* Mobile: título empilha sobre o botão (que vira full-width tappable);
          >=sm volta a ficar lado a lado (subtítulo não espreme contra o botão). */}
      <div className="mb-[18px] flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <PageHead title="Faturamento" subtitle={billingSubtitle(atendFromAgenda)} />
        <Link
          href="/atendimentos/novo"
          className="inline-flex h-11 shrink-0 items-center justify-center gap-2 rounded-pill border border-brand bg-brand px-4 font-display text-[13.5px] font-semibold text-bg outline-none transition-colors hover:bg-brand-600 focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-2 focus-visible:ring-offset-bg sm:mt-1 sm:h-10"
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

          <BillingAgendaSection balde={balde} de={periodo.de} ate={periodo.ate} />
        </>
      ) : (
        // Billing-da-agenda OFF (clones fora do gate de agenda — ex.: modo
        // atendente/Ingrid/Meduzza): relatório agregado legado. Sem abas — só
        // Faturado faz sentido (não há eventos futuros derivados da agenda).
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
      <PageHead title="Faturamento" subtitle="O que você já faturou." />
      <EmptyState
        icon={<IconWallet size={26} />}
        title="Recurso indisponível"
        description="O Faturamento ainda não está liberado pra sua conta. Fale com o suporte pra ativar."
      />
    </>
  );
}
