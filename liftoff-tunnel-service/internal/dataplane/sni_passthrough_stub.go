package dataplane

import "net/http"

// SNIPassthroughStub is the placeholder for the future inner-mTLS data plane.
// In MVP every mcp_tunnel_deployments row has inner_tls_enabled=false, so
// the dispatcher never selects this plane. When a customer eventually
// requests customer-CA-presented inner TLS, this stub is replaced with a
// real SNI router that reads the TLS ClientHello, looks up the route by
// hostname, and forwards the raw TCP stream through the chisel session
// without decryption.
type SNIPassthroughStub struct{}

func NewSNIPassthroughStub() *SNIPassthroughStub { return &SNIPassthroughStub{} }

func (s *SNIPassthroughStub) HandleHTTP(w http.ResponseWriter, _ *http.Request) {
	http.Error(w, "SNI passthrough data plane not implemented", http.StatusNotImplemented)
}
