// tests/unit/notifications/mark-as-read.spec.ts
jest.mock('../../../src/infrastructure/database/prisma.service', () => ({
  PrismaService: class MockPrismaService {},
}));

import { NotificationsService } from '../../../src/notifications/notifications.service';

const NOTIFICATION_ID = 'n-1';
const USER_ID = 'u-1';

describe('NotificationsService.markAsRead', () => {
  const prisma = { notification: { findUnique: jest.fn(), update: jest.fn() } };
  const stateService = { transition: jest.fn() };
  const sendTimeOptimization = { recordEngagement: jest.fn() };
  const dispatch = {};
  const prometheus = {};
  const pii = {};

  let service: NotificationsService;

  beforeEach(() => {
    jest.resetAllMocks();
    service = new NotificationsService(
      prisma as never,
      stateService as never,
      sendTimeOptimization as never,
      pii as never,
      dispatch as never,
      prometheus as never,
    );
  });

  it('delegates to StateService.transition (DELIVERED -> READ) instead of writing status directly', async () => {
    // Regression: a direct `notification.update({ status: 'READ' })` here used
    // to run BEFORE stateService.transition(), so transition() always read the
    // status back as already READ and rejected its own READ -> READ transition
    // with INVALID_STATE_TRANSITION — the endpoint failed on every call, silently
    // leaving the status changed but no state-log entry to show for it.
    prisma.notification.findUnique.mockResolvedValue({
      id: NOTIFICATION_ID,
      userId: USER_ID,
      status: 'DELIVERED',
    });
    stateService.transition.mockResolvedValue(undefined);
    sendTimeOptimization.recordEngagement.mockResolvedValue(undefined);

    await service.markAsRead(NOTIFICATION_ID, USER_ID);

    expect(prisma.notification.update).not.toHaveBeenCalled();
    expect(stateService.transition).toHaveBeenCalledWith(
      NOTIFICATION_ID,
      'READ',
      'user_interaction',
      { readBy: USER_ID },
    );
  });

  it('404s when the notification does not exist', async () => {
    prisma.notification.findUnique.mockResolvedValue(null);
    await expect(
      service.markAsRead(NOTIFICATION_ID, USER_ID),
    ).rejects.toMatchObject({ status: 404 });
    expect(stateService.transition).not.toHaveBeenCalled();
  });

  it("404s (not 403) when the notification belongs to someone else, so ownership isn't leaked", async () => {
    prisma.notification.findUnique.mockResolvedValue({
      id: NOTIFICATION_ID,
      userId: 'someone-else',
      status: 'DELIVERED',
    });
    await expect(
      service.markAsRead(NOTIFICATION_ID, USER_ID),
    ).rejects.toMatchObject({ status: 404 });
    expect(stateService.transition).not.toHaveBeenCalled();
  });

  it('propagates the invalid-transition error for an already-read notification, without masking it', async () => {
    prisma.notification.findUnique.mockResolvedValue({
      id: NOTIFICATION_ID,
      userId: USER_ID,
      status: 'READ',
    });
    stateService.transition.mockRejectedValue(
      new Error('Cannot transition notification from READ to READ'),
    );
    await expect(service.markAsRead(NOTIFICATION_ID, USER_ID)).rejects.toThrow(
      'READ to READ',
    );
  });
});
