#!/usr/bin/env bash
#
# Ask the running Ekon what it is, over HTTPS, and compare every answer against
# what was supposed to be deployed.
#
#   ./scripts/verify.sh                    verify against the expected values
#   APP_VERSION=<sha> ./scripts/verify.sh  verify a specific sha (deploy.sh does this)
#
# This exists because of a real failure: staging reported `"version": "staging"`
# while running a commit nobody could name. A health check that is only read by
# a human is a health check that agrees with whatever it says.
#
# Dependencies: curl and python3, both present on Ubuntu LTS. No jq — python3 is
# already there, parses JSON properly, and fails loudly on a malformed body
# rather than silently matching a substring.

set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
readonly SCRIPT_DIR
DEPLOY_DIR="$(cd -- "${SCRIPT_DIR}/.." && pwd)"
readonly DEPLOY_DIR
REPO_DIR="$(cd -- "${DEPLOY_DIR}/../.." && pwd)"
readonly REPO_DIR
readonly ENV_FILE="${DEPLOY_DIR}/production.env"

pass() { printf '    \033[32mPASS\033[0m  %s\n' "$*"; }
fail() { printf '    \033[31mFAIL\033[0m  %s\n' "$*" >&2; failures=$((failures + 1)); }
die()  { printf '\n\033[1;31m%s\033[0m\n' "$*" >&2; exit 1; }

failures=0

command -v curl >/dev/null || die 'curl is not installed'
command -v python3 >/dev/null || die 'python3 is not installed'

[[ -f "${ENV_FILE}" ]] || die "${ENV_FILE} not found"
# shellcheck disable=SC1090
EKON_DOMAIN="$(set -a; . "${ENV_FILE}"; set +a; printf '%s' "${EKON_DOMAIN:-}")"
[[ -n "${EKON_DOMAIN}" ]] || die 'EKON_DOMAIN is not set in production.env'

# When deploy.sh calls this, both are already exported. Run standalone, they are
# derived the same way deploy.sh derives them, from the checked-out tree — so a
# manual `verify.sh` still compares against the commit that is checked out
# rather than against whatever the server feels like saying.
if [[ -z "${APP_VERSION:-}" ]]; then
  APP_VERSION="$(git -C "${REPO_DIR}" rev-parse HEAD)"
fi
if [[ -z "${EXPECTED_SCHEMA_VERSION:-}" ]]; then
  head_migration="$(find "${REPO_DIR}/backend/migrations" -maxdepth 1 -name '[0-9][0-9][0-9][0-9]_*.sql' -printf '%f\n' | sort | tail -n 1)"
  EXPECTED_SCHEMA_VERSION="${head_migration%%_*}"
fi

# Production always verifies over the public HTTPS URL — that is the path a
# browser takes, and checking anything else would not prove the deployment is
# reachable. EKON_HEALTH_URL exists so the rehearsal in the runbook can point
# the same script at a local container before a domain exists; deploy.sh never
# sets it.
readonly URL="${EKON_HEALTH_URL:-https://${EKON_DOMAIN}/api/health}"

printf '\n\033[1m==> Verifying %s\033[0m\n' "${URL}"
printf '    expecting version %s, schema %s\n\n' "${APP_VERSION}" "${EXPECTED_SCHEMA_VERSION}"

# --retry rides out the few seconds where a just-replaced container is still
# opening its listener; it does not paper over a broken deploy, because every
# assertion below still has to hold afterwards.
#
# --retry-all-errors as well as --retry-connrefused: a container that has bound
# the port but not yet finished starting answers by closing the connection
# (curl exit 52), which the connection-refused option alone does not retry.
# Found during the local rehearsal, where the first request after `up` failed
# and the second succeeded.
http_status="$(curl --silent --show-error --location \
  --retry 10 --retry-delay 3 --retry-connrefused --retry-all-errors \
  --max-time 20 \
  --output /tmp/ekon-health.$$ --write-out '%{http_code}' \
  "${URL}")" || die "Could not reach ${URL}. Is DNS pointed at this VM, and are 80/443 open?"

body="$(cat "/tmp/ekon-health.$$")"
rm -f "/tmp/ekon-health.$$"

printf '    %s\n\n' "${body}"

if [[ "${http_status}" == "200" ]]; then
  pass "HTTP 200 over HTTPS"
else
  fail "HTTP ${http_status} (expected 200)"
fi

# One python3 invocation reads the body and prints the four values, one per
# line, in a fixed order. Anything that is not a valid JSON object exits
# non-zero here rather than producing empty strings that would then compare
# equal to nothing. The values are read with `read`, never eval'd: they come
# from the network, and a health endpoint is not a place to run shell.
if ! fields="$(printf '%s' "${body}" | python3 -c '
import json, sys
try:
    doc = json.load(sys.stdin)
except Exception as error:
    sys.stderr.write("health response is not valid JSON: %s\n" % error)
    sys.exit(1)
if not isinstance(doc, dict):
    sys.stderr.write("health response is not a JSON object\n")
    sys.exit(1)
for key in ("status", "database", "schemaVersion", "version"):
    value = doc.get(key)
    # One line each, newlines stripped so a hostile value cannot forge a field.
    print("" if value is None else str(value).replace("\n", " "))
')"; then
  die 'Could not parse the health response. Deployment NOT verified.'
fi

{
  read -r health_status
  read -r health_database
  read -r health_schemaVersion
  read -r health_version
} <<< "${fields}"

if [[ "${health_status:-}" == "ok" ]]; then
  pass "status = ok"
else
  fail "status = '${health_status:-}' (expected ok)"
fi

if [[ "${health_database:-}" == "up" ]]; then
  pass "database = up"
else
  fail "database = '${health_database:-}' (expected up)"
fi

if [[ "${health_schemaVersion:-}" == "${EXPECTED_SCHEMA_VERSION}" ]]; then
  pass "schemaVersion = ${EXPECTED_SCHEMA_VERSION}"
else
  fail "schemaVersion = '${health_schemaVersion:-}' (expected ${EXPECTED_SCHEMA_VERSION})"
fi

# The one this whole script exists for.
if [[ "${health_version:-}" == "${APP_VERSION}" ]]; then
  pass "version = ${APP_VERSION}"
else
  fail "version = '${health_version:-}' but this release is ${APP_VERSION}"
  printf '          The running application is NOT the commit that was deployed.\n' >&2
  printf '          This is the staging failure repeating. Do not enter inventory.\n' >&2
fi

printf '\n'
if (( failures > 0 )); then
  printf '\033[1;31m%d check(s) failed — deployment NOT verified.\033[0m\n\n' "${failures}" >&2
  exit 1
fi

printf '\033[1;32mAll checks passed.\033[0m\n\n'
