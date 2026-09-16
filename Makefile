.DEFAULT_GOAL := help
SHELL := /bin/bash

.PHONY: help setup db-up db-app-user db-down db-reset dev build test test-unit lint format typecheck check migrate migrate-status clean

help: ## Show this help
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) \
		| awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-16s\033[0m %s\n", $$1, $$2}'

setup: ## Install dependencies, create .env, start the database, migrate
	npm install
	@test -f .env || (cp .env.example .env && echo "Created .env from .env.example")
	$(MAKE) db-up
	npm run build --workspace shared
	$(MAKE) migrate
	$(MAKE) db-app-user
	@echo ""
	@echo "Setup complete. Run 'make dev' and open http://localhost:5173"

db-up: ## Start local PostgreSQL in Docker and wait for it
	docker compose -f infrastructure/docker/compose.yml up -d
	@echo -n "Waiting for PostgreSQL"
	@for i in $$(seq 1 30); do \
		if docker compose -f infrastructure/docker/compose.yml exec -T postgres pg_isready -U ekon -q 2>/dev/null; then \
			echo " ready."; exit 0; \
		fi; \
		echo -n "."; sleep 1; \
	done; \
	echo " timed out."; exit 1

db-app-user: ## Create the restricted application login role and put it in ekon_app
	@# The application connects as a role that may only INSERT into the ledger
	@# (migration 0014). `ekon_app` holds the privileges and cannot log in; this
	@# creates the local login user and grants it the membership. Run after
	@# migrating, because `ekon_app` is created by a migration.
	@#
	@# Idempotent, and safe on a database that predates 0014's arrival: Docker
	@# only runs an init script when it creates the data directory, so a
	@# developer with an existing volume gets the role from here instead.
	docker compose -f infrastructure/docker/compose.yml exec -T postgres \
		psql -v ON_ERROR_STOP=1 -U ekon -d ekon_dev -c "\
		DO \$$\$$ BEGIN \
		  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ekon_runtime') THEN \
		    CREATE ROLE ekon_runtime LOGIN PASSWORD 'ekon_runtime'; \
		  END IF; \
		  GRANT ekon_app TO ekon_runtime; \
		END \$$\$$;"
	@echo "ekon_runtime is a member of ekon_app."

db-down: ## Stop local PostgreSQL (data is preserved)
	docker compose -f infrastructure/docker/compose.yml down

db-reset: ## Destroy and recreate the local database from scratch
	docker compose -f infrastructure/docker/compose.yml down -v
	$(MAKE) db-up
	$(MAKE) migrate
	$(MAKE) db-app-user

dev: ## Run backend and frontend in watch mode
	npm run dev

build: ## Production build (shared, then frontend into backend/public, then backend)
	npm run build

migrate: ## Apply pending database migrations
	npm run migrate

migrate-status: ## Show which migrations are applied
	npm run migrate:status

test: ## Run all tests (requires the database to be up)
	npm run test

test-unit: ## Run only tests that do not need a database
	npm run test --workspace shared --if-present
	npm run test --workspace frontend

typecheck: ## Type-check every workspace
	npm run typecheck

lint: ## Lint, format check, and project conventions
	npm run lint
	npm run format:check
	node scripts/check-conventions.mjs

format: ## Auto-format the repository
	npm run format

check: typecheck lint test ## Everything CI runs, locally

clean: ## Remove build output and dependencies
	rm -rf node_modules */node_modules */dist backend/public
	find . -name '*.tsbuildinfo' -not -path './node_modules/*' -delete
