#!/usr/bin/env bash
# Konteynerleri durdurur ve kaldirir.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
docker compose down "$@"
