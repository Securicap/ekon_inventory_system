#!/usr/bin/env bash
#
# Deploy one exact commit of Ekon to this VM, and refuse to call it deployed
# until the running application says it is that commit.
#
#   ./scripts/deploy.sh <git-ref>     deploy that ref
#   ./scripts/deploy.sh               deploy the currently checked-out commit
#
# The second form exists for a recovery shell where the operator has already
# checked out a known SHA. It still resolves to a full immutable SHA and still
# refuses a dirty working tree, so it cannot deploy something that is not in Git.
#
# This is infrastructure glue, not a deployment framework. It runs the
# application's own commands — `npm run migrate`, `npm run migrate:status` —
# from inside the image it just built, so the migration logic lives in one place
# and this script never learns what a migration is.

set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
readonly SCRIPT_DIR
DEPLOY_DIR="$(cd -- "${SCRIPT_DIR}/.." && pwd)"
readonly DEPLOY_DIR
REPO_DIR="$(cd -- "${DEPLOY_DIR}/../.." && pwd)"
readonly REPO_DIR
readonly ENV_FILE="${DEPLOY_DIR}/production.env"

readonly COMPOSE=(docker compose --env-file "${ENV_FILE}" -f "${DEPLOY_DIR}/compose.yaml")

log()  { printf '\n\033[1m==> %s\033[0m\n' "$*"; }
info() { printf '    %s\n' "$*"; }
die()  { printf '\n\033[1;31mDEPLOY FAILED: %s\033[0m\n' "$*" >&2; exit 1; }

# ---------------------------------------------------------------------------
# 1. Preconditions
# ---------------------------------------------------------------------------

log 'Checking preconditions'

[[ -f "${ENV_FILE}" ]] || die "${ENV_FILE} not found. Copy production.env.example and fill it in."

# A world-readable file holding the database password is worth stopping for.
perms="$(stat -c '%a' "${ENV_FILE}")"
[[ "${perms}" == "600" ]] || die "${ENV_FILE} has mode ${perms}; expected 600. Run: chmod 600 ${ENV_FILE}"

command -v docker >/dev/null || die 'docker is not installed'
docker compose version >/dev/null 2>&1 || die 'docker compose v2 is not available'
command -v git >/dev/null || die 'git is not installed'
command -v python3 >/dev/null || die 'python3 is required (health verification); it ships with Ubuntu LTS'

cd "${REPO_DIR}"

# A dirty tree means the thing being built is not the thing the SHA names, and
# the whole verification below would be attesting to a commit that does not
# describe what is running.
git diff --quiet HEAD 2>/dev/null || die 'Working tree has uncommitted changes. Commit, stash, or reset before deploying.'
[[ -z "$(git status --porcelain --untracked-files=no)" ]] || die 'Working tree is not clean.'

# ---------------------------------------------------------------------------
# 2. Resolve the release to an immutable SHA
# ---------------------------------------------------------------------------

log 'Resolving release'

requested_ref="${1:-}"

if [[ -n "${requested_ref}" ]]; then
  info "Requested: ${requested_ref}"
  git fetch --tags --prune origin || die 'git fetch failed'
  release_sha="$(git rev-parse --verify "${requested_ref}^{commit}" 2>/dev/null)" \
    || die "Cannot resolve '${requested_ref}' to a commit."
  git checkout --quiet --detach "${release_sha}" || die "Cannot check out ${release_sha}"
else
  info 'No ref given — deploying the currently checked-out commit.'
  release_sha="$(git rev-parse --verify HEAD)"
fi

# Read back from the tree rather than trusting the variable: this is the value
# the application will report, so it has to come from the same place the build
# does. Not a branch name, not a tag, not "staging" — the full 40-character SHA.
APP_VERSION="$(git rev-parse HEAD)"
[[ "${APP_VERSION}" =~ ^[0-9a-f]{40}$ ]] || die "APP_VERSION is not a full commit sha: '${APP_VERSION}'"
export APP_VERSION

info "APP_VERSION = ${APP_VERSION}"
info "             $(git log -1 --format='%s' "${APP_VERSION}")"

