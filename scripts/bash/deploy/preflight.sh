#!/usr/bin/env bash
# scripts/bash/deploy/preflight.sh
#
# Refuses to let an unsafe production environment through.
#
#   scripts/bash/deploy/preflight.sh [path/to/.env]      (default: ./.env)
#
# Exit 0 = safe to deploy (warnings may be printed), exit 1 = fix the ERRORs first.
# It NEVER prints a secret's value — only the variable's name and what is wrong.
set -uo pipefail

ENV_FILE="${1:-.env}"
errors=0
warnings=0

red()    { printf '\033[31m%s\033[0m\n' "$*"; }
yellow() { printf '\033[33m%s\033[0m\n' "$*"; }
green()  { printf '\033[32m%s\033[0m\n' "$*"; }
err()  { red    "  ERROR   $*"; errors=$((errors + 1)); }
warn() { yellow "  WARNING $*"; warnings=$((warnings + 1)); }

[ -f "$ENV_FILE" ] || { red "ERROR: $ENV_FILE not found"; exit 1; }

# Read KEY=value without sourcing (the file may contain characters the shell would interpret).
get() {
  local v
  v=$(grep -E "^$1=" "$ENV_FILE" | tail -1 | cut -d= -f2-)
  v="${v%\"}"; v="${v#\"}"; v="${v%\'}"; v="${v#\'}"
  printf '%s' "$v"
}

echo "Preflight for $ENV_FILE"
echo

# ── required and non-empty ──────────────────────────────────────────────────
echo "Required settings"
for k in NODE_ENV DATABASE_URL DB_HOST DB_NAME DB_USER DB_PASSWORD REDIS_HOST REDIS_PASSWORD \
         KAFKA_BROKERS KAFKA_CLIENT_ID RABBITMQ_URL \
         JWT_SECRET JWT_REFRESH_SECRET PII_ENCRYPTION_KEY PII_HASH_KEY \
         WEBHOOK_SIGNATURE_SECRET SMTP_HOST SMTP_FROM; do
  [ -n "$(get "$k")" ] || err "$k is not set"
done

# ── strength ────────────────────────────────────────────────────────────────
echo "Secret strength"
min_len() { local v; v="$(get "$1")"; [ -z "$v" ] || [ "${#v}" -ge "$2" ] || err "$1 is too short (${#v} chars; need $2+)"; }
min_len JWT_SECRET 32
min_len JWT_REFRESH_SECRET 32
min_len PII_HASH_KEY 32
min_len DB_PASSWORD 16
min_len REDIS_PASSWORD 16
min_len RABBITMQ_PASSWORD 16
min_len WEBHOOK_SIGNATURE_SECRET 16

pii="$(get PII_ENCRYPTION_KEY)"
if [ -n "$pii" ] && ! printf '%s' "$pii" | grep -Eq '^[0-9a-fA-F]{64}$'; then
  err "PII_ENCRYPTION_KEY must be exactly 64 hex characters (generate: openssl rand -hex 32)"
fi

# ── placeholders ────────────────────────────────────────────────────────────
echo "Placeholder values"
for k in JWT_SECRET JWT_REFRESH_SECRET PII_ENCRYPTION_KEY PII_HASH_KEY DB_PASSWORD REDIS_PASSWORD \
         RABBITMQ_PASSWORD WEBHOOK_SIGNATURE_SECRET SERVICE_API_KEY OPERATOR_API_KEY ADMIN_API_KEY; do
  v="$(get "$k")"
  if [ -n "$v" ] && printf '%s' "$v" | grep -Eiq 'change[-_ ]?me|changeme|password|example|secret123|^test|your[-_ ]|placeholder|xxxx'; then
    err "$k looks like a placeholder"
  fi
done

# ── reuse ───────────────────────────────────────────────────────────────────
echo "Reuse"
same() { local a b; a="$(get "$1")"; b="$(get "$2")"; [ -z "$a" ] || [ -z "$b" ] || [ "$a" != "$b" ] || err "$1 and $2 must be different"; }
same JWT_SECRET JWT_REFRESH_SECRET
same PII_ENCRYPTION_KEY PII_HASH_KEY
same JWT_SECRET PII_HASH_KEY
same SERVICE_API_KEY OPERATOR_API_KEY
same SERVICE_API_KEY ADMIN_API_KEY
same OPERATOR_API_KEY ADMIN_API_KEY

