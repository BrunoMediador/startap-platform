/**
 * SCRUM-117 — guarda de regressão: telefone de cliente final NUNCA em CLARO no log
 * do núcleo bot/router (Regra de Ouro nº6 do CLAUDE.md; LGPD).
 *
 * Antes deste fix, o núcleo logava `log.info({ telefone, ... })` com o número cru
 * (confirmado ao vivo na auditoria 360: `{"telefone":"55...","flowId":"clone_..."}`)
 * e chegou a dumpar o `body.payload` inteiro (from/remoteJid/texto). O fix passou a
 * mascarar via `phoneLogTag` (packages/core/src/phone.ts).
 *
 * Este teste LÊ O SOURCE (padrão da casa, PR #491) e falha se qualquer chamada de
 * log pino nos arquivos do núcleo voltar a passar o telefone cru como campo, ou a
 * dumpar o payload cru. É determinístico e não depende de capturar stdout.
 *
 * ⚠️ v2 (review security #501): a v1 fatiava a partir de `log.<nível>(` e só olhava a
 * MESMA linha — como o biome quebra objetos longos em várias linhas, `log.warn(` ficava
 * numa linha e `{ telefone, … }` na seguinte, e o guard NUNCA escaneava o objeto
 * (falso-verde apesar de 23 vazamentos). Agora o parser extrai a chamada INTEIRA por
 * BALANCEAMENTO DE PARÊNTESES (multi-linha, ciente de strings) antes de checar.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));

// Arquivos do núcleo bot/router que recebem/roteiam o telefone do cliente final.
const NUCLEO_FILES = ['router.ts', 'bots/base.ts', 'bots/startap.ts', 'bots/teste_barbearia.ts'];

// Início de uma chamada de log pino: `log.info(`, `this.log.warn(`, etc. O `\b` impede
// casar `flowExecutionLog.logFlowEvent(` (DB de auditoria, sink legítimo separado).
const LOG_CALL = /(?:this\.)?\blog\.(?:info|warn|error|debug|trace|fatal)\(/g;

/**
 * Extrai o texto COMPLETO de cada chamada de log pino de `src`, do `(` de abertura ao
 * `)` casado — atravessando newlines e ignorando parênteses dentro de strings/templates.
 * Sem isto o guard é cego a objetos multi-linha (o bug do falso-verde do #501).
 */
function extractLogCalls(src: string): string[] {
  const calls: string[] = [];
  LOG_CALL.lastIndex = 0;
  let m: RegExpExecArray | null;
  // biome-ignore lint/suspicious/noAssignInExpressions: idioma de varredura de regex global
  while ((m = LOG_CALL.exec(src)) !== null) {
    // Índice do `(` de abertura (o último char do match).
    let i = m.index + m[0].length - 1;
    let depth = 0;
    let str: string | null = null; // aspa aberta: ' " ou `
    const start = i;
    for (; i < src.length; i++) {
      const c = src[i];
      const prev = src[i - 1];
      if (str) {
        if (c === str && prev !== '\\') str = null;
        continue;
      }
      if (c === "'" || c === '"' || c === '`') {
        str = c;
        continue;
      }
      if (c === '(') depth++;
      else if (c === ')') {
        depth--;
        if (depth === 0) {
          calls.push(src.slice(start, i + 1));
          break;
        }
      }
    }
  }
  return calls;
}

/**
 * true se a chamada de log expõe telefone cru ou DUMPA o payload/body do webhook.
 * Ignora: (a) strings/comentários — "telefone" na MENSAGEM do log é ok; (b) usos
 * mascarados phoneLogTag/phoneHint; (c) ACESSO a subcampo do payload
 * (body.payload?.foo, ex.: addressingMode de diagnóstico) — só o DUMP do objeto
 * inteiro (`payload: body.payload` / `body.payload` como valor) é vazamento.
 */
function leaks(callText: string): boolean {
  const s = callText
    // strings e templates viram vazios (o texto da mensagem não conta como campo)
    .replace(/'(?:[^'\\]|\\.)*'/g, "''")
    .replace(/"(?:[^"\\]|\\.)*"/g, '""')
    .replace(/`(?:[^`\\]|\\.)*`/g, '``')
    // comentários de linha somem
    .replace(/\/\/[^\n]*/g, '')
    // usos LEGÍTIMOS (mascarados) somem antes de procurar o cru
    .replace(/phoneLogTag\([^)]*\)/g, '')
    .replace(/phoneHint\([^)]*\)/g, '');
  const rawPhone = /\btelefone\b/.test(s);
  // Dump do objeto inteiro; subcampo (body.payload?. / body.payload._ / [..]) é seguro.
  const payloadDump = /\bbody\.payload\b(?!\s*[?.[])/.test(s) || /\bpayload:\s*body\b/.test(s);
  return rawPhone || payloadDump;
}

describe('SCRUM-117 — nenhum telefone cru em log do núcleo', () => {
  for (const rel of NUCLEO_FILES) {
    it(`${rel}: nenhuma chamada de log expõe telefone cru nem body.payload`, () => {
      const src = readFileSync(join(HERE, rel), 'utf8');
      const offenders = extractLogCalls(src)
        .filter(leaks)
        .map((c) => c.replace(/\s+/g, ' ').slice(0, 120));
      expect(offenders, `Telefone cru / payload em log:\n${offenders.join('\n')}`).toEqual([]);
    });
  }

  it('o parser É multi-linha (o que a v1 do #501 não era) e casa o vazamento antigo', () => {
    // Reproduz EXATAMENTE o formato quebrado pelo biome que enganou a v1: `log.warn(`
    // numa linha e o objeto `{ telefone, ... }` nas seguintes.
    const multilineLeak = [
      'log.warn(',
      '  {',
      '    telefone,',
      '    flowId: route.workflow_id,',
      '  },',
      "  'Fluxo suspenso',",
      ');',
    ].join('\n');
    const calls = extractLogCalls(multilineLeak);
    expect(calls).toHaveLength(1); // extraiu a chamada inteira, multi-linha
    expect(leaks(calls[0])).toBe(true); // e ACUSA o telefone cru

    // Dump de payload multi-linha também é pego.
    const payloadDump = 'log.warn(\n  { payload: body.payload },\n  "x",\n);';
    expect(extractLogCalls(payloadDump).some(leaks)).toBe(true);
  });

  it('a forma corrigida (mascarada, multi-linha) NÃO acusa', () => {
    const safe = [
      'log.info(',
      '  {',
      '    fone: phoneLogTag(telefone),',
      '    flowId: route.workflow_id,',
      '  },',
      "  'Mensagem processada',",
      ');',
    ].join('\n');
    const calls = extractLogCalls(safe);
    expect(calls).toHaveLength(1);
    expect(leaks(calls[0])).toBe(false);
  });

  it('não confunde o sink de DB (logFlowEvent) com log pino', () => {
    // `flowExecutionLog.logFlowEvent({ ...phoneLog, ... })` NÃO é `log.<nível>(` e o
    // parser não deve extraí-lo — a trilha de auditoria com telefone é sink separado.
    const dbSink = 'await flowExecutionLog.logFlowEvent({ ...phoneLog, eventType: "x" });';
    expect(extractLogCalls(dbSink)).toHaveLength(0);
  });
});
