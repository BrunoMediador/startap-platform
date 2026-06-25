/**
 * Testes do getGoogleAccountBySlot (migration 061): lê a credencial Google do CLIENTE
 * (e-mail + senha CIFRADA) por slot, SEM cache, parametrizado por $1.
 *
 * Inclui o round-trip encrypt -> decrypt da senha (a query devolve a senha AINDA cifrada;
 * quem chama decifra no ponto de uso). DB (client.js) mockado; crypto real.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockQuery = vi.fn();

vi.mock('../client.js', () => ({
  pool: {},
  query: (...args: unknown[]) => mockQuery(...args),
}));

// Importação dinâmica após o mock para o módulo usar o query mockado.
const { getGoogleAccountBySlot } = await import('./flow-clones.js');
const { encryptSecret, decryptSecret } = await import('@startap/core/crypto');

// Chave AES de teste (32 bytes hex). Setada antes de qualquer encrypt/decrypt.
const VALID_KEY = 'a'.repeat(64);

beforeEach(() => {
  process.env.GCAL_ENCRYPTION_KEY = VALID_KEY;
  mockQuery.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('getGoogleAccountBySlot', () => {
  it('lê e-mail + senha cifrada por slot, parametrizado ($1=slot)', async () => {
    const senhaEnc = encryptSecret('s3nha-do-cliente!');
    mockQuery.mockResolvedValue({
      rows: [{ google_account_email: 'cliente@gmail.com', google_account_password_enc: senhaEnc }],
    });

    const row = await getGoogleAccountBySlot('clone_seven_7_abc');

    expect(row).not.toBeNull();
    expect(row?.google_account_email).toBe('cliente@gmail.com');
    expect(row?.google_account_password_enc).toBe(senhaEnc);

    // Query parametrizada: slot é $1, nunca interpolado.
    const [sql, params] = mockQuery.mock.calls[0];
    expect(sql).toContain('google_account_email');
    expect(sql).toContain('google_account_password_enc');
    expect(sql).toContain('WHERE slot = $1');
    expect(sql).not.toContain('gcal_'); // NÃO toca a Service Account do bot
    expect(params).toEqual(['clone_seven_7_abc']);
  });

  it('round-trip: a senha cifrada devolvida decifra para o texto original', async () => {
    const plain = 'GoogleP@ss-2026';
    const senhaEnc = encryptSecret(plain);
    expect(senhaEnc.startsWith('enc:v2:')).toBe(true); // formato enc:v2:iv:tag:ciphertext

    mockQuery.mockResolvedValue({
      rows: [{ google_account_email: 'a@b.com', google_account_password_enc: senhaEnc }],
    });

    const row = await getGoogleAccountBySlot('clone_x');
    expect(row?.google_account_password_enc).not.toBeNull();
    // É exatamente o que a rota faz: decryptSecret no ponto de uso.
    expect(decryptSecret(row?.google_account_password_enc as string)).toBe(plain);
  });

  it('credencial não configurada: e-mail e senha vêm null', async () => {
    mockQuery.mockResolvedValue({
      rows: [{ google_account_email: null, google_account_password_enc: null }],
    });

    const row = await getGoogleAccountBySlot('clone_sem_google');

    expect(row).toEqual({ google_account_email: null, google_account_password_enc: null });
  });

  it('slot inexistente -> null', async () => {
    mockQuery.mockResolvedValue({ rows: [] });

    const row = await getGoogleAccountBySlot('clone_fantasma');

    expect(row).toBeNull();
  });
});
