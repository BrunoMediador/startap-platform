/**
 * Transcrição de áudio via OpenAI (audio.transcriptions.create).
 *
 * Alternativa hospedada ao Whisper LOCAL (container :9000). Centraliza o custo
 * na conta OpenAI do Bruno e libera RAM/CPU da VPS (o Whisper local é o gargalo
 * nº1 de capacidade — ver docs/capacidade-vps-100-clientes.md).
 *
 * Usa o MESMO SDK/chave (OPENAI_API_KEY) já configurados para o chat. Nenhum
 * segredo novo. Esta função NÃO é chamada por padrão: o router só a usa quando
 * TRANSCRIBE_PROVIDER=openai (default `local` = comportamento atual idêntico).
 */
import { logger } from '@startap/core/logger';
import OpenAI from 'openai';

const log = logger.child({ module: 'openai-transcribe' });

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

/**
 * Modelo de transcrição. Default gpt-4o-mini-transcribe: ~US$0.003/min
 * (metade do whisper-1, qualidade superior em PT-BR). Ajustável por env
 * sem deploy. Aceita: whisper-1 | gpt-4o-mini-transcribe | gpt-4o-transcribe.
 */
const TRANSCRIBE_MODEL = process.env.OPENAI_TRANSCRIBE_MODEL ?? 'gpt-4o-mini-transcribe';

/** Timeout da chamada de transcrição (ms). Áudio curto de WhatsApp resolve rápido. */
const TRANSCRIBE_TIMEOUT_MS = Number.parseInt(
  process.env.OPENAI_TRANSCRIBE_TIMEOUT_MS ?? '30000',
  10,
);

/**
 * Mapeia o mimetype do WhatsApp para uma extensão de arquivo que a OpenAI
 * aceita. Voice notes do WhatsApp são OGG/opus. A OpenAI aceita ogg/oga
 * (container Ogg) na prática; mantemos a extensão coerente com o mime pra
 * o servidor inferir o codec corretamente.
 */
function filenameFor(mimetype: string): string {
  const m = mimetype.toLowerCase();
  if (m.includes('ogg') || m.includes('opus')) return 'audio.ogg';
  if (m.includes('mpeg') || m.includes('mp3')) return 'audio.mp3';
  if (m.includes('mp4') || m.includes('m4a') || m.includes('aac')) return 'audio.m4a';
  if (m.includes('wav')) return 'audio.wav';
  if (m.includes('webm')) return 'audio.webm';
  return 'audio.ogg';
}

/**
 * Transcreve áudio via OpenAI. Mesma assinatura de whisper.transcribe:
 * recebe Buffer + mimetype, devolve o texto. Idioma fixado em pt (áudio de
 * barbearia em PT-BR) — corta latência e erro de detecção em áudios curtos.
 */
export async function transcribe(audio: Buffer, mimetype = 'audio/ogg'): Promise<string> {
  const filename = filenameFor(mimetype);
  // O SDK aceita um File (Web) construído a partir do Buffer; nome+type guiam
  // a inferência de codec no servidor.
  const file = new File([audio], filename, { type: mimetype });

  const res = await client.audio.transcriptions.create(
    {
      file,
      model: TRANSCRIBE_MODEL,
      language: 'pt',
      response_format: 'json',
    },
    { timeout: TRANSCRIBE_TIMEOUT_MS },
  );

  const text = (res.text ?? '').trim();
  log.info(
    { model: TRANSCRIBE_MODEL, bytes: audio.length, len: text.length },
    'Áudio transcrito (OpenAI)',
  );
  return text;
}
