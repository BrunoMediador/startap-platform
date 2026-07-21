import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from './api';
import {
  BUILDER_MAX_INPUT,
  PERSONA_MAX_CHARS,
  appendMessage,
  approveBuilder,
  buildApproveBody,
  fetchBuilderDraft,
  isBuilderUnavailable,
  isPersonaSavable,
  isSendable,
  personaCharsLeft,
  remainingChars,
  sendBuilderMessage,
  startBuilder,
} from './prompt-builder';

// Mocka o cliente HTTP: o que importa testar é o MAPA status/erro -> outcome, não a
// rede. Cada caso controla o que apiFetch resolve/rejeita (mesmo padrão de demo-chat).
const apiFetchMock = vi.fn();
vi.mock('./api', async (importOriginal) => {
  const real = await importOriginal<typeof import('./api')>();
  return { ...real, apiFetch: (...args: unknown[]) => apiFetchMock(...args) };
});

afterEach(() => apiFetchMock.mockReset());

describe('startBuilder — mapa de outcome', () => {
  it('200 mapeia pergunta/draftReady/retomada', async () => {
    apiFetchMock.mockResolvedValue({
      session_id: 's',
      pergunta: 'Como ele deve falar?',
      draft_ready: false,
      retomada: true,
    });
    expect(await startBuilder()).toEqual({
      kind: 'ok',
      pergunta: 'Como ele deve falar?',
      draftReady: false,
      retomada: true,
    });
  });

  it('pergunta ausente degrada pra string vazia (sem crash)', async () => {
    apiFetchMock.mockResolvedValue({ session_id: 's', draft_ready: true, retomada: false });
    expect(await startBuilder()).toEqual({
      kind: 'ok',
      pergunta: '',
      draftReady: true,
      retomada: false,
    });
  });

  it('404 / 502 / 503 -> unavailable (feature off / upstream fora)', async () => {
    for (const status of [404, 502, 503]) {
      apiFetchMock.mockRejectedValueOnce(new ApiError(status, 'x', null));
      expect(await startBuilder()).toEqual({ kind: 'unavailable' });
    }
  });

  it('500 e falha de rede -> error', async () => {
    apiFetchMock.mockRejectedValueOnce(new ApiError(500, 'boom', null));
    expect(await startBuilder()).toEqual({ kind: 'error' });
    apiFetchMock.mockRejectedValueOnce(new ApiError(0, 'sem conexao', null));
    expect(await startBuilder()).toEqual({ kind: 'error' });
  });
});

describe('sendBuilderMessage — mapa de outcome', () => {
  it('200 mapeia reply + draftReady + resumo + nomeBot', async () => {
    apiFetchMock.mockResolvedValue({
      reply: 'Anotado!',
      draft_ready: true,
      resumo: 'Descontraído, chama de Léo',
      nome_do_bot: 'Léo',
    });
    expect(await sendBuilderMessage('quero descontraído')).toEqual({
      kind: 'ok',
      reply: 'Anotado!',
      draftReady: true,
      resumo: 'Descontraído, chama de Léo',
      nomeBot: 'Léo',
    });
  });

  it('rate-limit chega como 200 canned -> ok (a copy é só a reply)', async () => {
    apiFetchMock.mockResolvedValue({
      reply: 'Por hoje já deu :) tenta amanhã',
      draft_ready: false,
    });
    expect(await sendBuilderMessage('oi')).toEqual({
      kind: 'ok',
      reply: 'Por hoje já deu :) tenta amanhã',
      draftReady: false,
      resumo: null,
      nomeBot: null,
    });
  });

  it('nome_do_bot null (sem nome) vira nomeBot null', async () => {
    apiFetchMock.mockResolvedValue({
      reply: 'ok',
      draft_ready: true,
      resumo: 'r',
      nome_do_bot: null,
    });
    const out = await sendBuilderMessage('x');
    expect(out).toMatchObject({ kind: 'ok', nomeBot: null, resumo: 'r' });
  });

  it('409 -> not_started; 400 -> invalid', async () => {
    apiFetchMock.mockRejectedValueOnce(new ApiError(409, 'entrevista_nao_iniciada', null));
    expect(await sendBuilderMessage('x')).toEqual({ kind: 'not_started' });
    apiFetchMock.mockRejectedValueOnce(new ApiError(400, 'dados_invalidos', null));
    expect(await sendBuilderMessage('x')).toEqual({ kind: 'invalid' });
  });

  it('404 / 502 / 503 -> unavailable', async () => {
    for (const status of [404, 502, 503]) {
      apiFetchMock.mockRejectedValueOnce(new ApiError(status, 'x', null));
      expect(await sendBuilderMessage('x')).toEqual({ kind: 'unavailable' });
    }
  });

  it('500 e rede -> error', async () => {
    apiFetchMock.mockRejectedValueOnce(new ApiError(500, 'boom', null));
    expect(await sendBuilderMessage('x')).toEqual({ kind: 'error' });
    apiFetchMock.mockRejectedValueOnce(new ApiError(0, 'sem conexao', null));
    expect(await sendBuilderMessage('x')).toEqual({ kind: 'error' });
  });
});

