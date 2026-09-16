# syntax=docker/dockerfile:1

# Container runtime for the whole Ekon application: React frontend + Fastify API.
# Node 22 matches package.json's supported engine.
#
# Production is an installation on the shop computer, not a container — see
# docs/07-decisions/0013-local-first-shop-installation.md. This image builds and
# runs the same artifact for development, CI, and any container host; it is not
# the deployment target.
FROM node:22-bookworm-slim

WORKDIR /app

# Install from the lockfile before copying source so dependency installation is
# cached when application code changes.
COPY package.json package-lock.json ./
COPY shared/package.json ./shared/package.json
COPY backend/package.json ./backend/package.json
COPY frontend/package.json ./frontend/package.json
RUN npm ci

COPY . .

# Root build order is shared -> frontend -> backend. Vite writes the browser
# build into backend/public, which Fastify serves from the same origin.
RUN npm run build

# The application's own default port is 3000; 8080 is the port containers are
# commonly expected to listen on, and it keeps every `docker run` of this image
# identical. Anything that owns PORT can still override it. The installed
# product sets its own port and binds to 127.0.0.1.
# `DEPLOYMENT_PROFILE=hosted` is what says *this is a container behind a proxy*,
# which is a different question from NODE_ENV: it defaults the session cookie to
# `Secure`, trusts `X-Forwarded-*`, and makes EXPECTED_SCHEMA_VERSION mandatory.
# The installed product sets `local` instead, where none of those is true — the
# browser reaches it at http://127.0.0.1 with no proxy in front.
ENV NODE_ENV=production \
    DEPLOYMENT_PROFILE=hosted \
    PORT=8080 \
    HOST=0.0.0.0 \
    STATIC_DIR=./public

# Keep migrations, source and dev tooling in this image so the exact same
# revision can run `ekon-ctl migrate` and `ekon-ctl create-owner` (and the npm
# scripts that call the same code) as controlled admin commands. We can split/trim the image later if it becomes
# materially useful; correctness is more important than image minimalism now.
WORKDIR /app/backend
USER node

CMD ["node", "dist/main.js"]
