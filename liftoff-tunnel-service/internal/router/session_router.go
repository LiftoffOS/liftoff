// Package router wraps the registry with Cloud Run session-affinity helpers.
//
// Primary mechanism (per plan): Cloud Run session affinity keyed on a header
// derived from Host (the tenant_prefix). Tool-call requests for
//   acme-jira.tunnels.example.com
// then consistently land on the instance that holds the `acme` tunnel
// client's chisel session.
//
// Fallback mechanism (not built in MVP): a small Memorystore (Redis) instance
// holding tenant_prefix → instance_url so any instance can forward a
// misrouted request to the owning instance. The interface stub below
// reserves the slot so the Redis-backed lookup can be wired in later
// without rework.
package router

import "github.com/LiftoffOS/liftoff/liftoff-tunnel-service/internal/registry"

type SessionRouter struct {
	Registry *registry.Registry
	Lookup   InstanceLookup
}

type InstanceLookup interface {
	OwningInstance(tenantPrefix string) (string, bool)
}

// noopInstanceLookup always returns "not found" — sufficient as long as the
// GCLB session affinity keeps requests on the right instance.
type noopInstanceLookup struct{}

func (noopInstanceLookup) OwningInstance(string) (string, bool) { return "", false }

func NewSessionRouter(reg *registry.Registry) *SessionRouter {
	return &SessionRouter{Registry: reg, Lookup: noopInstanceLookup{}}
}
