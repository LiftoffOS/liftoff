# Build stage
FROM node:22-alpine AS builder

WORKDIR /app

# Install Chromium so @prerenderer/renderer-puppeteer can snapshot routes during
# `vite build`. Tell Puppeteer to skip its own Chromium download and use the
# alpine package instead — it's smaller and avoids glibc issues on alpine.
RUN apk add --no-cache \
      chromium \
      nss \
      freetype \
      harfbuzz \
      ca-certificates \
      ttf-freefont \
      font-noto-emoji
ENV PUPPETEER_SKIP_DOWNLOAD=true \
    PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium-browser

# Firebase environment variables (passed from Cloud Build via Secret Manager)
ARG VITE_FIREBASE_API_KEY
ARG VITE_FIREBASE_AUTH_DOMAIN
ARG VITE_FIREBASE_PROJECT_ID
ARG VITE_FIREBASE_STORAGE_BUCKET
ARG VITE_FIREBASE_MESSAGING_SENDER_ID
ARG VITE_FIREBASE_APP_ID
ARG VITE_API_URL
ARG VITE_STRIPE_PUBLISHABLE_KEY
# Deployment-specific URLs. NO DEFAULTS, deliberately: an ARG default here is
# baked into every image built without an explicit --build-arg, so a default
# pointing at one deployment's infrastructure silently ships inside everybody
# else's. Empty means the feature is absent, which is visible; a stale URL is not.
# Credential CRUD calls go directly to developer-proxy (a public URL, not a secret).
ARG VITE_DEVELOPER_PROXY_URL=
# Web Push (VAPID) public key — shipped in the bundle, not a secret, but it is
# the key of ONE Firebase project and push silently goes nowhere with another's.
ARG VITE_FIREBASE_VAPID_KEY=
# Comma-separated email-domain allow-list for sign-in and signup. EMPTY BY
# DEFAULT, meaning no restriction — prod signup is open, and only the dev
# trigger overrides this. Defaulting to empty is what keeps a main-to-release
# promotion from silently closing public signup.
ARG VITE_ALLOWED_EMAIL_DOMAINS=

ENV VITE_FIREBASE_API_KEY=$VITE_FIREBASE_API_KEY
ENV VITE_FIREBASE_AUTH_DOMAIN=$VITE_FIREBASE_AUTH_DOMAIN
ENV VITE_FIREBASE_PROJECT_ID=$VITE_FIREBASE_PROJECT_ID
ENV VITE_FIREBASE_STORAGE_BUCKET=$VITE_FIREBASE_STORAGE_BUCKET
ENV VITE_FIREBASE_MESSAGING_SENDER_ID=$VITE_FIREBASE_MESSAGING_SENDER_ID
ENV VITE_FIREBASE_APP_ID=$VITE_FIREBASE_APP_ID
ENV VITE_API_URL=$VITE_API_URL
ENV VITE_STRIPE_PUBLISHABLE_KEY=$VITE_STRIPE_PUBLISHABLE_KEY
ENV VITE_DEVELOPER_PROXY_URL=$VITE_DEVELOPER_PROXY_URL
ENV VITE_FIREBASE_VAPID_KEY=$VITE_FIREBASE_VAPID_KEY
ENV VITE_ALLOWED_EMAIL_DOMAINS=$VITE_ALLOWED_EMAIL_DOMAINS

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm ci

# Copy source code
COPY . .

# Build the app
RUN npm run build

# Production stage — brotli-enabled nginx. nginx.conf uses brotli_static/brotli,
# which stock nginx:alpine lacks (it would fail to start on the unknown directive),
# so we use fholzer/nginx-brotli (brotli compiled in statically). Pinned to the
# nginx 1.28 stable line. To verify the module locally:
#   docker run --rm fholzer/nginx-brotli:v1.28.0 nginx -V 2>&1 | grep -i brotli
FROM fholzer/nginx-brotli:v1.28.0

# The nginx config is a TEMPLATE: docker-entrypoint.sh substitutes this
# deployment's own hostnames into it at container start and refuses to start
# when they are unset. See nginx.conf.template's header for why the
# substitution happens there rather than through an nginx variable.
COPY nginx.conf.template /etc/nginx/nginx.conf.template
COPY docker-entrypoint.sh /docker-entrypoint.sh
RUN chmod +x /docker-entrypoint.sh

# The SPA route allowlist, generated from src/App.tsx during `npm run build`
# above. nginx.conf includes it and will not start without it, which is
# deliberate: a missing allowlist would otherwise mean an undefined
# $is_spa_route and a site that 404s everything. Fail at boot, not in traffic.
#
# NOT into conf.d/ — the base image already includes conf.d/*.conf, so a second
# copy would be loaded twice and nginx would abort on the duplicate map.
COPY --from=builder /app/nginx/spa-routes.conf /etc/nginx/spa-routes.conf

# Copy built assets from builder
COPY --from=builder /app/dist /usr/share/nginx/html

# Expose port 8080 (Cloud Run default)
EXPOSE 8080

# fholzer/nginx-brotli sets ENTRYPOINT ["nginx", ...], so a bare CMD would be
# appended as args ('nginx: invalid option: "nginx"'). Reset it, then run the
# entrypoint, which renders the config and execs nginx itself.
ENTRYPOINT []
CMD ["/docker-entrypoint.sh"]
