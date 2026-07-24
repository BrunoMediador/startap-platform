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
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));

// Arquivos do núcleo bot/router que recebem/roteiam o telefone do cliente final.
const NUCLEO_FILES = ['router.ts', 'bots/base.ts', 'bots/startap.ts', 'bots/teste_barbearia.ts'];

// Início de uma chamada de log pino: `log.info(`, `this.log.warn(`, etc.
const LOG_CALL = /(?:this\.)?log\.(?:info|warn|error|debug|trace|fatal)\(/;

describe('SCRUM-117 — nenhum telefone cru em log do núcleo', () => {
  for (const rel of NUCLEO_FILES) {
    it(`${rel}: chamadas de log não expõem telefone cru nem body.payload`, () => {
      const src = readFileSync(join(HERE, rel), 'utf8');
      const offenders: string[] = [];

      src.split('\n').forEach((line, i) => {
        const m = line.match(LOG_CALL);
        if (!m || m.index === undefined) return;
        // Só o que vem DEPOIS do `log.<nível>(` importa (evita falso-positivo quando
        // `telefone` aparece antes na linha, ex.: antibot.logMessage(telefone).catch(e=>log.warn(e))).
        let afterCall = line.slice(m.index);
        // Remove os usos LEGÍTIMOS (mascarados) antes de checar o cru.
        afterCall = afterCall.replace(/phoneLogTag\([^)]*\)/g, '');
        afterCall = afterCall.replace(/phoneHint\([^)]*\)/g, '');
        // `telefone` como campo/valor de log (bare) = vazamento.
        if (/\btelefone\b/.test(afterCall)) {
          offenders.push(`${rel}:${i + 1}  ${line.trim()}`);
        }
        // Dump do payload/body cru no log = vazamento (from/remoteJid/texto).
        if (/\bbody\.payload\b|\bpayload:\s*body\b/.test(afterCall)) {
          offenders.push(`${rel}:${i + 1}  ${line.trim()}`);
        }
      });

      expect(offenders, `Telefone cru / payload em log:\n${offenders.join('\n')}`).toEqual([]);
    });
  }

  it('prova que o padrão de vazamento antigo casaria (não é regex morta)', () => {
    // Se o núcleo voltasse a logar cru, o detector acima acusaria — provado aqui.
    const leaky = `log.info({ telefone, flowId: route.workflow_id }, 'x');`;
    const m = leaky.match(LOG_CALL);
    const after = leaky.slice(m?.index ?? 0).replace(/phoneLogTag\([^)]*\)/g, '');
    expect(/\btelefone\b/.test(after)).toBe(true);

    // E a forma corrigida (mascarada) NÃO acusa.
    const safe = `log.info({ fone: phoneLogTag(telefone), flowId: x }, 'x');`;
    const m2 = safe.match(LOG_CALL);
    const after2 = safe.slice(m2?.index ?? 0).replace(/phoneLogTag\([^)]*\)/g, '');
    expect(/\btelefone\b/.test(after2)).toBe(false);
  });
});
