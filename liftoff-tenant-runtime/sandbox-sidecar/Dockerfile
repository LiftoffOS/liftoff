# Sandbox Sidecar Container Image
# Multi-process container: nginx + TS sidecar + openvscode-server + Chromium (via Playwright) + Xvfb/x11vnc/noVNC
# Shared /workspace across all processes (fusion property).
#
# BUILD CONTEXT: this Dockerfile expects the build context to be the REPO ROOT
# (the directory above `sandbox-sidecar/`), so it can COPY in the sibling
# `packages/sandbox-validators`, `packages/sandbox-contracts`, and
# `packages/agent-sdk` workspaces that the sidecar declares as `file:` deps.
# The matching cloudbuild.yaml invokes:
#     docker build -f sandbox-sidecar/Dockerfile .
# from the repo root.

# ─── Stage 1: build the sibling workspace packages (validators, contracts, agent-sdk) ──
FROM node:20-bookworm AS pkgs-build
WORKDIR /pkgs
COPY packages/sandbox-validators ./sandbox-validators
COPY packages/sandbox-contracts  ./sandbox-contracts
COPY packages/agent-sdk          ./agent-sdk
RUN cd sandbox-validators && npm install --include=dev --no-audit --no-fund && npm run build \
 && cd ../sandbox-contracts && npm install --include=dev --no-audit --no-fund && npm run build \
 && cd ../agent-sdk && npm install --include=dev --no-audit --no-fund && npm run build

# ─── Stage 2: build the TS sidecar ─────────────────────────────────────────
FROM node:20-bookworm AS sidecar-build
WORKDIR /build
# Place the prebuilt sibling packages where the sidecar's package.json
# `file:` refs resolve them (`file:../packages/sandbox-validators` etc).
COPY --from=pkgs-build /pkgs ./packages
WORKDIR /build/sandbox-sidecar
COPY sandbox-sidecar/package.json sandbox-sidecar/tsconfig.json ./
COPY sandbox-sidecar/package-lock.json* ./
COPY sandbox-sidecar/src ./src
# Reproducible build: npm ci when lockfile present (normal/CI builds); fall
# back to npm install only on the bootstrap commit before the lockfile exists.
# IMPORTANT: --ignore-scripts is NOT used — node-pty needs its prebuild-install
# postinstall to fetch the native binding. Playwright's chromium download is
# skipped because the runtime image already provides chromium at /ms-playwright.
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
# --install-links: resolve file: deps by copying contents into node_modules
# instead of symlinking back to ../packages. Required so the runtime image
# can COPY just node_modules without the workspace tree.
RUN if [ -f package-lock.json ]; then npm ci --install-links --no-audit --no-fund; else npm install --install-links --no-audit --no-fund; fi \
    && npm run build

# ─── Stage 3: download openvscode-server ───────────────────────────────────
FROM debian:bookworm-slim AS vscode-fetch
ARG OPENVSCODE_VERSION=1.92.1
# SHA256 MUST be set via --build-arg at build time. Image build will fail loudly if missing.
ARG OPENVSCODE_SHA256
ENV DEBIAN_FRONTEND=noninteractive
RUN test -n "${OPENVSCODE_SHA256}" || (echo "OPENVSCODE_SHA256 build-arg required" && exit 1) \
    && apt-get update && apt-get install -y --no-install-recommends curl ca-certificates \
    && curl -fSL "https://github.com/gitpod-io/openvscode-server/releases/download/openvscode-server-v${OPENVSCODE_VERSION}/openvscode-server-v${OPENVSCODE_VERSION}-linux-x64.tar.gz" -o /tmp/ovs.tgz \
    && echo "${OPENVSCODE_SHA256}  /tmp/ovs.tgz" | sha256sum -c - \
    && mkdir -p /opt/openvscode-server \
    && tar -xzf /tmp/ovs.tgz -C /opt/openvscode-server --strip-components=1 \
    && rm /tmp/ovs.tgz

# ─── Stage 4: runtime image ────────────────────────────────────────────────
# Playwright base ships with Chromium + every system dep needed to run it.
FROM mcr.microsoft.com/playwright:v1.48.0-jammy

ENV DEBIAN_FRONTEND=noninteractive

