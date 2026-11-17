// liftoff-tunnel-service — multi-tenant terminator for the Liftoff MCP
// reverse-tunnel.
//
// Customers run a single docker container in their network (chisel client).
// It opens an outbound websocket-over-HTTPS connection to this service and
// keeps it open. Each tunneled session is registered under a `tenant_prefix`.
// Incoming HTTPS requests at https://{tenant_prefix}-{subdomain}.tunnels.example.com
// are matched against the registered session and forwarded over the
// chisel-multiplexed channel to the upstream URL configured in the
// mcp_tunnel_routes row.
//
// Data plane has two modes — only HTTP reverse proxy is active in MVP; SNI
// passthrough is stubbed so the Anthropic-style customer-CA upgrade later
// is a mode flip + cert plumbing.

package main

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"io"
	"log"
	"net/http"
	"net/http/httputil"
	"net/url"
	"os"
	"time"

	"github.com/LiftoffOS/liftoff/liftoff-tunnel-service/internal/config"
	"github.com/LiftoffOS/liftoff/liftoff-tunnel-service/internal/dataplane"
	"github.com/LiftoffOS/liftoff/liftoff-tunnel-service/internal/registry"
	"github.com/LiftoffOS/liftoff/liftoff-tunnel-service/internal/router"
	"github.com/LiftoffOS/liftoff/liftoff-tunnel-service/internal/server"
	"github.com/LiftoffOS/liftoff/liftoff-tunnel-service/internal/usage"
)

func main() {
	ctx := context.Background()
	cfg := config.FromEnv()

	reg := registry.New()
	configClient := registry.NewPlatformBackendClient(cfg.PlatformBackendURL, cfg.PlatformBackendServiceToken, cfg.TunnelBaseDomain)
	if err := reg.Bootstrap(ctx, configClient); err != nil {
		log.Printf("warn: registry bootstrap failed (will retry via poller): %v", err)
	}
	// 30s polling is the durability fallback. The Pub/Sub push receiver below
	// is the primary mechanism for instant route invalidation.
	reg.StartBackgroundRefresh(ctx, configClient, 30*time.Second)

	heartbeatPub := registry.NewHeartbeatPublisher(cfg.PlatformBackendURL, cfg.PlatformBackendServiceToken)
	usageEmitter := usage.NewCostAttributionEmitter(cfg.UsageEndpoint, cfg.PlatformBackendServiceToken)

	httpPlane := dataplane.NewHTTPReverseProxy(reg).WithUsage(usageEmitter)
	sniPlane := dataplane.NewSNIPassthroughStub()
	dispatcher := dataplane.NewDispatcher(reg, httpPlane, sniPlane)

	router.NewSessionRouter(reg)

	// Chisel server runs on its own listener (CHISEL_BIND_ADDR). Cloud Run
	// containers expose both ports through the GCLB; client traffic for
	// `wss://tunnels.example.com/_tunnel/ws` is routed to the chisel port,
	// data-plane HTTPS hits the main port.
	chiselSrv, err := server.NewChiselServer(server.Options{
		BindAddr:    cfg.ChiselBindAddr,
		OnSession:   enrichAndRegister(reg),
		OnTeardown:  reg.DropSession,
		Heartbeater: heartbeatPub,
		UserSource:  &platformBackendUserSource{client: configClient},
	})
	if err != nil {
		log.Fatalf("chisel server init failed: %v", err)
	}
	if err := chiselSrv.Start(ctx); err != nil {
		log.Fatalf("chisel start: %v", err)
	}

	// HTTPS listener: dispatches tunneled HTTPS to the data plane. TLS is
	// terminated upstream at GCLB (wildcard cert via Google Certificate
	// Manager); this listener serves cleartext from the load balancer.
	mux := http.NewServeMux()
	mux.HandleFunc("/", dispatcher.HandleHTTP)
	mux.HandleFunc("/_tunnel/health", func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("ok"))
	})
	// Customer chisel WebSocket endpoint. Cloud Run exposes only one external
	// port (8080); chisel binds loopback-only on 7000 (see CHISEL_BIND_ADDR).
	// We reverse-proxy WS upgrades on /_tunnel/ws to the loopback chisel
	// server so customers connect via a single public hostname.
	mux.Handle("/_tunnel/ws", wsLoopbackProxy(cfg.ChiselBindAddr))
	// Pub/Sub push subscription endpoint. Platform-control creates a push
	// subscription on mcp-tunnel-routes-changed that POSTs envelopes here.
	// On every event we trigger an immediate route refresh — the 30s poll is
	// a fallback in case Pub/Sub delivery is delayed.
	mux.HandleFunc("/_tunnel/pubsub/routes-changed", pubsubRoutesChangedHandler(ctx, reg, configClient))

	usageEmitter.Start(ctx, reg)

	addr := os.Getenv("PORT")
	if addr == "" {
		addr = "8080"
	}
	log.Printf("liftoff-tunnel-service listening on :%s", addr)
	if err := http.ListenAndServe(":"+addr, mux); err != nil {
		log.Fatalf("http listen: %v", err)
	}
}

