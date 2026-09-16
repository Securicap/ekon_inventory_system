#!/usr/bin/env bash
#
# Prove a backup can be restored — into a throwaway database that is destroyed
# afterwards, never into anything a shop is using.
#
#   ./scripts/restore-drill.sh /srv/ekon/backups/ekon-20260810T030000Z.dump
#
# An untested backup is not a backup. This is the test, and it is meant to be
# run on a schedule and before real inventory is ever entered.
#
# What it will not do, by construction:
#
#   - it never connects to the production database;
#   - it never writes to the production volume;
#   - it starts its own PostgreSQL, on its own throwaway volume, on no network
#     that anything else is on, with a name that cannot collide with the running
#     stack, and removes it when it is finished.
#
# There is deliberately no restore-production.sh in this repository. Restoring
# the business's live records is a decision, not a script — the runbook walks an
# operator through it with their eyes open.

set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
readonly SCRIPT_DIR
DEPLOY_DIR="$(cd -- "${SCRIPT_DIR}/.." && pwd)"
readonly DEPLOY_DIR
REPO_DIR="$(cd -- "${DEPLOY_DIR}/../.." && pwd)"
readonly REPO_DIR
readonly ENV_FILE="${DEPLOY_DIR}/production.env"

# Fixed, and nothing else may use them. The compose project is `ekon`, so a
# container called `ekon-restore-drill-<pid>` cannot be one of its services.
readonly DRILL_CONTAINER="ekon-restore-drill-$$"
readonly DRILL_DB="ekon_restore_drill"
readonly DRILL_USER="drill"
readonly DRILL_PASSWORD="drill-only-never-leaves-this-container"

pass() { printf '    \033[32mPASS\033[0m  %s\n' "$*"; }
fail() { printf '    \033[31mFAIL\033[0m  %s\n' "$*" >&2; failures=$((failures + 1)); }
log()  { printf '\n\033[1m==> %s\033[0m\n' "$*"; }
die()  { printf '\n\033[1;31mDRILL ABORTED: %s\033[0m\n' "$*" >&2; exit 1; }

failures=0

# ---------------------------------------------------------------------------
# 1. Arguments, and the refusal to touch production
# ---------------------------------------------------------------------------

dump_path="${1:-}"
[[ -n "${dump_path}" ]] || die "Usage: $0 <path-to-.dump>"
[[ -f "${dump_path}" ]] || die "No such backup file: ${dump_path}"

# Belt and braces. Neither of these should be reachable from here anyway — the
# drill container is on no shared network and is given its own credentials —
# but an operator editing this script later should hit the guard, not the
# production database.
if [[ -n "${PGDATABASE:-}${PGHOST:-}${DATABASE_URL:-}" ]]; then
  die 'PGHOST/PGDATABASE/DATABASE_URL are set in this shell. Unset them: this drill must not inherit a route to a real database.'
fi

if [[ -f "${ENV_FILE}" ]]; then
  # shellcheck disable=SC1090
  production_db="$(set -a; . "${ENV_FILE}"; set +a; printf '%s' "${POSTGRES_DB:-}")"
  [[ "${DRILL_DB}" != "${production_db}" ]] \
    || die "The drill database name matches the production database name (${production_db}). Refusing."
fi

command -v docker >/dev/null || die 'docker is not installed'

printf '\n\033[1mEkon restore drill\033[0m\n'
printf '    backup:    %s\n' "${dump_path}"
printf '    target:    disposable container %s (destroyed on exit)\n' "${DRILL_CONTAINER}"

# ---------------------------------------------------------------------------
# 2. Checksum
# ---------------------------------------------------------------------------

log 'Verifying checksum'

if [[ -f "${dump_path}.sha256" ]]; then
  if ( cd "$(dirname "${dump_path}")" && sha256sum --check --status "$(basename "${dump_path}").sha256" ); then
    pass "sha256 matches ${dump_path}.sha256"
  else
    fail 'sha256 does NOT match — this backup is corrupt'
    die 'Refusing to continue with a corrupt archive.'
  fi
else
  fail "No ${dump_path}.sha256 beside the dump — integrity cannot be proven"
fi

if head -c 5 "${dump_path}" | grep -q 'PGDMP'; then
  pass 'file is a PostgreSQL custom-format archive'
else
  fail 'file is not a PostgreSQL custom-format archive'
  die 'Nothing to restore.'
fi

# ---------------------------------------------------------------------------
# 3. Disposable PostgreSQL
# ---------------------------------------------------------------------------
#
# Same major version as production, so the drill proves what production would
# actually do. No --network, no -p: nothing can reach it and it can reach
# nothing. Its data directory is the container's own writable layer, which is
# exactly the wrong place for real data and exactly the right place for this.

teardown() {
  printf '\n    Removing %s\n' "${DRILL_CONTAINER}"
  docker rm --force --volumes "${DRILL_CONTAINER}" >/dev/null 2>&1 || true
}
trap teardown EXIT

log 'Starting a disposable PostgreSQL'

docker run --detach --rm=false \
  --name "${DRILL_CONTAINER}" \
  --network none \
  --env POSTGRES_DB="${DRILL_DB}" \
  --env POSTGRES_USER="${DRILL_USER}" \
  --env POSTGRES_PASSWORD="${DRILL_PASSWORD}" \
  --env POSTGRES_INITDB_ARGS='--locale-provider=icu --icu-locale=en-US --encoding=UTF8' \
  postgres:16-alpine >/dev/null \
  || die 'Could not start the disposable PostgreSQL'

