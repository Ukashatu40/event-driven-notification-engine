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
  ],
  [NotificationStatus.ROUTED]: [NotificationStatus.QUEUED],
  [NotificationStatus.QUEUED]: [
    NotificationStatus.SENT,
    NotificationStatus.FAILED,
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
