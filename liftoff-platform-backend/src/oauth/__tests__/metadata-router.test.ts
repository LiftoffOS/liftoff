// OAuth discovery metadata + the Liftoff skill document — unit tests.
// Covers the MCP_OAUTH_ENABLED gate and the hosted skill (env-aware MCP URL,
// site-origin publication, valid Agent Skill frontmatter, markdown content
// type, public caching, the /agent-setup.md alias).

import express from 'express';

jest.mock('../../infrastructure/control-plane-url', () => ({
  getBackendUrl: () => 'https://api-test.example.com',
}));

import { oauthMetadataRouter } from '../metadata-router';
import { liftoffSkill, SKILL_INSTALL_PATHS } from '../skill-document';

const MCP_URL = 'https://api-test.example.com/mcp';
const SITE = 'https://site-test.example.com';

function buildApp() {
  const app = express();
  app.use(oauthMetadataRouter);
  return app;
}

async function get(
  app: express.Express,
  path: string,
): Promise<{ status: number; text: string; headers: Headers }> {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, () => {
      const addr = server.address() as { port: number };
      fetch(`http://127.0.0.1:${addr.port}${path}`)
        .then(async (res) => {
          const text = await res.text();
          server.close();
          resolve({ status: res.status, text, headers: res.headers });
        })
        .catch((err) => {
          server.close();
          reject(err);
        });
    });
  });
}