printf '    waiting for it to accept connections'
for _ in $(seq 1 60); do
  if docker exec "${DRILL_CONTAINER}" pg_isready -U "${DRILL_USER}" -d "${DRILL_DB}" >/dev/null 2>&1; then
    break
  fi
  printf '.'
  sleep 1
done
printf '\n'
docker exec "${DRILL_CONTAINER}" pg_isready -U "${DRILL_USER}" -d "${DRILL_DB}" >/dev/null 2>&1 \
  || die 'The disposable PostgreSQL never became ready'
pass 'disposable PostgreSQL is ready'

# ---------------------------------------------------------------------------
# 4. Restore
# ---------------------------------------------------------------------------

log 'Restoring'

# --no-owner / --no-privileges: the dump was taken the same way, and the drill
# user is not the production role. --exit-on-error so a partial restore is a
# failure rather than a database that looks plausible.
if docker exec -i "${DRILL_CONTAINER}" \
     pg_restore --username "${DRILL_USER}" --dbname "${DRILL_DB}" \
                --no-owner --no-privileges --exit-on-error \
     < "${dump_path}"; then
  pass 'pg_restore completed without error'
else
  fail 'pg_restore reported errors'
fi

drill_sql() {
  docker exec -i "${DRILL_CONTAINER}" \
    psql --username "${DRILL_USER}" --dbname "${DRILL_DB}" \
         --tuples-only --no-align --quiet --command "$1" 2>/dev/null | tr -d '[:space:]'
}

# ---------------------------------------------------------------------------
# 5. Schema state
# ---------------------------------------------------------------------------

log 'Checking schema'

restored_version="$(drill_sql 'SELECT version FROM schema_migrations ORDER BY version DESC LIMIT 1')"

if [[ -n "${restored_version}" ]]; then
  pass "schema_migrations head is ${restored_version}"
else
  fail 'schema_migrations is missing or empty — this is not an Ekon database'
fi

# The head migration in the repository as checked out. A backup older than the
# current release will legitimately be behind, so this reports rather than
# fails: what matters is that the restored database has a coherent version.
head_migration="$(find "${REPO_DIR}/backend/migrations" -maxdepth 1 -name '[0-9][0-9][0-9][0-9]_*.sql' -printf '%f\n' 2>/dev/null | sort | tail -n 1)"
repo_version="${head_migration%%_*}"
if [[ -n "${repo_version}" && -n "${restored_version}" ]]; then
  if [[ "${restored_version}" == "${repo_version}" ]]; then
    pass "restored schema matches this checkout (${repo_version})"
  else
    printf '    \033[33mNOTE\033[0m  restored schema %s, this checkout expects %s — the backup predates the current release; migrations would run on restore.\n' \
      "${restored_version}" "${repo_version}"
  fi
fi

# ---------------------------------------------------------------------------
# 6. The tables the business actually is
# ---------------------------------------------------------------------------

log 'Checking core tables'

for table in users sessions role_capabilities products product_variants variant_attributes \
             inventory_locations inventory_movements inventory_balances operations schema_migrations; do
  exists="$(drill_sql "SELECT to_regclass('public.${table}') IS NOT NULL")"
  if [[ "${exists}" == "t" ]]; then pass "table ${table}"; else fail "table ${table} is missing"; fi
done

# ---------------------------------------------------------------------------
# 7. Read-only sanity
# ---------------------------------------------------------------------------
#
# Counts only. A drill that wrote to the restored copy would be testing
# something nobody asked about and would make the numbers below meaningless.

log 'Reading the restored data'

movements="$(drill_sql 'SELECT count(*) FROM inventory_movements')"
users_count="$(drill_sql 'SELECT count(*) FROM users')"
products="$(drill_sql 'SELECT count(*) FROM products')"
balances="$(drill_sql 'SELECT count(*) FROM inventory_balances')"

printf '    users %s · products %s · movements %s · balance rows %s\n' \
  "${users_count:-?}" "${products:-?}" "${movements:-?}" "${balances:-?}"

if [[ -n "${movements}" ]]; then
  pass 'inventory_movements is queryable'
else
  fail 'could not read inventory_movements'
fi

# An owner must exist, or nobody can sign in to the restored system.
owners="$(drill_sql "SELECT count(*) FROM users WHERE role = 'OWNER' AND is_active")"
if [[ "${owners:-0}" -ge 1 ]]; then
  pass "restored database has ${owners} active owner(s)"
else
  fail 'restored database has no active owner — nobody could sign in to it'
fi

# The ledger's own invariant, checked against the restored copy: a balance is a
# projection of movements, so a balance row with no movement behind it would
# mean the dump caught the two out of step.
orphans="$(drill_sql '
  SELECT count(*) FROM inventory_balances b
  WHERE NOT EXISTS (
    SELECT 1 FROM inventory_movements m
    WHERE m.variant_id = b.variant_id AND m.location_id = b.location_id
  )')"
if [[ "${orphans:-0}" == "0" ]]; then
  pass 'every balance row has movements behind it'
else
  fail "${orphans} balance row(s) with no matching movements"
fi

# ---------------------------------------------------------------------------
# 8. Verdict
# ---------------------------------------------------------------------------

printf '\n'
if (( failures > 0 )); then
  printf '\033[1;31mRESTORE DRILL: FAIL — %d check(s) failed\033[0m\n' "${failures}" >&2
  printf 'Do not enter real inventory until a drill passes.\n\n' >&2
  exit 1
fi

printf '\033[1;32mRESTORE DRILL: PASS\033[0m\n'
printf 'This backup restores into a working Ekon database.\n\n'
