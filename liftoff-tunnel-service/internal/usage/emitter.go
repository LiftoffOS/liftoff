// Package usage emits per-session and per-request usage events into the
// existing cost-attribution ingester. Events carry tenant_id, deployment_id,
// and (per-request) route_id so usage attributes to the right Operating
// Unit. The OU mapping follows the consumer (resolved from the route's
// bound consumer at log time by the existing ingester).
package usage

import (
	"bytes"
	"context"
	"encoding/json"
	"log"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/LiftoffOS/liftoff/liftoff-tunnel-service/internal/registry"
)

// Event matches the cost-attribution ingester's accepted envelope. The
// ingester reads tenant_id (and route_id for per-request rows) to attribute
// usage to the OU bound to that consumer.
type Event struct {
	Service      string            `json:"service"`
	EventType    string            `json:"eventType"`
	TenantID     string            `json:"tenantId"`
	DeploymentID string            `json:"deploymentId,omitempty"`
	RouteID      string            `json:"routeId,omitempty"`
	OccurredAt   string            `json:"occurredAt"`
	Quantity     float64           `json:"quantity"`
	Unit         string            `json:"unit"`
	Attributes   map[string]string `json:"attributes,omitempty"`
}

// RequestEvent is the per-forwarded-request signal published by the HTTP
// reverse proxy on response completion. Aggregated locally and flushed in
// the 60s tick alongside session instance-hours.
type RequestEvent struct {
	TenantID     string
	DeploymentID string
	RouteID      string
	Bytes        int64
}

type CostAttributionEmitter struct {
	Endpoint     string
	ServiceToken string
	HTTPClient   *http.Client

	mu       sync.Mutex
	pending  []RequestEvent
}

func NewCostAttributionEmitter(endpoint, serviceToken string) *CostAttributionEmitter {
	return &CostAttributionEmitter{
		Endpoint:     endpoint,
		ServiceToken: serviceToken,
		HTTPClient:   &http.Client{Timeout: 10 * time.Second},
	}
}

// RecordRequest is called from the data plane when a forwarded request
// completes. Thread-safe; bytes accumulate until the next flush tick. Signature
// matches the dataplane.UsageRecorder interface to keep the dependency narrow.
func (e *CostAttributionEmitter) RecordRequest(tenantID, deploymentID, routeID string, bytes int64) {
	if tenantID == "" {
		return
	}
	e.mu.Lock()
	e.pending = append(e.pending, RequestEvent{
		TenantID:     tenantID,
		DeploymentID: deploymentID,
		RouteID:      routeID,
		Bytes:        bytes,
	})
	e.mu.Unlock()
}

func (e *CostAttributionEmitter) Start(ctx context.Context, reg *registry.Registry) {
	if e.Endpoint == "" {
		// Ingester not configured — discard silently. Cost attribution will
		// be backfilled from log-based metrics in this case.
		return
	}
	go func() {
		t := time.NewTicker(60 * time.Second)
		defer t.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-t.C:
				e.flushOnce(ctx, reg)
			}
		}
	}()
}

func (e *CostAttributionEmitter) flushOnce(ctx context.Context, reg *registry.Registry) {
	now := time.Now().UTC().Format(time.RFC3339)
	events := make([]Event, 0, 32)

	// Per-session instance-hours (1 unit = 1 minute, emitted each 60s tick).
	for _, s := range reg.ListSessions() {
		if s == nil || s.TenantID == "" {
			continue
		}
		events = append(events, Event{
			Service:      "tunnel-service",
			EventType:    "tunnel.session.minute",
			TenantID:     s.TenantID,
			DeploymentID: s.DeploymentID,
			OccurredAt:   now,
			Quantity:     1,
			Unit:         "minute",
			Attributes:   map[string]string{"tenantPrefix": s.TenantPrefix},
		})
	}

	// Drain per-request bytes accumulated since last flush.
	e.mu.Lock()
	drained := e.pending
	e.pending = nil
	e.mu.Unlock()
	for _, r := range drained {
		events = append(events, Event{
			Service:      "tunnel-service",
			EventType:    "tunnel.request.bytes",
			TenantID:     r.TenantID,
			DeploymentID: r.DeploymentID,
			RouteID:      r.RouteID,
			OccurredAt:   now,
			Quantity:     float64(r.Bytes),
			Unit:         "byte",
		})
	}

	if len(events) == 0 {
		return
	}
	if err := e.postBatch(ctx, events); err != nil {
		// Re-queue the request events so the next tick retries. Session
		// events are tick-derived so we just lose the missed minute.
		e.mu.Lock()
		e.pending = append(drained, e.pending...)
		e.mu.Unlock()
		log.Printf("warn: usage emitter flush failed: %v", err)
	}
}

func (e *CostAttributionEmitter) postBatch(ctx context.Context, events []Event) error {
	body, err := json.Marshal(map[string]any{"events": events})
	if err != nil {
		return err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost,
		strings.TrimRight(e.Endpoint, "/")+"/api/internal/cost-attribution/events",
		bytes.NewReader(body),
	)
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	if e.ServiceToken != "" {
		req.Header.Set("X-Service-Auth", e.ServiceToken)
	}
	resp, err := e.HTTPClient.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 300 {
		return errStatus(resp.StatusCode)
	}
	return nil
}

type errStatusCode int

func (e errStatusCode) Error() string {
	return "non-2xx status from cost-attribution ingester"
}

func errStatus(code int) error { return errStatusCode(code) }
