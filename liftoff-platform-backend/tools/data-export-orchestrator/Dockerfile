FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci
COPY tsconfig.json ./
COPY tools/data-export-orchestrator ./tools/data-export-orchestrator
RUN npx tsc -p tools/data-export-orchestrator/tsconfig.json

FROM node:22-alpine AS runtime
WORKDIR /app
COPY --from=build /app/dist ./dist
COPY --from=build /app/node_modules ./node_modules
USER node
CMD ["node", "dist/tools/data-export-orchestrator/index.js"]
