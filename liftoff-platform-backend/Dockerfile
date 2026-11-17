# Liftoff Platform Backend
# Deploys to Cloud Run per Section 2
# Multi-stage build optimized for minimal production image

FROM node:22-slim AS builder

# GCP AR token for fetching @liftoffos/proto-gen (not a workspace package)
ARG ARTIFACT_REGISTRY_TOKEN

WORKDIR /app

# Copy package files including workspace packages
COPY package*.json ./
COPY packages/ ./packages/
COPY .npmrc ./

# Install all dependencies; ARTIFACT_REGISTRY_TOKEN is expanded by npm from .npmrc
RUN ARTIFACT_REGISTRY_TOKEN="${ARTIFACT_REGISTRY_TOKEN}" npm ci

# Copy source code
COPY . .

# Build workspace packages first, then main app.
#
# The heap bump is load-bearing: node's default old-space ceiling is a fraction
# of the build machine's memory, and tsc over this codebase now crosses it —
# the failure is an abrupt "Reached heap limit" abort at ~90% of the way
# through, not a type error, so it reads like an infrastructure flake rather
# than what it is. Raised rather than tracked, because the number only ever goes
# one way as the codebase grows.
ENV NODE_OPTIONS=--max-old-space-size=6144
RUN npm run build --workspaces --if-present && npm run build

# Production dependencies only
FROM node:22-slim AS deps

ARG ARTIFACT_REGISTRY_TOKEN

WORKDIR /app
COPY package*.json ./
COPY packages/ ./packages/
COPY .npmrc ./

# Install production deps only (workspace packages will be linked)
RUN ARTIFACT_REGISTRY_TOKEN="${ARTIFACT_REGISTRY_TOKEN}" npm ci --omit=dev && npm cache clean --force

# Final production image
FROM node:22-slim

WORKDIR /app

# Copy only production dependencies (no devDeps)
COPY --from=deps /app/node_modules ./node_modules

# Copy ALL workspace package artifacts (dist + package.json) needed at runtime.
# Using the whole packages/ tree from the builder avoids whack-a-mole when new
# packages are added — service-client, telemetry, shared-types, etc. all need
# to be present or `require('@liftoffos/*')` fails at startup with
# "Cannot find module" and Cloud Run rolls back the revision.
# Packages are small; the dev-only packages/contract-tests/ src files are
# harmless to include.
COPY --from=builder /app/packages ./packages

# Copy built application
COPY --from=builder /app/dist ./dist
# Copy agent template catalog YAML files — TypeScript doesn't copy non-.ts files
# to dist/. initTemplateLoader() looks for dist/agent-templates/catalog/ at runtime.
COPY --from=builder /app/src/agent-templates/catalog ./dist/agent-templates/catalog
# Same for team-preset YAMLs — initTeamPresetLoader() looks for dist/agent-templates/team-presets/.
COPY --from=builder /app/src/agent-templates/team-presets ./dist/agent-templates/team-presets
# Copy Teams app-package assets (manifest template + icons) — read at runtime by
# teams-app-service from process.cwd()/assets/teams; tsc does not emit them to dist/.
COPY --from=builder /app/assets ./assets
COPY package*.json ./

ENV NODE_ENV=production
EXPOSE 8080

# Run as non-root user for security
USER node

CMD ["node", "dist/index.js"]

