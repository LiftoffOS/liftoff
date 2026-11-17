// OAuth discovery metadata (plan v6.1 Phase 2)
//
// RFC 9728 protected-resource metadata (served at both the bare path and the
// /mcp path-inserted variant — clients differ) and RFC 8414 authorization-
// server metadata. Mounted in index.ts BEFORE CORS and BEFORE authMiddleware;
// these are public, unauthenticated GETs with permissive CORS (public
// metadata only — token/register deliberately have NO CORS, see Phase 3).
//
// Everything is gated by MCP_OAUTH_ENABLED (the Phase 6 release flag): when
// the flag is off the endpoints 404 and the /mcp challenge header is omitted,
// which is exactly the legacy behavior.

import { Router, Request, Response } from 'express';
import { getBackendUrl } from '../infrastructure/control-plane-url';
import { enforceCanonicalPublicHost } from './canonical-host';
import { liftoffSkill } from './skill-document';

export const oauthMetadataRouter = Router();
// This router is mounted at the app root (index.ts) so it can serve
// /.well-known/*, /SKILL.md and /agent-setup.md. The canonical-host guard must be
// scoped to the paths this router owns: an unscoped router.use() on a
// root-mounted router runs for every request in the app, which rejected
// internal service-to-service POSTs on the raw *.run.app host — the host
// those callers pin as their OIDC audience (see canonical-host.ts).
oauthMetadataRouter.use(['/.well-known', '/SKILL.md', '/agent-setup.md'], enforceCanonicalPublicHost);

export function isMcpOauthEnabled(): boolean {
  return process.env.MCP_OAUTH_ENABLED === 'true';
}

/** Canonical RFC 8707 resource identifier set for this deployment. Single
 *  entry today; the deliberate extension point for deferred per-team or
 *  per-workspace resource URIs. */
export function isCanonicalMcpResource(resource: string): boolean {
  return resource === `${getBackendUrl()}/mcp`;
}

export function canonicalMcpResource(): string {
  return `${getBackendUrl()}/mcp`;
}

function metadataCors(res: Response): void {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'public, max-age=300');
}

function protectedResourceMetadata(_req: Request, res: Response): void {
  if (!isMcpOauthEnabled()) {
    res.status(404).json({ error: 'not_found' });
    return;
  }
  metadataCors(res);
  res.json({
    resource: canonicalMcpResource(),
    authorization_servers: [getBackendUrl()],
    scopes_supported: ['mcp'],
    bearer_methods_supported: ['header'],
  });
}

// Both spellings: bare and path-inserted (RFC 9728 path insertion).
oauthMetadataRouter.get('/.well-known/oauth-protected-resource', protectedResourceMetadata);
oauthMetadataRouter.get('/.well-known/oauth-protected-resource/mcp', protectedResourceMetadata);

// The Liftoff skill (skill-document.ts): the document a coding tool fetches
// to connect to a workspace over MCP and to install as a skill. The
// dashboard shows one copyable line ("Set up <site>/SKILL.md"); the tool
// fetches it and performs the setup itself, so per-tool instructions live
// there instead of in frontend copy. /agent-setup.md is the original address
// and serves the same document. Same release-flag gate as the discovery
// documents.
function serveSkill(_req: Request, res: Response): void {
  if (!isMcpOauthEnabled()) {
    res.status(404).json({ error: 'not_found' });
    return;
  }
  metadataCors(res);
  res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
  res.send(liftoffSkill());
}

oauthMetadataRouter.get('/SKILL.md', serveSkill);
oauthMetadataRouter.get('/agent-setup.md', serveSkill);

oauthMetadataRouter.get('/.well-known/oauth-authorization-server', (_req: Request, res: Response) => {
  if (!isMcpOauthEnabled()) {
    res.status(404).json({ error: 'not_found' });
    return;
  }
  const base = getBackendUrl();
  metadataCors(res);
  res.json({
    issuer: base,
    authorization_endpoint: `${base}/oauth/authorize`,
    token_endpoint: `${base}/oauth/token`,
    registration_endpoint: `${base}/oauth/register`,
    revocation_endpoint: `${base}/oauth/revoke`,
    // RFC 8628: the device flow, for a tool with no browser of its own.
    device_authorization_endpoint: `${base}/oauth/device_authorization`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token', 'urn:ietf:params:oauth:grant-type:device_code'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none'],
    scopes_supported: ['mcp'],
    // MCP 2026-07-28: we resolve URL-form client_ids via Client ID Metadata
    // Documents (CIMD is the primary path; DCR /oauth/register stays for
    // backward compat). RFC 9207 iss is returned on the authorization response.
    client_id_metadata_document_supported: true,
    authorization_response_iss_parameter_supported: true,
  });
});
