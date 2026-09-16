#!/usr/bin/env bash
#
# One night's backup: dump the database, checksum it, put both in OCI Object
# Storage, and only then prune old local copies.
#
#   ./scripts/backup.sh
#   EKON_BACKUP_SKIP_UPLOAD=1 ./scripts/backup.sh    dump and checksum only
#
# The skip-upload path exists so the dump/checksum/restore half can be rehearsed
# on a laptop with no OCI account. It is not for production: a backup that never
# left the VM does not survive the VM, and the VM is the thing Oracle may
# reclaim.
#
# Ordering matters more than anything else here:
#
#   dump to a temporary name  ->  a truncated dump can never be mistaken for a
#                                 finished one
#   rename only on success    ->  a file with the final name is a complete file
#   upload, then prune        ->  the last good local copy is never deleted
#                                 because the network was down
#
# pg_dump runs inside the postgres container, so the client is always the exact
# version of the server that wrote the data. Nothing needs installing on the host.

set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
readonly SCRIPT_DIR
DEPLOY_DIR="$(cd -- "${SCRIPT_DIR}/.." && pwd)"
readonly DEPLOY_DIR
readonly ENV_FILE="${DEPLOY_DIR}/production.env"

log()  { printf '[ekon-backup] %s\n' "$*"; }
die()  { printf '[ekon-backup] FAILED: %s\n' "$*" >&2; exit 1; }

[[ -f "${ENV_FILE}" ]] || die "${ENV_FILE} not found"
set -a
# shellcheck disable=SC1090  # path is computed at runtime
. "${ENV_FILE}"
set +a

: "${POSTGRES_DB:?POSTGRES_DB is not set}"
: "${POSTGRES_USER:?POSTGRES_USER is not set}"

readonly STATE_DIR="${EKON_STATE_DIR:-/srv/ekon}"
readonly BACKUP_DIR="${STATE_DIR}/backups"
readonly KEEP="${BACKUP_LOCAL_KEEP:-7}"
readonly COMPOSE=(docker compose --env-file "${ENV_FILE}" -f "${DEPLOY_DIR}/compose.yaml")

mkdir -p "${BACKUP_DIR}"

stamp="$(date -u +%Y%m%dT%H%M%SZ)"
base="ekon-${stamp}.dump"
tmp="${BACKUP_DIR}/.${base}.partial"
final="${BACKUP_DIR}/${base}"
checksum="${final}.sha256"

# A partial file from a crashed run must never linger where the next restore
# might reach for it.
cleanup() { rm -f "${tmp}"; }
trap cleanup EXIT

# ---------------------------------------------------------------------------
# 1. Dump
# ---------------------------------------------------------------------------
#
# -Fc: PostgreSQL's custom format. Compressed, and restorable selectively by
# pg_restore, which is what the restore drill uses. Plain SQL would be larger
# and would force an all-or-nothing psql restore.

log "Dumping ${POSTGRES_DB} -> ${base}"

"${COMPOSE[@]}" exec -T postgres \
  pg_dump --format=custom --compress=6 --no-owner --no-privileges \
          --username "${POSTGRES_USER}" "${POSTGRES_DB}" \
  > "${tmp}" \
  || die 'pg_dump failed — no backup was produced'

[[ -s "${tmp}" ]] || die 'pg_dump produced an empty file'

# A custom-format dump starts with the magic "PGDMP". Catching a shell error
# message that landed in the file here is cheaper than discovering it during a
# restore six months from now.
head -c 5 "${tmp}" | grep -q 'PGDMP' || die 'Dump does not look like a PostgreSQL custom-format archive'

mv "${tmp}" "${final}"
trap - EXIT

size="$(du -h "${final}" | cut -f1)"
log "Dump complete: ${final} (${size})"

# ---------------------------------------------------------------------------
# 2. Checksum
# ---------------------------------------------------------------------------
#
# Written next to the dump and uploaded with it. The restore drill and the
# weekly off-Oracle copy both verify against this, which is what makes "the
# backup exists" mean "the backup is intact".

( cd "${BACKUP_DIR}" && sha256sum "${base}" > "${base}.sha256" ) || die 'Could not compute checksum'
log "Checksum: $(cut -d' ' -f1 "${checksum}")"

# ---------------------------------------------------------------------------
# 3. Upload to Object Storage
# ---------------------------------------------------------------------------
#
# Instance principal: the VM proves who it is with its own instance identity,
# through a dynamic group and a policy scoped to this one bucket. No API key, no
# private key, no tenancy OCID on this machine.

if [[ "${EKON_BACKUP_SKIP_UPLOAD:-0}" == "1" ]]; then
  log 'EKON_BACKUP_SKIP_UPLOAD=1 — skipping upload and skipping local pruning.'
  log 'This is a rehearsal, not a backup: nothing has left the VM.'
  exit 0
fi

: "${OCI_BACKUP_BUCKET:?OCI_BACKUP_BUCKET is not set}"
command -v oci >/dev/null || die 'The OCI CLI is not installed — see the runbook'

oci_args=(--auth instance_principal)
[[ -n "${OCI_REGION:-}" ]] && oci_args+=(--region "${OCI_REGION}")

namespace="${OCI_BACKUP_NAMESPACE:-}"
if [[ -z "${namespace}" ]]; then
  namespace="$(oci os ns get "${oci_args[@]}" --query 'data' --raw-output)" \
    || die 'Could not resolve the Object Storage namespace. Check the instance principal and dynamic group.'
fi

upload() {
  local path="$1" name="$2"
  log "Uploading ${name}"
  oci os object put "${oci_args[@]}" \
    --namespace "${namespace}" \
    --bucket-name "${OCI_BACKUP_BUCKET}" \
    --name "${name}" \
    --file "${path}" \
    --no-overwrite \
    >/dev/null \
    || die "Upload of ${name} failed. The local copy is kept and nothing was pruned."
}

# The checksum goes up first. If the connection dies between the two, the
# orphan is a checksum with no dump — harmless — rather than a dump nobody can
# verify, which is worse than no dump at all.
upload "${checksum}" "${base}.sha256"
upload "${final}" "${base}"

log "Uploaded to oci://${OCI_BACKUP_BUCKET}/${base}"

# ---------------------------------------------------------------------------
# 4. Prune local copies — only now
# ---------------------------------------------------------------------------
#
# Remote retention is an Object Storage lifecycle rule, configured once in the
# console. This script deletes nothing in the bucket: a scripted delete loop
# against the only off-VM copy of the business's records is the kind of clever
# that erases a shop's inventory history at 3am.

log "Pruning local backups, keeping the newest ${KEEP}"

# `find -printf` then sort by name: the timestamp is in the filename in a
# lexicographically sortable form, so this needs no stat and no ls parsing.
mapfile -t all_dumps < <(find "${BACKUP_DIR}" -maxdepth 1 -name 'ekon-*.dump' -printf '%f\n' | sort)

if (( ${#all_dumps[@]} > KEEP )); then
  prune_count=$(( ${#all_dumps[@]} - KEEP ))
  for old in "${all_dumps[@]:0:${prune_count}}"; do
    log "Removing local ${old}"
    rm -f "${BACKUP_DIR}/${old}" "${BACKUP_DIR}/${old}.sha256"
  done
fi

log "Done. ${base} is in Object Storage and on this VM."
