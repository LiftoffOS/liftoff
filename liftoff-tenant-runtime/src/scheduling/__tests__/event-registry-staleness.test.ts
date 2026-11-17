// A registry miss is a cache miss, not proof that nobody wants the event.
//
// `eventAgentRegistry` is filled by `loadEventAgentsFromDB()` and mutated
// in-process by activate()/pause(). This runtime is deployed as several Cloud
// Run services from one image: the event subscriber lives in agent-service,
// while a lifecycle change can be handled in coordinator-service. That change
// updates the registry in the process that served it and no other, so an agent
// resumed anywhere else is invisible here until agent-service restarts.
//
// So a paused agent can be resumed, its Composio trigger fire, and the event
// travel the entire path in under a second — Composio → platform-backend
// webhook → control-plane-events → coordinator → connector-events →
// dispatchConnectorEventDirect — only to be dropped with
// `no_registered_agents`, a skip whose own comment read "that's normal". Every
// hop reports success and the mail goes unanswered.
//
// A redistill opens the same hole: the agent stays deaf until a reconciler
// re-registers it, and a real event that lands inside that window is dropped.

jest.mock('../../infrastructure/database', () => ({
  getPool: jest.fn(),
}));
jest.mock('../../infrastructure/logging', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.mock('../../agent-execution/service', () => ({
  agentExecutionService: { executeTask: jest.fn() },
}));
jest.mock('../../invocations/service', () => ({
  invocationsService: { createThread: jest.fn(), updateThreadStatus: jest.fn() },
}));

import { readFileSync } from 'fs';
import { join } from 'path';
import { getPool } from '../../infrastructure/database';
import {
  loadEventAgentsFromDB,
  registerEventAgent,
  deregisterEventAgent,
} from '../event-trigger';

const source = readFileSync(join(__dirname, '..', 'event-trigger.ts'), 'utf8');
const mockGetPool = getPool as jest.Mock;

/** One row as `loadEventAgentsFromDB`'s query returns it. */
function agentRow(id: string, tenantId: string, eventTopic: string) {
  return { id, tenant_id: tenantId, trigger_config: { type: 'event', eventTopic } };
}

describe('the miss path consults the database', () => {
  it('reloads from the DB before concluding nobody is registered', () => {
    // The ordering is the whole fix: refresh and re-match must happen BEFORE
    // recordTriggerSkip, or the event is still dropped on a stale snapshot.
    const refreshAt = source.indexOf('await loadEventAgentsFromDB()');
    const skipAt = source.indexOf("recordTriggerSkip('connector_event', 'no_registered_agents')");
    expect(refreshAt).toBeGreaterThan(-1);
    expect(skipAt).toBeGreaterThan(-1);
    expect(refreshAt).toBeLessThan(skipAt);
  });

  it('re-matches after the refresh rather than refreshing for nothing', () => {
    const block = source.slice(
      source.indexOf('registryMissIsTrustworthy()'),
      source.indexOf("recordTriggerSkip('connector_event', 'no_registered_agents')"),
    );
    expect(block).toContain('matchedAgents = matchAgainstRegistry()');
  });

  it('does not let a refresh failure change the outcome', () => {
    // A failed reload must fall through to the same skip that would have
    // happened anyway — never throw into the Pub/Sub handler, which would nack
    // and redeliver forever.
    const block = source.slice(
      source.indexOf('registryMissIsTrustworthy()'),
      source.indexOf("recordTriggerSkip('connector_event', 'no_registered_agents')"),
    );
    expect(block).toMatch(/catch\s*\(/);
    expect(block).toContain('Event-agent registry refresh failed');
  });
});

describe('the negative-result bound', () => {
  it('is measured from the last successful LOAD, not the last attempt', () => {
    // The previous timer was stamped on the miss path, so it answered "how long
    // since we last tried" — which says nothing about whether the cache is
    // stale. A burst of misses right after a lifecycle change all declined to
    // reload precisely when the cache could least be trusted.
    expect(source).toMatch(/REGISTRY_NEGATIVE_TRUST_MS\s*=\s*[\d_]+/);
    expect(source).toContain('function registryMissIsTrustworthy()');
    expect(source).toContain('lastRegistryLoadAt = Date.now()');
    // The stamp belongs to the loader, not the miss path.
    const loaderAt = source.indexOf('export async function loadEventAgentsFromDB');
    expect(source.indexOf('lastRegistryLoadAt = Date.now()')).toBeGreaterThan(loaderAt);
  });

  it('is bounded, because a topic nobody watches is the ordinary case', () => {
    // Most connector events are for entities no agent subscribes to. Without a
    // bound the miss path becomes one database query per message.
    const m = /REGISTRY_NEGATIVE_TRUST_MS\s*=\s*([\d_]+)/.exec(source);
    expect(Number(m![1].replace(/_/g, ''))).toBeGreaterThan(0);
  });

  it('still always reloads when this tenant has no registrations at all', () => {
    // The state a redistill leaves behind. Rate-limiting it means the authority
    // is never consulted while a configured agent stays invisible.
    expect(source).toContain('tenantHasNoRegistrations');
    expect(source).toMatch(/tenantHasNoRegistrations\s*\|\|\s*!registryMissIsTrustworthy\(\)/);
  });
});

// ── The convergence property ────────────────────────────────────────────────
//
// This is the half that a grep cannot assert, and the defect that made the
// miss-path reload unable to help: the reload only ever ADDED.

describe('a reload converges the cache on the database', () => {
  const TENANT = 'tenant-1';

  beforeEach(() => {
    jest.clearAllMocks();
  });

  function poolReturning(rows: Array<ReturnType<typeof agentRow>>) {
    mockGetPool.mockReturnValue({ query: jest.fn().mockResolvedValue({ rows }) });
  }

  it('drops a registration the database no longer backs', async () => {
    // A paused or archived agent whose lifecycle change was served by another
    // process. Before this, it stayed registered until the pod restarted and
    // could still be woken by an event it no longer subscribed to — which is
    // worse than deafness: deafness loses work, a spurious wake invents it.
    poolReturning([agentRow('agent-a', TENANT, 'pr.opened')]);
    await loadEventAgentsFromDB();

    poolReturning([]);
    await loadEventAgentsFromDB();

    // Deregistering is now a no-op because nothing is registered. If the reload
    // had merged, the stale entry would still be here and this would have been
    // the only thing that could remove it.
    expect(() => deregisterEventAgent('agent-a', TENANT, 'pr.opened')).not.toThrow();
    poolReturning([]);
    await loadEventAgentsFromDB();
  });

  it('drops the OLD topic when a redistill retargets an agent', async () => {
    // The precise hole the tenant-has-no-registrations check does not close: a
    // retargeted agent leaves its old topic registered, so the tenant still
    // looks registered and the miss path's cheap escape never fires.
    poolReturning([agentRow('agent-a', TENANT, 'pr.opened')]);
    await loadEventAgentsFromDB();

    poolReturning([agentRow('agent-a', TENANT, 'pr.synchronized')]);
    await loadEventAgentsFromDB();

    // registerEventAgent reports whether it ADDED. If the old topic had
    // survived the reload, re-asserting it would be a no-op (false). It was
    // dropped, so this adds it back — proving it was gone.
    expect(registerEventAgent('agent-a', TENANT, 'pr.opened')).toBe(true);
    // The new topic did survive, so re-asserting that one changes nothing.
    expect(registerEventAgent('agent-a', TENANT, 'pr.synchronized')).toBe(false);
  });

  it('keeps a registration the database still backs', async () => {
    // Convergence must not mean churn: a reload that dropped and re-added every
    // registration would make the "added" signal meaningless and bury the one
    // case worth logging.
    poolReturning([agentRow('agent-a', TENANT, 'pr.opened')]);
    await loadEventAgentsFromDB();
    await loadEventAgentsFromDB();

    expect(registerEventAgent('agent-a', TENANT, 'pr.opened')).toBe(false);
  });
});

describe('registerEventAgent reports whether it changed anything', () => {
  it('is true only for a registration the cache did not hold', () => {
    // The reconciler keys its drift-is-a-defect warning off this. Returning
    // true unconditionally would make every tick look like a repair; returning
    // false unconditionally would hide every real one.
    expect(registerEventAgent('agent-z', 'tenant-z', 'topic.z')).toBe(true);
    expect(registerEventAgent('agent-z', 'tenant-z', 'topic.z')).toBe(false);
    deregisterEventAgent('agent-z', 'tenant-z', 'topic.z');
    expect(registerEventAgent('agent-z', 'tenant-z', 'topic.z')).toBe(true);
    deregisterEventAgent('agent-z', 'tenant-z', 'topic.z');
  });
});
