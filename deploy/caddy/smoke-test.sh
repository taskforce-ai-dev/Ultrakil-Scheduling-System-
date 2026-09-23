#!/usr/bin/env sh
# Read-only staging smoke test. It never sends credentials or mutates Caddy.
set -eu

PORTAL_URL="${PORTAL_URL:-https://ultrakil.taskforceai.tech/login}"
API_URL="${API_URL:-https://ultrakil-api.taskforceai.tech/api/health/ready}"
headers="$(mktemp)"
trap 'rm -f "$headers"' EXIT

require_header() {
  name="$1"
  value="$2"
  if ! grep -Eiq "^${name}:.*${value}" "$headers"; then
    echo "missing expected ${name} header" >&2
    exit 1
  fi
}

for url in "$PORTAL_URL" "$API_URL"; do
  curl --fail --silent --show-error --location --dump-header "$headers" --output /dev/null "$url"
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
