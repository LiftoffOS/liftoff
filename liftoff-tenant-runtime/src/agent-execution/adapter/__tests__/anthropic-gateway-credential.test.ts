// What credential the Claude Agent SDK's child process is given, and which of
// three states the run is in.
//
// The child is the process that runs the agent's Bash tool, so what is in its
// environment is what an agent can print into its own transcript. That is the
// original reason a gateway session exists at all. The second reason is counting:
// a managed session puts something in front of the vendor's own response for a run
// Liftoff is paying for, which is where the cache write can be read independently
// of this process's own enumerations.
//
// All three states produce a working turn, so none of them fails loudly. The way
// this breaks is a release that sets one credential variable and not the other, or
// a managed session that quietly falls through to Liftoff's raw key and is
// therefore never counted.

jest.mock('@anthropic-ai/claude-agent-sdk', () => ({
  AbortError: class AbortError extends Error {},
  query: jest.fn(() => {
    const it = (async function* () { /* no messages */ })();
    return Object.assign(it, { interrupt: jest.fn(), setPermissionMode: jest.fn() });
  }),
}));

jest.mock('../../../infrastructure/secret-store', () => ({
  getManagedSecret: (name: string) => `managed-${name}`,
}));

import { query } from '@anthropic-ai/claude-agent-sdk';
import { AnthropicAdapter } from '../anthropic';
import type { McpToolCatalog } from '../catalog-types';
import type { ByokAdapterCredential, InvocationInput } from '../types';

function makeInput(byok?: ByokAdapterCredential): InvocationInput {
  return {
    messages: [], systemPrompt: 's', model: 'claude-sonnet-5', provider: 'anthropic',
    tenantId: 't1', invocationId: 'inv1', maxTurns: 5,
    ...(byok ? { byok } : {}),
  };
}

async function envOf(byok?: ByokAdapterCredential): Promise<Record<string, string>> {
  (query as jest.Mock).mockClear();
  const adapter = new AnthropicAdapter();
  adapter.registerToolCatalog({ servers: [], tools: [] } as McpToolCatalog);
  try {
    for await (const _ of adapter.invoke(makeInput(byok), new AbortController().signal)) { void _; }
  } catch { /* the stream is irrelevant; query() was already called with its options */ }
  return (query as jest.Mock).mock.calls[0][0].options.env as Record<string, string>;
}

const GATEWAY = {
  baseUrl: 'https://api-dev.example.com/byok/anthropic',
  token: 'liftoff_byok_t1_secret',
  rerouteToVendorApi: false,
} as const;

describe('a customer-funded session', () => {
  it('sends the gateway and the run token, never a provider key', async () => {
    const env = await envOf({ ...GATEWAY, mode: 'byok', vendor: 'anthropic' });
    expect(env.ANTHROPIC_BASE_URL).toBe(GATEWAY.baseUrl);
    expect(env.ANTHROPIC_AUTH_TOKEN).toBe(GATEWAY.token);
    expect(env.ANTHROPIC_API_KEY).toBe(GATEWAY.token);
    // The whole point. Liftoff's key must not be in the environment of the
    // process running the agent's shell commands, and neither must the
    // customer's — which never leaves the control plane.
    expect(Object.values(env)).not.toContain('managed-ANTHROPIC_API_KEY');
  });
});

describe('a MANAGED gateway session', () => {
  it('is wired exactly like the customer-funded one', async () => {
    // Identical wiring, because the wiring was never about the money. If this
    // silently fell through to the else branch the turn would still work and
    // nothing would be counted, which is the failure this whole change exists to
    // end.
    const env = await envOf({ ...GATEWAY, mode: 'managed_gateway', vendor: 'anthropic' });
    expect(env.ANTHROPIC_BASE_URL).toBe(GATEWAY.baseUrl);
    expect(env.ANTHROPIC_AUTH_TOKEN).toBe(GATEWAY.token);
    expect(env.ANTHROPIC_API_KEY).toBe(GATEWAY.token);
    expect(Object.values(env)).not.toContain('managed-ANTHROPIC_API_KEY');
  });
});

describe('no session at all', () => {
  it('falls back to Liftoff\'s own key, as it did before the gateway existed', async () => {
    // The control plane unreachable, or a provider with no door. The run must
    // still happen; what is lost is the capture, not the turn.
    const env = await envOf();
    expect(env.ANTHROPIC_API_KEY).toBe('managed-ANTHROPIC_API_KEY');
    expect(env.ANTHROPIC_BASE_URL).toBeUndefined();
    expect(env.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
  });

  it('ignores a session for another vendor entirely', async () => {
    // A run can carry a credential for a different door — a coding session sent
    // elsewhere, a re-routed Grok turn. This engine reads only its own, or it
    // would hand the CLI a token no Anthropic endpoint honours.
    const env = await envOf({
      ...GATEWAY, mode: 'managed_gateway', vendor: 'openrouter',
      baseUrl: 'https://api-dev.example.com/byok/openrouter',
    });
    expect(env.ANTHROPIC_API_KEY).toBe('managed-ANTHROPIC_API_KEY');
    expect(env.ANTHROPIC_BASE_URL).toBeUndefined();
  });
});

describe('both credential variables, always', () => {
  it.each([['byok'], ['managed_gateway']] as const)(
    'sets AUTH_TOKEN and API_KEY together on a %s session',
    async (mode) => {
      // The CLI accepts either and which one it prefers has moved between
      // releases. Setting one and leaving the other unset is how a release
      // quietly starts authenticating with nothing.
      const env = await envOf({ ...GATEWAY, mode, vendor: 'anthropic' });
      expect(env.ANTHROPIC_AUTH_TOKEN).toBe(env.ANTHROPIC_API_KEY);
      expect(env.ANTHROPIC_AUTH_TOKEN).toBeTruthy();
    },
  );
});
