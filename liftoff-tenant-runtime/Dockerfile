# Liftoff Tenant Runtime
# Deploys to Cloud Run per Section 2

FROM node:20-slim AS builder

WORKDIR /app

# R5 Fix 1: build toolchain required for the openat native addon
# (src/workspace/native/openat.cc). Linux Cloud Run target; Python + g++
# for node-gyp.
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
       python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

# Copy package files including workspace packages
COPY package*.json ./
COPY .npmrc ./
COPY packages/ ./packages/

# ARTIFACT_REGISTRY_TOKEN is a short-lived access token (used by .npmrc's
# :_authToken substitution) that authorizes this build to pull @liftoffos/*
# packages from us-west1-npm.pkg.dev. Cloud Build populates it via
# `gcloud auth print-access-token`.
# ENV re-export is required: .npmrc reads ${ARTIFACT_REGISTRY_TOKEN} from
# process.env, and Docker ARG values aren't on env by default. Previous
# builds happened to hit the npm-ci layer cache; any package-lock.json
# change exposes the missing ENV with a 403 from the GAR npm proxy.
ARG ARTIFACT_REGISTRY_TOKEN=""
ENV ARTIFACT_REGISTRY_TOKEN=$ARTIFACT_REGISTRY_TOKEN

# Install all dependencies (including @liftoffos/* from Artifact Registry)
RUN npm ci

# Copy source code
COPY . .

# R5 Fix 1: compile the openat native addon. Required for atomic write-path
# TOCTOU check in path-isolation. Falls back to chain-walk advisory if missing,
# but that is a degraded mode; Cloud Run builds MUST include the .node binary.
RUN cd src/workspace/native/ && npx node-gyp rebuild

# Build workspace packages first, then main app
RUN npm run build --workspaces --if-present && npm run build

FROM node:20-slim

WORKDIR /app

# Copy ALL workspace package artifacts (dist + package.json) needed at runtime.
# Using the whole packages/ tree from the builder avoids whack-a-mole when new
# packages are added — shared-types, service-client, telemetry, etc. all need
# to be present or `require('@liftoffos/*')` fails at startup with
# "Cannot find module" and Cloud Run rolls back the revision.
COPY --from=builder /app/packages ./packages

# Copy built application and dependencies
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
# R5 Fix 1: copy the compiled openat.node binary
COPY --from=builder /app/src/workspace/native/build ./src/workspace/native/build
COPY package*.json ./
# Phase 2b: MCP sidecars moved to the connector-service image. The tenant
# runtime is now a pure RPC client of connector-service — no in-process
# sidecar lookup — so the old COPY of /app/mcp-servers is removed.

# Vendor coding-agent CLIs / servers:
#  - F-3b: OpenAI Codex CLI (`codex` binary). @openai/codex-sdk spawns it at
#    runtime for code_session AND for the Codex agent engine (adapter/codex),
#    which is OpenAI's DEFAULT engine.
#  - F-6:  Gemini CLI (`gemini` binary) for the code_session Gemini runner AND
#    for the Gemini CLI agent engine (adapter/gemini-cli), Google's DEFAULT
#    engine, which drives it headless over stream-json.
#  - opencode: `opencode` binary for the opencode agent engine (adapter/opencode),
#    the DEFAULT for xAI and the open-weights families. @opencode-ai/sdk's
#    createOpencode() spawns the server.
#
# The SDK pin in package-lock.json and the CLI pin here are a PAIR, and both
# feed the `certify-on-sdk-change` fingerprint in cloudbuild.yaml: a move of
# either re-runs the live certification before the deploy proceeds.
#
# PIN every CLI to a specific STABLE version — never `@latest`. opencode-ai
# publishes 10+ builds/day, and `@latest` made images non-reproducible: dev and
# prod (built minutes apart) silently got different opencode versions, and the
# 1.18.8 release slowed the opencode server startup past the SDK's default,
# breaking the openrouter/opencode engine on rebuilt images. opencode-ai is
# pinned to 1.18.7 (last stable before that regression; compatible with the
# @opencode-ai/sdk 1.18.x pinned in package-lock). Bump these deliberately.
# curl / python3 / jq are here because agents run shell steps in this image and
# a data task reaches for them by reflex. Without them a step dies on exit 127
# ("command not found"), which the recovery LLM correctly reads as an
# environment problem and escalates to a human — ending a run that was otherwise
# working. For example, an agent can fetch every record it needs, then
# escalate with "provision an environment that includes curl and python3".
#
# This grants no new capability. The image already ships node, whose built-in
# fetch covers every HTTP call curl makes, plus arbitrary scripting — so these
# are convenience, not access. python3 is stdlib-only on purpose: pip would mean
# arbitrary package installs at runtime, which IS a new surface, and the
# sandbox-sidecar image already provides pip/venv for work that needs it.
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates curl python3 jq \
 && rm -rf /var/lib/apt/lists/* \
 && npm install -g @openai/codex@0.139.0 @google/gemini-cli@0.52.0 opencode-ai@1.18.7

ENV NODE_ENV=production
EXPOSE 8080

CMD ["node", "dist/index.js"]
