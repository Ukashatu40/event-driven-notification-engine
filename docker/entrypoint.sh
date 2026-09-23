#!/bin/sh
# Runs before the app starts. Local Docker Compose has its own one-shot
# `migrate` service and never sets RUN_MIGRATIONS_ON_BOOT, so this is a no-op
# there; a host with no equivalent (e.g. Render) sets it instead.
# `prisma migrate deploy` only applies pending migrations, so running it again
# on every boot is safe.
set -e

if [ "$RUN_MIGRATIONS_ON_BOOT" = "true" ]; then
  echo "RUN_MIGRATIONS_ON_BOOT=true — applying pending migrations..."
  npx prisma migrate deploy
fi

exec node dist/src/main
