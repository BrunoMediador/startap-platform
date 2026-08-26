/**
 * Job — HEALTH-CHECK do Google Calendar (SCRUM-27, fim do "active mentiroso").
 *
 * PROBLEMA: hoje `gcal_status`/`gcal_last_check_at` só mudam quando alguém clica "Testar
 * conexão" no painel. Uma agenda pode quebrar (permissão da Service Account revogada,
 * calendarId apagado, chave da SA trocada) e SEGUIR marcada 'active' — o bot acha que tem
 * agenda e silencia ("nenhum colaborador agendável" / não agenda). Este cron revalida as
 * agendas 'active' periodicamente e corrige o status.
 *
 * REUSO: usa o MESMO `GoogleCalendarClient.testConnection()` que o botão do painel
 * (POST /api/clones/:id/gcal/test) — listEvents numa janela de 1 dia, chamada LEVE — e a
 * MESMA decryptSecret. Não reimplementa validação.
 *
 * DUAS FONTES:
 *   - INDIVIDUAL: flow_clones (1 agenda por clone).
 *   - ESTABELECIMENTO: clone_colaboradores (N calendarIds; credencial = a do CLONE, ADR 0024 §2).
 *   bot_config (matrizes/bots internos) fica fora desta v1 — são internos/teste (follow-up).
 *
 * DECISÃO DE STATUS (conservadora — não trocar um mentiroso por outro):
 *   - validação OK            -> 'active'  (revalida + carimba last_check).
 *   - falha DEFINITIVA        -> 'invalid' (HTTP 400/401/403/404 ou creds estruturalmente
 *                                inválidas: a agenda REALMENTE não está agendável).
 *   - falha TRANSITÓRIA        -> NÃO escreve (timeout, 429, 5xx, erro de rede): inconclusivo,
 *                                preserva status + last_check para não DEMOVER agenda boa por blip.
 *   Só toca 'active' (auto-heal 'invalid'->'active' fica de fora: quem promove é o operador OU
 *   um próximo incremento — manter o escopo cirúrgico no "active mentiroso"). 'pending'/'disabled'
 *   nunca são tocados.
 *
 * IDEMPOTÊNCIA (regra de ouro 6): rodar 2× produz o mesmo resultado. O UPDATE tem guarda
 * `WHERE gcal_status='active'` (não ressuscita 'disabled' nem clobbera mudança do operador).
 *
 * ISOLAMENTO / fail-safe: a falha de UMA agenda NUNCA derruba o job nem afeta as outras
 * (try/catch por item — regras de ouro 7/8). Teto por ciclo + priorização por check mais
 * antigo dão a volta em todas sem martelar a API do Google.
 *
 * TIMEOUT (regra 7): cada validação corre contra GCAL_HEALTHCHECK_TIMEOUT_MS — nunca aguardar
 * o Google infinito. Timeout = inconclusivo (não demove).
 *
 * LGPD/segredos: NUNCA loga credencial/chave nem corpo cru do Google. Só slot, id, transição e
 * uma CATEGORIA de erro. (Não há telefone neste fluxo — GCal não carrega contato do cliente.)
 */
import { decryptSecret } from '@startap/core';
import { logger } from '@startap/core/logger';
import { gcalHealth } from '@startap/db';
import { gcal } from '@startap/integrations';
import { config } from '../config.js';

const log = logger.child({ job: 'gcal-healthcheck' });

export interface GcalHealthcheckResult extends Record<string, unknown> {
  /** quantas agendas a varredura validou neste ciclo (individual + colaborador). */
  scanned: number;
  /** quantas seguem OK (revalidadas 'active'). */
  healthy: number;
  /** quantas caíram 'active' -> 'invalid' (o "active mentiroso" corrigido). */
  demoted: number;
  /** quantas ficaram inconclusivas (timeout/transitório) — status preservado. */
  inconclusive: number;
}

/**
 * Veredito da revalidação de UMA agenda. 'active' = OK; 'invalid' = quebrou de verdade;
 * null = inconclusivo (não escrever).
 */
