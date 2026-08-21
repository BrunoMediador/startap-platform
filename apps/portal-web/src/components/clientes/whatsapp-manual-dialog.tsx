'use client';

import { IconCheck, IconSend, IconWhatsapp, IconX } from '@/components/icons';
import { Button } from '@/components/ui/button';
import { Overlay } from '@/components/ui/overlay';
import { ApiError } from '@/lib/api';
import {
  WHATSAPP_MANUAL_MESSAGE_MAX_LENGTH,
  canReviewWhatsAppManualMessage,
  normalizeWhatsAppManualMessage,
} from '@/lib/whatsapp-manual';
import { useRef, useState } from 'react';

export interface WhatsAppManualTarget {
  id: string;
  nome: string;
  telefoneMasked: string;
}

type Step = 'compose' | 'confirm' | 'sending' | 'success';

interface WhatsAppManualDialogProps {
  target: WhatsAppManualTarget | null;
  onClose: () => void;
  onSend: (id: string, mensagem: string) => Promise<void>;
  onFeatureOff: () => void;
}

function sendErrorMessage(error: unknown): string {
  if (error instanceof ApiError && error.status === 400) {
    return 'Revise a mensagem e tente novamente.';
  }
  if (error instanceof ApiError && error.status === 409) {
    return 'Este envio não está disponível agora. Atualize o perfil antes de tentar de novo.';
  }
  if (error instanceof ApiError && error.status === 429) {
    return 'Aguarde um momento antes de tentar outro envio.';
  }
  return 'Não foi possível enviar agora. Nenhuma confirmação de envio foi recebida.';
}

export function WhatsAppManualDialog({
  target,
  onClose,
  onSend,
  onFeatureOff,
}: WhatsAppManualDialogProps) {
  const [message, setMessage] = useState('');
  const [step, setStep] = useState<Step>('compose');
  const [error, setError] = useState<string | null>(null);
  const inFlightRef = useRef(false);
  const open = target != null;
  const normalizedMessage = normalizeWhatsAppManualMessage(message);
  const canReview = canReviewWhatsAppManualMessage(message);
  const sending = step === 'sending';

  const close = () => {
    if (sending) return;
    setMessage('');
    setStep('compose');
    setError(null);
    onClose();
  };

  const send = async () => {
    if (!target || inFlightRef.current || !canReview) return;
    inFlightRef.current = true;
    setError(null);
    setStep('sending');
    try {
      await onSend(target.id, normalizedMessage);
      setStep('success');
    } catch (cause) {
      if (
        cause instanceof ApiError &&
        cause.status === 404 &&
        typeof cause.body === 'object' &&
        cause.body !== null &&
        'error' in cause.body &&
        cause.body.error === 'feature_off'
      ) {
        onFeatureOff();
        close();
        return;
      }
      setError(sendErrorMessage(cause));
      setStep('confirm');
    } finally {
      inFlightRef.current = false;
    }
  };

  return (
    <Overlay
      open={open}
      onClose={close}
      variant="modal"
      ariaLabel="Enviar mensagem manual pelo WhatsApp"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2.5">
          <span className="flex size-10 shrink-0 items-center justify-center rounded-[12px] bg-brand-soft text-brand">
            {step === 'success' ? <IconCheck size={20} /> : <IconWhatsapp size={20} />}
          </span>
          <div className="min-w-0">
            <h2 className="truncate font-display text-[17px] font-semibold text-ink">
              {step === 'success' ? 'Mensagem enviada' : 'Enviar WhatsApp'}
            </h2>
            {target && (
              <p className="truncate text-[12.5px] text-ink-soft">
                {target.nome} · {target.telefoneMasked}
              </p>
            )}
          </div>
        </div>
        <button
          type="button"
          onClick={close}
          disabled={sending}
          aria-label="Fechar envio manual"
          className="flex size-11 shrink-0 items-center justify-center rounded-btn text-ink-soft hover:bg-surface-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand disabled:opacity-50"
        >
          <IconX size={19} />
        </button>
      </div>

      {step === 'success' ? (
        <>
          <p className="mt-4 text-[14px] leading-snug text-ink-soft">
            O envio foi confirmado pelo servidor. Não envie novamente para esta conversa agora.
          </p>
          <div className="mt-5">
            <Button onClick={close}>Concluir</Button>
          </div>
        </>
      ) : step === 'compose' ? (
        <>
          <label
            className="mt-4 block text-[13px] font-semibold text-ink"
            htmlFor="whatsapp-manual-message"
          >
            Mensagem
          </label>
          <textarea
            id="whatsapp-manual-message"
            value={message}
            onChange={(event) =>
              setMessage(event.target.value.slice(0, WHATSAPP_MANUAL_MESSAGE_MAX_LENGTH))
            }
            maxLength={WHATSAPP_MANUAL_MESSAGE_MAX_LENGTH}
            rows={6}
            placeholder="Escreva a mensagem que será enviada"
            className="mt-1.5 w-full resize-y rounded-field border-[1.5px] border-line-strong bg-surface-sunken px-3 py-2.5 text-[14px] leading-snug text-ink outline-none placeholder:text-ink-faint focus:border-brand focus:shadow-focus focus:ring-[3px] focus:ring-brand/35"
          />
          <p className="mt-1 text-right text-[11.5px] tabular-nums text-ink-faint">
            {message.length}/{WHATSAPP_MANUAL_MESSAGE_MAX_LENGTH}
          </p>
          <p className="mt-3 text-[12.5px] leading-snug text-ink-soft">
            Revise o destinatário e o texto antes de continuar. O envio só acontece após sua
            confirmação.
          </p>
          <div className="mt-5 flex gap-2.5">
            <Button variant="secondary" size="inline" onClick={close}>
              Cancelar
            </Button>
            <Button size="inline" disabled={!canReview} onClick={() => setStep('confirm')}>
              Revisar envio
            </Button>
          </div>
        </>
      ) : (
        <>
          <p className="mt-4 text-[14px] leading-snug text-ink-soft">
            Confirme que quer enviar esta mensagem manualmente para este cliente.
          </p>
          <p className="mt-3 whitespace-pre-wrap rounded-field border border-line bg-surface-sunken px-3 py-2.5 text-[13.5px] leading-snug text-ink">
            {normalizedMessage}
          </p>
          {error && (
            <p role="alert" className="mt-3 text-[13px] leading-snug text-danger">
              {error}
            </p>
          )}
          <div className="mt-5 flex flex-wrap gap-2.5">
            <Button
              variant="secondary"
              size="inline"
              disabled={sending}
              onClick={() => setStep('compose')}
            >
              Editar
            </Button>
            <Button size="inline" loading={sending} loadingLabel="Enviando…" onClick={send}>
              <IconSend size={17} />
              Confirmar envio
            </Button>
          </div>
        </>
      )}
    </Overlay>
  );
}
