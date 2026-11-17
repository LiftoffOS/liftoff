# liftoff-tunnel-service

Everything runs in your own cloud project, on your own credentials, and every
hostname is something you configure. The code throws rather than falling back
to a default, because a default here would point at infrastructure that is not
yours.

Licensed under [Apache-2.0](LICENSE). The licence grants no trademark rights:
the Liftoff name and logo are not licensed for use as the name of what you ship.

Multi-tenant terminator for the Liftoff MCP reverse-tunnel.

Customers run a single `docker run` of `liftoffos/tunnel-client` in their
network. It opens an outbound websocket-over-HTTPS to this service and keeps
it open. Incoming HTTPS requests at
`https://{tenant_prefix}-{subdomain}.tunnels.example.com` (prod) or
`https://{tenant_prefix}-{subdomain}.tunnels-dev.example.com` (dev) are
forwarded through the chisel-multiplexed session to the customer-defined
upstream URL (e.g. `http://jira.internal:8080`) that lives only inside the
customer's network. The subdomain is a server-generated opaque hex token;
clients never pick it.

The consumer flows always operate **1:1** — one tunnel = one customer Docker
container = one routed private service. If a customer has another private
service in another network, they run another `docker run` and that produces
another tunnel.

## How it works

### Stock chisel, no fork, per-tenant loopback ports

Cloud Run exposes exactly one external port. We can't bind a separate chisel
server port for each tenant on the public side. Instead:

1. **PB allocates a unique loopback port (20000–29999)** per
   `mcp_tunnel_deployments` row at create time (migration 229).
2. **The customer's tunnel-client image polls PB** at
   `GET /api/customer/tunnel-config` for `{loopbackPort, upstreamHost,
   upstreamPort}` and exec-s
   `chisel client … R:<loopbackPort>:<upstreamHost>:<upstreamPort>`.
3. **Inside this Cloud Run container** stock chisel server binds
   `127.0.0.1:7000` (loopback only — not externally exposed). When the
   customer's chisel client connects with that `R:` spec, chisel server-side
   binds `127.0.0.1:<loopbackPort>` and forwards bytes through the SSH session
   to the customer's `upstreamHost:upstreamPort`.
4. **The HTTP dispatcher on `:8080`** receives the incoming HTTPS request
   from GCLB, looks up the route by `Host` header, finds the
   `LoopbackPort`, and dials `127.0.0.1:<LoopbackPort>` —
   bytes flow through chisel into the customer's network.

The dispatcher reverse-proxies `/_tunnel/ws` to the loopback chisel server
(via Go's `httputil.ReverseProxy`, which handles WebSocket upgrades
natively since Go 1.20). All other paths route to the HTTP data plane.

## Layout

```
main.go                              # entry point; mounts dispatcher + chisel WS proxy
internal/auth/                       # Secret Manager tunnel-token verifier
internal/config/                     # env -> typed config (CHISEL_BIND_ADDR defaults to 127.0.0.1:7000)
internal/dataplane/
  dataplane.go                       # DataPlane interface + Dispatcher
  http_reverse_proxy.go              # active MVP plane (dials localhost:LoopbackPort)
  sni_passthrough_stub.go            # placeholder for inner-mTLS mode
internal/registry/
  registry.go                        # in-memory sessions + routes (Route carries LoopbackPort)
  platform_backend_client.go         # 30s background poll of routes
  heartbeat.go                       # status pushes to platform-backend
internal/router/                     # Cloud Run session affinity glue
internal/server/chisel_server.go     # stock chisel server (loopback) + User refresh from PB
internal/usage/emitter.go            # cost-attribution emitter
client/Dockerfile                    # customer-side image (alpine + jq + chisel binary)
client/entrypoint.sh                 # polling wrapper that exec-s chisel with the right R: spec
Dockerfile                           # terminator image (Cloud Run)
cloudbuild.yaml                      # CI: builds + deploys terminator (one image per env)
```

The customer-side image is published separately by
`.github/workflows/publish-tunnel-client.yml` to
`docker.io/liftoffos/tunnel-client` (anonymous-pullable, multi-arch). It uses
the `GITHUB_TOKEN` for GHCR-style auth swapped over to Docker Hub via the
`DOCKERHUB_USERNAME` / `DOCKERHUB_TOKEN` repo secrets.