describe('approveBuilder — mapa de outcome', () => {
  it('200 mapeia versionSaved', async () => {
    apiFetchMock.mockResolvedValue({ ok: true, persona_aplicada: true, version_saved: 7 });
    expect(await approveBuilder()).toEqual({ kind: 'ok', versionSaved: 7 });
  });

  it('version_saved null preservado', async () => {
    apiFetchMock.mockResolvedValue({ ok: true, persona_aplicada: true, version_saved: null });
    expect(await approveBuilder()).toEqual({ kind: 'ok', versionSaved: null });
  });

  it('409 -> no_draft; 422 -> invalid; 400 -> invalid; 404 -> unavailable; 500 -> error', async () => {
    apiFetchMock.mockRejectedValueOnce(new ApiError(409, 'sem_rascunho', null));
    expect(await approveBuilder()).toEqual({ kind: 'no_draft' });
    apiFetchMock.mockRejectedValueOnce(new ApiError(422, 'rascunho_insuficiente', null));
    expect(await approveBuilder()).toEqual({ kind: 'invalid' });
    // 400 = persona_editada fora de 1..4000 ou campo extra (schema .strict()).
    apiFetchMock.mockRejectedValueOnce(new ApiError(400, 'dados_invalidos', null));
    expect(await approveBuilder('x')).toEqual({ kind: 'invalid' });
    apiFetchMock.mockRejectedValueOnce(new ApiError(404, 'recurso_indisponivel', null));
    expect(await approveBuilder()).toEqual({ kind: 'unavailable' });
    apiFetchMock.mockRejectedValueOnce(new ApiError(500, 'falha_ao_salvar', null));
    expect(await approveBuilder()).toEqual({ kind: 'error' });
  });

  it('sem persona editada -> POST SEM body (aprova o rascunho, request byte-idêntico)', async () => {
    apiFetchMock.mockResolvedValue({ ok: true, persona_aplicada: true, version_saved: 3 });
    await approveBuilder();
    expect(apiFetchMock).toHaveBeenCalledWith('/portal/prompt-builder/approve', { method: 'POST' });
  });

  it('persona editada não-vazia -> POST com body { persona_editada } (trim aplicado)', async () => {
    apiFetchMock.mockResolvedValue({ ok: true, persona_aplicada: true, version_saved: 4 });
    await approveBuilder('  Você é o Léo, descontraído  ');
    expect(apiFetchMock).toHaveBeenCalledWith('/portal/prompt-builder/approve', {
      method: 'POST',
      body: { persona_editada: 'Você é o Léo, descontraído' },
    });
  });

  it('persona só-espaço -> POST SEM body (cai no caminho "aprovar rascunho")', async () => {
    apiFetchMock.mockResolvedValue({ ok: true, persona_aplicada: true, version_saved: 5 });
    await approveBuilder('   ');
    expect(apiFetchMock).toHaveBeenCalledWith('/portal/prompt-builder/approve', { method: 'POST' });
  });
});

describe('buildApproveBody — montagem do body persona_editada', () => {
  it('ausente/vazio/só-espaço -> undefined (aprova rascunho, sem body)', () => {
    expect(buildApproveBody()).toBeUndefined();
    expect(buildApproveBody(undefined)).toBeUndefined();
    expect(buildApproveBody(null)).toBeUndefined();
    expect(buildApproveBody('')).toBeUndefined();
    expect(buildApproveBody('   \n  ')).toBeUndefined();
  });

  it('texto não-vazio -> { persona_editada: <trim> }', () => {
    expect(buildApproveBody('Léo brincalhão')).toEqual({ persona_editada: 'Léo brincalhão' });
    expect(buildApproveBody('  espaços nas bordas  ')).toEqual({
      persona_editada: 'espaços nas bordas',
    });
  });
});

