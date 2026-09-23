// tests/unit/shared/failure-classifier.spec.ts
import { classifyFailure } from '../../../src/shared/utils/failure-classifier.util';

describe('classifyFailure (DLQ classification)', () => {
  it.each([
    ['NETWORK_ERROR', 'ECONNRESET', 'TRANSIENT'],
    ['CIRCUIT_OPEN', 'Circuit breaker is OPEN for msg91', 'TRANSIENT'],
    ['503', 'Service Unavailable', 'TRANSIENT'],
    ['DND_CHECK_UNAVAILABLE', 'DND registry unavailable', 'TRANSIENT'],
    ['MAX_RETRIES_EXCEEDED', 'Max retries exceeded', 'TRANSIENT'],
    ['429', 'rate_limited', 'TRANSIENT'],
    ['INVALID_RECIPIENT', 'number not in service', 'PERMANENT'],
    ['EXPIRED_TOKEN', 'FCM token expired', 'PERMANENT'],
    ['BOUNCE', 'mailbox does not exist', 'PERMANENT'],
    ['400', 'Bad Request', 'PERMANENT'],
    [
      'RENDER_OR_QUEUE_FAILED',
      'Template X has no definition for channel sms',
      'CONFIGURATION',
    ],
    ['REQUEUE_NO_CONTENT', 'nothing to resend', 'CONFIGURATION'],
    ['401', 'Unauthorized', 'CONFIGURATION'],
    ['INVALID_API_KEY', 'bad key', 'CONFIGURATION'],
  ])('%s / %s → %s', (code, reason, expected) => {
    expect(classifyFailure(code, reason)).toBe(expected);
  });

  it("a provider 401 is OUR misconfiguration, not the recipient's fault", () => {
    expect(classifyFailure('401', 'invalid authentication')).toBe(
      'CONFIGURATION',
    );
  });

  it('defaults to TRANSIENT when there is nothing to go on', () => {
    expect(classifyFailure(undefined, undefined)).toBe('TRANSIENT');
    expect(classifyFailure(null, '')).toBe('TRANSIENT');
  });
});
