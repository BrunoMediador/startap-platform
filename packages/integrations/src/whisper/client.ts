/**
 * Cliente Whisper ASR (transcrição de áudio).
 *
 * Substitui o nó "Transcrever" (HTTP request multipart pro :9000/asr).
 */
import { logger } from '@startap/core/logger';
import { transcribe as transcribeOpenAI } from '../openai/transcribe.js';

const WHISPER_URL = process.env.WHISPER_URL ?? 'http://whisper:9000';

const log = logger.child({ module: 'whisper' });

/**
 * Transcreve áudio via Whisper LOCAL (container :9000). Recebe Buffer e mimetype.
 * Retorna o texto transcrito (em portugues, idioma auto-detectado).
 */
export async function transcribeLocal(audio: Buffer, mimetype = 'audio/ogg'): Promise<string> {
  const form = new FormData();
  const blob = new Blob([audio], { type: mimetype });
  form.append('audio_file', blob, 'audio.ogg');

  const url = `${WHISPER_URL}/asr?output=json&task=transcribe`;
  const res = await fetch(url, { method: 'POST', body: form });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    log.error({ status: res.status, body: text }, 'Whisper error');
    throw new Error(`Whisper -> HTTP ${res.status}: ${text}`);
  }

  const json = (await res.json()) as { text?: string };
  return (json.text ?? '').trim();
}

/**
 * Entrypoint de transcrição flag-gated (ADR 0021).
 *
 * Provider escolhido por TRANSCRIBE_PROVIDER (lido em runtime, NÃO no boot —
 * lição do incidente #247: env nova nunca derruba api/worker):
 *   - ausente | 'local' (DEFAULT)  -> Whisper LOCAL :9000. Comportamento ATUAL,
 *     byte-a-byte idêntico ao de hoje. Nada muda enquanto a flag não for ligada.
 *   - 'openai'                      -> OpenAI audio.transcriptions.create (mesma
 *     chave/SDK do chat). Centraliza custo na conta do Bruno + libera a VPS.
 *
 * FAIL-SAFE: com provider=openai, se a OpenAI falhar, faz FALLBACK pro Whisper
 * local (se TRANSCRIBE_OPENAI_FALLBACK_LOCAL != 'false') antes de propagar o
 * erro. O atendimento NUNCA cai por causa de transcrição: o router já trata
 * exceção desta função com texto-marcador '[áudio não transcrito]'.
 *
 * Mantém a assinatura histórica (audio, mimetype) -> texto para o router.
 */
export async function transcribe(audio: Buffer, mimetype = 'audio/ogg'): Promise<string> {
  const provider = (process.env.TRANSCRIBE_PROVIDER ?? 'local').toLowerCase();

  if (provider !== 'openai') {
    // Caminho default — idêntico ao comportamento atual.
    return transcribeLocal(audio, mimetype);
  }

  try {
    return await transcribeOpenAI(audio, mimetype);
  } catch (err) {
    const fallbackEnabled =
      (process.env.TRANSCRIBE_OPENAI_FALLBACK_LOCAL ?? 'true').toLowerCase() !== 'false';
    if (fallbackEnabled) {
      log.warn(
        { err: (err as Error).message, bytes: audio.length },
        'Transcrição OpenAI falhou — caindo pro Whisper local (fallback)',
      );
      // Se o local também falhar, propaga: o router trata sem derrubar o atendimento.
      return transcribeLocal(audio, mimetype);
    }
    log.error(
      { err: (err as Error).message, bytes: audio.length },
      'Transcrição OpenAI falhou e fallback local está desligado',
    );
    throw err;
  }
}