// enrichAndRegister populates a session's TenantID + DeploymentID from the
// route table before handing it to the registry. Required so the usage
// emitter's per-session instance-hour events carry the right tenant.
//
// If no route has been fetched yet for this prefix (rare; bootstrap or pre-
// route deployment), the session is still registered with the prefix only —
// the usage emitter skips empty-tenant sessions and the registry retries on
// the next route refresh.
func enrichAndRegister(reg *registry.Registry) func(*registry.Session) {
	return func(s *registry.Session) {
		if s.TenantID == "" || s.DeploymentID == "" {
			if tid, did, ok := reg.ResolvePrefix(s.TenantPrefix); ok {
				s.TenantID = tid
				s.DeploymentID = did
			}
		}
		reg.RegisterSession(s)
	}
}

// platformBackendUserSource adapts the platform-backend active-tokens endpoint
// into a chisel UserSource. The endpoint returns the current
// { tenantPrefix → token } snapshot; chisel's User table is keyed by
// tenantPrefix so AddUser keeps the new token authoritative.
type platformBackendUserSource struct {
	client *registry.PlatformBackendClient
}

func (p *platformBackendUserSource) ListAuthorizedUsers(ctx context.Context) (map[string]string, error) {
	return p.client.FetchActiveTokens(ctx)
}

// pubsubPushEnvelope is the structure GCP Pub/Sub delivers to push subscribers.
type pubsubPushEnvelope struct {
	Message struct {
		Data        string            `json:"data"`
		Attributes  map[string]string `json:"attributes"`
		MessageID   string            `json:"messageId"`
		PublishTime string            `json:"publishTime"`
	} `json:"message"`
	Subscription string `json:"subscription"`
}

// pubsubRoutesChangedHandler refreshes the registry on every push from the
// mcp-tunnel-routes-changed topic. Always returns 2xx so Pub/Sub doesn't
// redeliver — the 30s poll is the durability backstop.
func pubsubRoutesChangedHandler(parent context.Context, reg *registry.Registry, src registry.RouteSource) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, 1<<20))
		if err != nil {
			log.Printf("warn: pubsub envelope read: %v", err)
			w.WriteHeader(http.StatusNoContent)
			return
		}
		var env pubsubPushEnvelope
		if err := json.Unmarshal(body, &env); err == nil {
			// Decode payload for observability; we don't actually need the
			// content, since we always do a full refresh.
			if env.Message.Data != "" {
				_, _ = base64.StdEncoding.DecodeString(env.Message.Data)
			}
		}
		// 5s budget so a slow platform-backend can't pile up Pub/Sub workers.
		ctx, cancel := context.WithTimeout(parent, 5*time.Second)
		defer cancel()
		if err := reg.Refresh(ctx, src); err != nil {
			log.Printf("warn: pubsub-driven route refresh: %v", err)
		}
		w.WriteHeader(http.StatusNoContent)
	}
}

// wsLoopbackProxy reverse-proxies incoming WebSocket upgrade requests to the
// in-container chisel server's loopback listener. Chisel itself binds 127.0.0.1
// (CHISEL_BIND_ADDR) and never reaches the GCLB directly; this handler is what
// makes wss://tunnels.example.com/_tunnel/ws land on chisel.
//
// httputil.ReverseProxy natively handles WebSocket upgrades since Go 1.20: it
// sees Connection: Upgrade + Upgrade: websocket, performs the hijack, and
// shuttles bytes both ways. Avoids the subtle header-loss footguns of doing
// the upgrade dance manually (Request.Write strips Connection-class headers).
func wsLoopbackProxy(loopbackAddr string) http.Handler {
	target := &url.URL{Scheme: "http", Host: loopbackAddr}
	return &httputil.ReverseProxy{
		Rewrite: func(pr *httputil.ProxyRequest) {
			pr.SetURL(target)
			pr.Out.Host = pr.In.Host
		},
		ErrorHandler: func(w http.ResponseWriter, _ *http.Request, err error) {
			log.Printf("ws proxy: %v", err)
			http.Error(w, "tunnel upstream unavailable", http.StatusBadGateway)
		},
	}
}
