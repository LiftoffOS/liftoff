// An agent working through a vendor's own MCP server has to remember what it did.
//
// The ledger is written inside the tool gateway, and a vendor-hosted connector
// never passes through it — `resolveVendorMcpServers` gives the engine a direct
// connection to the vendor. So a GitHub review was posted and nothing recorded
// it, `have_i_acted_on` answered "no record" for the commit just reviewed, and
// every redelivery reviewed again.
import { parseVendorToolName, recordExternalToolCall, triggerTargetOf } from '../record-external-tool-call';

const intents: unknown[] = [];
const outcomes: unknown[] = [];
const ledger = {
  recordIntent: jest.fn(async (i: unknown) => { intents.push(i); return 'action-1'; }),
  recordOutcome: jest.fn(async (...o: unknown[]) => { outcomes.push(o); }),
  recordFailure: jest.fn(async () => undefined),
} as never;

const REVIEW = {
  tenantId: 't1',
  agentId: 'a1',
  toolName: 'mcp__github-dd4c4689__pull_request_review_write',
  callId: 'call-1',
  input: { owner: 'acme', repo: 'api', pullNumber: 123 },
  result: { ok: true },
  invocationId: 'inv-1',
  ledger,
};

beforeEach(() => { intents.length = 0; outcomes.length = 0; jest.clearAllMocks(); });

describe('parseVendorToolName', () => {
  it('keeps the instance ALIAS, exactly as the native path stores it', () => {
    // `<type>-<first 8 of the uuid>` is what names an INSTANCE. A tenant with
    // two custom MCP servers has two aliases and one type; stripped to the type
    // they ledgered as one server, and nothing could say which an action went
    // to. `deriveTarget` derives the type itself, so the alias costs it nothing.
    expect(parseVendorToolName('mcp__github-dd4c4689__pull_request_review_write'))
      .toEqual({ connector: 'github-dd4c4689', actionType: 'pull_request_review_write' });
    expect(parseVendorToolName('mcp__custom-mcp-d144a7ea__get_article'))
      .toEqual({ connector: 'custom-mcp-d144a7ea', actionType: 'get_article' });
  });

  it('gives two instances of one type two connectors', () => {
    const a = parseVendorToolName('mcp__custom-mcp-d144a7ea__get_article');
    const b = parseVendorToolName('mcp__custom-mcp-9e1b77c0__get_article');
    expect(a?.connector).not.toEqual(b?.connector);
  });

  it('accepts a server with no instance suffix', () => {
    expect(parseVendorToolName('mcp__notion__create_page'))
      .toEqual({ connector: 'notion', actionType: 'create_page' });
  });

  it('refuses a name it cannot read rather than guessing a connector', () => {
    // A row filed under the wrong connector vouches for something that never
    // happened there, which is worse than no row.
    expect(parseVendorToolName('read_skill')).toBeNull();
    expect(parseVendorToolName('mcp__onlyserver')).toBeNull();
    expect(parseVendorToolName('mcp__server__')).toBeNull();
  });
});

describe('recordExternalToolCall', () => {
  it('records a vendor-hosted write against the thing it acted on', async () => {
    await recordExternalToolCall(REVIEW);
    expect(intents).toHaveLength(1);
    expect(intents[0]).toMatchObject({
      tenantId: 't1',
      agentId: 'a1',
      // The instance alias in the column; the TYPE in the ref. `deriveTarget`
      // derives the type from the alias itself, which is why storing the alias
      // costs the ref nothing — and why stripping it here only ever lost
      // information.
      connector: 'github-dd4c4689',
      actionType: 'pull_request_review_write',
      targetRef: 'github:acme/api#123',
    });
    expect(outcomes).toHaveLength(1);
  });

  it('does not double-record a call our own gateway already wrote', async () => {
    await recordExternalToolCall({
      ...REVIEW,
      toolName: 'mcp__liftoff-tool-gateway__github-dd4c4689__pull_request_review_write',
    });
    expect(intents).toHaveLength(0);
  });

  it('keys idempotency per call, so a replayed call does not stack rows', async () => {
    await recordExternalToolCall(REVIEW);
    expect(intents[0]).toMatchObject({ idempotencyKey: 'inv-1:call-1' });
  });

  it('records a failure as a failure, not a success', async () => {
    await recordExternalToolCall({ ...REVIEW, error: 'boom' });
    expect(intents).toHaveLength(1);
    expect(outcomes).toHaveLength(0);
  });

  it('skips a call that names nothing identifiable', async () => {
    // A row nothing can look up reports coverage the ledger does not have.
    await recordExternalToolCall({ ...REVIEW, input: {} });
    expect(intents).toHaveLength(0);
  });

  it('never throws, whatever the ledger does', async () => {
    const broken = {
      recordIntent: jest.fn(async () => { throw new Error('db down'); }),
      recordOutcome: jest.fn(),
      recordFailure: jest.fn(),
    } as never;
    // The action already happened. Throwing here would report a completed
    // review as a failure and invite a retry that reviews twice. It SAYS it
    // failed, though: a caller that took a resolved promise for a written row
    // marked calls remembered that no row existed for.
    await expect(recordExternalToolCall({ ...REVIEW, ledger: broken })).resolves.toBe('failed');
  });
});