# ── API credentials: one per role ───────────────────────────────────────────
echo "API credentials (a role with no key cannot log in)"
for k in SERVICE_API_KEY OPERATOR_API_KEY ADMIN_API_KEY; do
  v="$(get "$k")"
  if [ -z "$v" ]; then warn "$k is empty — that role cannot log in"
  elif [ "${#v}" -lt 24 ]; then err "$k is too short (${#v} chars; need 24+)"
  fi
done

# ── environment ─────────────────────────────────────────────────────────────
echo "Environment"
[ "$(get NODE_ENV)" = "production" ] || err "NODE_ENV must be 'production' (is '$(get NODE_ENV)')"

cors="$(get CORS_ORIGINS)"
if [ -z "$cors" ]; then err "CORS_ORIGINS is not set (the default is http://localhost:3000)"
elif printf '%s' "$cors" | grep -Eq 'localhost|127\.0\.0\.1|\*'; then err "CORS_ORIGINS must list real front-end origins, not localhost or '*'"
fi

[ "$(get KAFKA_SSL)" = "true" ] || warn "KAFKA_SSL is not 'true': Kafka traffic is unencrypted (fine only on a private network / the bundled compose broker)"

db="$(get DATABASE_URL)"
printf '%s' "$db" | grep -Eq 'sslmode=(require|verify-full|verify-ca)' || warn "DATABASE_URL has no sslmode=require|verify-full (Postgres TLS is available; use it)"
[ "$(get GRAFANA_PASSWORD)" != "admin" ] && [ -n "$(get GRAFANA_PASSWORD)" ] || warn "GRAFANA_PASSWORD is unset or 'admin'"

mode="$(get CONSENT_ENFORCEMENT)"
case "${mode:-enforce}" in
  enforce) : ;;
  audit)   warn "CONSENT_ENFORCEMENT=audit: sends WITHOUT consent are allowed (logged). Fine while migrating users; switch to 'enforce' after." ;;
  off)     err  "CONSENT_ENFORCEMENT=off: consent is not checked at all" ;;
  *)       err  "CONSENT_ENFORCEMENT must be enforce|audit|off" ;;
esac

# ── optional integrations: half-configured is worse than absent ─────────────
echo "Providers"
[ -n "$(get MSG91_API_KEY)$(get TERMII_API_KEY)$(get TWILIO_AUTH_TOKEN)" ] || warn "no SMS provider key set: SMS runs in MOCK mode (simulated receipts) — not real deliveries"
[ -n "$(get FCM_PROJECT_ID)" ] || warn "FCM_PROJECT_ID unset: push runs in MOCK mode"
[ -n "$(get SMTP_USER)" ] || warn "SMTP_USER unset: email uses a test transport, nothing is really emailed"
for pair in "PAYSTACK_SECRET_KEY:Paystack" "FLUTTERWAVE_SECRET_HASH:Flutterwave" "OPAY_SECRET_KEY:OPay" "INTERSWITCH_SECRET_KEY:Interswitch"; do
  [ -n "$(get "${pair%%:*}")" ] || warn "${pair%%:*} unset: the ${pair##*:} webhook rejects every request (fails closed)"
done

# ── tooling ─────────────────────────────────────────────────────────────────
echo "Tooling"
if command -v docker >/dev/null 2>&1; then
  docker compose config -q >/dev/null 2>&1 && echo "  ok      docker compose config is valid" || err "docker compose config is invalid"
  if [ -f monitoring/alert-rules.yml ]; then
    docker run --rm --entrypoint promtool -v "$PWD/monitoring:/m" prom/prometheus:v2.49.0 check rules /m/alert-rules.yml >/dev/null 2>&1 \
      && echo "  ok      Prometheus alert rules are valid" || err "Prometheus alert rules are invalid"
  fi
else
  warn "docker not found — skipped compose/alert-rule validation"
fi
git ls-files --error-unmatch .env >/dev/null 2>&1 && err ".env is tracked by git — remove it from the repository history" || echo "  ok      .env is not tracked by git"

echo
if [ "$errors" -gt 0 ]; then red "✗ $errors error(s), $warnings warning(s) — NOT safe to deploy"; exit 1; fi
green "✓ safe to deploy ($warnings warning(s))"
exit 0
