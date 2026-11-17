# ConnectorService — Liftoff Platform Decomposition Phase 1
# Deploys to Cloud Run in YOUR_GCP_PROJECT<env>.

FROM node:20-slim AS builder

WORKDIR /app

# Native build deps if any @liftoffos/* dep grows one later. Keeping the
# image parity with tenant-runtime for now.
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

COPY package*.json ./
COPY .npmrc ./

# ARTIFACT_REGISTRY_TOKEN authorises pulling @liftoffos/* from
# us-west1-npm.pkg.dev. Cloud Build populates via
# `gcloud auth print-access-token`.
ARG ARTIFACT_REGISTRY_TOKEN=""

RUN npm ci

COPY . .

RUN npm run build

# ─── Runtime image ───────────────────────────────────────────────────────

FROM node:20-slim

WORKDIR /app

COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package*.json ./

ENV NODE_ENV=production
EXPOSE 8080

CMD ["node", "dist/index.js"]
