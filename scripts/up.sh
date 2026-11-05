#!/usr/bin/env bash
# Imajlari derler, konteynerleri baslatir, saglik kontrolu yapar.
# Kullanim: ./scripts/up.sh [--open]
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

OPEN=0
for arg in "$@"; do
  case "$arg" in
    --open) OPEN=1 ;;
    -h|--help) echo "Kullanim: $0 [--open]"; exit 0 ;;
    *) echo "Bilinmeyen arguman: $arg" >&2; exit 2 ;;
  esac
done

echo "CPU limiti: ${BENCH_CPUS:-2}  |  Bellek limiti: ${BENCH_MEM:-2g}  (her iki konteyner icin ayni)"
docker compose up --build -d

wait_healthy() {
  local name="$1" port="$2" i
  printf 'Bekleniyor: %s (http://localhost:%s/healthz) ' "$name" "$port"
  for ((i = 0; i < 45; i++)); do
    if curl -fsS --max-time 2 "http://localhost:${port}/healthz" >/dev/null 2>&1; then
      echo "OK"
      return 0
    fi
    printf '.'
    sleep 2
  done
  echo " ZAMAN ASIMI"
  echo "Loglar icin: docker compose logs ${name}" >&2
  return 1
}

wait_healthy bench10 5010
wait_healthy bench11 5011

echo
for port in 5010 5011; do
  echo "--- http://localhost:${port}/api/info"
  curl -fsS --max-time 5 "http://localhost:${port}/api/info"
  echo
done

echo
echo "Dashboard: http://localhost:8088"

if [[ "$OPEN" -eq 1 ]]; then
  if command -v open >/dev/null 2>&1; then
    open "http://localhost:8088"
  elif command -v xdg-open >/dev/null 2>&1; then
    xdg-open "http://localhost:8088" >/dev/null 2>&1 || true
  fi
fi
