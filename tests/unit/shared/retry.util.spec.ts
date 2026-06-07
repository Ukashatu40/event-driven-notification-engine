// tests/unit/shared/retry.util.spec.ts
import {
  calculateRetryDelay,
  withRetry,
} from '../../../src/shared/utils/retry.util';

describe('calculateRetryDelay', () => {
  it('should return base delay on attempt 1', () => {
    const delay = calculateRetryDelay({
      baseDelayMs: 1000,
      maxDelayMs: 300_000,
      attempt: 1,
      jitterMs: 0,
    });

    expect(delay).toBe(1000);
  });

  it('should double delay on each attempt', () => {
    const attempt1 = calculateRetryDelay({
      baseDelayMs: 1000,
      maxDelayMs: 300_000,
      attempt: 1,
      jitterMs: 0,
    });

    const attempt2 = calculateRetryDelay({
      baseDelayMs: 1000,
      maxDelayMs: 300_000,
      attempt: 2,
      jitterMs: 0,
    });

    expect(attempt2).toBe(attempt1 * 2);
  });

  it('should not exceed maxDelay', () => {
    const delay = calculateRetryDelay({
      baseDelayMs: 1000,
      maxDelayMs: 5000,
      attempt: 20,
      jitterMs: 0,
    });

    expect(delay).toBe(5000);
  });

  it('should add jitter within bounds', () => {
    const results = Array.from({ length: 50 }, () =>
      calculateRetryDelay({
        baseDelayMs: 1000,
        maxDelayMs: 300_000,
        attempt: 1,
        jitterMs: 1000,
      }),
    );

    const allWithinBounds = results.every((d) => d >= 1000 && d <= 2000);
    expect(allWithinBounds).toBe(true);

    // With 50 samples, jitter should produce at least some variation
    const unique = new Set(results);
    expect(unique.size).toBeGreaterThan(1);
  });
});

describe('withRetry', () => {
  it('should return result on first success', async () => {
    const fn = jest.fn().mockResolvedValue('success');

    const result = await withRetry(fn, {
      maxAttempts: 3,
      baseDelayMs: 10,
      maxDelayMs: 100,
    });

    expect(result).toBe('success');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('should retry on failure and succeed', async () => {
    const fn = jest
      .fn()
      .mockRejectedValueOnce(new Error('fail'))
      .mockRejectedValueOnce(new Error('fail'))
      .mockResolvedValue('success');

    const result = await withRetry(fn, {
      maxAttempts: 3,
      baseDelayMs: 1,
      maxDelayMs: 10,
    });

    expect(result).toBe('success');
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('should throw after max attempts exceeded', async () => {
    const fn = jest.fn().mockRejectedValue(new Error('permanent failure'));

    await expect(
      withRetry(fn, {
        maxAttempts: 3,
        baseDelayMs: 1,
        maxDelayMs: 10,
      }),
    ).rejects.toThrow('permanent failure');

    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('should call onRetry callback on each retry', async () => {
    const fn = jest
      .fn()
      .mockRejectedValueOnce(new Error('fail'))
      .mockResolvedValue('ok');

    const onRetry = jest.fn();

    await withRetry(fn, {
      maxAttempts: 3,
      baseDelayMs: 1,
      maxDelayMs: 10,
      onRetry,
    });

    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(onRetry).toHaveBeenCalledWith(1, expect.any(Error));
  });
});
