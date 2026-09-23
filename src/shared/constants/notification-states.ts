// src/shared/constants/notification-states.ts
export enum NotificationStatus {
  CREATED = 'CREATED',
  ENRICHED = 'ENRICHED',
  ROUTED = 'ROUTED',
  QUEUED = 'QUEUED',
  SENT = 'SENT',
  DELIVERED = 'DELIVERED',
  READ = 'READ',
  CAPPED = 'CAPPED',
  QUIET = 'QUIET',
  DND = 'DND',
  FAILED = 'FAILED',
  RETRYING = 'RETRYING',
  DLQ = 'DLQ',
  DEDUPLICATED = 'DEDUPLICATED',
  BOUNCED = 'BOUNCED',
  /** Blocked at dispatch: no valid consent on record. */
  NO_CONSENT = 'NO_CONSENT',
  /** Held for a digest. */
  DIGEST_PENDING = 'DIGEST_PENDING',
  /** Delivered as part of a digest notification. */
  DIGESTED = 'DIGESTED',
}

export const VALID_TRANSITIONS: Partial<
  Record<NotificationStatus, NotificationStatus[]>
> = {
  [NotificationStatus.CREATED]: [
    NotificationStatus.ENRICHED,
    NotificationStatus.DEDUPLICATED,
  ],
  [NotificationStatus.ENRICHED]: [
    NotificationStatus.ROUTED,
    NotificationStatus.CAPPED,
    NotificationStatus.QUIET,
    NotificationStatus.DND,
    NotificationStatus.DIGEST_PENDING,
  ],
  [NotificationStatus.ROUTED]: [
    NotificationStatus.QUEUED,
    NotificationStatus.FAILED,
  ],
  // A deferred notification (quiet hours / send-time optimisation) is
  // released back into the pipeline at ROUTED once its window opens.
  [NotificationStatus.QUIET]: [
    NotificationStatus.ROUTED,
    NotificationStatus.DIGEST_PENDING,
  ],
  // Notifications suppressed by a frequency cap can be swept into a digest
  // (spec Appendix B: "if user has 3+ capped notifications, batch into a digest").
  [NotificationStatus.CAPPED]: [NotificationStatus.DIGEST_PENDING],
  [NotificationStatus.DIGEST_PENDING]: [NotificationStatus.DIGESTED],
  // DND is checked at dispatch (ADR-004), i.e. from QUEUED, not at routing.
  [NotificationStatus.QUEUED]: [
    NotificationStatus.SENT,
    NotificationStatus.FAILED,
    NotificationStatus.DND,
    NotificationStatus.NO_CONSENT,
  ],
  [NotificationStatus.SENT]: [
    NotificationStatus.DELIVERED,
    NotificationStatus.FAILED,
    NotificationStatus.BOUNCED,
  ],
  [NotificationStatus.DELIVERED]: [NotificationStatus.READ],
  [NotificationStatus.FAILED]: [
    NotificationStatus.RETRYING,
    NotificationStatus.DLQ,
  ],
  [NotificationStatus.RETRYING]: [
    NotificationStatus.QUEUED,
    NotificationStatus.DLQ,
  ],
};

export function isValidTransition(
  from: NotificationStatus,
  to: NotificationStatus,
): boolean {
  const allowed = VALID_TRANSITIONS[from];
  if (!allowed) return false;
  return allowed.includes(to);
}