## Cloud Run config

- `min-instances=1`, `max-instances=50` (gated by `tunnel_service_min_instances`
  in Terraform).
- Session affinity ON, keyed on the `Host` header so requests for a
  `tenant_prefix` consistently land on the instance holding that customer's
  chisel session.
- Backend service has the maximum Cloud Run request timeout (3600s gen2). The
  legacy `timeoutSec=86400` is not valid for serverless NEGs.
- Ingress: `INGRESS_TRAFFIC_INTERNAL_LOAD_BALANCER`. Only GCLB can reach
  the service; the `*.run.app` URL is closed.

## Route table refresh

Primary mechanism: Pub/Sub **push** subscription on `mcp-tunnel-routes-changed-{env}`
delivers to `POST /_tunnel/pubsub/routes-changed`; the handler triggers an
immediate `FetchAllRoutes` against platform-backend. Sub-second propagation
of every route CRUD operation. Always returns 2xx so failures don't pile up
in Pub/Sub redeliveries — the 30s background poll is the durability backstop.

The route fetch endpoint (`GET /api/internal/tunnel-routes/all`) includes
`loopbackPort` per route so the dispatcher knows which loopback to dial
when traffic arrives.

## Data-plane dispatch

The `Dispatcher` branches per-route on `route.InnerTLSEnabled`:
- `false` (MVP default) → `HTTPReverseProxy` reads `Host`, looks up the route,
  dials `localhost:<LoopbackPort>` (the in-container chisel-bound port for
  this tenant), forwards. `DisableKeepAlives: true` for request isolation;
  `ResponseHeaderTimeout: 24h` for long-running tool calls.
- `true` → `SNIPassthroughStub` returns 501 today; replaced when a customer
  opts into inner-mTLS with their own CA.

## Tunnel-client auth

The customer's image runs `chisel client --auth=${TUNNEL_PREFIX}:${TUNNEL_TOKEN} …`:

- Username slot carries the `tenant_prefix` so we look up exactly one
  Secret Manager entry per connection (no brute-force scan).
- Password is the `tk_…` token; verified against any ENABLED version of
  `mcp-tunnel-token-{tenant_prefix}` (so the 5-minute rotation grace window
  works automatically; prior versions are disabled by the platform-backend's
  `tunnel-sweep-token-grace` Cloud Scheduler job).

The chisel server's User table is pre-populated and refreshed every 30s from
`GET /api/internal/tunnel-deployments/active-tokens` on platform-backend. Only
**new** or **rotated** entries trigger `OnSession` + a heartbeat publish so we
don't spam PB with "active" status pings every refresh.

## Cost attribution

`internal/usage/emitter.go` batches per-session minutes + per-request bytes
and POSTs them to platform-backend's existing ingester
(`POST /api/internal/cost-attribution/events`) every 60s. Events carry
`tenantId` + `deploymentId` + (per-request) `routeId`; OU mapping follows
the consumer at log time.

## Logging

Every connection event and forwarded request includes `tenant_id`,
`deployment_id`, `route_id`, `session_id`. Suggested Cloud Logging filters
are documented in `docs/ops-filters.md`.

## Local development

A minimal mock platform-backend is sufficient to boot the terminator and
exercise the dispatcher / Pub/Sub / chisel-handshake paths end-to-end. See
`docs/ops-filters.md` for the matching log filters.

## End-to-end validation (dev)

To validate the full chain on a dev deployment: connect a customer chisel
client to `wss://tunnels-dev.example.com/_tunnel/ws` with prefix + token,
and check that the route table is fetched from PB, the dispatcher dials the
loopback port, and an HTTP request flows through the chisel session to a
local upstream HTTP server. Production uses the same architecture on
`tunnels.example.com`.

## Known limitations

- **Multi-instance routing**: Cloud Run autoscaling. Each replica has its own
  chisel server with its own loopback ports. A customer's chisel session
  lands on one replica; HTTP requests for that tenant's subdomain need to
  hit the same replica. Today's Host-keyed session affinity covers this but
  should be verified when scaling out beyond `min=max=1`.
