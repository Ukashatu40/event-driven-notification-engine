// src/shared/utils/failure-classifier.util.ts

/**
 * Automated DLQ classification (spec Day 9): how should an operator treat a
 * dead-lettered notification?
 *
 *  TRANSIENT     — the cause is likely temporary; a retry may well succeed
 *                  (provider 5xx / timeouts / network / open circuit / registry down).
 *  PERMANENT     — retrying cannot help; the recipient or content is bad
 *                  (invalid number, expired device token, bounced address, rejected by DND).
 *  CONFIGURATION — something in OUR setup is wrong and must be fixed first
 *                  (template can't render, missing provider credentials, no content to resend).
 */
export type FailureClass = 'TRANSIENT' | 'PERMANENT' | 'CONFIGURATION';

const CONFIGURATION =
  /RENDER_OR_QUEUE_FAILED|REQUEUE_NO_CONTENT|INVALID_TEMPLATE|TEMPLATE|NOT_CONFIGURED|UNAUTHORI[SZ]ED|AUTH(ENTICATION)?_FAILED|INVALID_(API_)?KEY|\b40[13]\b/i;
const PERMANENT =
  /INVALID_RECIPIENT|INVALID_(PHONE|NUMBER|EMAIL)|UNREGISTERED|EXPIRED_TOKEN|NOT_REGISTERED|BOUNCE|DND_(REGISTERED|BLOCKED)|BLACKLIST|OPT_?OUT|\b(400|404|410)\b/i;

export function classifyFailure(
  code?: string | null,
  reason?: string | null,
): FailureClass {
  const text = `${code ?? ''} ${reason ?? ''}`;
  // Configuration first: a 401 from a provider means OUR key is wrong, which is
  // not the recipient's fault and will not fix itself.
  if (CONFIGURATION.test(text)) return 'CONFIGURATION';
  if (PERMANENT.test(text)) return 'PERMANENT';
  // Everything else — timeouts, 5xx, rate limits, network, open circuit,
  // registry unavailable, retries exhausted — is treated as transient.
  return 'TRANSIENT';
}
