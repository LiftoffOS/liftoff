package dataplane

import (
	"context"
	"fmt"
	"net"
	"net/http"
	"net/http/httputil"
	"net/url"
	"time"

	"github.com/LiftoffOS/liftoff/liftoff-tunnel-service/internal/registry"
)

// UsageRecorder is the narrow surface the data plane needs to emit per-request
// bytes — kept minimal so dataplane doesn't pull in the usage package directly.
type UsageRecorder interface {
	RecordRequest(tenantID, deploymentID, routeID string, bytes int64)
}

type noopUsageRecorder struct{}

func (noopUsageRecorder) RecordRequest(string, string, string, int64) {}

type HTTPReverseProxy struct {
	Registry *registry.Registry
	Usage    UsageRecorder
}

func NewHTTPReverseProxy(reg *registry.Registry) *HTTPReverseProxy {
	return &HTTPReverseProxy{Registry: reg, Usage: noopUsageRecorder{}}
}

// WithUsage wires a usage recorder. Called from main.go after the cost
// attribution emitter is constructed.
func (p *HTTPReverseProxy) WithUsage(u UsageRecorder) *HTTPReverseProxy {
	if u != nil {
		p.Usage = u
	}
	return p
}

func (p *HTTPReverseProxy) HandleHTTP(w http.ResponseWriter, r *http.Request) {
	host := r.Host
	route := p.Registry.LookupRoute(host)
	if route == nil {
		http.Error(w, "tunnel route not found", http.StatusNotFound)
		return
	}
	if route.LoopbackPort == 0 {
		// Should be unreachable: PB allocates loopback_port on every deployment
		// create (migration 229). Belt-and-braces guard so a stale route in the
		// registry can't crash the proxy with a localhost:0 dial.
		http.Error(w, "tunnel route has no loopback port assigned", http.StatusBadGateway)
		return
	}
	upstream, err := url.Parse(route.UpstreamURL)
	if err != nil {
		http.Error(w, "invalid upstream URL", http.StatusInternalServerError)
		return
	}

	// Wrap the response writer to count bytes flushed downstream. Recorded
	// in the per-tick cost-attribution batch.
	counting := &byteCountingResponseWriter{ResponseWriter: w}

	proxy := &httputil.ReverseProxy{
		Director: func(req *http.Request) {
			req.URL.Scheme = upstream.Scheme
			req.URL.Host = upstream.Host
			req.URL.Path = singleJoiningSlash(upstream.Path, req.URL.Path)
			req.Host = upstream.Host
		},
		Transport:    loopbackTransport{LoopbackPort: route.LoopbackPort},
		ErrorHandler: func(w http.ResponseWriter, _ *http.Request, err error) {
			http.Error(w, "tunnel upstream error: "+err.Error(), http.StatusBadGateway)
		},
	}
	proxy.ServeHTTP(counting, r)

	p.Usage.RecordRequest(route.TenantID, route.DeploymentID, route.RouteID, counting.bytes)
}

type byteCountingResponseWriter struct {
	http.ResponseWriter
	bytes int64
}

func (w *byteCountingResponseWriter) Write(b []byte) (int, error) {
	n, err := w.ResponseWriter.Write(b)
	w.bytes += int64(n)
	return n, err
}

// loopbackTransport implements http.RoundTripper by dialing localhost:<port>
// inside this Cloud Run container. That port is bound by the in-process chisel
// server when the customer's chisel client connects with
// `R:<port>:upstream-host:upstream-port`, so bytes flowing through it traverse
// the customer's tunnel back into their network — without us ever needing
// programmatic access to chisel's internal SSH sessions.
type loopbackTransport struct {
	LoopbackPort int
}

func (t loopbackTransport) RoundTrip(req *http.Request) (*http.Response, error) {
	target := fmt.Sprintf("127.0.0.1:%d", t.LoopbackPort)
	transport := &http.Transport{
		DialContext: func(ctx context.Context, _ string, _ string) (net.Conn, error) {
			d := net.Dialer{Timeout: 10 * time.Second}
			return d.DialContext(ctx, "tcp", target)
		},
		// Disable connection reuse — chisel binds a fresh per-request tunnel
		// stream; reusing a TCP connection across requests can cross-talk
		// streams in subtle ways.
		DisableKeepAlives: true,
		// 24h cap mirrors GCLB backend timeoutSec for long-running tool calls.
		ResponseHeaderTimeout: 24 * time.Hour,
	}
	return transport.RoundTrip(req)
}

func singleJoiningSlash(a, b string) string {
	switch {
	case len(a) == 0:
		return b
	case len(b) == 0:
		return a
	case a[len(a)-1] == '/' && b[0] == '/':
		return a + b[1:]
	case a[len(a)-1] != '/' && b[0] != '/':
		return a + "/" + b
	}
	return a + b
}