type Verdict = 'active' | 'invalid' | null;

/** Sentinela interno de timeout (não é mensagem do Google) — classificado como inconclusivo. */
const GCAL_HEALTHCHECK_TIMEOUT_SENTINEL = '__gcal_healthcheck_timeout__';

/** Extrai o status HTTP de uma mensagem de erro do GoogleCalendarClient, se houver. */
function httpStatusFromError(msg: string): number | null {
  const m = msg.match(/HTTP (\d{3})/);
  return m ? Number(m[1]) : null;
}

/**
 * Razões (`error.errors[].reason` no corpo do Google) que indicam causa TRANSITÓRIA:
 * rate-limit / quota / backend momentâneo. O ponto do SCRUM-41: o Google devolve HTTP 403
 * TANTO para "forbidden" real (SA sem acesso — definitivo) QUANTO para rate-limit
 * (`rateLimitExceeded` / `userRateLimitExceeded`) — só o `reason` distingue os dois. Rebaixar
 * por rate-limit derruba uma agenda BOA num pico de tráfego e o bot para de agendar pra um
 * cliente que estava OK. Comparação em lower-case (o Google emite camelCase; normalizamos).
 */
const TRANSIENT_GOOGLE_REASONS: ReadonlySet<string> = new Set([
  'ratelimitexceeded',
  'userratelimitexceeded',
  'quotaexceeded',
  'backenderror',
]);

/**
 * Extrai os `reason` de um corpo de erro do Google embutido na mensagem do client
 * (`... -> HTTP 403: {"error":{"errors":[{"reason":"rateLimitExceeded",...}]}}`). Devolve
 * tudo em lower-case. Sem match (corpo ausente / outro formato) = []. Não faz JSON.parse
 * (o corpo vem concatenado, pode estar truncado) — regex tolerante é suficiente e robusto.
 */
function extractGoogleReasons(errorMessage: string): string[] {
  const matches = errorMessage.matchAll(/"reason"\s*:\s*"([^"]+)"/gi);
  return Array.from(matches, (m) => m[1].toLowerCase());
}

const SAFE_GCAL_ERROR_CLASSES = new Set([
  'bad_request',
  'unauthenticated',
  'forbidden',
  'not_found',
  'conflict',
  'rate_limited',
  'backend_error',
  'server_error',
  'unexpected_http',
]);

/** Enum fechado emitido pelo client, sem depender do corpo externo do Google. */
function safeGcalErrorClass(errorMessage: string): string | undefined {
  const match = /\[([a-z_]+)\]$/.exec(errorMessage);
  if (!match || !SAFE_GCAL_ERROR_CLASSES.has(match[1])) return undefined;
  return match[1];
}

/** true se o corpo do erro carrega um `reason` de rate-limit/quota/backend (transitório). */
function hasTransientGoogleReason(errorMessage: string): boolean {
  const safeClass = safeGcalErrorClass(errorMessage);
  if (safeClass === 'rate_limited' || safeClass === 'backend_error') return true;
  return extractGoogleReasons(errorMessage).some((r) => TRANSIENT_GOOGLE_REASONS.has(r));
}

/**
 * Classifica a mensagem de erro de uma validação que FALHOU em DEFINITIVA ('invalid') vs
 * TRANSITÓRIA (null = inconclusivo, NÃO demove).
 *
 * DEFINITIVA (a agenda realmente não dá pra agendar): 400 (calendarId malformado), 401
 * (creds/token rejeitados), 403 forbidden REAL (SA sem permissão), 404 (agenda inexistente).
 *
 * TRANSITÓRIA (preserva status + re-tenta no próximo ciclo): timeout/rede; 408/429/5xx; e — o
 * fix do SCRUM-41 — QUALQUER status (inclusive 403) cujo `reason` do Google seja
 * rate-limit/quota/backend. Um pico de rate-limit devolve 403 e NÃO pode rebaixar uma agenda
 * que está OK.
 */
