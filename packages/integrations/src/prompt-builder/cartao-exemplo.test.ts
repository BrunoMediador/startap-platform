/**
 * Testes de buildCartaoExemplo (SCRUM-99) — a prévia FIEL do cartão de confirmação que o
 * portal mostra ao dono. Foco:
 *  - o exemplo é o cartão que o cliente RECEBE (CAIXA ALTA, barras, "Responda SIM para
 *    confirmar."), NÃO o cartão "elegante" antigo (mixed-case / "Posso confirmar?");
 *  - individual (agenda) NÃO tem linha de profissional; só estabelecimento tem;
 *  - nome real do negócio + serviço/preço reais entram no cartão;
 *  - FONTE ÚNICA: o exemplo compartilha as MESMAS linhas de cartão da instrução do runtime
 *    (buildCartaoRuntimeBlock) — provado substituindo os placeholders da instrução pelos
 *    valores de amostra e conferindo que as linhas do exemplo aparecem lá.
 */
import { describe, expect, it } from 'vitest';
import { buildCartaoExemplo, buildCartaoRuntimeBlock } from './bloco-estrutural.js';

const SAMPLE = {
  nomeNegocio: 'Barbearia do Zé',
  dia: 'quinta, 24/07',
  horario: '15:00',
  servico: 'Corte',
  valor: 'R$ 65,00',
  profissional: 'Léo',
} as const;

describe('buildCartaoExemplo — variante agenda (individual)', () => {
  it('padrao: CAIXA ALTA + barras + "Responda SIM para confirmar." e SEM profissional', () => {
    const card = buildCartaoExemplo({ modo: 'agenda', area: 'barbearia', sample: SAMPLE });
    expect(card).toBe(
      [
        '💈 Barbearia do Zé',
        '📅 DIA: quinta, 24/07 / ⏰ HORARIO: 15:00 / ✂️ SERVICO: Corte / 💰 VALOR: R$ 65,00',
        'Responda SIM para confirmar. ✅',
      ].join('\n'),
    );
    // Individual NUNCA tem linha de profissional.
    expect(card).not.toContain('PROFISSIONAL');
    expect(card).not.toContain('👤');
    // Não é o cartão "elegante" antigo (nada de bold markdown / "Posso confirmar?").
    expect(card).not.toContain('*');
    expect(card).not.toContain('Posso confirmar');
  });

  it('semeia o nome real do negócio e um serviço/preço reais (não placeholders)', () => {
    const card = buildCartaoExemplo({ modo: 'agenda', area: 'barbearia', sample: SAMPLE });
    expect(card).toContain('Barbearia do Zé');
    expect(card).toContain('Corte');
    expect(card).toContain('R$ 65,00');
    expect(card).not.toContain('<dia>');
    expect(card).not.toContain('<nome do negócio>');
  });

  it('nome ausente cai no placeholder <nome do negócio>', () => {
    const card = buildCartaoExemplo({
      modo: 'agenda',
      area: 'barbearia',
      sample: { ...SAMPLE, nomeNegocio: '' },
    });
    expect(card).toContain('💈 <nome do negócio>');
  });

  it('área não-barbearia troca a marca (salão → 💇, sem 💈)', () => {
    const card = buildCartaoExemplo({ modo: 'agenda', area: 'salao', sample: SAMPLE });
    expect(card).toContain('💇');
    expect(card).not.toContain('💈');
  });

  it('override do dono (emojis do cartao_config) VENCE a área — 🌻 no lugar do 💈', () => {
    const card = buildCartaoExemplo({
      modo: 'agenda',
      area: 'barbearia',
      config: { emojis: { marca: '🌻' } },
      sample: SAMPLE,
    });
    expect(card).toContain('🌻 Barbearia do Zé');
    expect(card).not.toContain('💈');
  });

  it('compacto = uma linha só; detalhado = um campo por linha (layouts distintos)', () => {
    const compacto = buildCartaoExemplo({
      modo: 'agenda',
      area: 'barbearia',
      config: { template: 'compacto' },
      sample: SAMPLE,
    });
    expect(compacto).toBe(
      [
        '💈 Barbearia do Zé — 📅 quinta, 24/07 ⏰ 15:00 ✂️ Corte 💰 R$ 65,00',
        'Responda SIM para confirmar. ✅',
      ].join('\n'),
    );

    const detalhado = buildCartaoExemplo({
      modo: 'agenda',
      area: 'barbearia',
      config: { template: 'detalhado' },
      sample: SAMPLE,
    });
    expect(detalhado).toBe(
      [
        '💈 Barbearia do Zé',
        '📅 DIA: quinta, 24/07',
        '⏰ HORARIO: 15:00',
        '✂️ SERVICO: Corte',
        '💰 VALOR: R$ 65,00',
        'Responda SIM para confirmar. ✅',
      ].join('\n'),
    );
  });
});

