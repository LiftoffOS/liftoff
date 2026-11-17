// Management Router Tests
// Tests CRUD endpoints, tenant membership enforcement, revocation permissions

import fs from 'fs';
import path from 'path';

const routerSource = fs.readFileSync(
  path.join(__dirname, '..', 'router.ts'),
  'utf-8',
);

describe('management router structural checks', () => {
  describe('endpoints', () => {
    it('has POST /keys for key creation', () => {
      expect(routerSource).toContain("'/keys',");
      expect(routerSource).toMatch(/claudeCodeProxyRouter\.post\(\s*'\/keys'/);
    });

    it('has GET /keys for listing', () => {
      expect(routerSource).toMatch(/claudeCodeProxyRouter\.get\(\s*'\/keys'/);
    });

    it('has DELETE /keys/:keyId for revocation', () => {
      expect(routerSource).toMatch(/claudeCodeProxyRouter\.delete\(\s*'\/keys\/:keyId'/);
    });

    it('has POST /keys/:keyId/refresh for cache busting', () => {
      expect(routerSource).toMatch(/claudeCodeProxyRouter\.post\(\s*'\/keys\/:keyId\/refresh'/);
    });
  });

  describe('authentication via tenantAuthMiddleware', () => {
    it('uses tenantAuthMiddleware on all endpoints', () => {
      const matches = routerSource.match(/tenantAuthMiddleware\(/g);
      // Should appear on: POST /keys, GET /keys, GET /keys/:keyId,
      // PUT /keys/:keyId, DELETE /keys/:keyId, POST /keys/:keyId/refresh
      expect(matches!.length).toBeGreaterThanOrEqual(6);
    });

    it('uses viewDashboard for basic member access', () => {
      expect(routerSource).toContain("tenantAuthMiddleware('viewDashboard')");
    });
  });

  describe('authorization (BE-015)', () => {
    it('checks manageClaudeCodeProxy permission for admin visibility', () => {
      expect(routerSource).toContain("hasPermission(auth.role, 'manageClaudeCodeProxy')");
    });
  });

  // Revocation-permission tests removed: ownership enforcement now lives in
  // liftoff-developer-proxy. Local router only checks devProxyClient is
  // enabled and 503s otherwise.

  describe('audit logging (SE-012)', () => {
    it('logs key creation', () => {
      expect(routerSource).toContain('claude_code_proxy.key_created');
    });

    it('logs key revocation', () => {
      expect(routerSource).toContain('claude_code_proxy.key_revoked');
    });

    it('logs key cache refresh', () => {
      expect(routerSource).toContain('claude_code_proxy.key_refreshed');
    });
  });

  describe('Zod validation', () => {
    it('validates create request body', () => {
      expect(routerSource).toContain('createProxyKeySchema.safeParse(req.body)');
    });

    it('validates list query params', () => {
      expect(routerSource).toContain('listProxyKeysSchema.safeParse(req.query)');
    });
  });

  describe('developer-proxy delegation (post-migration-132)', () => {
    it('short-circuits with 503 when developer-proxy is not configured', () => {
      expect(routerSource).toContain("developer_proxy_not_configured");
    });

    it('every proxy-key handler routes through devProxyClient', () => {
      expect(routerSource).toContain('devProxyClient.createCredential');
      expect(routerSource).toContain('devProxyClient.listCredentials');
      expect(routerSource).toContain('devProxyClient.getCredential');
      expect(routerSource).toContain('devProxyClient.revokeCredential');
    });

    it('does not import the dropped repository module', () => {
      expect(routerSource).not.toContain("from './repository'");
    });

    it('does not import the dropped proxy-router module', () => {
      expect(routerSource).not.toContain("from './proxy-router'");
    });
  });
});
