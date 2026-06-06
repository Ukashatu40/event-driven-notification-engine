export enum Priority {
  CRITICAL = 1,
  HIGH = 2,
  MEDIUM = 3,
  LOW = 5,
}

export const PRIORITY_LABEL: Record<Priority, string> = {
  [Priority.CRITICAL]: 'CRITICAL',
  [Priority.HIGH]: 'HIGH',
  [Priority.MEDIUM]: 'MEDIUM',
  [Priority.LOW]: 'LOW',
};

// Retry configuration per priority
export const RETRY_CONFIG: Record<
  Priority,
  { maxRetries: number; baseDelayMs: number; maxDelayMs: number }
> = {
  [Priority.CRITICAL]: {
    maxRetries: 10,
    baseDelayMs: 500,
    maxDelayMs: 60_000,
  },
  [Priority.HIGH]: {
    maxRetries: 5,
    baseDelayMs: 1_000,
    maxDelayMs: 300_000,
  },
  [Priority.MEDIUM]: {
    maxRetries: 3,
    baseDelayMs: 5_000,
    maxDelayMs: 1_800_000,
  },
  [Priority.LOW]: {
    maxRetries: 2,
    baseDelayMs: 30_000,
    maxDelayMs: 7_200_000,
  },
};
