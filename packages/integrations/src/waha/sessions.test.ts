/**
 * Testes dos helpers de reconexão WAHA (ADR 0015). fetch é MOCKADO — nada bate em
 * WAHA real. Foco: contrato request-code (E.164 sem +, SEM method), guard do QR,
 * orquestração restart+poll, e timeout/AbortController em toda chamada.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  WahaSessionNotFoundError,
  WahaTimeoutError,
  WahaWrongStateError,
  getSessionQR,
  getSessionStatus,
  requestPairingCode,
  restartAndWaitForScan,
} from './sessions.js';

const fetchMock = vi.fn();

beforeEach(() => {
  vi.useRealTimers();
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/** Resposta JSON ok genérica. */
function jsonOk(body: unknown): Response {
  return {
    ok: true,
    status: 200,
    headers: { get: () => 'application/json' },
    json: async () => body,
    text: async () => JSON.stringify(body),
    arrayBuffer: async () => new ArrayBuffer(0),
  } as unknown as Response;
}

function statusResp(status: string) {
  return jsonOk({ name: 'sess', status });
}

/** Resposta de erro HTTP genérica (status code arbitrário). */
function httpErr(status: number, body = ''): Response {
  return {
    ok: false,
    status,
    headers: { get: () => 'text/plain' },
    json: async () => ({}),
    text: async () => body,
    arrayBuffer: async () => new ArrayBuffer(0),
  } as unknown as Response;
}

// ── getSessionStatus (404 -> WahaSessionNotFoundError) ────────────────────────────
describe('getSessionStatus', () => {
  it('404 -> WahaSessionNotFoundError (sessão descartada — gatilho de recriação)', async () => {
    fetchMock.mockResolvedValueOnce(httpErr(404, 'session not found'));
    await expect(getSessionStatus('sess')).rejects.toBeInstanceOf(WahaSessionNotFoundError);
  });

  it('500 -> Error genérico (NÃO confundir com 404 — não recria)', async () => {
    fetchMock.mockResolvedValueOnce(httpErr(500, 'boom'));
    const err = await getSessionStatus('sess').catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(WahaSessionNotFoundError);
  });

  it('200 -> devolve o status normalmente', async () => {
    fetchMock.mockResolvedValueOnce(statusResp('WORKING'));
    const out = await getSessionStatus('sess');
    expect(out.status).toBe('WORKING');
  });
});

// ── requestPairingCode ──────────────────────────────────────────────────────────
describe('requestPairingCode', () => {
  it('envia phoneNumber SÓ DÍGITOS (sem +) e SEM method; retorna o code', async () => {
    fetchMock.mockResolvedValueOnce(jsonOk({ code: 'ABCD-1234' }));

    const out = await requestPairingCode('sess', '+55 11 97963-0828');

    expect(out).toEqual({ code: 'ABCD-1234' });
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toContain('/api/sess/auth/request-code');
    const body = JSON.parse((init as RequestInit).body as string);
    // Normalizado para E.164 só dígitos.
    expect(body).toEqual({ phoneNumber: '5511979630828' });
    // NUNCA enviar `method` (NOWEB devolve 422).
    expect(body).not.toHaveProperty('method');
  });

  it('rejeita número inválido ANTES de chamar o WAHA (defesa contra 422)', async () => {
    await expect(requestPairingCode('sess', '123')).rejects.toThrow(/inválido/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('lança se a resposta não tem code', async () => {
    fetchMock.mockResolvedValueOnce(jsonOk({}));
    await expect(requestPairingCode('sess', '5511979630828')).rejects.toThrow(/sem `code`/);
  });
});

// ── getSessionQR (guard de estado) ───────────────────────────────────────────────
describe('getSessionQR guard', () => {
  it('WORKING -> { connected:true, qr:null } sem buscar QR', async () => {
    fetchMock.mockResolvedValueOnce(statusResp('WORKING'));
    const out = await getSessionQR('sess');
    expect(out).toEqual({ connected: true, qr: null });
    expect(fetchMock).toHaveBeenCalledTimes(1); // só o status
  });

  it('estado != SCAN_QR_CODE -> WahaWrongStateError com o status', async () => {
    fetchMock.mockResolvedValueOnce(statusResp('STARTING'));
    await expect(getSessionQR('sess')).rejects.toBeInstanceOf(WahaWrongStateError);
    expect(fetchMock).toHaveBeenCalledTimes(1); // não chega a pedir QR
  });

  it('SCAN_QR_CODE -> retorna o QR (data-uri)', async () => {
    fetchMock
      .mockResolvedValueOnce(statusResp('SCAN_QR_CODE'))
      .mockResolvedValueOnce(jsonOk({ value: 'data:image/png;base64,AAAA' }));
    const out = await getSessionQR('sess');
    expect(out).toEqual({ qr: 'data:image/png;base64,AAAA' });
  });
});

// ── restartAndWaitForScan (orquestração) ─────────────────────────────────────────
describe('restartAndWaitForScan', () => {
  it('WORKING -> alreadyWorking, NÃO reinicia (protege sessão pagante)', async () => {
    fetchMock.mockResolvedValueOnce(statusResp('WORKING'));
    const out = await restartAndWaitForScan('sess');
    expect(out).toEqual({ status: 'WORKING', ready: false, alreadyWorking: true });
    // Apenas 1 chamada (status) — nenhum restart.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls.some(([u]) => String(u).includes('/restart'))).toBe(false);
  });

  it('já SCAN_QR_CODE -> ready sem novo restart (não invalida código vigente)', async () => {
    fetchMock.mockResolvedValueOnce(statusResp('SCAN_QR_CODE'));
    const out = await restartAndWaitForScan('sess');
    expect(out).toEqual({ status: 'SCAN_QR_CODE', ready: true, alreadyWorking: false });
    expect(fetchMock.mock.calls.some(([u]) => String(u).includes('/restart'))).toBe(false);
  });

  it('FAILED -> restart + poll até SCAN_QR_CODE', async () => {
    fetchMock
      .mockResolvedValueOnce(statusResp('FAILED')) // status inicial
      .mockResolvedValueOnce(statusResp('STARTING')) // restart (resposta)
      .mockResolvedValueOnce(statusResp('SCAN_QR_CODE')); // 1º poll
    const out = await restartAndWaitForScan('sess', { pollIntervalMs: 1, totalTimeoutMs: 5_000 });
    expect(out.ready).toBe(true);
    expect(out.status).toBe('SCAN_QR_CODE');
    expect(fetchMock.mock.calls.some(([u]) => String(u).includes('/restart'))).toBe(true);
  });
});

// ── Timeout / AbortController ─────────────────────────────────────────────────────
describe('timeout', () => {
  it('aborta e lança WahaTimeoutError quando o fetch demora além do timeoutMs', async () => {
    // fetch que rejeita com AbortError quando o signal aborta.
    fetchMock.mockImplementationOnce(
      (_url: string, init: RequestInit) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => {
            const e = new Error('aborted');
            e.name = 'AbortError';
            reject(e);
          });
        }),
    );
    await expect(
      requestPairingCode('sess', '5511979630828', { timeoutMs: 10 }),
    ).rejects.toBeInstanceOf(WahaTimeoutError);
  });

  it('passa o signal para o fetch (toda chamada tem AbortController)', async () => {
    fetchMock.mockResolvedValueOnce(statusResp('SCAN_QR_CODE'));
    await restartAndWaitForScan('sess').catch(() => {});
    const init = fetchMock.mock.calls[0][1] as RequestInit;
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });
});
