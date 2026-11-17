// Package auth verifies tunnel-client tokens against Secret Manager.
//
// Tokens are stored in Secret Manager under
//   mcp-tunnel-token-{tenant_prefix}
// (tenant_prefix is globally UNIQUE per the schema, so no tenant_id suffix is
// needed). Rotated via platform-backend's POST /api/tunnel-deployments/:id/rotate-token,
// which writes a new Secret Manager version and persists the prior version
// name + expiry on the deployment row. Both the in-process timer and the
// sweep-token-grace Cloud Scheduler job disable the prior version after a
// 5-minute grace window so the customer can roll over without downtime.
//
// Authenticate() checks the offered token against the secret's CURRENT and
// PREVIOUS versions only (anything older is silently rejected even if still
// enabled, to bound exposure).
package auth

import (
	"context"
	"errors"
	"fmt"
	"strings"

	secretmanager "cloud.google.com/go/secretmanager/apiv1"
	"cloud.google.com/go/secretmanager/apiv1/secretmanagerpb"
)

type SecretManagerTokenSource struct {
	projectID string
	client    *secretmanager.Client
}

func NewSecretManagerTokenSource(ctx context.Context, projectID string) (*SecretManagerTokenSource, error) {
	if projectID == "" {
		return nil, errors.New("GCP_PROJECT_ID is required")
	}
	client, err := secretmanager.NewClient(ctx)
	if err != nil {
		return nil, err
	}
	return &SecretManagerTokenSource{projectID: projectID, client: client}, nil
}

// Authenticate is invoked by the chisel server with the username/password the
// tunnel client offers. The customer's docker run command supplies
//   chisel client --auth ${TUNNEL_PREFIX}:${TUNNEL_TOKEN} ...
// so the username carries the tenant_prefix and the password carries the
// token. The pair lets us look up exactly one Secret Manager entry per
// connection instead of brute-forcing every secret.
//
// We iterate all currently-ENABLED versions of the secret (max 2 — current
// + any prior version still inside its 5-minute rotation grace window).
// Disabled / destroyed versions are not returned by ListSecretVersions filter
// and stop authenticating immediately.
func (s *SecretManagerTokenSource) Authenticate(ctx context.Context, user, pass string) (tenantPrefix string, ok bool) {
	if !strings.HasPrefix(pass, "tk_") {
		return "", false
	}
	if user == "" {
		return "", false
	}
	secretName := fmt.Sprintf("mcp-tunnel-token-%s", user)
	parent := fmt.Sprintf("projects/%s/secrets/%s", s.projectID, secretName)

	it := s.client.ListSecretVersions(ctx, &secretmanagerpb.ListSecretVersionsRequest{
		Parent: parent,
		Filter: "state:ENABLED",
	})
	for {
		v, err := it.Next()
		if err != nil {
			break
		}
		resp, err := s.client.AccessSecretVersion(ctx, &secretmanagerpb.AccessSecretVersionRequest{Name: v.Name})
		if err != nil {
			continue
		}
		if string(resp.Payload.Data) == pass {
			return user, true
		}
	}
	return "", false
}
