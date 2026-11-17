package registry

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"strings"
	"time"
)

// HeartbeatPublisher notifies platform-backend when a tunnel session goes
// active or drops. Platform-backend's stale-tunnel sweep flips deployments
// to 'disconnected' if heartbeats stop arriving for >90s.
type HeartbeatPublisher struct {
	BaseURL      string
	ServiceToken string
	HTTPClient   *http.Client
}

func NewHeartbeatPublisher(baseURL, serviceToken string) *HeartbeatPublisher {
	return &HeartbeatPublisher{
		BaseURL:      baseURL,
		ServiceToken: serviceToken,
		HTTPClient:   &http.Client{Timeout: 10 * time.Second},
	}
}

type heartbeatPayload struct {
	TenantPrefix string `json:"tenantPrefix"`
	Status       string `json:"status"`
	ObservedAt   string `json:"observedAt"`
}

func (h *HeartbeatPublisher) Publish(ctx context.Context, tenantPrefix, status string) error {
	if h.BaseURL == "" {
		return nil
	}
	body, _ := json.Marshal(heartbeatPayload{
		TenantPrefix: tenantPrefix,
		Status:       status,
		ObservedAt:   time.Now().UTC().Format(time.RFC3339),
	})
	req, err := http.NewRequestWithContext(ctx, http.MethodPost,
		strings.TrimRight(h.BaseURL, "/")+"/api/internal/tunnel-deployments/heartbeat",
		bytes.NewReader(body),
	)
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Service-Auth", h.ServiceToken)
	resp, err := h.HTTPClient.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	return nil
}
