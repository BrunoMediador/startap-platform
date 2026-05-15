/**
 * Cliente Whisper ASR (transcrição de áudio).
 *
 * Substitui o nó "Transcrever" (HTTP request multipart pro :9000/asr).
 */
import { logger } from '@startap/core/logger';

const WHISPER_URL = process.env.WHISPER_URL ?? 'http://whisper:9000';

const log = logger.child({ module: 'whisper' });

/**
 * Transcreve áudio. Recebe Buffer e mimetype.
 * Retorna o texto transcrito (em portugues, idioma auto-detectado).
 */
export async function transcribe(audio: Buffer, mimetype = 'audio/ogg'): Promise<string> {
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
