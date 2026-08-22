import { describe, expect, it } from 'vitest';
import {
  BLOQUEIO_TIPO_OPTIONS,
  bloqueioEtapaAtual,
  bloqueioResumoAcao,
  bloqueioUsaDiaInteiroPorPadrao,
  remocaoSerieProximasDescricao,
} from './agenda-bloqueios-ui';

describe('fluxo visual de bloqueios', () => {
  it('mantém os quatro tipos que o contrato da API aceita', () => {
    expect(BLOQUEIO_TIPO_OPTIONS.map((item) => item.value)).toEqual([
      'almoco',
      'ausencia',
      'ferias',
      'indisponivel',
    ]);
  });

  it('só apresenta a revisão como etapa atual depois de receber a prévia', () => {
    expect(bloqueioEtapaAtual({ repetir: false, temPrevia: false })).toBe(3);
    expect(bloqueioEtapaAtual({ repetir: true, temPrevia: false })).toBe(3);
    expect(bloqueioEtapaAtual({ repetir: true, temPrevia: true })).toBe(4);
  });

  it('nomeia a ação conforme a progressão sem prometer resultado da prévia', () => {
    expect(bloqueioResumoAcao({ repetir: false, temPrevia: false, resultado: false })).toBe(
      'Criar bloqueio',
    );
    expect(bloqueioResumoAcao({ repetir: true, temPrevia: false, resultado: false })).toBe(
      'Ver prévia',
    );
    expect(bloqueioResumoAcao({ repetir: true, temPrevia: true, resultado: false })).toBe(
      'Criar série',
    );
  });

  it('oferece dia inteiro por padrão para ausência e férias, sem mudar almoço', () => {
    expect(bloqueioUsaDiaInteiroPorPadrao('ausencia')).toBe(true);
    expect(bloqueioUsaDiaInteiroPorPadrao('ferias')).toBe(true);
    expect(bloqueioUsaDiaInteiroPorPadrao('almoco')).toBe(false);
    expect(bloqueioUsaDiaInteiroPorPadrao('indisponivel')).toBe(false);
  });

  it('não promete corte por data ao remover as próximas ocorrências de uma série', () => {
    expect(remocaoSerieProximasDescricao()).toContain('Todas as próximas ocorrências');
    expect(remocaoSerieProximasDescricao()).toContain('Não há escolha de data inicial');
  });
});
