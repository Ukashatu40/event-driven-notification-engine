# ADR-009: Sign-up is a deliberately different security posture from login

**Status:** Accepted

## Context

ADR-008 makes login (`POST /auth/otp/request`) deliberately silent about whether a phone/email is registered — it returns the
identical response and takes the identical code path either way, so it can't be used to test which contact details belong to a
real account. Adding self-service sign-up on top of that raises an obvious question: does sign-up need the same silence?

## Decision

No — sign-up says plainly when an identifier is already registered, and that's correct, not an inconsistency:

1. **Every real sign-up flow does this.** "This email is already in use" is standard, expected UX. Hiding it would just be
   unusual, not more secure.
2. **Hiding it would be pointless anyway.** If login won't say whether an identifier is registered, but sign-up will, an attacker
   simply uses sign-up to find out and gains nothing by going through login instead. Login's silence only has value while sign-up
   doesn't punch a hole in the same wall.
3. **Nothing is written to Postgres until the code is verified.** `SignupService.request()` only ever writes to Redis (5-minute
   TTL) — a bot hammering the endpoint with fake names never creates a real row, only a lot of expiring Redis keys and, if it
   picks a real person's phone/email, one `ConflictException` telling it so (which is the intended, unavoidable signal, not a
   leak of anything beyond "this identifier exists somewhere").
4. **Shared machinery, different Redis keys, different rules.** Sign-up and login share `OtpCodeDeliveryService` (provider
   selection, circuit breaker, masked outcome logging) and `OtpCodeStore` (the code/attempts/expiry state machine) — see the class
   docs on both. They do NOT share Redis keys or rate-limit budgets: `auth:otp:*` vs `auth:signup:*`, so exhausting one doesn't
   block the other.
5. **No CAPTCHA.** For a demo at this scale, requiring control of a real phone/email (the OTP itself) plus per-identifier rate
   limiting is a reasonable bar. A CAPTCHA or similar is the natural next control if abuse becomes real, not built pre-emptively.
6. **Market/language are set once, at sign-up, and not editable afterward.** The Preferences page is currently view-only for those
   two fields — letting sign-up choose them is consistent with what a user can already do post-signup, not a new gap. A settings
   page to change them is a reasonable separate follow-up.

## Consequences

+ Login keeps its anti-enumeration property where it actually matters (an existing user's account can't be probed via login).
+ Sign-up behaves the way every user already expects a sign-up form to behave.
+ The two shared services mean a fix to code delivery or the attempts/expiry logic lands in both flows at once.
− A determined attacker can still enumerate registered identifiers via sign-up's 409. This is accepted, not overlooked — see point 2.
