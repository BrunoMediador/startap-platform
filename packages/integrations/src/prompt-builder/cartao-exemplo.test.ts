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
import {
  CARTAO_EMOJI_DISABLED,
  type CartaoExemploSegmento,
  buildCartaoExemplo,
  buildCartaoExemploSegmentado,
  buildCartaoRuntimeBlock,
} from './bloco-estrutural.js';

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

/**
 * Emoji DESABILITADO no EXEMPLO (prévia do portal) — mesma regra do runtime: some só o ícone,
 * a linha fica, sem espaço órfão. Cobre os 3 templates × agenda/estabelecimento.
 */
describe('buildCartaoExemplo — emoji DESABILITADO não deixa espaço órfão', () => {
  it('padrao: marca desabilitada → "Barbearia do Zé" sem espaço à esquerda', () => {
    const card = buildCartaoExemplo({
      modo: 'agenda',
      area: 'barbearia',
      config: { emojis: { marca: CARTAO_EMOJI_DISABLED } },
      sample: SAMPLE,
    });
    expect(card.split('\n')[0]).toBe('Barbearia do Zé');
  });

  it('compacto: todos os emojis desabilitados → linha só com separadores intactos', () => {
    const card = buildCartaoExemplo({
      modo: 'agenda',
      area: 'barbearia',
      config: {
        template: 'compacto',
        emojis: {
          marca: CARTAO_EMOJI_DISABLED,
          dia: CARTAO_EMOJI_DISABLED,
          horario: CARTAO_EMOJI_DISABLED,
          servico: CARTAO_EMOJI_DISABLED,
          valor: CARTAO_EMOJI_DISABLED,
          confirma: CARTAO_EMOJI_DISABLED,
        },
      },
      sample: SAMPLE,
    });
    expect(card).toBe(
      ['Barbearia do Zé — quinta, 24/07 15:00 Corte R$ 65,00', 'Responda SIM para confirmar.'].join(
        '\n',
      ),
    );
    expect(card).not.toMatch(/ {2,}/);
  });

  it('detalhado (estabelecimento): profissional desabilitado → "PROFISSIONAL: Léo" sem ícone', () => {
    const card = buildCartaoExemplo({
      modo: 'estabelecimento',
      area: 'barbearia',
      config: { template: 'detalhado', emojis: { profissional: CARTAO_EMOJI_DISABLED } },
      sample: SAMPLE,
    });
    expect(card.split('\n')[0]).toBe('PROFISSIONAL: Léo');
  });
});

/**
 * buildCartaoExemploSegmentado (item 4 do plano — PR 2 vai tornar os emojis clicáveis na
 * prévia). Prova: RECONSTRUÇÃO byte-a-byte (juntar os `valor` dos segmentos = a string de
 * buildCartaoExemplo, a MESMA fonte) + slots corretos mesmo com o MESMO emoji em 2 campos
 * (caso real: Samuel tem marca=servico=✂️) + emoji desabilitado não vira segmento fantasma.
 */
describe('buildCartaoExemploSegmentado — fonte única com buildCartaoExemplo', () => {
  const juntarSegmentos = (segs: CartaoExemploSegmento[]): string =>
    segs.map((s) => s.valor).join('');

  it('atendente → lista vazia (espelha string vazia)', () => {
    expect(buildCartaoExemploSegmentado({ modo: 'atendente', sample: SAMPLE })).toEqual([]);
  });

  for (const modo of ['agenda', 'estabelecimento'] as const) {
    for (const template of ['padrao', 'compacto', 'detalhado'] as const) {
      it(`${modo}/${template}: reconstrução dos segmentos === buildCartaoExemplo (byte-a-byte)`, () => {
        const opts = { modo, area: 'barbearia', config: { template }, sample: SAMPLE };
        const stringVersion = buildCartaoExemplo(opts);
        const segs = buildCartaoExemploSegmentado(opts);
        expect(juntarSegmentos(segs)).toBe(stringVersion);
      });
    }
  }

  it('CRÍTICO (Samuel: marca=servico=✂️): os 2 segmentos de emoji têm SLOTS diferentes, não confundidos', () => {
    const segs = buildCartaoExemploSegmentado({
      modo: 'agenda',
      area: 'barbearia',
      sample: SAMPLE, // servico: 'Corte' — emoji vem do default da área (✂️ pra ambos marca/servico? não: marca=💈)
    });
    // Força colisão real: override marca também pra ✂️ (mesmo emoji que servico já usa por default).
    const segsColisao = buildCartaoExemploSegmentado({
      modo: 'agenda',
      area: 'barbearia',
      config: { emojis: { marca: '✂️' } },
      sample: SAMPLE,
    });
    const emojiSegs = segsColisao.filter(
      (s): s is CartaoExemploSegmento & { tipo: 'emoji' } => s.tipo === 'emoji',
    );
    const marcaSeg = emojiSegs.find((s) => s.slot === 'marca');
    const servicoSeg = emojiSegs.find((s) => s.slot === 'servico');
    expect(marcaSeg?.valor).toBe('✂️');
    expect(servicoSeg?.valor).toBe('✂️');
    // Mesmo emoji, slots DISTINTOS — não é 1 segmento compartilhado por engano.
    expect(marcaSeg).not.toBe(servicoSeg);
    expect(segs.length).toBeGreaterThan(0); // (asserção trivial, mantém `segs` usado)
  });

  it('emoji desabilitado NÃO vira segmento (a linha perde só o ícone, igual à string)', () => {
    const segs = buildCartaoExemploSegmentado({
      modo: 'agenda',
      area: 'barbearia',
      config: { emojis: { marca: CARTAO_EMOJI_DISABLED } },
      sample: SAMPLE,
    });
    expect(segs.some((s) => s.tipo === 'emoji' && s.slot === 'marca')).toBe(false);
    expect(juntarSegmentos(segs).split('\n')[0]).toBe('Barbearia do Zé');
  });

  it('todo segmento emoji carrega slot; todo segmento texto não', () => {
    const segs = buildCartaoExemploSegmentado({
      modo: 'estabelecimento',
      area: 'barbearia',
      sample: SAMPLE,
    });
    for (const s of segs) {
      if (s.tipo === 'emoji') expect(s.slot).toBeDefined();
      else expect(s.slot).toBeUndefined();
    }
  });
});
