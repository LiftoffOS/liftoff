/**
 * Translating an id that is ALREADY a runtime id is not a miss.
 *
 * `internal_agents.id` and the runtime's `agents.id` are disjoint (ADR-039),
 * and several callers legitimately hold the runtime one — the agent-execution
 * loop passes the id it is running under. Handing that to a naive translator
 * finds no `internal_agent_id` row, logs `agent_id_mapping_miss`, and falls
 * back to the input.
 *
 * The fallback is the right answer there BY LUCK. The cost is the warning: it
 * would fire on every web-tool call of every run (e.g. from
 * `boundWebVendorConnectors`), and a GENUINE miss — a control-plane id with no
 * mapping row, where the fallback really does query the wrong id space and
 * hand a workspace's accounts to a team bound to none — would look exactly the
 * same, buried under dozens of benign ones per run.
 */
const query = jest.fn();
jest.mock('../../infrastructure/database', () => ({
  getPoolForService: () => ({ query: (...a: unknown[]) => query(...a) }),
}));
const warn = jest.fn();
// `scrubLogger` lives in observability, not infrastructure/logging — mocking
// the wrong path let the REAL one run, which validates its fields against the
// log schema and threw a ZodError on a non-UUID fixture.
jest.mock('../../observability/scrub-logger', () => ({
  scrubLogger: { warn: (...a: unknown[]) => warn(...a), info: jest.fn(), error: jest.fn() },
}));

import { resolveRuntimeAgentId, resolveRuntimeAgentIdStrict } from '../resolve-runtime-agent-id';

// The log schema validates both ids as UUIDs, so the tenant has to be one too.
const TENANT = 'dd7d80bd-3b77-4677-817c-053fdb8668cd';
const INTERNAL = 'beae8b0b-6e23-4e0d-a016-48eac5b8e27a';
const RUNTIME = '34cca997-11da-477a-9d62-e8bf6fca5ae6';
/** A well-formed id with no mapping row. The log schema validates these as
 *  UUIDs, so a placeholder string fails validation rather than the lookup. */
const UNMAPPED = '00000000-0000-4000-8000-000000000001';

beforeEach(() => { query.mockReset(); warn.mockReset(); });

/** The mapping row as the single statement selects it. */
const translated = () => query.mockResolvedValue({ rows: [{ agent_id: RUNTIME, by_internal: true }] });
const already = () => query.mockResolvedValue({ rows: [{ agent_id: RUNTIME, by_internal: false }] });
const missing = () => query.mockResolvedValue({ rows: [] });

describe('an internal id is translated', () => {
  it('returns the runtime id', async () => {
    translated();
    await expect(resolveRuntimeAgentId(TENANT, INTERNAL, 'c')).resolves.toBe(RUNTIME);
  });

  it('says nothing: a translation is the normal case', async () => {
    translated();
    await resolveRuntimeAgentId(TENANT, INTERNAL, 'c');
    expect(warn).not.toHaveBeenCalled();
  });
});

describe('a runtime id passes through', () => {
  it('is returned unchanged', async () => {
    already();
    await expect(resolveRuntimeAgentId(TENANT, RUNTIME, 'boundWebVendorConnectors')).resolves.toBe(RUNTIME);
  });

  it('is NOT reported as a miss', async () => {
    // The whole point. This fired on every web-tool call of every run.
    already();
    await resolveRuntimeAgentId(TENANT, RUNTIME, 'boundWebVendorConnectors');
    expect(warn).not.toHaveBeenCalled();
  });

  it('is accepted by the STRICT variant rather than refused', async () => {
    // Strict exists to stop a CONTROL-PLANE id reaching a runtime-keyed
    // column. An id that is already runtime is exactly what the caller wants
    // to write, so refusing it would refuse correct writes.
    already();
    await expect(resolveRuntimeAgentIdStrict(TENANT, RUNTIME, 'c')).resolves.toBe(RUNTIME);
    expect(warn).not.toHaveBeenCalled();
  });
});

describe('a genuine miss is still loud', () => {
  it('warns and falls back', async () => {
    missing();
    await expect(resolveRuntimeAgentId(TENANT, UNMAPPED, 'c')).resolves.toBe(UNMAPPED);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toMatchObject({ event: 'agent_id_mapping_miss', fellBack: true });
  });

  it('warns and REFUSES under the strict variant', async () => {
    missing();
    await expect(resolveRuntimeAgentIdStrict(TENANT, UNMAPPED, 'c')).resolves.toBeNull();
    expect(warn.mock.calls[0][0]).toMatchObject({ event: 'agent_id_mapping_miss', fellBack: false });
  });

  it('names the caller, so the miss can be traced to one seam', async () => {
    missing();
    await resolveRuntimeAgentId(TENANT, UNMAPPED, 'boundWebVendorConnectors');
    expect(warn.mock.calls[0][0]).toMatchObject({ caller: 'boundWebVendorConnectors' });
  });
});

describe('the lookup costs one round trip', () => {
  it('asks both columns in one statement', async () => {
    // A second query to ask "was it already a runtime id" would double the cost
    // of the hot path this sits on: every web-tool call resolves through it.
    already();
    await resolveRuntimeAgentId(TENANT, RUNTIME, 'c');
    expect(query).toHaveBeenCalledTimes(1);
    const sql = String(query.mock.calls[0][0]);
    expect(sql).toMatch(/internal_agent_id = \$1 OR agent_id = \$1/);
    expect(sql).toMatch(/\(internal_agent_id = \$1\) AS by_internal/);
  });

  it('prefers the translation when an id is somehow both', async () => {
    const sql = (() => { already(); return null; })();
    void sql;
    await resolveRuntimeAgentId(TENANT, RUNTIME, 'c');
    expect(String(query.mock.calls[0][0])).toMatch(/ORDER BY by_internal DESC/);
  });
});