describe('isPersonaSavable / personaCharsLeft — estado do botão "Salvar e ativar"', () => {
  it('vazio/só-espaço = não salvável', () => {
    expect(isPersonaSavable('')).toBe(false);
    expect(isPersonaSavable('    ')).toBe(false);
  });

  it('texto válido = salvável; no limite ainda salvável; acima do limite não', () => {
    expect(isPersonaSavable('Você é o assistente da barbearia.')).toBe(true);
    expect(isPersonaSavable('x'.repeat(PERSONA_MAX_CHARS))).toBe(true);
    expect(isPersonaSavable('x'.repeat(PERSONA_MAX_CHARS + 1))).toBe(false);
  });

  it('trim conta pro limite (espaços nas bordas não estouram)', () => {
    const dentro = `  ${'x'.repeat(PERSONA_MAX_CHARS)}  `;
    expect(isPersonaSavable(dentro)).toBe(true);
  });

  it('personaCharsLeft conta a partir do teto (negativo se passar)', () => {
    expect(personaCharsLeft('')).toBe(PERSONA_MAX_CHARS);
    expect(personaCharsLeft('abc')).toBe(PERSONA_MAX_CHARS - 3);
    expect(personaCharsLeft('x'.repeat(PERSONA_MAX_CHARS + 7))).toBe(-7);
  });
});

describe('fetchBuilderDraft', () => {
  it('200 mapeia campos (status pronto)', async () => {
    apiFetchMock.mockResolvedValue({
      status: 'pronto',
      persona_rascunho: 'Você é o Léo...',
      preview_final: 'Você é o Léo...\n\n[BLOCO]',
      nome_do_bot: 'Léo',
      resumo: 'Descontraído',
    });
    expect(await fetchBuilderDraft()).toEqual({
      status: 'pronto',
      personaRascunho: 'Você é o Léo...',
      previewFinal: 'Você é o Léo...\n\n[BLOCO]',
      nomeBot: 'Léo',
      resumo: 'Descontraído',
    });
  });

  it('status sem_rascunho: campos null coerentes', async () => {
    apiFetchMock.mockResolvedValue({
      status: 'sem_rascunho',
      persona_rascunho: null,
      preview_final: null,
    });
    expect(await fetchBuilderDraft()).toEqual({
      status: 'sem_rascunho',
      personaRascunho: null,
      previewFinal: null,
      nomeBot: null,
      resumo: null,
    });
  });

  it('404 -> indisponivel (feature off, some a seção)', async () => {
    apiFetchMock.mockRejectedValueOnce(new ApiError(404, 'recurso_indisponivel', null));
    expect(await fetchBuilderDraft()).toEqual({ status: 'indisponivel' });
  });

  it('erro real (500) propaga pra virar ErrorState na tela', async () => {
    apiFetchMock.mockRejectedValueOnce(new ApiError(500, 'boom', null));
    await expect(fetchBuilderDraft()).rejects.toBeInstanceOf(ApiError);
  });
});

describe('helpers puros de estado do chat', () => {
  it('remainingChars conta a partir do teto', () => {
    expect(remainingChars('')).toBe(BUILDER_MAX_INPUT);
    expect(remainingChars('abc')).toBe(BUILDER_MAX_INPUT - 3);
    expect(remainingChars('x'.repeat(BUILDER_MAX_INPUT + 10))).toBe(-10);
  });

  it('isSendable: vazio/só-espaço/pending = false; texto válido = true', () => {
    expect(isSendable('', false)).toBe(false);
    expect(isSendable('   ', false)).toBe(false);
    expect(isSendable('oi', true)).toBe(false);
    expect(isSendable('oi', false)).toBe(true);
    expect(isSendable('x'.repeat(BUILDER_MAX_INPUT), false)).toBe(true);
    expect(isSendable('x'.repeat(BUILDER_MAX_INPUT + 1), false)).toBe(false);
  });

  it('appendMessage: id incremental e imutabilidade', () => {
    const a = appendMessage([], 'assistant', 'Oi!');
    expect(a).toEqual([{ id: 1, role: 'assistant', text: 'Oi!' }]);
    const b = appendMessage(a, 'user', 'quero descontraído');
    expect(b).toEqual([
      { id: 1, role: 'assistant', text: 'Oi!' },
      { id: 2, role: 'user', text: 'quero descontraído' },
    ]);
    expect(a).toHaveLength(1); // não mutou o array anterior
  });

  it('isBuilderUnavailable só é true no 404', () => {
    expect(isBuilderUnavailable(new ApiError(404, 'x', null))).toBe(true);
    expect(isBuilderUnavailable(new ApiError(500, 'x', null))).toBe(false);
    expect(isBuilderUnavailable(new Error('x'))).toBe(false);
  });
});