# ---------------------------------------------------------------------------
# 3. Derive the schema pin from the commit's own migrations
# ---------------------------------------------------------------------------
#
# The head migration of the checked-out tree, never a number from a file
# somebody edits. If this and the database disagree, the application refuses to
# boot — that refusal is the point, and it only works if this value is derived.

log 'Deriving schema version'

head_migration="$(find backend/migrations -maxdepth 1 -name '[0-9][0-9][0-9][0-9]_*.sql' -printf '%f\n' 2>/dev/null | sort | tail -n 1)"
[[ -n "${head_migration}" ]] || die 'No migrations found in backend/migrations. Refusing to deploy without a schema pin.'

EXPECTED_SCHEMA_VERSION="${head_migration%%_*}"
[[ "${EXPECTED_SCHEMA_VERSION}" =~ ^[0-9]{4}$ ]] \
  || die "Cannot derive a four-digit schema version from '${head_migration}'."
export EXPECTED_SCHEMA_VERSION

info "EXPECTED_SCHEMA_VERSION = ${EXPECTED_SCHEMA_VERSION}  (${head_migration})"

# ---------------------------------------------------------------------------
# 4. Refuse a password that would corrupt the connection string
# ---------------------------------------------------------------------------
#
# compose.yaml builds DATABASE_URL by substituting POSTGRES_PASSWORD into a URL.
# A password containing URL syntax would produce a connection string that fails
# in a way nobody would attribute to the password.

# shellcheck disable=SC1090
db_password="$(set -a; . "${ENV_FILE}"; set +a; printf '%s' "${POSTGRES_PASSWORD:-}")"
[[ -n "${db_password}" ]] || die 'POSTGRES_PASSWORD is empty in production.env'
[[ "${db_password}" =~ ^[A-Za-z0-9._~-]+$ ]] \
  || die 'POSTGRES_PASSWORD must contain only A-Z a-z 0-9 . _ ~ - so it is safe inside DATABASE_URL. Generate one with: openssl rand -hex 32'
[[ "${db_password}" != 'replace-with-openssl-rand-hex-32' ]] || die 'POSTGRES_PASSWORD is still the placeholder from production.env.example'

# ---------------------------------------------------------------------------
# 5. Build the image for this exact commit
# ---------------------------------------------------------------------------

log "Building ekon-app:${APP_VERSION}"
"${COMPOSE[@]}" build app || die 'Image build failed'

# ---------------------------------------------------------------------------
# 6. Database up and healthy before anything touches it
# ---------------------------------------------------------------------------

log 'Starting PostgreSQL'
"${COMPOSE[@]}" up -d --wait postgres || die 'PostgreSQL did not become healthy'
info 'PostgreSQL is healthy'

# ---------------------------------------------------------------------------
# 7. Migrate, using the application's own command from the image being deployed
# ---------------------------------------------------------------------------
#
# `run --rm` and not `exec`: the app container may not be running yet, and on a
# release it is deliberately still the *old* one. Migrations run from the new
# image, before the new container takes traffic, exactly as the platform-neutral
# deployment document describes.

log 'Running migrations'
"${COMPOSE[@]}" run --rm --no-deps app npm run migrate \
  || die 'Migration failed. The previous application container is untouched and still serving.'

log 'Migration status'
"${COMPOSE[@]}" run --rm --no-deps app npm run migrate:status \
  || die 'Could not read migration status'

# ---------------------------------------------------------------------------
# 8. Replace the application, then the edge
# ---------------------------------------------------------------------------

log 'Starting application and Caddy'
"${COMPOSE[@]}" up -d --wait app caddy || die 'Application or Caddy failed to start'

# ---------------------------------------------------------------------------
# 9. Verify — mechanically, against the public URL
# ---------------------------------------------------------------------------
#
# Not "print the health JSON and let a person glance at it". The deployment is
# not finished until the running application, reached the way a browser reaches
# it, reports this commit.

log 'Verifying deployment'
"${SCRIPT_DIR}/verify.sh" || die 'Health verification failed. The deployed build is NOT confirmed — see the output above.'

log "Deployed ${APP_VERSION}"
info "schema ${EXPECTED_SCHEMA_VERSION}"
info 'Next: docs/06-operations/oci-zero-cost.md — acceptance checklist'
