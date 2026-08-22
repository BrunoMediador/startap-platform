import { describe, expect, it } from 'vitest';
import {
  BLOQUEIO_TIPO_OPTIONS,
  bloqueioEtapaAtual,
  bloqueioResumoAcao,
  bloqueioUsaDiaInteiroPorPadrao,
  nomeGrupoAgendaBloqueio,
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
    expect(
      bloqueioEtapaAtual({
        canPickProfissional: true,
        profissionalSelecionado: false,
        repetir: false,
        temPrevia: false,
      }),
    ).toBe(1);
    expect(
      bloqueioEtapaAtual({
        canPickProfissional: true,
        profissionalSelecionado: true,
        repetir: false,
        temPrevia: false,
      }),
    ).toBe(3);
    expect(
      bloqueioEtapaAtual({
        canPickProfissional: false,
        profissionalSelecionado: true,
        repetir: true,
        temPrevia: false,
      }),
    ).toBe(3);
    expect(
      bloqueioEtapaAtual({
        canPickProfissional: false,
        profissionalSelecionado: true,
        repetir: true,
        temPrevia: true,
      }),
    ).toBe(4);
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
    expect(remocaoSerieProximasDescricao()).toContain(
      'tentar remover todas as próximas ocorrências',
    );
    expect(remocaoSerieProximasDescricao()).toContain('Não há escolha de data inicial');
  });

  it('nomeia a agenda do colaborador sem expor um identificador interno', () => {
    expect(
      nomeGrupoAgendaBloqueio({
        mode: 'colaborador',
        colaboradorId: 42,
        nomeProfissional: undefined,
      }),
    ).toBe('Minha agenda');
    expect(
      nomeGrupoAgendaBloqueio({ mode: 'owner', colaboradorId: 42, nomeProfissional: undefined }),
    ).toBe('Profissional da equipe');
  });
});
