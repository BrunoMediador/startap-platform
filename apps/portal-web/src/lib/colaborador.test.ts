import { describe, expect, it } from 'vitest';
import {
  COLABORADOR_HOME,
  OWNER_HOME,
  getColaboradorNav,
  loginRedirectPath,
} from './colaborador';

describe('loginRedirectPath', () => {
  it('manda colaborador pra agenda read-only', () => {
    expect(loginRedirectPath('colaborador')).toBe(COLABORADOR_HOME);
  });

  it('manda owner explicito pra /inicio', () => {
    expect(loginRedirectPath('owner')).toBe(OWNER_HOME);
  });

  it('trata role AUSENTE (owner legado pre-#394) como dono', () => {
    expect(loginRedirectPath(undefined)).toBe(OWNER_HOME);
    expect(loginRedirectPath(null)).toBe(OWNER_HOME);
  });

  it('NUNCA vaza o dono pro painel do colaborador num valor inesperado', () => {
    // Defesa: só o literal 'colaborador' abre a area read-only; ruido cai no dono.
    expect(loginRedirectPath('admin')).toBe(OWNER_HOME);
    expect(loginRedirectPath('')).toBe(OWNER_HOME);
    expect(loginRedirectPath('Colaborador')).toBe(OWNER_HOME); // case-sensitive de proposito
  });
});

describe('getColaboradorNav', () => {
  it('esconde Clientes enquanto o CRM estiver OFF', () => {
    expect(getColaboradorNav(false).map((item) => item.href)).toEqual([
      '/colaborador/agenda',
      '/colaborador/comissao',
    ]);
  });

  it('inclui Clientes entre Agenda e Faturamento quando o CRM estiver ON', () => {
    expect(getColaboradorNav(true).map((item) => item.href)).toEqual([
      '/colaborador/agenda',
      '/colaborador/clientes',
      '/colaborador/comissao',
    ]);
  });
});
