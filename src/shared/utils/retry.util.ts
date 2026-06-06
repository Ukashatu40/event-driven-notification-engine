// src/shared/utils/retry.util.ts

/**
 * Exponential backoff with full jitter.
 * Used by retry worker and circuit breaker.
 * Formula: min(baseDelay * 2^(attempt-1) + jitter, maxDelay)
 *
 * NOTE ON SPEC ERROR (Deliberate Error #1):
 * The spec shows baseDelay * 2^attempt which gives 2000ms on attempt 1
 * with baseDelay=1000ms. Correct formula uses (attempt-1) so attempt 1 = baseDelay.
 */

export interface RetryDelayOptions {
  baseDelayMs: number;
  maxDelayMs: number;
  attempt: number; // 1-indexed
  jitterMs?: number; // defaults to 1000ms
}

export function calculateRetryDelay(options: RetryDelayOptions): number {
  const { baseDelayMs, maxDelayMs, attempt, jitterMs = 1_000 } = options;

  // Exponential backoff: baseDelay * 2^(attempt-1)
  const exponential = baseDelayMs * Math.pow(2, attempt - 1);

  // Full jitter: random value between 0 and jitterMs
  const jitter = Math.floor(Math.random() * jitterMs);

  return Math.min(exponential + jitter, maxDelayMs);
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Retry wrapper — wraps any async function with exponential backoff.
 * Used for provider calls and database operations.
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  options: {
    maxAttempts: number;
    baseDelayMs: number;
    maxDelayMs: number;
    onRetry?: (attempt: number, error: Error) => void;
  },
): Promise<T> {
  let lastError: Error = new Error('Unknown error');

  for (let attempt = 1; attempt <= options.maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err as Error;

      if (attempt === options.maxAttempts) break;

      const delay = calculateRetryDelay({
        baseDelayMs: options.baseDelayMs,
        maxDelayMs: options.maxDelayMs,
        attempt,
      });

      options.onRetry?.(attempt, lastError);
      await sleep(delay);
    }
  }

  throw lastError;
}
