// The gate sees the tools the gateway never dispatches — and can refuse them.
//
// `checkWriteProvenance` and `recordProvenance` had one caller each, both
// inside the gateway, so a vendor-hosted MCP server — GitHub, Stripe, and every
// `custom_mcp_server` a customer brings — produced no provenance evidence at
// all. Not a failing verdict: no verdict, which reads identically to a
// connector nothing exercised.
//
// Two seams now, because a check and a record happen at different moments:
// `guardExternalToolCall` runs BEFORE dispatch (from the adapter gate, on every
// engine) and is where a write is judged and can be held;
// `recordExternalToolResult` runs AFTER (from the event stream) and records
// only. The properties below are what make that split honest, and each of
// them fails silently if it regresses.

import {
  _resetInertReportingForTesting,
  provenanceGateMode,
} from '../record-provenance';
import { guardExternalToolCall, recordExternalToolResult } from '../external-provenance';
import type { ProvenanceDeclaration } from '../record-provenance';
import { logger } from '../../infrastructure/logging';

const TENANT = '11111111-1111-1111-1111-111111111111';
const AGENT = '22222222-2222-2222-2222-222222222222';

function emitted(spy: jest.SpyInstance, event: string): Array<Record<string, unknown>> {
  return spy.mock.calls
    .map((c) => c[0] as Record<string, unknown>)
    .filter((p) => p && p.event === event);
}

/** A read on the vendor server, recorded the way the event stream does it. */
async function read(id: string, toolName: string, result: unknown): Promise<void> {
  await recordExternalToolResult({
    tenantId: TENANT, agentId: AGENT, invocationId: id, toolName, input: {}, result,
  }, undefined);
}

/** A derived declaration, the shape the schema cache produces for a tool whose
 *  input schema names a record. */
const GITHUB_REVIEW: ProvenanceDeclaration = { idArgs: ['head_sha'], entityType: 'pull_request' };

