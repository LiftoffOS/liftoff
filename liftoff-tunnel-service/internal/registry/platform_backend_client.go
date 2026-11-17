package registry

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"strings"
	"time"
)

type PlatformBackendClient struct {
	BaseURL          string
	ServiceToken     string
	TunnelBaseDomain string
	HTTPClient       *http.Client
}

func NewPlatformBackendClient(baseURL, serviceToken, tunnelBaseDomain string) *PlatformBackendClient {
	return &PlatformBackendClient{
		BaseURL:          baseURL,
		ServiceToken:     serviceToken,
		TunnelBaseDomain: tunnelBaseDomain,
		HTTPClient:       &http.Client{Timeout: 15 * time.Second},
	}
}

type platformRoutesResponse struct {
	Routes []struct {
		ID              string `json:"id"`
		DeploymentID    string `json:"deploymentId"`
		TenantID        string `json:"tenantId"`
		TenantPrefix    string `json:"tenantPrefix"`
		InnerTLSEnabled bool   `json:"innerTlsEnabled"`
		LoopbackPort    int    `json:"loopbackPort"`
		Subdomain       string `json:"subdomain"`
		UpstreamURL     string `json:"upstreamUrl"`
		PublicURL       string `json:"publicUrl"`
	} `json:"routes"`
}

type platformActiveTokensResponse struct {
	Tokens []struct {
		TenantPrefix string `json:"tenantPrefix"`
		Token        string `json:"token"`
	} `json:"tokens"`
}

// FetchAllRoutes hits a small internal endpoint that returns every route
// across all tenants. Endpoint definition lives in the platform-backend
// tunnels module and is service-token authenticated.
func (c *PlatformBackendClient) FetchAllRoutes(ctx context.Context) ([]Route, error) {
	if c.BaseURL == "" {
		return nil, fmt.Errorf("platform backend URL is not configured")
	}
	u, err := url.Parse(strings.TrimRight(c.BaseURL, "/") + "/api/internal/tunnel-routes/all")
	if err != nil {
		return nil, err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u.String(), nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("X-Service-Auth", c.ServiceToken)
	resp, err := c.HTTPClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("platform backend returned %d", resp.StatusCode)
	}
	var body platformRoutesResponse
	if err := json.NewDecoder(resp.Body).Decode(&body); err != nil {
		return nil, err
	}
	out := make([]Route, 0, len(body.Routes))
	for _, r := range body.Routes {
		publicHost := strings.TrimPrefix(strings.TrimPrefix(r.PublicURL, "https://"), "http://")
		// Strip any trailing path.
		if i := strings.IndexByte(publicHost, '/'); i >= 0 {
			publicHost = publicHost[:i]
		}
		out = append(out, Route{
			RouteID:         r.ID,
			DeploymentID:    r.DeploymentID,
			TenantID:        r.TenantID,
			TenantPrefix:    r.TenantPrefix,
			InnerTLSEnabled: r.InnerTLSEnabled,
			LoopbackPort:    r.LoopbackPort,
			Subdomain:       r.Subdomain,
			UpstreamURL:     r.UpstreamURL,
			PublicHost:      publicHost,
		})
	}
	return out, nil
}

// FetchActiveTokens returns the current tenantPrefix → token snapshot the
// chisel server uses to pre-populate its User table. Token validation on
// rotation grace-window edges is still done against Secret Manager directly
// (see internal/auth) — this endpoint just lets us avoid a Secret Manager
// round-trip per first-connect for warm tunnels.
func (c *PlatformBackendClient) FetchActiveTokens(ctx context.Context) (map[string]string, error) {
	if c.BaseURL == "" {
		return nil, fmt.Errorf("platform backend URL is not configured")
	}
	u, err := url.Parse(strings.TrimRight(c.BaseURL, "/") + "/api/internal/tunnel-deployments/active-tokens")
	if err != nil {
		return nil, err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u.String(), nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("X-Service-Auth", c.ServiceToken)
	resp, err := c.HTTPClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("platform backend returned %d", resp.StatusCode)
	}
	var body platformActiveTokensResponse
	if err := json.NewDecoder(resp.Body).Decode(&body); err != nil {
		return nil, err
	}
	out := make(map[string]string, len(body.Tokens))
	for _, t := range body.Tokens {
		if t.TenantPrefix == "" || t.Token == "" {
			continue
		}
		out[t.TenantPrefix] = t.Token
	}
	return out, nil
}
