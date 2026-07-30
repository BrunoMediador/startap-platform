/**
 * Job — RELATÓRIO de reconciliação de pacotes (ADR 0025 dívida 5: cancelar+reagendar).
 *
 * PROBLEMA mitigado: o bot NÃO cancela (escala pro dono). Quando um atendimento é cancelado
 * e reagendado, o GCal gera um gcal_event_id NOVO. O UNIQUE(gcal_event_id, reason) impede
 * dupla baixa do MESMO evento, mas não liga o evento velho (já descontado) ao novo (que
 * descontaria de novo) -> risco de consumir 2 sessões de 1 atendimento. O refund é MANUAL.
 *
 * Este job NÃO estorna nada — é READ-ONLY. Ele cruza o ledger procurando a assinatura de
 * dupla-baixa (2+ redeem do MESMO serviço/crédito na janela, sem refund compensatório) e,
 * quando acha, LOGA alto (log.warn estruturado) pro ops auditar e fazer o refund manual.
 * Substitui o "log solto" do reconciliationHook por um relatório periódico acionável
 * (recomendação do review do #321: ter alerta/relatório antes de escalar pacotes).
 *
 * GATE: o worker só registra o cron com PACOTES_RECONCILE_ENABLED=true (default OFF). Com a
 * flag OFF o job nem existe — zero query. Acompanha o rollout de PACOTES_ENABLED.
 *
 * LGPD: a query agrega por crédito+serviço; NUNCA toca telefone (nem hash). Só slot, serviço,
 * contagem e os gcal_event_ids HASHEADOS entram no log.
 *
 * ⚠️ SCRUM-148 item 2: este job logava o ARRAY de gcal_event_id CRU (reidentificação indireta,
 * LGPD art. 12 §2 — mesma classe fechada no #531 pro caminho de erro do GCal). O array agora sai
 * pelo MESMO `hashEventIdForLog` do SCRUM-91: o ops continua cruzando com a agenda pelo hash
 * (determinístico) e, se precisar do id cru, ele permanece na LINHA do ledger (package_redemptions),
 * que é a fonte de investigação — nunca o log.
 *
 * IDEMPOTENTE: é só leitura + log; rodar de novo não tem efeito colateral.
 */
import { hashEventIdForLog } from '@startap/core/gcal-event-log';
import { logger } from '@startap/core/logger';
import { type SuspectDoubleRedeem, packages } from '@startap/db';
import { config } from '../config.js';

const log = logger.child({ job: 'reconcile-packages' });

export interface ReconcilePackagesResult extends Record<string, unknown> {
  /** quantas suspeitas de dupla-baixa o relatório encontrou. */
  suspects: number;
  /** janela usada (horas). */
  windowHours: number;
}

export async function runReconcilePackages(): Promise<ReconcilePackagesResult> {
  const windowHours = config.PACOTES_RECONCILE_WINDOW_HOURS;
  let suspects: SuspectDoubleRedeem[] = [];
  try {
    suspects = await packages.findSuspectDoubleRedeems({ janelaHoras: windowHours });
  } catch (err) {
    // Read-only: falha de DB não derruba o worker nem afeta atendimento. Loga e segue.
    log.error(
      { err: err instanceof Error ? err.message : String(err) },
      'reconcile-packages: leitura do ledger falhou — relatório vazio neste ciclo',
    );
    return { suspects: 0, windowHours };
  }

  if (suspects.length === 0) {
    // Silêncio quando não há suspeita — não polui o log em prod.
    return { suspects: 0, windowHours };
  }

  // Uma linha de WARN por suspeita: o ops cruza os gcalEventIds (HASHEADOS, SCRUM-148 item 2)
  // com a agenda via a linha do ledger e faz o refund manual.
  for (const s of suspects) {
    log.warn(
      {
        slot: s.slot,
        creditId: s.credit_id,
        servico: s.servico_nome,
        redeems: s.redeems,
        refunds: s.refunds,
        baixaLiquida: s.redeems - s.refunds,
        gcalEventIds: s.gcal_event_ids.map(hashEventIdForLog),
        primeiro: s.primeiro,
        ultimo: s.ultimo,
      },
      'reconcile-packages: SUSPEITA de dupla-baixa de pacote (cancelar+reagendar?) — ops conferir e estornar manualmente',
    );
  }
  log.warn(
    { suspects: suspects.length, windowHours },
    'reconcile-packages: relatório com suspeitas de dupla-baixa — ação manual do ops necessária',
  );

  return { suspects: suspects.length, windowHours };
}