describe('provenance for directly dispatched tools', () => {
  let warn: jest.SpyInstance;
  let info: jest.SpyInstance;
  let invocation = 0;
  const env = { ...process.env };

  beforeEach(async () => {
    _resetInertReportingForTesting();
    warn = jest.spyOn(logger, 'warn').mockImplementation(() => undefined as never);
    info = jest.spyOn(logger, 'info').mockImplementation(() => undefined as never);
    invocation += 1;
    delete process.env.PROVENANCE_GATE_MODE;
    delete process.env.PROVENANCE_ENFORCE_CONNECTORS;
  });
  afterEach(() => {
    jest.restoreAllMocks();
    process.env = { ...env };
  });

  const inv = (): string => `inv-${invocation}`;

  it('is switched on at all in this environment', async () => {
    // Guards every assertion below: in `off` both seams return immediately and
    // every "nothing emitted" expectation would pass vacuously.
    expect(provenanceGateMode()).not.toBe('off');
  });

  it('judges a write on a server the gateway never saw, and says which path', async () => {
    await guardExternalToolCall({
      tenantId: TENANT, agentId: AGENT, invocationId: inv(),
      toolName: 'mcp__custom-mcp-d144a7ea__update_article',
      input: { slug: 'ai-teams/managing-your-teams', body: 'new' },
    }, undefined);
    const hits = [...emitted(warn, 'provenance_floor_would_block'), ...emitted(info, 'provenance_pass'),
      ...emitted(info, 'provenance_not_judged')];
    expect(hits.length).toBeGreaterThan(0);
    for (const h of hits) expect(h.dispatch).toBe('direct');
  });

  it('lets a later write stand on an earlier read from the same server', async () => {
    const id = inv();
    await read(id, 'mcp__github-dd4c4689__get_pull_request', { head_sha: 'abc123def4567890', number: 122 });
    warn.mockClear();

    await guardExternalToolCall({
      tenantId: TENANT, agentId: AGENT, invocationId: id,
      toolName: 'mcp__github-dd4c4689__create_pull_request_review',
      input: { head_sha: 'abc123def4567890', body: 'looks good' },
    }, undefined);
    // The read established it, so the floor has nothing to flag. Without the
    // recording half this is exactly the write that would be reported unseen —
    // and the fix for that report would have been to weaken the floor.
    expect(emitted(warn, 'provenance_floor_would_block')).toEqual([]);
  });

  it('does not let a write provenance itself', async () => {
    // The check runs at the gate BEFORE the call, the record from the stream
    // AFTER it. Nothing this write returns can be in the store when it is
    // judged — which is the ordering the gateway path has always had, and the
    // one that stops every write being its own evidence.
    const id = inv();
    await read(id, 'mcp__github-dd4c4689__get_pull_request', { number: 1, head_sha: '1111111111111111' });
    warn.mockClear();

    await guardExternalToolCall({
      tenantId: TENANT, agentId: AGENT, invocationId: id,
      toolName: 'mcp__github-dd4c4689__create_pull_request_review',
      input: { head_sha: 'deadbeefcafe1234', body: 'an id this run never read' },
    }, undefined);
    expect(emitted(warn, 'provenance_floor_would_block').length).toBe(1);
  });

  it('ignores our own gateway tools on both seams', async () => {
    // The gateway judged and recorded these inside execute(). A second pass
    // would double the denominator and re-report every verdict.
    const id = inv();
    await guardExternalToolCall({
      tenantId: TENANT, agentId: AGENT, invocationId: id,
      toolName: 'mcp__liftoff-tool-gateway__google-mail-0105297e__create_draft',
      input: { thread_id: 'never-read-1a03cafc' },
    }, undefined);
    await recordExternalToolResult({
      tenantId: TENANT, agentId: AGENT, invocationId: id,
      toolName: 'mcp__liftoff-tool-gateway__google-mail-0105297e__get_thread',
      input: {}, result: { id: 'x' },
    }, undefined);
    expect(emitted(warn, 'provenance_floor_would_block')).toEqual([]);
    expect(emitted(info, 'provenance_pass')).toEqual([]);
    expect(emitted(info, 'provenance_not_judged')).toEqual([]);
  });

  it('records nothing from a failed call', async () => {
    const id = inv();
    await read(id, 'mcp__github-dd4c4689__get_pull_request', { number: 1, head_sha: '2222222222222222' });
    // The failed one names the sha the write will use. If a failure recorded
    // anything, the write below would look provenanced by a call that read
    // nothing.
    await recordExternalToolResult({
      tenantId: TENANT, agentId: AGENT, invocationId: id,
      toolName: 'mcp__github-dd4c4689__get_pull_request',
      input: { pullNumber: 7 }, result: { head_sha: 'f00dfacef00dface' }, error: 'not found',
    }, undefined);
    warn.mockClear();

    await guardExternalToolCall({
      tenantId: TENANT, agentId: AGENT, invocationId: id,
      toolName: 'mcp__github-dd4c4689__create_pull_request_review',
      input: { head_sha: 'f00dfacef00dface', body: 'x' },
    }, undefined);
    expect(emitted(warn, 'provenance_floor_would_block').length).toBe(1);
  });

  it('records without reporting, so a write is counted once', async () => {
    // The verdict was produced at the gate. Reporting again from the stream
    // would double every direct-dispatch write in the denominator the readiness
    // report reads.
    await recordExternalToolResult({
      tenantId: TENANT, agentId: AGENT, invocationId: inv(),
      toolName: 'mcp__github-dd4c4689__create_pull_request_review',
      input: { head_sha: 'cafe' }, result: { id: 1 },
    }, undefined);
    expect(emitted(info, 'provenance_pass')).toEqual([]);
    expect(emitted(info, 'provenance_not_judged')).toEqual([]);
    expect(emitted(warn, 'provenance_would_block')).toEqual([]);
  });

  describe('the hold', () => {
    const write = (id: string, decl: ProvenanceDeclaration | undefined, sha = 'never-read-0000'): Promise<string | null> =>
      guardExternalToolCall({
        tenantId: TENANT, agentId: AGENT, invocationId: id,
        toolName: 'mcp__github-dd4c4689__create_pull_request_review',
        input: { head_sha: sha, body: 'x' },
      }, decl);

    it('is null in shadow, whatever the verdict', async () => {
      const id = inv();
      await read(id, 'mcp__github-dd4c4689__get_pull_request', { head_sha: '3333333333333333' });
      expect(await write(id, GITHUB_REVIEW)).toBeNull();
    });

    it('is null in enforce for a connector not on the list', async () => {
      process.env.PROVENANCE_GATE_MODE = 'enforce';
      process.env.PROVENANCE_ENFORCE_CONNECTORS = 'notion';
      const id = inv();
      await read(id, 'mcp__github-dd4c4689__get_pull_request', { head_sha: '4444444444444444' });
      expect(await write(id, GITHUB_REVIEW)).toBeNull();
    });

    it('is null with no declaration even in enforce — only the floor spoke, and the floor never refuses', async () => {
      process.env.PROVENANCE_GATE_MODE = 'enforce';
      process.env.PROVENANCE_ENFORCE_CONNECTORS = 'github';
      const id = inv();
      await read(id, 'mcp__github-dd4c4689__get_pull_request', { head_sha: '5555555555555555' });
      expect(await write(id, undefined)).toBeNull();
    });

    it('HOLDS an unprovenanced write on an enforced connector, given a declaration', async () => {
      // The case the whole seam exists for. A first version passed `undefined`
      // for every vendor-hosted tool and so could never reach this branch — an
      // enforcement seam that refused nothing, and every other test here would
      // have passed.
      process.env.PROVENANCE_GATE_MODE = 'enforce';
      process.env.PROVENANCE_ENFORCE_CONNECTORS = 'github';
      const id = inv();
      await read(id, 'mcp__github-dd4c4689__get_pull_request', { head_sha: '6666666666666666' });
      const hold = await write(id, GITHUB_REVIEW);
      expect(hold).toMatch(/Held: github\.create_pull_request_review names never-read-0000/);
      expect(hold).toMatch(/not a refusal of the action/);
    });

    it('lets the same write through once the id has been read', async () => {
      process.env.PROVENANCE_GATE_MODE = 'enforce';
      process.env.PROVENANCE_ENFORCE_CONNECTORS = 'github';
      const id = inv();
      // The read's own declaration is what records the sha under its entity
      // type, which is what the precise check consults.
      await recordExternalToolResult({
        tenantId: TENANT, agentId: AGENT, invocationId: id,
        toolName: 'mcp__github-dd4c4689__get_pull_request',
        input: { pullNumber: 1 }, result: { head_sha: '7777777777777777' },
      }, { entityType: 'pull_request', returnsIds: [{ entityType: 'pull_request', path: 'head_sha' }] });
      expect(await write(id, GITHUB_REVIEW, '7777777777777777')).toBeNull();
    });

    it('names the declared read that would ground the write, when there is one', async () => {
      // A hold that says "read first" without saying what to read leaves the
      // model to search a server of forty tools for it. The pilot's
      // declarations say which read returns a pull request, and the hold
      // says so; for an entity nothing declared returns, the generic form.
      process.env.PROVENANCE_GATE_MODE = 'enforce';
      process.env.PROVENANCE_ENFORCE_CONNECTORS = 'github';
      const { vendorDeclarationFor } = jest.requireActual('../../connectors/vendor-declarations');
      const id = inv();
      // The run read #123; it is about to write to #124.
      await recordExternalToolResult({
        tenantId: TENANT, agentId: AGENT, invocationId: id,
        toolName: 'mcp__github-dd4c4689__pull_request_read',
        input: { method: 'get', owner: 'acme', repo: 'api', pullNumber: 123 },
        result: { number: 123, base: { repo: { full_name: 'acme/api' } }, head: { sha: '8888888888888888' } },
      }, vendorDeclarationFor('github', 'pull_request_read'));
      const review = await guardExternalToolCall({
        tenantId: TENANT, agentId: AGENT, invocationId: id,
        toolName: 'mcp__github-dd4c4689__pull_request_review_write',
        input: { owner: 'acme', repo: 'api', pullNumber: 124, event: 'COMMENT', body: 'x' },
      }, vendorDeclarationFor('github', 'pull_request_review_write'));
      expect(review).toMatch(/names github:acme\/api#124/);
      expect(review).toMatch(/Call `pull_request_read` first/);

      const comment = await guardExternalToolCall({
        tenantId: TENANT, agentId: AGENT, invocationId: id,
        toolName: 'mcp__github-dd4c4689__add_issue_comment',
        input: { owner: 'acme', repo: 'api', issue_number: 124, body: 'x' },
      }, vendorDeclarationFor('github', 'add_issue_comment'));
      expect(comment).toMatch(/Read the record from github first/);
    });

    it('matches the enforce list by connector TYPE, not by instance alias', async () => {
      // An operator writes `github`; the call carries `github-dd4c4689`.
      // Compared verbatim those never meet, and an allowlist that never
      // matches enforces nothing while appearing switched on.
      process.env.PROVENANCE_GATE_MODE = 'enforce';
      process.env.PROVENANCE_ENFORCE_CONNECTORS = 'github';
      const { provenanceEnforcedFor } = jest.requireActual('../record-provenance');
      expect(provenanceEnforcedFor('github-dd4c4689')).toBe(true);
      expect(provenanceEnforcedFor('GitHub')).toBe(true);
      expect(provenanceEnforcedFor('google-mail-0105297e')).toBe(false);
    });
  });

  it('never throws, on either seam', async () => {
    const cyclic = (() => { const o: Record<string, unknown> = {}; o.self = o; return o; })();
    await expect(guardExternalToolCall({
      tenantId: TENANT, agentId: AGENT, invocationId: inv(),
      toolName: 'mcp__custom-mcp-d144a7ea__update_article',
      input: cyclic as Record<string, unknown>,
    }, undefined)).resolves.toBeNull();
    await expect(recordExternalToolResult({
      tenantId: TENANT, agentId: AGENT, invocationId: inv(),
      toolName: 'mcp__custom-mcp-d144a7ea__update_article',
      input: undefined, result: cyclic,
    }, undefined)).resolves.toBeDefined();
  });
});

describe('the answer covers everything the read established', () => {
  // The declared facts and the floor's were two appends, and the observer
  // answered for the first. For a long-tail read the first append holds
  // nothing but the has-read marker and the second every identifier; a
  // store that took the first and refused the second was reported as
  // "recorded", the call was marked remembered, and nothing retried it.
  const { _setProvenanceStoreForTesting } = jest.requireActual('../provenance-store');
  let n = 0;
  const inv = (): string => `inv-append-${++n}`;
  beforeEach(() => { delete process.env.PROVENANCE_GATE_MODE; });
  afterEach(() => _setProvenanceStoreForTesting(undefined));

  it('is ONE append holding both, so a refusal cannot hide behind a partial success', async () => {
    const appends: Array<Array<{ kind: string; entityType?: string; value: string }>> = [];
    _setProvenanceStoreForTesting({
      append: async (_t: unknown, _i: unknown, rows: typeof appends[number]) => { appends.push(rows); return appends.length === 1; },
      load: async () => undefined,
    });
    const ok = await recordExternalToolResult({
      tenantId: TENANT, agentId: AGENT, invocationId: inv(),
      toolName: 'mcp__notion-0badf00d__search_pages', input: {},
      result: { results: [{ id: 'page-aaaa-1111' }] },
    }, undefined);
    expect(ok).toBe(true);
    expect(appends).toHaveLength(1);
    expect(appends[0]).toEqual(expect.arrayContaining([{ kind: 'untyped', value: 'page-aaaa-1111' }]));
  });

  it('answers false when the store refuses that one append', async () => {
    _setProvenanceStoreForTesting({ append: async () => false, load: async () => undefined });
    await expect(recordExternalToolResult({
      tenantId: TENANT, agentId: AGENT, invocationId: inv(),
      toolName: 'mcp__notion-0badf00d__search_pages', input: {},
      result: { results: [{ id: 'page-aaaa-1111' }] },
    }, undefined)).resolves.toBe(false);
  });
});

describe('a vendor read establishes what it returned, through the envelope it returned it in', () => {
  // A vendor server's result is MCP content — JSON inside a text part — and on
  // the OpenAI wire it sits inside the SDK's own `{ type: 'text', text }` as
  // well. Read against the envelope, a declared path found nothing and the
  // floor saw one long string: every write that followed a vendor read was
  // judged against an empty store, on every engine.
  let warn: jest.SpyInstance;
  let info: jest.SpyInstance;
  const env = { ...process.env };
  beforeEach(async () => {
    _resetInertReportingForTesting();
    warn = jest.spyOn(logger, 'warn').mockImplementation(() => undefined as never);
    info = jest.spyOn(logger, 'info').mockImplementation(() => undefined as never);
    process.env.PROVENANCE_GATE_MODE = 'enforce';
    process.env.PROVENANCE_ENFORCE_CONNECTORS = 'github';
  });
  afterEach(() => { jest.restoreAllMocks(); process.env = { ...env }; });

  const PR_READ: ProvenanceDeclaration = { entityType: 'pull_request', returnsIds: [{ entityType: 'pull_request', path: 'head.sha' }] };
  const github = { number: 123, head: { sha: '3807325c9f1e4b2a8d6c0e7f1a2b3c4d5e6f7a8b' } };
  const mcpEnvelope = { content: [{ type: 'text', text: JSON.stringify(github) }] };
  const sdkWrapped = { type: 'text', text: JSON.stringify(mcpEnvelope) };

  it.each([
    ['the MCP envelope, as the Anthropic engine delivers it', mcpEnvelope],
    ["the SDK's text wrapper around it, as the OpenAI wire delivers it", sdkWrapped],
  ])('lets a write stand on a read delivered as %s', async (_label, result) => {
    const id = `inv-env-${_label.length}`;
    await recordExternalToolResult({
      tenantId: TENANT, agentId: AGENT, invocationId: id,
      toolName: 'mcp__github-dd4c4689__pull_request_read', input: { pullNumber: 123 }, result,
    }, PR_READ);
    const hold = await guardExternalToolCall({
      tenantId: TENANT, agentId: AGENT, invocationId: id,
      toolName: 'mcp__github-dd4c4689__pull_request_review_write',
      input: { head_sha: github.head.sha, body: 'x' },
    }, GITHUB_REVIEW);
    expect(hold).toBeNull();
    expect(emitted(warn, 'provenance_floor_would_block')).toEqual([]);
    expect(info).toHaveBeenCalled();
  });

  it('records nothing from a call whose RESULT says it failed, with no error on the event', async () => {
    const id = 'inv-env-failed';
    // A successful read first, so the run has an entry to be judged against;
    // with none at all a write is deliberately not judged.
    await recordExternalToolResult({
      tenantId: TENANT, agentId: AGENT, invocationId: id,
      toolName: 'mcp__github-dd4c4689__pull_request_read', input: { pullNumber: 7 },
      result: { content: [{ type: 'text', text: JSON.stringify({ number: 7, head: { sha: '7777777777777777' } }) }] },
    }, PR_READ);
    // The failed one names the sha the write will use. The event carries no
    // error; only the envelope says it failed.
    await recordExternalToolResult({
      tenantId: TENANT, agentId: AGENT, invocationId: id,
      toolName: 'mcp__github-dd4c4689__pull_request_read', input: { pullNumber: 123 },
      result: { content: [{ type: 'text', text: JSON.stringify(github) }], isError: true },
    }, PR_READ);
    const hold = await guardExternalToolCall({
      tenantId: TENANT, agentId: AGENT, invocationId: id,
      toolName: 'mcp__github-dd4c4689__pull_request_review_write',
      input: { head_sha: github.head.sha, body: 'x' },
    }, GITHUB_REVIEW);
    expect(hold).toMatch(/Held/);
  });
});

describe('toolResultData', () => {
  const { toolResultData } = jest.requireActual<typeof import('../mcp-result')>('../mcp-result');
  it('prefers structuredContent, the structured result MCP servers may send beside the text', async () => {
    const pr = { number: 123, head: { sha: 'abc' } };
    expect(toolResultData({ content: [{ type: 'text', text: 'PR #123 (abc)' }], structuredContent: pr })).toEqual(pr);
  });
  it('falls back to the text parts, parsed when they are JSON', async () => {
    expect(toolResultData({ content: [{ type: 'text', text: '{"number":123}' }] })).toEqual({ number: 123 });
    expect(toolResultData({ content: [{ type: 'text', text: 'plain prose' }] })).toBe('plain prose');
  });
  it('reads the parts when they arrive BARE, as the Claude Agent SDK hands them', async () => {
    // PostToolUse's tool_response for an MCP tool is the content array itself.
    // Read as data it had no `number` and no `base.repo.full_name`, so every
    // vendor read on the Anthropic engine recorded nothing: dev's runs passed
    // on the trigger's seed, and prod's first constructed run — a chat prompt,
    // no trigger — was judged would-block after reading the pull request.
    const pr = { number: 123, base: { repo: { full_name: 'acme/r' } }, head: { sha: 'abc' } };
    expect(toolResultData([{ type: 'text', text: JSON.stringify(pr) }])).toEqual(pr);
    expect(toolResultData([{ type: 'text', text: '[{"sha":"a"},{"sha":"b"}]' }])).toEqual([{ sha: 'a' }, { sha: 'b' }]);
  });
  it('leaves a vendor’s own array of records alone — data, not parts', async () => {
    const commits = [{ sha: 'a', type: 'commit' }, { sha: 'b', type: 'commit' }];
    expect(toolResultData(commits)).toEqual(commits);
    expect(toolResultData([{ type: 'text' }])).toEqual([{ type: 'text' }]);
  });
});

describe('a vendor read on the Anthropic engine establishes what it returned', () => {
  // The whole path, with the result in the shape the Claude hook hands it.
  const { _resetProvenanceForTesting, checkWriteProvenance } = jest.requireActual('../record-provenance');
  const { vendorDeclarationFor } = jest.requireActual('../../connectors/vendor-declarations');
  beforeEach(() => _resetProvenanceForTesting());
  it('a bare-array pull request read grounds the review that follows', async () => {
    const inv = 'inv-claude-shape';
    await recordExternalToolResult({
      tenantId: TENANT, agentId: AGENT, invocationId: inv,
      toolName: 'mcp__github-7d07a896__pull_request_read',
      input: { method: 'get', owner: 'acme', repo: 'api', pullNumber: 123 },
      result: [{ type: 'text', text: JSON.stringify({ number: 123, base: { repo: { full_name: 'acme/api' } }, head: { sha: 'ee28241a' } }) }],
    }, vendorDeclarationFor('github', 'pull_request_read'));
    const verdict = await checkWriteProvenance({
      tenantId: TENANT, invocationId: inv, actionType: 'pull_request_review_write',
      declaration: vendorDeclarationFor('github', 'pull_request_review_write'),
      payload: { owner: 'acme', repo: 'api', pullNumber: 123, event: 'COMMENT', body: 'x' },
    });
    expect(verdict).toEqual({ provenanced: true, basis: 'canonical_ref', unseen: [] });
  });
});
