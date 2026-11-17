# syntax=docker/dockerfile:1.6
# Artifact Registry access token injected via --build-arg by Cloud Build's ar-token step;
# .npmrc references ${ARTIFACT_REGISTRY_TOKEN} for @liftoffos/* scoped packages.
FROM node:20-alpine AS build
ARG ARTIFACT_REGISTRY_TOKEN
WORKDIR /app
COPY package.json package-lock.json* .npmrc ./
RUN ARTIFACT_REGISTRY_TOKEN="${ARTIFACT_REGISTRY_TOKEN}" npm ci
COPY tsconfig.json ./
COPY src ./src
# The build's pre-hook runs the dependency-integrity check, so the script has to
# be in the image. It passes trivially here — a container has exactly one
# node_modules and nothing to borrow from — but keeping the gate uniform means
# `npm run build` behaves the same everywhere rather than only outside Docker.
COPY scripts ./scripts
RUN npm run build

FROM node:20-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/dist ./dist
COPY --from=build /app/node_modules ./node_modules
COPY package.json ./
# Cloud Run grace period matches Phase 0r contract (30s internal + 5s buffer = 35s)
EXPOSE 8080
USER node
CMD ["node", "dist/index.js"]