# Process supervisor, reverse proxy, signal handler, VNC stack
RUN apt-get update && apt-get install -y --no-install-recommends \
      tini supervisor nginx \
      xvfb x11vnc \
      python3 python3-pip python3-venv \
      git curl jq openssh-client ripgrep fd-find \
      ca-certificates \
    && ln -s /usr/bin/fdfind /usr/local/bin/fd \
    && rm -rf /var/lib/apt/lists/*

# Python tooling: markitdown + websockify.
# websockify drives the noVNC viewer. The git-cloned websockify `run` script
# (below) is Python2-era and throws `SyntaxError: invalid syntax` under jammy's
# python3, which sent the novnc supervisor program into a FATAL restart loop.
# Install the maintained pip package instead and launch it as a module
# (`python -m websockify`) from supervisord.
# Future: when a `agent` Python in-sandbox SDK is published to
# Artifact Registry, pip-install it here. Until then, agent-authored Python
# scripts can call the sidecar's loopback /v1/mcp/dispatch directly via
# requests/httpx.
RUN python3 -m venv /opt/py-tools \
    && /opt/py-tools/bin/pip install --no-cache-dir 'markitdown==0.0.1a3' 'websockify==0.12.0' \
    && ln -s /opt/py-tools/bin/markitdown /usr/local/bin/markitdown

# In-sandbox Node SDK so agent-authored scripts can `require('@liftoffos/agent-sdk')`.
# Bundled from the build's prebuilt package (no registry pull). It has zero
# runtime deps (pure fetch to the loopback sidecar), so dist/index.js is fully
# self-contained.
#
# `npm link` alone is NOT enough: agent scripts execute from
# /tmp/.nodejs-sessions (the node REPL runner) or arbitrary cwds via bash, and
# Node's require() never searches the global link root from those locations
# (MODULE_NOT_FOUND). We therefore expose the package under a FIXED directory
# that the code runners put on NODE_PATH (see SAFE_BASE_ENV in
# nodejs/repl-session.ts and bash/session-manager.ts), so resolution is:
#   require('@liftoffos/agent-sdk') -> $NODE_PATH/@liftoffos/agent-sdk -> /opt/agent-sdk
COPY --from=pkgs-build /pkgs/agent-sdk /opt/agent-sdk
RUN cd /opt/agent-sdk && npm install --omit=dev --no-audit --no-fund && npm link \
 && mkdir -p /opt/sandbox-node-path/@liftoffos \
 && ln -s /opt/agent-sdk /opt/sandbox-node-path/@liftoffos/agent-sdk

# noVNC web assets for browser observation in a normal browser tab. websockify
# itself comes from pip (above) and is launched as a module by supervisord —
# NOT the bundled `utils/websockify/run` script, which is Python2-era.
RUN git clone --depth 1 https://github.com/novnc/noVNC.git /opt/novnc \
    && ln -s /opt/novnc/vnc.html /opt/novnc/index.html

# Non-root user (UID 1001)
RUN useradd -m -u 1001 -s /bin/bash sandbox \
    && mkdir -p /workspace && chown sandbox:sandbox /workspace \
    && mkdir -p /var/log/supervisor && chown sandbox:sandbox /var/log/supervisor

# openvscode-server
COPY --from=vscode-fetch /opt/openvscode-server /opt/openvscode-server
RUN chown -R sandbox:sandbox /opt/openvscode-server

# openvscode-server settings (telemetry off, autoSave on)
RUN mkdir -p /opt/openvscode-server/data/Machine \
    && echo '{"telemetry.telemetryLevel":"off","telemetry.enableTelemetry":false,"update.mode":"none","extensions.autoUpdate":false,"files.autoSave":"afterDelay","files.autoSaveDelay":1000,"terminal.integrated.cwd":"/workspace","workbench.startupEditor":"none"}' > /opt/openvscode-server/data/Machine/settings.json \
    && chown -R sandbox:sandbox /opt/openvscode-server/data

# Sidecar app + its built node_modules.
WORKDIR /sidecar
COPY --from=sidecar-build /build/sandbox-sidecar/dist/ ./dist/
COPY --from=sidecar-build /build/sandbox-sidecar/node_modules/ ./node_modules/
COPY --from=sidecar-build /build/sandbox-sidecar/package.json ./
RUN chown -R sandbox:sandbox /sidecar

# Process orchestration
COPY sandbox-sidecar/docker/supervisord.conf /etc/supervisor/supervisord.conf
COPY sandbox-sidecar/docker/nginx.conf /etc/nginx/nginx.conf
COPY sandbox-sidecar/docker/entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

# Git defaults
RUN git config --system init.defaultBranch main \
    && git config --system safe.directory '*'

# Internal-only ports (NOT exposed) — Cloud Run only sees PORT
# 8090 = sidecar TS server (main)
# 8081 = auth subrequest backend
# 8200 = openvscode-server
# 9222 = Chromium remote debugging (CDP)
# 5900 = x11vnc
# 6080 = websockify (noVNC)
# 8118 = forward proxy

ENV WORKSPACE_DIR=/workspace
ENV PORT=8080
ENV NODE_ENV=production
ENV DISPLAY=:99
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

EXPOSE 8080

USER sandbox
ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/entrypoint.sh"]
