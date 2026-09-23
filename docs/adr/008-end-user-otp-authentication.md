# ADR-008: End-user login is phone/email + OTP, on a separate `/me` surface

**Status:** Accepted

## Context

Every token in the system was issued from a static per-role key (ADMIN/OPERATOR/SERVICE) — there was no way for an actual notification
recipient to prove who they are. "Manage my own preferences/consent" only ever existed as an ops person opening `/users/:id` on someone
else's behalf. This adds a real self-service path.

## Decision

1. **A fourth role, `USER`, with its own entry point.** It cannot be requested from `POST /auth/login` (that endpoint's DTO still only
   accepts `ADMIN|OPERATOR|SERVICE`) — a `USER` token exists only via `AuthService.issueForUser()`, called after a verified OTP.
   Rotation, revocation and refresh (`AuthService.refresh`) are unchanged and already role-agnostic.
2. **Login is phone or email + a 6-digit code**, not a password. Matches how both target markets already expect to authenticate, and
   needs no new secret storage.
3. **A `/api/v1/me/*` surface, not an ownership check on `/users/:userId/*`.** Every `/me` handler takes its id from the verified
   token's `sub` (`@CurrentUserId()`) — there is no `:userId` route parameter anywhere on this controller for one user to substitute
   another's id into. This was chosen over adding an ownership guard to the existing ops routes because a guard can be forgotten on a
   future route; a route with no id parameter cannot leak by omission. `MeController` duplicates no business logic — every handler
   delegates to the same `PreferencesService` / `ConsentService` / `NotificationsService` the ops routes already call.
4. **OTP delivery bypasses the notification pipeline entirely.** It is sent synchronously through the existing SMS/email providers
   (market-based primary/fallback for SMS, same as `DeliveryService`), never creates a `Notification` row, and is exempt from
   consent/DND — the same "solicited, not marketing" reasoning ADR-006 already uses for transactional sends. An OTP is the direct
   result of the recipient's own action.
5. **The code itself is never stored.** Only its SHA-256 hash, under a server-generated `requestId`, 5-minute TTL, verified with a
   constant-time comparison (same pattern as the existing static-key check in `AuthService.login`).
6. **Anti-enumeration by construction.** `request()` returns the identical response shape and takes the identical code path whether or
   not the phone/email belongs to an account — an unregistered identifier just doesn't get an SMS/email sent. `verify()` fails with the
   same generic "Incorrect code" for a wrong code and for a code issued against an unregistered identifier. Neither endpoint can be used
   to test which phone numbers or emails are registered.
7. **Rate-limited and cooled down per identifier** (blind-index hashed, never the raw value, in Redis — 60 s between sends, 3 requests /
   15 min), and **5 wrong attempts invalidates the code**, not just the guess.

## Consequences

+ No ownership-check bug is possible on the self-service surface — there is nothing to check.
+ No business logic duplicated between the ops and self-service surfaces.
+ `verify()` cannot be used to enumerate accounts, and neither can `request()`.
− A consumer login is a second thing to rate-limit and monitor for SMS/email cost, separate from notification spend.
− Only SMS and email are supported for v1; WhatsApp OTP (natural for the Nigerian market) is not built.
