import { logger } from '@startap/core/logger';
import { bookingConfirmations } from '@startap/db';
import { config } from '../config.js';

const log = logger.child({ job: 'booking-confirmation-retention' });
const MS_PER_DAY = 86_400_000;

export interface BookingConfirmationRetentionResult {
  dry_run: boolean;
  cutoff: string;
  matched: number;
  deleted: number;
}

/** Remove somente estado terminal além da janela; pending/confirming nunca são candidatos. */
export async function runBookingConfirmationRetention(): Promise<BookingConfirmationRetentionResult> {
  const cutoff = new Date(
    Date.now() - config.BOOKING_CONFIRMATION_RETENTION_DAYS * MS_PER_DAY,
  ).toISOString();
  const dry_run = !config.BOOKING_CONFIRMATION_RETENTION_ENABLED;
  const matched = await bookingConfirmations.countTerminalBefore(cutoff);
  const deleted = dry_run ? 0 : await bookingConfirmations.pruneTerminalBefore(cutoff);
  const result = { dry_run, cutoff, matched, deleted };
  log.info(
    result,
    dry_run
      ? 'booking confirmation retention dry-run'
      : 'booking confirmation retention terminal proposals pruned',
  );
  return result;
}
