# liftoff-harvest-service
# Deploys to Cloud Run in YOUR_GCP_PROJECT<env>.

FROM node:20-slim AS builder

WORKDIR /app

RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

COPY package*.json ./
COPY .npmrc ./

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
