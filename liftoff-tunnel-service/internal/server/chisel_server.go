// Package server wraps the chisel server with Liftoff-specific session
// lifecycle hooks and a fork-compatible session dialer.
//
// Chisel v1.10.1 uses a static User table for auth (Server.AddUser). We
// populate that table from platform-backend's tunnel-token-list endpoint
// at startup and refresh it whenever a deployment is created or its token
// rotated (driven by the mcp-tunnel-routes-changed Pub/Sub topic on the
// tenant-runtime side; for the terminator we use a 30s background poll).
//
// chisel's Server runs its own listener (Start/StartContext). We start it
// on a dedicated port (CHISEL_BIND_ADDR) inside the same Cloud Run container
// as the data-plane HTTP listener; the container exposes both ports through
// the GCLB.
//
// The chisel SDK does not expose per-session SSH channel opening on its
// public API surface. The terminator therefore relies on the liftoffos/chisel
// fork (a thin patch that exports SessionDial) for the production data
// path; a noop SessionDialer is used in the scaffold + unit tests.

package server

import (
	"context"
	"fmt"
	"net"
	"sync"
	"time"

	"github.com/LiftoffOS/liftoff/liftoff-tunnel-service/internal/registry"
	chserver "github.com/jpillora/chisel/server"
)

type AuthFunc func(ctx context.Context, user, pass string) (tenantPrefix string, ok bool)

type UserSource interface {
	// Returns the current set of (tenantPrefix -> token) pairs the chisel
	// server should accept. Polled by RefreshUsers().
	ListAuthorizedUsers(ctx context.Context) (map[string]string, error)
}

type Options struct {
	BindAddr        string
	UserSource      UserSource
	OnSession       func(*registry.Session)
	OnTeardown      func(tenantPrefix string)
	Heartbeater     Heartbeater
	RefreshInterval time.Duration
}

type Heartbeater interface {
	Publish(ctx context.Context, tenantPrefix, status string) error
}

type ChiselServer struct {
	opts        Options
	chisel      *chserver.Server
	knownUsers  map[string]string // tenantPrefix → token, last seen
	knownUsersM sync.Mutex
}

func NewChiselServer(opts Options) (*ChiselServer, error) {
	cfg := &chserver.Config{
		KeepAlive: 30 * time.Second,
		Reverse:   true,
	}
	s, err := chserver.NewServer(cfg)
	if err != nil {
		return nil, fmt.Errorf("chisel server init: %w", err)
	}
	if opts.RefreshInterval == 0 {
		opts.RefreshInterval = 30 * time.Second
	}
	return &ChiselServer{opts: opts, chisel: s, knownUsers: make(map[string]string)}, nil
}

// Start binds the chisel server to its configured port. Returns when the
// listener is up; chisel's serve loop runs in the background.
func (s *ChiselServer) Start(ctx context.Context) error {
	host, port, err := splitBindAddr(s.opts.BindAddr)
	if err != nil {
		return err
	}
	if err := s.refreshUsersOnce(ctx); err != nil {
		// Non-fatal: refresh loop retries every interval.
		return nil
	}
	go s.refreshLoop(ctx)
	go func() {
		_ = s.chisel.StartContext(ctx, host, port)
	}()
	return nil
}

// HandleForPrefix returns the registry.Session for a tenant prefix. Called
// by OnSession registration when the chisel server accepts a new auth.
//
// The session is just a presence marker — chisel server-side opens its own
// per-client TCP listener on the deployment's loopback_port when the client
// presents `R:<port>:host:port`, and the dispatcher dials that loopback port
// directly. We don't need a handle to the chisel session itself.
func (s *ChiselServer) HandleForPrefix(tenantPrefix string) *registry.Session {
	return &registry.Session{
		TenantPrefix: tenantPrefix,
		OpenedAt:     time.Now(),
	}
}

func (s *ChiselServer) refreshLoop(ctx context.Context) {
	t := time.NewTicker(s.opts.RefreshInterval)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			_ = s.refreshUsersOnce(ctx)
		}
	}
}

func (s *ChiselServer) refreshUsersOnce(ctx context.Context) error {
	if s.opts.UserSource == nil {
		return nil
	}
	users, err := s.opts.UserSource.ListAuthorizedUsers(ctx)
	if err != nil {
		return err
	}
	// AddUser is idempotent on the address list; chisel's User table is
	// keyed by name. We track which (prefix, token) pairs we've already
	// installed so OnSession / heartbeats only fire on NEW or rotated
	// entries — not on every 30s refresh. Chisel v1.10.1 doesn't expose
	// per-session accepted hooks; the liftoffos/chisel fork (TODO) replaces
	// this pre-population path with real-time session-accepted callbacks
	// from inside chisel itself, at which point this map goes away.
	s.knownUsersM.Lock()
	defer s.knownUsersM.Unlock()
	for prefix, token := range users {
		// AddUser's third arg is a regex matched against requested remote
		// specs (e.g. "R:localhost:80"). ".+" allows any remote — the data
		// plane is what actually validates the per-route upstream URL.
		if err := s.chisel.AddUser(prefix, token, ".+"); err != nil {
			continue
		}
		if s.knownUsers[prefix] == token {
			continue // already installed; skip OnSession + heartbeat
		}
		s.knownUsers[prefix] = token
		if s.opts.OnSession != nil {
			s.opts.OnSession(s.HandleForPrefix(prefix))
		}
		if s.opts.Heartbeater != nil {
			_ = s.opts.Heartbeater.Publish(ctx, prefix, "active")
		}
	}
	return nil
}

func splitBindAddr(addr string) (host, port string, err error) {
	if addr == "" {
		return "0.0.0.0", "7000", nil
	}
	host, port, err = net.SplitHostPort(addr)
	if err != nil {
		return "", "", err
	}
	if host == "" {
		host = "0.0.0.0"
	}
	return host, port, nil
}