describe('the Liftoff skill document', () => {
  beforeEach(() => {
    process.env.FRONTEND_URL = SITE;
  });
  afterEach(() => {
    delete process.env.MCP_OAUTH_ENABLED;
    delete process.env.FRONTEND_URL;
  });

  it('404s when the release flag is off', async () => {
    process.env.MCP_OAUTH_ENABLED = 'false';
    const res = await get(buildApp(), '/SKILL.md');
    expect(res.status).toBe(404);
  });

  it('serves markdown with the env-canonical MCP URL when the flag is on', async () => {
    process.env.MCP_OAUTH_ENABLED = 'true';
    const res = await get(buildApp(), '/SKILL.md');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/markdown');
    expect(res.headers.get('cache-control')).toBe('public, max-age=300');
    expect(res.text).toContain(`claude mcp add --transport http --scope user liftoff ${MCP_URL}`);
    expect(res.text).toContain(`codex mcp add liftoff --url ${MCP_URL}`);
    expect(res.text).toContain(`gemini mcp add --transport http --scope user liftoff ${MCP_URL}`);
    expect(res.text).toContain(`grok mcp add --transport http liftoff ${MCP_URL}`);
    expect(res.text).toContain(`"serverUrl": "${MCP_URL}"`);
    expect(res.text).toContain('liftoff_find_teammates');
    // The closing step relays the connection overview in the person's terms
    // and lists no capabilities; there are no fixed example lines to echo.
    expect(res.text).toContain('Relay that overview to the user in their own terms');
    expect(res.text).toContain('Do not list this server\'s tools');
  });

  it('serves the same document at the original /agent-setup.md address', async () => {
    process.env.MCP_OAUTH_ENABLED = 'true';
    const skill = await get(buildApp(), '/SKILL.md');
    const alias = await get(buildApp(), '/agent-setup.md');
    expect(alias.status).toBe(200);
    expect(alias.text).toBe(skill.text);
  });

  it('is a valid Agent Skill: frontmatter with name, description and a version, no angle brackets', () => {
    process.env.MCP_OAUTH_ENABLED = 'true';
    const md = liftoffSkill();
    expect(md.startsWith('---\n')).toBe(true);
    const close = md.indexOf('\n---\n', 4);
    expect(close).toBeGreaterThan(0);
    const frontmatter = md.slice(4, close);
    expect(frontmatter).toMatch(/^name: liftoff$/m);
    expect(frontmatter).not.toMatch(/[<>]/);
    // The description is the trigger every tool loads at startup; the spec
    // caps it at 1024 characters and it must say when to use the skill.
    const description = /^description: "(.*)"$/m.exec(frontmatter)![1];
    expect(description.length).toBeGreaterThan(50);
    expect(description.length).toBeLessThanOrEqual(1024);
    // It names the moments to check Liftoff before falling back, what the
    // user can get done, and the one exception: the user's own tool wins.
    expect(description).toContain('before writing a scraper');
    expect(description).toContain('whenever the user needs');
    expect(description).toContain('Exception:');
    expect(frontmatter).toMatch(/^ {2}version: "[0-9a-f]{12}"$/m);
    expect(frontmatter).toContain(`homepage: ${SITE}`);
    // Under the spec's guidance for the body a tool loads on activation.
    expect(md.split('\n').length).toBeLessThan(500);
  });

  it('tells the tool where to install itself and where to check for a newer version', () => {
    process.env.MCP_OAUTH_ENABLED = 'true';
    const md = liftoffSkill();
    for (const p of SKILL_INSTALL_PATHS) expect(md).toContain(p.path);
    expect(md).toContain('~/.agents/skills/liftoff/SKILL.md');
    expect(md).toContain('~/.claude/skills/liftoff/SKILL.md');
    expect(md).toContain(`metadata.version`);
    expect(md).toContain(`${SITE}/SKILL.md`);
  });

  it('names the site origin as its home, and the API host only as the MCP resource and its OAuth endpoints', () => {
    process.env.MCP_OAUTH_ENABLED = 'true';
    const md = liftoffSkill();
    const urls = md.match(/https:\/\/[^\s"'`)]+/g) ?? [];
    const liftoffUrls = urls.filter((u) => u.includes('-test.example.com'));
    expect(liftoffUrls).toContain(MCP_URL);
    expect(liftoffUrls).toContain(`${SITE}/SKILL.md`);
    expect(liftoffUrls).toContain(`${SITE}/agent-setup.md`);
    expect(liftoffUrls).toContain(`${SITE}/activate`);
    const api = 'https://api-test.example.com';
    const allowed = [
      MCP_URL, `${SITE}/SKILL.md`, `${SITE}/agent-setup.md`, `${SITE}/activate`, SITE,
      `${api}/oauth/register`, `${api}/oauth/device_authorization`, `${api}/oauth/token`, `${api}/oauth/revoke`,
    ];
    for (const url of liftoffUrls) {
      expect(allowed).toContain(url);
    }
  });

  it('tells a remote agent to use the device flow, with the grant to register for', () => {
    process.env.MCP_OAUTH_ENABLED = 'true';
    const md = liftoffSkill();
    expect(md).toContain('### Device flow (browser and tool on different machines)');
    expect(md).toContain('urn:ietf:params:oauth:grant-type:device_code');
    expect(md).toContain(`${SITE}/activate`);
    expect(md).toContain('slow_down');
    // resource is documented and defaults.
    expect(md).toContain('when it is omitted the server assumes that value');
    // The expiry is in the sign-in step, not only troubleshooting.
    expect(md).toContain('A sign-in request stays valid for 10 minutes');
  });

  // A remote agent followed the standard flow twice before finding out the
  // browser was on another machine: the choice between the two flows is a
  // Step 0 BEFORE the first tool's instructions, the standard flow states its
  // precondition (a loopback redirect, so the browser must be on the tool's
  // machine), the device flow's heading names that condition rather than "no
  // browser", and the failure that means "wrong flow" is named at the gate
  // and in troubleshooting so the tool switches instead of retrying.
  it('puts Step 0 before the first tool, states the loopback precondition, names the device flow by its condition, and names the failure signature', () => {
    process.env.MCP_OAUTH_ENABLED = 'true';
    const md = liftoffSkill();
    const gate = md.indexOf('### Step 0: Pick the sign-in flow before running any command');
    expect(gate).toBeGreaterThan(-1);
    expect(gate).toBeLessThan(md.indexOf('### Claude Code'));
    expect(md).toContain('The standard sign-in ends with the browser redirecting to `http://127.0.0.1:<port>`, a temporary web server on the machine running the coding tool. That only works if the browser that approves the sign-in runs **on the same machine** as the coding tool.');
    expect(md).toContain('skip the standard flow and use the device flow, the "Device flow (browser and tool on different machines)" section at the end of this list. Do not try the standard flow first');
    expect(md).toContain('Failure signature: if a sign-in attempt ends with the browser on a blank `http://127.0.0.1:<port>` page while the coding tool reports it is still waiting, you are in a split environment. Do not retry the same flow; switch to the device flow.');
    expect(md.indexOf('### Device flow (browser and tool on different machines)')).toBeGreaterThan(md.indexOf('### Cursor, GitHub Copilot, and all other tools'));
    expect(md).toContain('**The browser lands on a blank `http://127.0.0.1:<port>` page and the tool keeps waiting.** The approving browser is on a different machine than the coding tool, so the loopback redirect has nowhere to land. Abandon this attempt and use the device flow instead of retrying.');
  });

  // House voice: no contractions and no em dashes anywhere in the document
  // (the trigger description included). Possessives are fine.
  it('carries no contractions and no em dashes', () => {
    process.env.MCP_OAUTH_ENABLED = 'true';
    const md = liftoffSkill();
    expect(md.match(/\b\w+n't\b|\b\w+'(re|ll|ve|d|m)\b/g)).toBeNull();
    expect(md).not.toContain('—');
  });

  it('tells a remote agent how to disconnect and how to remove its registration', () => {
    process.env.MCP_OAUTH_ENABLED = 'true';
    const md = liftoffSkill();
    const api = 'https://api-test.example.com';
    // Disconnect: revoke the refresh token, which ends the connection.
    expect(md).toContain(`POST ${api}/oauth/revoke`);
    expect(md).toContain('token=<refresh_token>&token_type_hint=refresh_token&client_id=<client_id>');
    // Remove the registration: RFC 7592 DELETE on the registration_client_uri
    // with the registration token as Bearer, ending every connection made
    // through it.
    expect(md).toContain('DELETE <registration_client_uri>');
    expect(md).toContain('Authorization: Bearer <registration_access_token>');
    expect(md).toContain('ends every connection made through that registration');
  });

  it('changes its version whenever its content changes, and not otherwise', () => {
    process.env.MCP_OAUTH_ENABLED = 'true';
    const a = liftoffSkill();
    const b = liftoffSkill();
    expect(a).toBe(b);
    process.env.FRONTEND_URL = 'https://other.example.com';
    const c = liftoffSkill();
    const version = (doc: string) => /version: "([0-9a-f]{12})"/.exec(doc)![1];
    expect(version(c)).not.toBe(version(a));
  });
});

describe('canonical-host redirect', () => {
  afterEach(() => {
    delete process.env.MCP_OAUTH_ENABLED;
  });

  it('301s public docs requested via a raw *.run.app host to the canonical host', async () => {
    process.env.MCP_OAUTH_ENABLED = 'true';
    const http = await import('http');
    const app = buildApp();
    const { status, location } = await new Promise<{ status: number; location?: string }>((resolve, reject) => {
      const server = app.listen(0, () => {
        const addr = server.address() as { port: number };
        const req = http.request(
          {
            host: '127.0.0.1',
            port: addr.port,
            path: '/agent-setup.md',
            headers: { Host: 'platform-backend-abc123-uw.a.run.app' },
          },
          (res) => {
            server.close();
            resolve({ status: res.statusCode ?? 0, location: res.headers.location });
          },
        );
        req.on('error', (e) => {
          server.close();
          reject(e);
        });
        req.end();
      });
    });
    expect(status).toBe(301);
    expect(location).toBe('https://api-test.example.com/agent-setup.md');
  });

  it('404s non-GET requests on a raw *.run.app host', async () => {
    process.env.MCP_OAUTH_ENABLED = 'true';
    const http = await import('http');
    const app = buildApp();
    const status = await new Promise<number>((resolve, reject) => {
      const server = app.listen(0, () => {
        const addr = server.address() as { port: number };
        const req = http.request(
          {
            host: '127.0.0.1',
            port: addr.port,
            path: '/agent-setup.md',
            method: 'POST',
            headers: { Host: 'platform-backend-abc123-uw.a.run.app' },
          },
          (res) => {
            server.close();
            resolve(res.statusCode ?? 0);
          },
        );
        req.on('error', (e) => {
          server.close();
          reject(e);
        });
        req.end();
      });
    });
    expect(status).toBe(404);
  });
});

describe('discovery metadata gate', () => {
  afterEach(() => {
    delete process.env.MCP_OAUTH_ENABLED;
  });

  it('protected-resource metadata 404s off / serves canonical resource on', async () => {
    process.env.MCP_OAUTH_ENABLED = 'false';
    expect((await get(buildApp(), '/.well-known/oauth-protected-resource/mcp')).status).toBe(404);

    process.env.MCP_OAUTH_ENABLED = 'true';
    const res = await get(buildApp(), '/.well-known/oauth-protected-resource/mcp');
    expect(res.status).toBe(200);
    expect(JSON.parse(res.text).resource).toBe(MCP_URL);
  });
});
