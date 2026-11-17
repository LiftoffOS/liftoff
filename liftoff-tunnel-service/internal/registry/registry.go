// Package registry holds the in-memory route table for the tunnel terminator.
//
// Two indexes:
//   - by tenant_prefix      → the live chisel.Session for that customer
//   - by public hostname    → (tenant_prefix, upstream_url, route_id, deployment_id)
//
// Refreshed every 30s from platform-backend's tunnel-routes endpoint and
// invalidated on Pub/Sub events when a route changes.
package registry

import (
	"context"
	"sync"
	"time"
)

type Route struct {
	RouteID         string
	DeploymentID    string
	TenantID        string
	TenantPrefix    string
	Subdomain       string
	UpstreamURL     string
	PublicHost      string
	InnerTLSEnabled bool
	// LoopbackPort is the in-container chisel-bound TCP port for this
	// deployment. The dispatcher dials localhost:LoopbackPort to forward
	// HTTP traffic; chisel server-side bound it when the customer's chisel
	// client opened `R:<LoopbackPort>:upstreamHost:upstreamPort` at connect.
	// See PB migration 229.
	LoopbackPort int
}

type Session struct {
	TenantPrefix string
	DeploymentID string
	TenantID     string
	OpenedAt     time.Time
}

type Registry struct {
	mu             sync.RWMutex
	sessionsByPrefix map[string]*Session
	routesByHost     map[string]*Route
}

func New() *Registry {
	return &Registry{
		sessionsByPrefix: make(map[string]*Session),
		routesByHost:     make(map[string]*Route),
	}
}

func (r *Registry) RegisterSession(s *Session) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.sessionsByPrefix[s.TenantPrefix] = s
}

func (r *Registry) DropSession(tenantPrefix string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	delete(r.sessionsByPrefix, tenantPrefix)
}

func (r *Registry) ReplaceRoutes(routes []Route) {
	r.mu.Lock()
	defer r.mu.Unlock()
	next := make(map[string]*Route, len(routes))
	for i := range routes {
		route := routes[i]
		next[route.PublicHost] = &route
	}
	r.routesByHost = next
}

func (r *Registry) LookupRoute(publicHost string) *Route {
	r.mu.RLock()
	defer r.mu.RUnlock()
	return r.routesByHost[publicHost]
}

func (r *Registry) LookupSession(tenantPrefix string) *Session {
	r.mu.RLock()
	defer r.mu.RUnlock()
	return r.sessionsByPrefix[tenantPrefix]
}

// ResolvePrefix returns the tenantId + deploymentId associated with the given
// tenantPrefix by inspecting any route owned by that prefix. Returns ok=false
// if no route is currently registered for the prefix (which is normal during
// a brief startup window before the first route fetch lands).
func (r *Registry) ResolvePrefix(tenantPrefix string) (tenantID, deploymentID string, ok bool) {
	r.mu.RLock()
	defer r.mu.RUnlock()
	for _, route := range r.routesByHost {
		if route.TenantPrefix == tenantPrefix {
			return route.TenantID, route.DeploymentID, true
		}
	}
	return "", "", false
}

func (r *Registry) ListSessions() []*Session {
	r.mu.RLock()
	defer r.mu.RUnlock()
	out := make([]*Session, 0, len(r.sessionsByPrefix))
	for _, s := range r.sessionsByPrefix {
		out = append(out, s)
	}
	return out
}

// Bootstrap loads routes from platform-backend at start-up.
func (r *Registry) Bootstrap(ctx context.Context, client RouteSource) error {
	return r.Refresh(ctx, client)
}

// Refresh performs a single fetch-and-replace cycle. Called by Bootstrap, the
// 30s background poller (durability fallback), AND the Pub/Sub push receiver
// for the mcp-tunnel-routes-changed topic (sub-second invalidation on every
// platform-backend route CRUD).
func (r *Registry) Refresh(ctx context.Context, client RouteSource) error {
	routes, err := client.FetchAllRoutes(ctx)
	if err != nil {
		return err
	}
	r.ReplaceRoutes(routes)
	return nil
}

// StartBackgroundRefresh polls every interval as the durability fallback for
// the Pub/Sub push subscriber (which runs in main.go). If Pub/Sub delivery is
// briefly disrupted, the 30s poll keeps the route table eventually consistent.
func (r *Registry) StartBackgroundRefresh(ctx context.Context, client RouteSource, interval time.Duration) {
	go func() {
		t := time.NewTicker(interval)
		defer t.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-t.C:
				_ = r.Refresh(ctx, client)
			}
		}
	}()
}

type RouteSource interface {
	FetchAllRoutes(ctx context.Context) ([]Route, error)
}
