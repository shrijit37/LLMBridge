#!/bin/sh
# Self-seeding entrypoint: guarantees /app/config/config.json exists on first
# boot (fresh named volumes) by copying the baked environment template.
# Existing config files are never overwritten, so live edits persist.
set -e

CCS_ENV="${CCS_ENV:-dev}"

if [ ! -f /app/config/config.json ]; then
  echo "[entrypoint] Seeding /app/config/config.json from baked '${CCS_ENV}' template"
  cp "/app/baked-config/config.${CCS_ENV}.json" /app/config/config.json
fi

exec node dist/index.js
