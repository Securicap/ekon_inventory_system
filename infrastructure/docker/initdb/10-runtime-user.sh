#!/bin/sh
#
# Creates the LOGIN user the application connects as, for local development.
#
# Migration 0014 creates `ekon_app` — a NOLOGIN role that holds the privileges —
# and deliberately does not create anybody who can log in: a migration is
# committed to this repository and a password is not. Every environment creates
# its own login user and puts it in `ekon_app`, and this is that step for a
# developer's machine.
#
# The *membership* cannot be granted here: Docker runs this on an empty data
# directory, before any migration has run, so `ekon_app` does not exist yet.
# `make db-app-user` grants it afterwards, and is idempotent — it is also what a
# developer whose volume predates this file runs, since Docker only runs an init
# script when it creates the data directory.
set -e

user="${EKON_RUNTIME_USER:-ekon_runtime}"
password="${EKON_RUNTIME_PASSWORD:-ekon_runtime}"

psql --username "${POSTGRES_USER}" --dbname "${POSTGRES_DB}" \
     --set ON_ERROR_STOP=1 \
     --set runtime_user="${user}" \
     --set runtime_password="${password}" <<'SQL'
SELECT format('CREATE ROLE %I LOGIN PASSWORD %L', :'runtime_user', :'runtime_password')
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = :'runtime_user')
\gexec
SQL