function classifyFailure(errorMessage: string): Verdict {
  if (errorMessage === GCAL_HEALTHCHECK_TIMEOUT_SENTINEL) return null; // timeout = inconclusivo

  // Rate-limit/quota/backend reconhecido pelo `reason` do corpo, ANTES do status: o Google usa
  // 403 tanto pra rate-limit quanto pra forbidden real, então o status sozinho não decide.
  if (hasTransientGoogleReason(errorMessage)) return null;

  const status = httpStatusFromError(errorMessage);
  // 429 (Too Many Requests) e 5xx = transitório mesmo sem `reason` no corpo.
  if (status === 429 || (status !== null && status >= 500)) return null;
  // Definitiva: 400/401/403/404 (403 aqui já é forbidden REAL — o rate-limit saiu acima).
  if (status === 400 || status === 401 || status === 403 || status === 404) return 'invalid';
  // Sem status HTTP (erro de rede/DNS), ou 408: transitório -> não demove.
  return null;
}

/**
 * Roda testConnection() com timeout duro. Resolve (nunca rejeita) com o resultado do client
 * OU com o sentinel de timeout — o caller classifica. O timer é sempre limpo.
 */
async function testWithTimeout(
  client: { testConnection(): Promise<{ ok: true } | { ok: false; error: string }> },
  timeoutMs: number,
): Promise<{ ok: true } | { ok: false; error: string }> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<{ ok: false; error: string }>((resolve) => {
    timer = setTimeout(
      () => resolve({ ok: false, error: GCAL_HEALTHCHECK_TIMEOUT_SENTINEL }),
      timeoutMs,
    );
  });
  try {
    return await Promise.race([client.testConnection(), timeout]);
  } catch (err: unknown) {
    // testConnection já captura tudo internamente, mas blindamos: erro inesperado -> trata
    // como falha cujo classificador decide (sem status HTTP -> inconclusivo).
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Revalida UMA agenda (creds + calendarId já resolvidos). Monta o client, testa com timeout,
 * e devolve o veredito. Creds inválidas estruturalmente (construtor lança) = 'invalid'
 * (definitivo). NUNCA loga creds. Devolve também uma categoria curta de erro pra log.
 */
async function checkOne(
  credentialsJson: string,
  calendarId: string,
): Promise<{ verdict: Verdict; errorCategory?: string }> {
  let client: { testConnection(): Promise<{ ok: true } | { ok: false; error: string }> };
  try {
    client = new gcal.GoogleCalendarClient({ credentialsJson, calendarId });
  } catch {
    // JSON malformado / type != service_account: creds estruturalmente quebradas = definitivo.
    return { verdict: 'invalid', errorCategory: 'bad_credentials' };
  }

  const res = await testWithTimeout(client, config.GCAL_HEALTHCHECK_TIMEOUT_MS);
  if (res.ok) return { verdict: 'active' };

  const verdict = classifyFailure(res.error);
  const status = httpStatusFromError(res.error);
  // O client novo fornece enum seguro; mocks/versões anteriores seguem no fallback do reason.
  // Isso mantém visível por que um 403 foi preservado sem registrar corpo externo do Google.
  const reason = safeGcalErrorClass(res.error) ?? extractGoogleReasons(res.error)[0];
  const reasonTag = reason ? `:${reason}` : '';
  const errorCategory =
    res.error === GCAL_HEALTHCHECK_TIMEOUT_SENTINEL
      ? 'timeout'
      : status
        ? `http_${status}${reasonTag}`
        : reason
          ? `error${reasonTag}`
          : 'network';
  return { verdict, errorCategory };
}

/**
 * Varre as agendas 'active' (individuais + colaboradores) sob o teto por ciclo e corrige o
 * status. Retorna o resumo do ciclo. NÃO faz nada de destrutivo. NÃO alerta ninguém (v1 — alerta
 * interno é follow-up).
 *
 * O teto (GCAL_HEALTHCHECK_MAX_PER_RUN) é o ORÇAMENTO TOTAL do ciclo: gasta primeiro nos
 * individuais (check mais antigo primeiro), depois nos colaboradores com o que sobrar.
 */
export async function runGcalHealthcheck(): Promise<GcalHealthcheckResult> {
  const budget = config.GCAL_HEALTHCHECK_MAX_PER_RUN;
  const result: GcalHealthcheckResult = { scanned: 0, healthy: 0, demoted: 0, inconclusive: 0 };

  // ── Individuais (flow_clones) ─────────────────────────────────────────────────
  const individuals = await gcalHealth.listActiveIndividualGcals(budget);
  for (const row of individuals) {
    result.scanned++; // exatamente 1× por item, independente de onde falhe abaixo.
    try {
      let credentials: string;
      try {
        credentials = decryptSecret(row.gcal_credentials_json);
      } catch {
        // Creds não-descriptografáveis (chave trocada/corrompida) = quebra definitiva.
        const changed = await gcalHealth.setIndividualGcalStatus(row.id, 'invalid');
        if (changed > 0) result.demoted++;
        log.warn(
          { slot: row.slot, cloneId: row.id, errorCategory: 'decrypt_failed' },
          'gcal individual -> invalid',
        );
        continue;
      }

      const { verdict, errorCategory } = await checkOne(credentials, row.gcal_calendar_id);
      if (verdict === null) {
        result.inconclusive++;
        log.info(
          { slot: row.slot, cloneId: row.id, errorCategory },
          'gcal individual inconclusivo (status preservado)',
        );
        continue;
      }
      const changed = await gcalHealth.setIndividualGcalStatus(row.id, verdict);
      if (verdict === 'invalid') {
        if (changed > 0) result.demoted++;
        log.warn(
          { slot: row.slot, cloneId: row.id, errorCategory },
          'gcal individual -> invalid (active mentiroso corrigido)',
        );
      } else {
        result.healthy++;
      }
    } catch (err: unknown) {
      // Falha do item (incluindo o UPDATE) não derruba o ciclo nem afeta os demais.
      result.inconclusive++;
      log.error(
        { slot: row.slot, cloneId: row.id, err: err instanceof Error ? err.message : String(err) },
        'gcal individual: erro no item',
      );
    }
  }

  // ── Colaboradores (clone_colaboradores) ───────────────────────────────────────
  const remaining = budget - individuals.length;
  if (remaining > 0) {
    const colaboradores = await gcalHealth.listActiveColaboradorGcals(remaining);
    for (const row of colaboradores) {
      result.scanned++; // exatamente 1× por item.
      try {
        let credentials: string;
        try {
          credentials = decryptSecret(row.clone_credentials_json);
        } catch {
          const changed = await gcalHealth.setColaboradorGcalStatus(row.colaborador_id, 'invalid');
          if (changed > 0) result.demoted++;
          log.warn(
            { slot: row.slot, colaboradorId: row.colaborador_id, errorCategory: 'decrypt_failed' },
            'gcal colaborador -> invalid',
          );
          continue;
        }

        const { verdict, errorCategory } = await checkOne(credentials, row.gcal_calendar_id);
        if (verdict === null) {
          result.inconclusive++;
          log.info(
            { slot: row.slot, colaboradorId: row.colaborador_id, errorCategory },
            'gcal colaborador inconclusivo (status preservado)',
          );
          continue;
        }
        const changed = await gcalHealth.setColaboradorGcalStatus(row.colaborador_id, verdict);
        if (verdict === 'invalid') {
          if (changed > 0) result.demoted++;
          log.warn(
            { slot: row.slot, colaboradorId: row.colaborador_id, errorCategory },
            'gcal colaborador -> invalid (active mentiroso corrigido)',
          );
        } else {
          result.healthy++;
        }
      } catch (err: unknown) {
        result.inconclusive++;
        log.error(
          {
            slot: row.slot,
            colaboradorId: row.colaborador_id,
            err: err instanceof Error ? err.message : String(err),
          },
          'gcal colaborador: erro no item',
        );
      }
    }
  }

  return result;
}
