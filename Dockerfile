# syntax=docker/dockerfile:1

# Container runtime for the whole Ekon application: React frontend + Fastify API.
# Node 22 matches package.json's supported engine.
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

# The application's own default port is 3000; setting 8080 here is what makes the
# container listen where the hosting platform's public port expects it, and keeps
# local `docker run` identical to the deployed service. A platform that owns PORT
# can still override it.
ENV NODE_ENV=production \
    PORT=8080 \
    HOST=0.0.0.0 \
    STATIC_DIR=./public

# Keep migrations, source and dev tooling in this first deployment image so the
# exact same revision can run `npm run migrate` and `npm run identity:create-owner`
# as controlled admin commands. We can split/trim the image later if it becomes
# materially useful; correctness is more important than image minimalism now.
WORKDIR /app/backend
USER node

CMD ["node", "dist/main.js"]
