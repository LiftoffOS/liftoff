# syntax=docker/dockerfile:1.6
FROM node:20-alpine AS build
WORKDIR /app
ARG ARTIFACT_REGISTRY_TOKEN
COPY .npmrc ./
COPY package.json package-lock.json* ./
RUN ARTIFACT_REGISTRY_TOKEN=${ARTIFACT_REGISTRY_TOKEN} npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:20-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/dist ./dist
COPY --from=build /app/node_modules ./node_modules
COPY package.json ./
EXPOSE 8080
USER node
CMD ["node", "dist/index.js"]
