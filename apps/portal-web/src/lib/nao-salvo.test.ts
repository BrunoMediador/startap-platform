import { describe, expect, it, vi } from 'vitest';
import {
  type CliqueAncora,
  type Modificadores,
  type RegistroNaoSalvo,
  descreveSecoesSujas,
  deveInterceptarClique,
  salvarTodos,
  sujos,
} from './nao-salvo';

const ORIGEM = 'https://app.startap.tech';
const PATH_ATUAL = '/atendente/mensagens';

function mods(over: Partial<Modificadores> = {}): Modificadores {
  return {
    defaultPrevented: false,
    button: 0,
    metaKey: false,
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    ...over,
  };
}

function ancora(over: Partial<CliqueAncora> = {}): CliqueAncora {
  return { href: '/inicio', download: false, target: null, ...over };
}

describe('deveInterceptarClique', () => {
  it('link interno diferente do atual -> intercepta e devolve o destino', () => {
    expect(deveInterceptarClique(ancora({ href: '/inicio' }), ORIGEM, PATH_ATUAL, mods())).toBe(
      '/inicio',
    );
  });

  it('preserva search e hash do destino', () => {
    expect(
      deveInterceptarClique(ancora({ href: '/negocio/dados?x=1#tab' }), ORIGEM, PATH_ATUAL, mods()),
    ).toBe('/negocio/dados?x=1#tab');
  });

  it('href relativo é resolvido contra a origem', () => {
    expect(deveInterceptarClique(ancora({ href: 'planos' }), ORIGEM, PATH_ATUAL, mods())).toBe(
      '/planos',
    );
  });

  it('origem externa -> null', () => {
    expect(
      deveInterceptarClique(
        ancora({ href: 'https://outro.com/pagina' }),
        ORIGEM,
        PATH_ATUAL,
        mods(),
      ),
    ).toBeNull();
  });

  it('âncora (#hash) -> null', () => {
    expect(
      deveInterceptarClique(ancora({ href: '#secao' }), ORIGEM, PATH_ATUAL, mods()),
    ).toBeNull();
  });

  it('target=_blank -> null', () => {
    expect(
      deveInterceptarClique(
        ancora({ href: '/inicio', target: '_blank' }),
        ORIGEM,
        PATH_ATUAL,
        mods(),
      ),
    ).toBeNull();
  });

  it('download -> null', () => {
    expect(
      deveInterceptarClique(
        ancora({ href: '/arquivo.pdf', download: true }),
        ORIGEM,
        PATH_ATUAL,
        mods(),
      ),
    ).toBeNull();
  });

  it('mesmo pathname (âncora da própria página) -> null', () => {
    expect(
      deveInterceptarClique(ancora({ href: PATH_ATUAL }), ORIGEM, PATH_ATUAL, mods()),
    ).toBeNull();
  });

  it.each([
    ['metaKey', mods({ metaKey: true })],
    ['ctrlKey', mods({ ctrlKey: true })],
    ['shiftKey', mods({ shiftKey: true })],
    ['altKey', mods({ altKey: true })],
  ])('modificador %s -> null', (_label, m) => {
    expect(deveInterceptarClique(ancora(), ORIGEM, PATH_ATUAL, m)).toBeNull();
  });

  it('botão diferente de 0 (ex.: clique do meio) -> null', () => {
    expect(deveInterceptarClique(ancora(), ORIGEM, PATH_ATUAL, mods({ button: 1 }))).toBeNull();
  });

  it('defaultPrevented -> null', () => {
    expect(
      deveInterceptarClique(ancora(), ORIGEM, PATH_ATUAL, mods({ defaultPrevented: true })),
    ).toBeNull();
  });

  it('sem âncora (clique fora de link) -> null', () => {
    expect(deveInterceptarClique(null, ORIGEM, PATH_ATUAL, mods())).toBeNull();
  });

  it('href ausente -> null', () => {
    expect(deveInterceptarClique(ancora({ href: null }), ORIGEM, PATH_ATUAL, mods())).toBeNull();
  });

  it('href malformado não lança -> null', () => {
    expect(
      deveInterceptarClique(ancora({ href: 'http://' }), ORIGEM, PATH_ATUAL, mods()),
    ).toBeNull();
  });
});

describe('sujos', () => {
  it('filtra só os registros com dirty=true, preservando ordem', () => {
    const regs: RegistroNaoSalvo[] = [
      { nome: 'A', dirty: false, salvar: vi.fn() },
      { nome: 'B', dirty: true, salvar: vi.fn() },
      { nome: 'C', dirty: true, salvar: vi.fn() },
    ];
    expect(sujos(regs).map((r) => r.nome)).toEqual(['B', 'C']);
  });

  it('nenhuma suja -> []', () => {
    expect(sujos([{ nome: 'A', dirty: false, salvar: vi.fn() }])).toEqual([]);
  });
});

describe('salvarTodos — regressão do bug (2 seções sujas juntas, SCRUM-158)', () => {
  it('duas seções sujas -> chama salvar das DUAS, ok:true', async () => {
    const salvarTom = vi.fn().mockResolvedValue(undefined);
    const salvarCartao = vi.fn().mockResolvedValue(undefined);
    const regs: RegistroNaoSalvo[] = [
      { nome: 'Tom da conversa', dirty: true, salvar: salvarTom },
      { nome: 'Cartão de confirmação', dirty: true, salvar: salvarCartao },
    ];
    const res = await salvarTodos(sujos(regs));
    expect(res).toEqual({ ok: true });
    expect(salvarTom).toHaveBeenCalledTimes(1);
    expect(salvarCartao).toHaveBeenCalledTimes(1);
  });

  it('uma das duas rejeita -> ok:false (não navega)', async () => {
    const salvarTom = vi.fn().mockResolvedValue(undefined);
    const salvarCartao = vi.fn().mockRejectedValue(new Error('save-falhou'));
    const regs: RegistroNaoSalvo[] = [
      { nome: 'Tom da conversa', dirty: true, salvar: salvarTom },
      { nome: 'Cartão de confirmação', dirty: true, salvar: salvarCartao },
    ];
    const res = await salvarTodos(sujos(regs));
    expect(res).toEqual({ ok: false });
  });

  it('registro síncrono (sem Promise) é aceito', async () => {
    const sincrono = vi.fn();
    const res = await salvarTodos([{ nome: 'X', dirty: true, salvar: sincrono }]);
    expect(res).toEqual({ ok: true });
    expect(sincrono).toHaveBeenCalledTimes(1);
  });

  it('lista vazia -> ok:true sem chamar nada', async () => {
    expect(await salvarTodos([])).toEqual({ ok: true });
  });
});

describe('descreveSecoesSujas', () => {
  it('0 seções -> string vazia', () => {
    expect(descreveSecoesSujas([])).toBe('');
  });

  it('1 seção -> só o nome', () => {
    expect(descreveSecoesSujas(['Tom da conversa'])).toBe('Tom da conversa');
  });

  it('2 seções -> "A e B"', () => {
    expect(descreveSecoesSujas(['Tom da conversa', 'Cartão de confirmação'])).toBe(
      'Tom da conversa e Cartão de confirmação',
    );
  });

  it('3+ seções -> vírgulas + "e" antes da última', () => {
    expect(descreveSecoesSujas(['A', 'B', 'C'])).toBe('A, B e C');
    expect(descreveSecoesSujas(['A', 'B', 'C', 'D'])).toBe('A, B, C e D');
  });
});
