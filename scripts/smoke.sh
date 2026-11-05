#!/usr/bin/env bash
# Duman testi: 'json' is yukunu her runtime'da SIRAYLA calistirir (asla ikisi ayni anda degil)
# ve son 'result' olayini yazdirir. Kullanim: ./scripts/smoke.sh [workload-id]
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

WORKLOAD="${1:-json}"
STATUS=0

for pair in "10:5010" "11:5011"; do
  label="${pair%%:*}"
  port="${pair##*:}"
  echo "=== .NET ${label} (port ${port}) - workload: ${WORKLOAD}"

  if ! curl -fsS --max-time 5 "http://localhost:${port}/healthz" >/dev/null; then
    echo "HATA: http://localhost:${port}/healthz yanit vermiyor (konteyner ayakta mi? ./scripts/up.sh)" >&2
    STATUS=1
    continue
  fi

  out="$(mktemp)"
  if ! curl -fsS -N --max-time 120 \
      "http://localhost:${port}/api/run/${WORKLOAD}/stream?scale=1&warmup=1" >"$out"; then
    echo "HATA: stream basarisiz (port ${port})" >&2
    STATUS=1
    rm -f "$out"
    continue
  fi

  # SSE: "event: result" satirindan sonraki "data:" satirini al
  result="$(awk '/^event: *result/ {r=1; next} r && /^data:/ {print; r=0}' "$out" | tail -n 1)"
  if [[ -z "$result" ]]; then
    echo "HATA: 'result' olayi bulunamadi. Ham cikti (son 20 satir):" >&2
    tail -n 20 "$out" >&2
    STATUS=1
  else
    echo "$result"
  fi
  rm -f "$out"
  echo
done

if [[ "$STATUS" -eq 0 ]]; then
  echo "Smoke test BASARILI"
else
  echo "Smoke test BASARISIZ" >&2
fi
exit "$STATUS"
