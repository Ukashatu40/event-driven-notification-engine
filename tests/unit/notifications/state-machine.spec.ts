// tests/unit/notifications/state-machine.spec.ts
import {
  NotificationStatus,
  isValidTransition,
} from '../../../src/shared/constants/notification-states';

describe('isValidTransition', () => {
  describe('valid forward transitions', () => {
    it('CREATED → ENRICHED is valid', () => {
      expect(
        isValidTransition(
          NotificationStatus.CREATED,
          NotificationStatus.ENRICHED,
        ),
      ).toBe(true);
    });

    it('CREATED → DEDUPLICATED is valid', () => {
      expect(
        isValidTransition(
          NotificationStatus.CREATED,
          NotificationStatus.DEDUPLICATED,
        ),
      ).toBe(true);
    });

    it('ENRICHED → ROUTED is valid', () => {
      expect(
        isValidTransition(
          NotificationStatus.ENRICHED,
          NotificationStatus.ROUTED,
        ),
      ).toBe(true);
    });

    it('ENRICHED → CAPPED is valid', () => {
      expect(
        isValidTransition(
          NotificationStatus.ENRICHED,
          NotificationStatus.CAPPED,
        ),
      ).toBe(true);
    });

    it('ENRICHED → QUIET is valid', () => {
      expect(
        isValidTransition(
          NotificationStatus.ENRICHED,
          NotificationStatus.QUIET,
        ),
      ).toBe(true);
    });

    it('ENRICHED → DND is valid', () => {
      expect(
        isValidTransition(NotificationStatus.ENRICHED, NotificationStatus.DND),
      ).toBe(true);
    });

    it('ROUTED → QUEUED is valid', () => {
      expect(
        isValidTransition(NotificationStatus.ROUTED, NotificationStatus.QUEUED),
      ).toBe(true);
    });

    it('QUEUED → SENT is valid', () => {
      expect(
        isValidTransition(NotificationStatus.QUEUED, NotificationStatus.SENT),
      ).toBe(true);
    });

    it('SENT → DELIVERED is valid', () => {
      expect(
        isValidTransition(
          NotificationStatus.SENT,
          NotificationStatus.DELIVERED,
        ),
      ).toBe(true);
    });

    it('DELIVERED → READ is valid', () => {
      expect(
        isValidTransition(
          NotificationStatus.DELIVERED,
          NotificationStatus.READ,
        ),
      ).toBe(true);
    });

    it('FAILED → RETRYING is valid', () => {
      expect(
        isValidTransition(
          NotificationStatus.FAILED,
          NotificationStatus.RETRYING,
        ),
      ).toBe(true);
    });

    it('FAILED → DLQ is valid', () => {
      expect(
        isValidTransition(NotificationStatus.FAILED, NotificationStatus.DLQ),
      ).toBe(true);
    });
  });

  describe('invalid transitions', () => {
    it('CREATED → DELIVERED is invalid', () => {
      expect(
        isValidTransition(
          NotificationStatus.CREATED,
          NotificationStatus.DELIVERED,
        ),
      ).toBe(false);
    });

    it('READ → CREATED is invalid (no backward transitions)', () => {
      expect(
        isValidTransition(NotificationStatus.READ, NotificationStatus.CREATED),
      ).toBe(false);
    });

    it('DLQ → SENT is invalid (terminal state)', () => {
      expect(
        isValidTransition(NotificationStatus.DLQ, NotificationStatus.SENT),
      ).toBe(false);
    });

    it('CAPPED → SENT is invalid (terminal state)', () => {
      expect(
        isValidTransition(NotificationStatus.CAPPED, NotificationStatus.SENT),
      ).toBe(false);
    });

    it('DELIVERED → CREATED is invalid', () => {
      expect(
        isValidTransition(
          NotificationStatus.DELIVERED,
          NotificationStatus.CREATED,
        ),
      ).toBe(false);
    });
  });
});