// A review is idempotent PER COMMIT, so the row has to say which commit.
//
// `deriveTarget` reads the version off the tool payload, and a GitHub
// review-write payload is `{method, owner, repo, pullNumber}` — no sha. The row
// therefore recorded WHAT was acted on and not which revision of it, and
// `have_i_acted_on` could only answer `acted_version_unknown`: "you did
// something here, I cannot tell at which commit". An agent given that answer
// reviews again, which is how a redelivery got a second review with the write
// correctly recorded.
const TRIGGER = {
  eventSource: 'github',
  eventEntityType: 'PullRequest',
  eventData: { repository: 'acme/api', number: 123, head: '2358e17' },
};

describe('triggerTargetOf', () => {
  it('reads what the waking event was about', () => {
    expect(triggerTargetOf(TRIGGER)).toEqual({
      ref: 'github:acme/api#123',
      version: '2358e17',
    });
  });

  it('is null for a run nothing triggered', () => {
    expect(triggerTargetOf(undefined)).toBeNull();
    expect(triggerTargetOf({ objective: 'do a thing' })).toBeNull();
  });
});

describe('the version an action is recorded at', () => {
  it('inherits the triggering event version when the payload carries none', async () => {
    await recordExternalToolCall({ ...REVIEW, triggerTarget: triggerTargetOf(TRIGGER) });
    expect(intents[0]).toMatchObject({ targetVersion: '2358e17' });
  });

  it('does NOT stamp the trigger version on a different target', async () => {
    // A run woken by PR 123 may also touch PR 456. Stamping 123's head sha
    // there files a confident lie the next redelivery would read as "already
    // handled at that revision" for a revision never examined.
    await recordExternalToolCall({
      ...REVIEW,
      input: { owner: 'acme', repo: 'api', pullNumber: 456 },
      triggerTarget: triggerTargetOf(TRIGGER),
    });
    expect(intents[0]).toMatchObject({
      targetRef: 'github:acme/api#456',
      targetVersion: null,
    });
  });

  it("prefers the payload's own version over the trigger's", async () => {
    // The payload names the revision the call actually acted on; the trigger
    // only names what woke the run.
    await recordExternalToolCall({
      ...REVIEW,
      input: { ...REVIEW.input, commitId: 'abc1234' },
      triggerTarget: triggerTargetOf(TRIGGER),
    });
    expect(intents[0]).toMatchObject({ targetVersion: 'abc1234' });
  });

  it('records no version when nothing knows one', async () => {
    await recordExternalToolCall(REVIEW);
    expect(intents[0]).toMatchObject({ targetVersion: null });
  });
});


// The row has to be one the READER counts.
//
// `hasActedOn` selects `status IN ('completed','succeeded')`, and
// `recordOutcome` derives that status from `result.success` — the shape an
// ExecuteResult has and a raw MCP tool result does not. Handed the raw result,
// every row was written, versioned, and marked FAILED, so the ledger filled up
// with actions the idempotency check could not see. A row nobody counts is the
// same as no row, arrived at more expensively.
//
// The earlier tests here mocked the ledger, which is exactly why they passed
// while this was broken: mocking the collaborator hides a mismatch with its
// contract. This asserts the shape that crosses the seam.
describe('the outcome handed to the ledger', () => {
  it('is an ExecuteResult, so the row lands countable', async () => {
    await recordExternalToolCall(REVIEW);
    const [, outcome] = outcomes[0] as [string, { success: boolean; data: unknown }];
    expect(outcome.success).toBe(true);
    expect(outcome.data).toEqual({ ok: true });
  });

  it('carries the raw tool result as the response, not the wrapper', async () => {
    // `recordOutcome` stores `result.data` and derives a target ref from it, so
    // the wrapper must not become the thing the ledger remembers.
    await recordExternalToolCall(REVIEW);
    const [, outcome] = outcomes[0] as [string, { data: unknown }];
    expect(outcome.data).not.toHaveProperty('success');
  });
});
