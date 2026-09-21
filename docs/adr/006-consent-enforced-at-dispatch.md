# ADR-006: Consent is append-only and enforced at dispatch

**Status:** Accepted

## Context

Spec A6.1/C3.3 require explicit opt-in records with timestamps, IP and wording, kept immutably; B2.3 requires proof of consent for every
promotional recipient. `ConsentService` existed but nothing called it: there was no API, and no send was ever checked against it — a
record-keeping façade with no effect, the same failure mode as an RBAC guard nobody applied.

## Decision

1. **Append-only in the database** (trigger refusing UPDATE/DELETE/TRUNCATE), not by convention. Withdrawal is a new row.
2. **Enforce at dispatch**, immediately before the provider call — the same reasoning as ADR-004 for DND: consent can be withdrawn
   between routing and sending, and the check must reflect the moment of sending.
3. **Store the authorising record's id on the notification** so the audit is a join, not an inference from timestamps.
4. **Scope:** WhatsApp (all messages) and promotional SMS/email. Transactional messages are exempt, as they are from DND.
5. **`CONSENT_ENFORCEMENT` = enforce | audit | off**, default `enforce`, so existing users can be migrated without an outage.
6. **Erasure retains consent records** (legal-obligation exception; they hold no identifier once the user is anonymised).

## Consequences

+ A withdrawal takes effect on the next send; the audit can show consent per message.
+ History cannot be rewritten, even by a bug.
− Every promotional/WhatsApp send costs one indexed lookup (`userId, channel, grantedAt DESC`). Not cached: a cached "yes" would outlive a withdrawal.
− Deleting test data requires a superuser (replica role) — deliberate friction.
− Existing users have no records: production must run in `audit` first and collect real consent (nothing may fabricate it).
