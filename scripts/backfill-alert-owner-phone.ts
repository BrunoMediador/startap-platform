/**
 * backfill-alert-owner-phone — preenche flow_clones.alert_owner_phone dos clones JÁ
 * CONECTADOS que ficaram com a coluna VAZIA (provisionados antes da feature de
 * autofill ao conectar — Seven 7, Vitor). Lê o me.id AO VIVO da sessão WAHA e grava
 * os dígitos puros, SOMENTE se a coluna estiver vazia.
 *
 * Por que existe: o hook de autofill (alert-owner-autofill.ts) só age no PRÓXIMO
 * evento WORKING. Para os clones que JÁ estão WORKING agora, este script aplica o
 * preenchimento sem esperar uma reconexão.
 *
 * SEGURANÇA / idempotência:
 *  - Usa o MESMO code path do hook: flowClones.setCloneAlertOwnerPhoneIfEmpty, que só
 *    grava onde alert_owner_phone IS NULL/'' (NUNCA sobrescreve override/backfill).
 *  - Normaliza o me.id com meIdToDigits (dígitos puros, preserva o 9) — mesmo formato
 *    dos pagantes (Cirilo 5511979630828, Samuel 5535991746797).
 *  - LGPD: número NUNCA impresso em claro — só phoneHint (DDD + 2 últimos).
 *  - Timeout duro no GET da sessão (não trava em WAHA fora).
 *
 * USO:
 *   # PREVIEW (não grava nada — mostra o que SERIA preenchido):
 *   npx tsx scripts/backfill-alert-owner-phone.ts --dry-run
 *
 *   # APLICAR de verdade:
 *   npx tsx scripts/backfill-alert-owner-phone.ts
 *
 * Pré-requisito: env de DB + WAHA_URL + WAHA_API_KEY no ambiente (mesmas da api).
 */
import { phoneHint } from '@startap/core/phone';
import { closePool, flowClones, query } from '@startap/db';
import { waha } from '@startap/integrations';

const WAHA_TIMEOUT_MS = 8_000;

interface CandidateRow {
  slot: string;
  waha_sessao: string | null;
}

async function main(): Promise<void> {
  const dryRun = process.argv.includes('--dry-run');
  const mode = dryRun ? 'DRY-RUN (preview, nada gravado)' : 'APPLY (grava no banco)';
  console.log(`[backfill-alert-owner-phone] modo: ${mode}\n`);

  // Clones com alert_owner_phone vazio E sessão WAHA atribuída.
  const r = await query<CandidateRow>(
    `SELECT slot, waha_sessao
       FROM flow_clones
      WHERE (alert_owner_phone IS NULL OR alert_owner_phone = '')
        AND waha_sessao IS NOT NULL
      ORDER BY slot`,
  );

  if (r.rows.length === 0) {
    console.log('Nenhum clone com alert_owner_phone vazio + sessão atribuída. Nada a fazer.');
    return;
  }

  let filled = 0;
  let skipped = 0;

  for (const row of r.rows) {
    const sessao = row.waha_sessao;
    if (!sessao) {
      skipped++;
      continue;
    }

    let meId: string | null = null;
    let status = 'unknown';
    try {
      const s = await waha.sessions.getSessionStatus(sessao, { timeoutMs: WAHA_TIMEOUT_MS });
      status = s.status;
      meId = s.me?.id ?? null;
    } catch (e) {
      console.log(
        `- ${row.slot} (${sessao}): WAHA indisponível/erro (${e instanceof Error ? e.message : String(e)}) — pulado`,
      );
      skipped++;
      continue;
    }

    if (status !== 'WORKING' || !meId) {
      console.log(
        `- ${row.slot} (${sessao}): status=${status} me=${meId ? 'sim' : 'não'} — pulado`,
      );
      skipped++;
      continue;
    }

    if (dryRun) {
      // Em preview só mostramos o hint do número que SERIA gravado.
      const digits = meId.split('@')[0]?.split(':')[0]?.replace(/\D/g, '') ?? '';
      console.log(
        `- ${row.slot} (${sessao}): SETARIA alert_owner_phone = ${phoneHint(digits)} (de me.id da sessão)`,
      );
      filled++;
      continue;
    }

    const didFill = await flowClones.setCloneAlertOwnerPhoneIfEmpty(row.slot, meId);
    if (didFill) {
      console.log(`- ${row.slot} (${sessao}): PREENCHIDO (${phoneHint(meId.replace(/\D/g, ''))})`);
      filled++;
    } else {
      console.log(`- ${row.slot} (${sessao}): já tinha valor ou me.id inválido — no-op`);
      skipped++;
    }
  }

  console.log(`\nResumo: ${filled} ${dryRun ? 'a preencher' : 'preenchidos'}, ${skipped} pulados.`);
}

main()
  .then(() => closePool())
  .catch(async (e) => {
    console.error('[backfill-alert-owner-phone] erro fatal:', e);
    await closePool();
    process.exit(1);
  });
