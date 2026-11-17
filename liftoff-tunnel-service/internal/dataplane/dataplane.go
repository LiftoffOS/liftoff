// Package dataplane defines the abstraction the terminator dispatches
// requests through. Two implementations:
//
//   HTTPReverseProxy   — active in MVP; terminates TLS at GCLB, reads Host,
//                        forwards over the chisel session to the upstream URL.
//   SNIPassthroughStub — placeholder for the future inner-mTLS mode that lets
//                        the customer keep their own CA. Returns
//                        NotImplementedError if invoked; the dispatcher selects
//                        it via the mcp_tunnel_deployments.inner_tls_enabled
//                        flag (always false in MVP).
package dataplane

import (
	"errors"
	"net/http"

	"github.com/LiftoffOS/liftoff/liftoff-tunnel-service/internal/registry"
)

// ErrNotImplemented is returned by stubbed data planes (only SNI passthrough
// today). The dispatcher selects between planes based on the deployment's
// inner_tls_enabled flag.
var ErrNotImplemented = errors.New("data plane mode not implemented")

type DataPlane interface {
	HandleHTTP(w http.ResponseWriter, r *http.Request)
}

// Dispatcher routes incoming requests to the right data plane based on the
// deployment's inner_tls_enabled flag.
type Dispatcher struct {
	Registry *registry.Registry
	HTTP     DataPlane
	SNI      DataPlane
}

func NewDispatcher(reg *registry.Registry, httpPlane, sniPlane DataPlane) *Dispatcher {
	return &Dispatcher{Registry: reg, HTTP: httpPlane, SNI: sniPlane}
}

func (d *Dispatcher) HandleHTTP(w http.ResponseWriter, r *http.Request) {
	host := r.Host
	route := d.Registry.LookupRoute(host)
	if route == nil {
		http.Error(w, "tunnel route not found", http.StatusNotFound)
		return
	}
	session := d.Registry.LookupSession(route.TenantPrefix)
	if session == nil {
		http.Error(w, "tunnel client not connected", http.StatusBadGateway)
		return
	}
	// Per-deployment data-plane selection. In MVP every route has
	// InnerTLSEnabled=false → HTTPReverseProxy. The SNI plane is wired (and
	// returns 501) so the dispatch path itself is the same the day a
	// customer opts into customer-CA inner TLS.
	if route.InnerTLSEnabled {
		d.SNI.HandleHTTP(w, r)
		return
	}
	d.HTTP.HandleHTTP(w, r)
}
