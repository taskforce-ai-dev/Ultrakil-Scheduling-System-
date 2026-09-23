#!/usr/bin/env sh
# Read-only staging smoke test. It never sends credentials or mutates Caddy.
set -eu

PORTAL_URL="${PORTAL_URL:-https://ultrakil.taskforceai.tech/login}"
API_URL="${API_URL:-https://ultrakil-api.taskforceai.tech/api/health/ready}"
CURL_BIN="${CURL_BIN:-curl}"
all_headers="$(mktemp)"
headers="$(mktemp)"
trap 'rm -f "$all_headers" "$headers"' EXIT

final_header_block() {
  # curl writes every response while following redirects. Only the final
  # response is relevant: a hardened redirect cannot compensate for an
  # unprotected response that actually renders portal/API content.
  awk '
    /^HTTP\/[0-9.]+ [0-9][0-9][0-9]/ { block = $0 ORS; seen = 1; next }
    seen { block = block $0 ORS }
    END { printf "%s", block }
  ' "$1" > "$2"
}

require_final_success() {
  status="$(awk '/^HTTP\/[0-9.]+ [0-9][0-9][0-9]/ { code = $2 } END { print code }' "$headers")"
  case "$status" in
    2??) ;;
    *)
      echo "final response must be 2xx, got ${status:-no HTTP status}" >&2
      exit 1
      ;;
  esac
}

require_header() {
  name="$1"
  value="$2"
  if ! grep -Eiq "^${name}:.*${value}" "$headers"; then
    echo "missing expected ${name} header" >&2
    exit 1
  fi
}

for url in "$PORTAL_URL" "$API_URL"; do
  : > "$all_headers"
  "$CURL_BIN" --fail --silent --show-error --location --dump-header "$all_headers" --output /dev/null "$url"
  final_header_block "$all_headers" "$headers"
  require_final_success
  require_header 'strict-transport-security' 'max-age=31536000'
  require_header 'x-content-type-options' 'nosniff'
  require_header 'referrer-policy' 'strict-origin-when-cross-origin'
  require_header 'x-frame-options' 'DENY'
  require_header 'permissions-policy' 'geolocation=\(\)'
  require_header 'content-security-policy-report-only' "frame-ancestors 'none'"
  if grep -Eiq '^(server|x-powered-by):' "$headers"; then
    echo "implementation header unexpectedly exposed" >&2
    exit 1
  fi
done

echo 'Caddy staging security-header smoke test passed.'
