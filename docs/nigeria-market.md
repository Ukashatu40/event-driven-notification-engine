# Nigeria Market Pack

The engine serves two markets. **India (`IN`) is the default**; a user's `market` column (`IN` | `NG`) selects the
profile in `src/shared/markets/market-profiles.ts`. Nothing about the India behaviour or the assessed API contracts changes.

| | India (`IN`) | Nigeria (`NG`) |
|---|---|---|
| Currency / minor unit | INR / paisa | NGN (₦) / kobo |
| Telecom regulator · DND registry | TRAI · NCPR | NCC · National DND Registry |
| Securities regulator | SEBI | SEC Nigeria |
| SMS providers (primary → failover) | MSG91 → Twilio | **Termii → Twilio** |
| Default timezone | Asia/Kolkata | Africa/Lagos |
| Languages | en, hi, mr, ta, te | en, **pcm** (Pidgin), **ha** (Hausa), **yo** (Yoruba), **ig** (Igbo) |

> `costPaisa` columns hold integer **minor units** (paisa or kobo — both are 1/100).

## Languages

Nigerian-language content lives in one reviewable file, `src/templates/definitions/ng-localisations.ts`, merged into the
template registry at startup (RISK-001, RISK-002, TXNX-001, TXNX-005 for SMS + push). Missing locale/channel falls back to English.

> **These are draft translations and must be reviewed by native speakers before production** — margin-call wording has
> real financial consequences.

### Why SMS text is written without diacritics

A single SMS holds **160 characters only in the GSM-7 alphabet**. One character outside it switches the whole message to
UCS-2, which holds **70** (about double the cost, and the message splits). Yoruba `ẹ ọ ṣ`, Igbo `ị ụ`, Hausa `ɓ ɗ ƙ`,
and the currency signs `₦` `₹` are all outside GSM-7. So:

- SMS bodies for pcm/ha/yo/ig are written in plain ASCII; push and in-app text use proper orthography.
- `SmsTruncationService` computes the limit **per message** (160 vs 70) and normalises `₦`→`NGN `, `₹`→`Rs ` and Intl's
  non-breaking spaces before measuring. (Hindi/Tamil/Telugu/Marathi SMS are inherently UCS-2, so they now truncate at 70, not 160.)
- Termii is sent `type: "unicode"` only when the text really is non-GSM.

## SMS: Termii

`TermiiProvider` (`src/delivery/providers/sms/termii.provider.ts`). Termii has two routes
([docs](https://developers.termii.com/messaging-api)):

| Route | Delivers to DND numbers? | Used for |
|---|---|---|
| `dnd` | Yes, all numbers; not subject to the MTN 8PM–8AM restriction | **TRANSACTIONAL** only |
| `generic` | No; MTN time-restricted | PROMOTIONAL, and anything unclassified |

The route is derived from the message classification and never the other way round — a promotional message must never
travel on the `dnd` route. DND is still checked at dispatch first (ADR-004). Without `TERMII_API_KEY` the provider simulates success.

## Inbound payment webhooks → TXNX-005 "Funds Deposited"

`POST /api/webhooks/payments/{paystack|flutterwave|opay|interswitch}` — public (no JWT); the provider signature is the
authentication and **the endpoint fails closed** if the provider's secret is not configured. Rate limit 1000/min.

| Provider | Verification | Success signal | Amount unit | User attribution |
|---|---|---|---|---|
| Paystack | `x-paystack-signature` = HMAC-SHA512(raw body, secret key) | `charge.success` | kobo | `metadata.user_id`, else customer email |
| Flutterwave | `verif-hash` header equals your configured secret hash | `charge.completed` + `status: successful` | naira | `meta.user_id`, else customer email |
| OPay | `sha512` field in body = HMAC-SHA3-512 over `{Amount:"…",Currency:"…",Reference:"…",Refunded:t/f,Status:"…",Timestamp:"…",Token:"…",TransactionID:"…"}` | `transaction-status` + `SUCCESS` | kobo¹ | reference `"<userId>:<suffix>"` |
| Interswitch | `X-Interswitch-Signature` = HMAC-SHA512(raw body, secret) | `TRANSACTION.COMPLETED` + `responseCode "00"` | kobo¹ | `merchantCustomerId` if it is an email |

¹ **Confirm against your merchant account** — the docs reviewed did not state the unit explicitly.

Behaviour: the email fallback uses the **blind index**, never the plaintext. Only `NGN` is accepted (other currencies are
acknowledged and ignored). Provider event ids feed the idempotency key, so a retried webhook returns the *original*
notification id and sends nothing twice. Unknown users / non-payment events return `200 {status:"ignored"}` so the
provider stops retrying; Kafka being down returns `503` so it retries.

Env: `PAYSTACK_SECRET_KEY`, `FLUTTERWAVE_SECRET_HASH`, `OPAY_SECRET_KEY`, `INTERSWITCH_SECRET_KEY`,
`TERMII_API_KEY`, `TERMII_SENDER_ID` (≤11 chars, must be registered with the operators), `TERMII_BASE_URL`.

## Seeding

```bash
npm run seed:ng -- 25     # 25 Nigerian users across en/pcm/ha/yo/ig, +234 numbers, Africa/Lagos
```

## Not yet done (suggested next)

- Native-speaker review of the pcm/ha/yo/ig translations; translations for the other 21 templates and WhatsApp/email.
- A `DND_CATEGORIES` model for NCC's category-level DND (today DND is a single registered/not-registered flag).
- NGX trading-hours awareness (the profile stores `tradingHours`; quiet-hours/STO do not use it yet).
- Nigeria-specific events (naira/FX alerts, T-bill maturity, BVN/NIN verification reminders) and a USSD fallback channel.
- Termii DLR (delivery report) webhook, so Termii-sent SMS reach `DELIVERED`.
- NDPA 2023 review: the erasure endpoint and 90-day scrub already exist; cross-border-transfer rules need a legal read.