describe('buildCartaoExemplo — variante estabelecimento', () => {
  it('padrao: inclui 👤 PROFISSIONAL com o nome, usa 🕐 (não ⏰) e "Responda SIM"', () => {
    const card = buildCartaoExemplo({ modo: 'estabelecimento', area: 'barbearia', sample: SAMPLE });
    expect(card).toBe(
      [
        '👤 PROFISSIONAL: Léo',
        '📅 DIA: quinta, 24/07 / 🕐 HORARIO: 15:00 / ✂️ SERVICO: Corte / 💰 VALOR: R$ 65,00',
        'Responda SIM para confirmar. ✅',
      ].join('\n'),
    );
    expect(card).not.toMatch(/⏰ HORARIO/);
  });

  it('compacto usa o nome do profissional na linha única', () => {
    const card = buildCartaoExemplo({
      modo: 'estabelecimento',
      area: 'barbearia',
      config: { template: 'compacto' },
      sample: SAMPLE,
    });
    expect(card).toContain('👤 Léo — ');
    expect(card).toContain('🕐 15:00');
  });
});

describe('buildCartaoExemplo — atendente', () => {
  it('não tem cartão (string vazia) em qualquer template', () => {
    expect(buildCartaoExemplo({ modo: 'atendente', sample: SAMPLE })).toBe('');
    expect(
      buildCartaoExemplo({ modo: 'atendente', config: { template: 'detalhado' }, sample: SAMPLE }),
    ).toBe('');
  });
});

describe('buildCartaoExemplo — determinismo', () => {
  it('mesma entrada → mesma string (puro)', () => {
    const opts = {
      modo: 'agenda' as const,
      area: 'estetica',
      config: { template: 'detalhado' as const, emojis: { marca: '🌟' } },
      sample: SAMPLE,
    };
    expect(buildCartaoExemplo(opts)).toBe(buildCartaoExemplo(opts));
  });
});

/**
 * FONTE ÚNICA (o coração do SCRUM-99): o exemplo e a instrução do runtime compartilham as
 * MESMAS linhas de cartão. Prova: pega o bloco de instrução do runtime, substitui os
 * placeholders (`<dia>` etc.) pelos valores de amostra, e confirma que TODA linha do exemplo
 * (menos o fechamento amigável) aparece na instrução transformada. Se alguém mudar o layout do
 * cartão em um lado, este teste quebra — impedindo a divergência que causava a "prévia que mente".
 */
describe('buildCartaoExemplo — consistência com o runtime (fonte única)', () => {
  const subst = (s: string): string =>
    s
      .replaceAll('<dia>', SAMPLE.dia)
      .replaceAll('<horario>', SAMPLE.horario)
      .replaceAll('<servico>', SAMPLE.servico)
      .replaceAll('<valor>', SAMPLE.valor)
      .replaceAll('<nome do negócio>', SAMPLE.nomeNegocio)
      .replaceAll('<nome do profissional escolhido>', SAMPLE.profissional)
      .replaceAll('<profissional>', SAMPLE.profissional);

  for (const modo of ['agenda', 'estabelecimento'] as const) {
    for (const template of ['padrao', 'compacto', 'detalhado'] as const) {
      it(`${modo}/${template}: as linhas do exemplo vêm da instrução do runtime`, () => {
        const exemplo = buildCartaoExemplo({
          modo,
          area: 'barbearia',
          config: { template },
          sample: SAMPLE,
        });
        const instrucao = subst(
          buildCartaoRuntimeBlock({
            modo,
            area: 'barbearia',
            config: { template },
            nomeNegocio: SAMPLE.nomeNegocio,
          }),
        );
        // Toda linha de campo do exemplo (exceto o fechamento amigável) aparece na instrução.
        const linhas = exemplo.split('\n').filter((l) => !l.startsWith('Responda SIM'));
        for (const linha of linhas) {
          expect(instrucao).toContain(linha);
        }
      });
    }
  }
});
