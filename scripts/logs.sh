#!/usr/bin/env bash
# Loglari izler. Kullanim: ./scripts/logs.sh [servis...]   (ornek: ./scripts/logs.sh bench11)
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
docker compose logs -f --tail=100 "$@"
