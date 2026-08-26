import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  countTerminalBefore: vi.fn(),
  pruneTerminalBefore: vi.fn(),
}));
let cfg = {
  BOOKING_CONFIRMATION_RETENTION_ENABLED: false,
  BOOKING_CONFIRMATION_RETENTION_DAYS: 30,
};

vi.mock('@startap/db', () => ({ bookingConfirmations: mocks }));
vi.mock('@startap/core/logger', () => ({ logger: { child: () => ({ info: vi.fn() }) } }));
vi.mock('../config.js', () => ({
  get config() {
    return cfg;
  },
}));

const { runBookingConfirmationRetention } = await import('./booking-confirmation-retention.js');

beforeEach(() => {
  vi.clearAllMocks();
  cfg = { BOOKING_CONFIRMATION_RETENTION_ENABLED: false, BOOKING_CONFIRMATION_RETENTION_DAYS: 30 };
  mocks.countTerminalBefore.mockResolvedValue(3);
  mocks.pruneTerminalBefore.mockResolvedValue(3);
});

describe('booking confirmation retention', () => {
  it('fica em dry-run por padrão e nunca chama DELETE', async () => {
    await expect(runBookingConfirmationRetention()).resolves.toMatchObject({
      dry_run: true,
      matched: 3,
      deleted: 0,
    });
    expect(mocks.pruneTerminalBefore).not.toHaveBeenCalled();
  });

  it('com gate explícito remove somente a seleção terminal do query module', async () => {
    cfg.BOOKING_CONFIRMATION_RETENTION_ENABLED = true;
    await expect(runBookingConfirmationRetention()).resolves.toMatchObject({
      dry_run: false,
      matched: 3,
      deleted: 3,
    });
    expect(mocks.pruneTerminalBefore).toHaveBeenCalledOnce();
  });
});
