#!/usr/bin/env sh
# End-to-end smoke test for a running stack (docker compose up --wait).
#
# Runs the same flow as the README: service health, the UI proxy, customer and account setup, a
# demo session, a mock import, the account summary and an idempotent re-import. Stops at the
# first failed check and exits non-zero. It only creates demo data (a new customer and account).
#
# Usage:
#   scripts/dev/smoke-test.sh
#
# Override the endpoints when the stack uses non-default host ports (values from .env):
#   GATEWAY_URL=http://localhost:8000 AGGREGATION_URL=http://localhost:8088 UI_URL=http://localhost:5173
#
# Requires: curl and python3.
set -eu

GATEWAY_URL="${GATEWAY_URL:-http://localhost:8000}"
AGGREGATION_URL="${AGGREGATION_URL:-http://localhost:8088}"
UI_URL="${UI_URL:-http://localhost:5173}"

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

pass() {
  echo "ok   $*"
}

# json_field NAME: prints the top-level NAME from a JSON object on stdin.
json_field() {
  python3 -c 'import json,sys; print(json.load(sys.stdin)[sys.argv[1]])' "$1"
}

echo "Smoke test: gateway=$GATEWAY_URL aggregation=$AGGREGATION_URL ui=$UI_URL"

# ---------------------------------------------------------------- health and routing
curl -fsS "$GATEWAY_URL/actuator/health" >/dev/null || fail "api-gateway health check"
pass "api-gateway health"

curl -fsS "$AGGREGATION_URL/actuator/health" >/dev/null || fail "aggregation-service health check"
pass "aggregation-service health"

curl -fsS -o /dev/null "$UI_URL/" || fail "frontend is not served at $UI_URL"
pass "frontend served"

# nginx forwards /api/v1/ to the gateway. Any HTTP answer from the gateway (2xx or 4xx) proves the
# route; a connection failure or 5xx from nginx means the proxy is broken.
proxy_code="$(curl -s -o /dev/null -w '%{http_code}' "$UI_URL/api/v1/customers/00000000-0000-0000-0000-000000000000")"
case "$proxy_code" in
  2*|4*) pass "frontend proxies /api/v1 to the gateway (HTTP $proxy_code)" ;;
  *) fail "frontend proxy to /api/v1 returned HTTP $proxy_code" ;;
esac

# ---------------------------------------------------------------- setup and session
suffix="$(date +%s)"
customer_json="$(curl -fsS -X POST "$GATEWAY_URL/api/v1/customers" \
  -H 'Content-Type: application/json' \
  -d "{\"firstName\":\"Smoke\",\"lastName\":\"Test\",\"email\":\"smoke-$suffix@example.test\",\"clientType\":\"INDIVIDUAL\"}")" \
  || fail "create customer"
customer_id="$(printf '%s' "$customer_json" | json_field id)"
pass "created customer $customer_id"

account_json="$(curl -fsS -X POST "$GATEWAY_URL/api/v1/accounts" \
  -H 'Content-Type: application/json' \
  -d "{\"customerId\":\"$customer_id\",\"accountType\":\"SAVINGS\"}")" \
  || fail "create account"
account_id="$(printf '%s' "$account_json" | json_field id)"
pass "created account $account_id"

token="$(curl -fsS -X POST "$GATEWAY_URL/api/v1/session" \
  -H 'Content-Type: application/json' \
  -d "{\"customerId\":\"$customer_id\"}" | json_field token)" \
  || fail "issue demo session token"
pass "issued demo session token"
auth="Authorization: Bearer $token"

curl -fsS "$GATEWAY_URL/api/v1/aggregation/sources" -H "$auth" | grep -q 'BANK_FEED' \
  || fail "source list does not include BANK_FEED"
pass "source list includes BANK_FEED"

# ---------------------------------------------------------------- import and idempotency
period="$(python3 -c 'import datetime as d; t=d.date.today(); print((t-d.timedelta(days=29)).isoformat(), t.isoformat())')"
from_date="${period% *}"
to_date="${period#* }"
import_body="{\"accountId\":\"$account_id\",\"source\":\"BANK_FEED\",\"from\":\"$from_date\",\"to\":\"$to_date\",\"count\":100,\"seed\":42}"

first="$(curl -fsS -X POST "$GATEWAY_URL/api/v1/aggregation/imports" \
  -H 'Content-Type: application/json' -H "$auth" -d "$import_body")" \
  || fail "first import request"
counted="$(printf '%s' "$first" | json_field counted)"
[ "$counted" -gt 0 ] || fail "first import counted no transactions: $first"
pass "first import counted $counted transactions"

summary="$(curl -fsS "$GATEWAY_URL/api/v1/aggregation/accounts/$account_id/summary" -H "$auth")" \
  || fail "account summary request"
summary_count="$(printf '%s' "$summary" | json_field transactionCount)"
[ "$summary_count" -eq "$counted" ] \
  || fail "summary transactionCount=$summary_count does not match counted=$counted"
pass "summary transactionCount matches the import"

second="$(curl -fsS -X POST "$GATEWAY_URL/api/v1/aggregation/imports" \
  -H 'Content-Type: application/json' -H "$auth" -d "$import_body")" \
  || fail "re-import request"
recounted="$(printf '%s' "$second" | json_field counted)"
duplicates="$(printf '%s' "$second" | json_field duplicatesSkipped)"
[ "$recounted" -eq 0 ] && [ "$duplicates" -gt 0 ] \
  || fail "re-import is not idempotent: counted=$recounted duplicatesSkipped=$duplicates"
pass "re-import skipped $duplicates duplicates and counted none"

echo "All smoke checks passed."
