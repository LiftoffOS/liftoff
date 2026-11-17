# framer-secret-rotate Cloud Run Job
# Rotates the UntrustedContentFramer server secret in Secret Manager.
# Triggered by Cloud Scheduler every 90 days.

FROM node:20-slim

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY rotate.js ./

# Run as non-root
USER node

CMD ["node", "rotate.js"]
