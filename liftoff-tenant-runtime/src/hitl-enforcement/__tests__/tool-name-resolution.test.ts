import {
  normalizeToolName,
  dispatchNameFor,
  resolveCatalogTool,
  UnresolvedToolError,
  isOwnGatewayTool,
  sdkCallNameFor,
} from '../tool-name-resolution';

// The bug this fixes: a call arrives as
// `mcp__liftoff-tool-gateway__slack-<id>__send_message` while the catalog holds
// `slack-<id>__send_message`. Every governance lookup compared the two with `===`,
// found nothing, and read `undefined?.categories` — so sensitive-work oversight was
// inert for EVERY connector tool, and the draft pre-check guarded on the same lookup
// silently did nothing.

describe('normalizeToolName', () => {
  it('strips the SDK prefix and server id, keeping the connector-scoped name', () => {
    expect(normalizeToolName('mcp__liftoff-tool-gateway__slack-d77db9a0__send_message'))
      .toBe('slack-d77db9a0__send_message');
  });

  // The tool name itself contains `__`, so only the FIRST separator after the server
  // id may be consumed. Eating more would produce `send_message` and silently resolve
  // to the wrong connector's tool.
  it('consumes only the first separator after the server id', () => {
    expect(normalizeToolName('mcp__srv__a__b__c')).toBe('a__b__c');
  });

  it('leaves un-prefixed names untouched so standard tools are unaffected', () => {
    expect(normalizeToolName('slack_send_message')).toBe('slack_send_message');
    expect(normalizeToolName('corpus_search')).toBe('corpus_search');
  });

  // A standard in-process gateway tool arrives SDK-prefixed with no connector
  // segment. The write-capability gate and the approval arming key off the bare
  // `run_capability`, so the prefixed form must normalize to it — otherwise a
  // correctly write-marked capability is never paused, and its approval never armed.
  it('normalizes a standard gateway tool to its bare name', () => {
    expect(normalizeToolName('mcp__liftoff-tool-gateway__run_capability')).toBe('run_capability');
    expect(normalizeToolName('run_capability')).toBe('run_capability');
  });

  // Malformed input must not be "helpfully" reinterpreted into some other tool's name.
  it('returns a malformed prefixed name unchanged', () => {
    expect(normalizeToolName('mcp__noseparator')).toBe('mcp__noseparator');
  });
});

describe('resolveCatalogTool', () => {
  const catalog = [
    { name: 'slack-d77db9a0__send_message', categories: ['internalCollaboration'] },
    { name: 'corpus_search', categories: [] as string[] },
  ];

  it('resolves the namespaced call name the model actually emits', () => {
    const t = resolveCatalogTool('mcp__liftoff-tool-gateway__slack-d77db9a0__send_message', catalog);
    expect(t?.name).toBe('slack-d77db9a0__send_message');
    expect(t?.categories).toEqual(['internalCollaboration']);
  });

  // Exact match is tried first so nothing that already worked changes behaviour.
  it('prefers an exact match', () => {
    expect(resolveCatalogTool('corpus_search', catalog)?.name).toBe('corpus_search');
  });

  it('returns undefined when the catalog genuinely lacks the tool', () => {
    expect(resolveCatalogTool('mcp__liftoff-tool-gateway__github-x__merge', catalog)).toBeUndefined();
  });

  it('handles an empty or absent catalog without throwing', () => {
    expect(resolveCatalogTool('anything', [])).toBeUndefined();
    expect(resolveCatalogTool('anything', undefined)).toBeUndefined();
  });
});

describe('UnresolvedToolError', () => {
  // A miss is a catalog/caller mismatch — a defect. It must not be conflated with the
  // ordinary case of a resolved tool carrying no categories, and must never become an
  // approval card, which an approver has no basis to judge.
  it('carries the tool name and says what kind of failure it is', () => {
    const err = new UnresolvedToolError('mcp__liftoff-tool-gateway__x__y');
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('UnresolvedToolError');
    expect(err.toolName).toBe('mcp__liftoff-tool-gateway__x__y');
    expect(err.message).toMatch(/not an oversight decision/);
  });
});

// The plan's replacement for "watch a metric until it reads zero". A metric only proves
// nothing exercised the gap during the window; this proves totality against the whole
// catalog shape, and it is the check that would have caught the vendor-MCP regression
// before the suite did.
describe('catalog-wide resolvability', () => {
  // Representative of what mcp-server.ts registers: connector tools as
  // `<alias>__<fn>`, plus agent-level and standard tools under bare names.
  const registered = [
    { name: 'slack-d77db9a0__send_message' },
    { name: 'github-7d07a896__create_pull_request' },
    { name: 'gitlab-1924102e__create_merge_request_note' },
    { name: 'google_sheets-2b820bc9__append_row' },
    { name: 'slack_send_message' },
    { name: 'corpus_search' },
  ];

  it('resolves EVERY registered tool under the name the SDK will emit', () => {
    const unresolved = registered.filter(
      (t) => !resolveCatalogTool(`mcp__liftoff-tool-gateway__${t.name}`, registered),
    );
    expect(unresolved).toEqual([]);
  });

  it('resolves every registered tool under its bare name too', () => {
    const unresolved = registered.filter((t) => !resolveCatalogTool(t.name, registered));
    expect(unresolved).toEqual([]);
  });

  // Ownership, not mere resolvability, is what makes a miss a defect.
  it('claims only our own gateway namespace', () => {
    expect(isOwnGatewayTool('mcp__liftoff-tool-gateway__slack-d77db9a0__send_message')).toBe(true);
    // A remote vendor MCP server: legitimately absent from our catalog, must NOT be
    // treated as a defect or every vendor-MCP call fails.
    expect(isOwnGatewayTool('mcp__some-vendor-server__do_thing')).toBe(false);
    expect(isOwnGatewayTool('unknown__vendor_mcp_tool')).toBe(false);
    expect(isOwnGatewayTool('corpus_search')).toBe(false);
  });
});

describe('vendor MCP tools, which the adapter stores alias-qualified', () => {
  // Two catalogs, two conventions. The gateway catalog stores the bare `<tool>`,
  // so normalizeToolName strips the SDK prefix AND the server segment. The
  // adapter's vendor-MCP enumeration stores `<alias>__<tool>`, which neither the
  // raw call name nor the fully bare name matches.
  //
  // A miss reads as an unknown tool, unknown fails closed, and on an
  // untrusted-inbound run that turns a server's declared read-only search into
  // an approval card.
  const adapterCatalog = [
    { name: 'custom-mcp-d144a7ea__search_articles', effect: 'read' as const },
    { name: 'custom-mcp-d144a7ea__get_article', effect: 'read' as const },
  ];

  it('resolves an alias-qualified entry from the SDK call name', () => {
    const hit = resolveCatalogTool('mcp__custom-mcp-d144a7ea__search_articles', adapterCatalog);
    expect(hit?.name).toBe('custom-mcp-d144a7ea__search_articles');
    expect(hit?.effect).toBe('read');
  });

  it('resolves every tool on the same server, not just the first', () => {
    expect(resolveCatalogTool('mcp__custom-mcp-d144a7ea__get_article', adapterCatalog)?.name)
      .toBe('custom-mcp-d144a7ea__get_article');
  });

  it('still resolves a catalog that stores the bare name', () => {
    // The gateway convention, unchanged.
    const bare = [{ name: 'search_articles' }];
    expect(resolveCatalogTool('mcp__custom-mcp-d144a7ea__search_articles', bare)?.name)
      .toBe('search_articles');
  });

  it('prefers an exact match over either fallback', () => {
    const both = [
      { name: 'mcp__custom-mcp-d144a7ea__search_articles', which: 'exact' },
      { name: 'custom-mcp-d144a7ea__search_articles', which: 'alias' },
    ];
    expect(resolveCatalogTool('mcp__custom-mcp-d144a7ea__search_articles', both)?.which).toBe('exact');
  });

  it('still returns undefined when the catalog genuinely lacks the tool', () => {
    // A miss must stay a miss: it is what makes an unknown tool fail closed.
    expect(resolveCatalogTool('mcp__custom-mcp-d144a7ea__delete_everything', adapterCatalog)).toBeUndefined();
  });
});

describe('sdkCallNameFor: one call name for every engine', () => {
  // The seams that remember a call the gateway never dispatched parse the SDK
  // form. The bridge's engines call the bare form, and a collapsed server's
  // calls arrive wrapped — so on those engines a vendor write left no ledger
  // row and no provenance verdict, and nothing said so.
  const catalog = {
    tools: [
      { name: 'google-mail-0105297e__create_draft', serverId: 'liftoff-tool-gateway' },
      { name: 'record_step_output', serverId: 'liftoff-tool-gateway' },
      { name: 'github-dd4c4689__pull_request_read', serverId: 'github-dd4c4689' },
      { name: 'search_github_dd4c4689_tools', serverId: 'github-dd4c4689' },
      { name: 'call_github_dd4c4689_tool', serverId: 'github-dd4c4689' },
    ],
    deferredVendorTools: new Map([[
      'github-dd4c4689',
      [{ name: 'github-dd4c4689__pull_request_review_write', serverId: 'github-dd4c4689' }],
    ]]),
  };

  it('prefixes our own gateway tools with the gateway server, so the seams skip them', () => {
    // The gateway judged, recorded and ledgered these inside execute(). By
    // bare name, `google-mail-0105297e__create_draft` and a vendor tool are the
    // same shape; only the catalog says whose it is.
    expect(sdkCallNameFor(catalog, 'google-mail-0105297e__create_draft', { thread_id: 't' }))
      .toEqual({ toolName: 'mcp__liftoff-tool-gateway__google-mail-0105297e__create_draft', args: { thread_id: 't' } });
    expect(isOwnGatewayTool(sdkCallNameFor(catalog, 'record_step_output', {}).toolName)).toBe(true);
  });

  it('prefixes a vendor tool into the form the Anthropic engine already calls', () => {
    expect(sdkCallNameFor(catalog, 'github-dd4c4689__pull_request_read', { pullNumber: 1 }))
      .toEqual({ toolName: 'mcp__github-dd4c4689__pull_request_read', args: { pullNumber: 1 } });
  });

  it('unwraps a collapsed server\'s call to the tool it actually ran, with its own arguments', () => {
    // The event stream sees the wrapper; the review was written by the tool
    // named inside it, and it is THAT call the ledger has to remember.
    const wrapped = sdkCallNameFor(catalog, 'call_github_dd4c4689_tool', {
      name: 'github-dd4c4689__pull_request_review_write',
      args: { method: 'create', owner: 'acme', repo: 'api', pullNumber: 123 },
    });
    expect(wrapped).toEqual({
      toolName: 'mcp__github-dd4c4689__pull_request_review_write',
      args: { method: 'create', owner: 'acme', repo: 'api', pullNumber: 123 },
    });
  });

  it('reaches a ledgerable target from the wrapper form, end to end', () => {
    // The chain the wire path never completed: wrapper → SDK form → parsed
    // vendor call → a target ref `have_i_acted_on` can look up.
    const { parseVendorToolName } = jest.requireActual<typeof import('../../action-ledger/record-external-tool-call')>('../../action-ledger/record-external-tool-call');
    const { deriveTarget } = jest.requireActual<typeof import('../../action-ledger/target-ref')>('../../action-ledger/target-ref');
    const external = sdkCallNameFor(catalog, 'call_github_dd4c4689_tool', {
      name: 'github-dd4c4689__pull_request_review_write',
      args: { method: 'create', owner: 'acme', repo: 'api', pullNumber: 123 },
    });
    const parsed = parseVendorToolName(external.toolName);
    expect(parsed).toEqual({ connector: 'github-dd4c4689', actionType: 'pull_request_review_write' });
    const target = deriveTarget({ connector: parsed!.connector, actionType: parsed!.actionType, payload: external.args ?? {} });
    expect(target.ref).toBeTruthy();
  });

  it('unwraps a call that names the tool by its VENDOR name, as the bridge also accepts', () => {
    // The bridge matches `c.name === wanted || c.remoteToolName === wanted`.
    // A resolver that matched only the first left a valid call — one that
    // executed — invisible to the ledger and the recorder.
    const withRemote = {
      ...catalog,
      deferredVendorTools: new Map([[
        'github-dd4c4689',
        [{ name: 'github-dd4c4689__pull_request_review_write', remoteToolName: 'pull_request_review_write', serverId: 'github-dd4c4689' }],
      ]]),
    };
    expect(sdkCallNameFor(withRemote, 'call_github_dd4c4689_tool', { name: 'pull_request_review_write', args: { pullNumber: 1 } }))
      .toEqual({ toolName: 'mcp__github-dd4c4689__pull_request_review_write', args: { pullNumber: 1 } });
  });

  it('resolves an ordinary name that lives only in the deferred list', () => {
    // The bridge unwraps the call and re-dispatches it AS the inner tool, so
    // the gate is handed the inner name — against the catalog the run started
    // with, where the tool was never promoted into `tools`.
    expect(sdkCallNameFor(catalog, 'github-dd4c4689__pull_request_review_write', { pullNumber: 1 }).toolName)
      .toBe('mcp__github-dd4c4689__pull_request_review_write');
  });

  it('searches only the wrapper\'s own server, the way the bridge resolves it', () => {
    const two = {
      ...catalog,
      deferredVendorTools: new Map([
        ['github-dd4c4689', [{ name: 'github-dd4c4689__issue_write', remoteToolName: 'issue_write', serverId: 'github-dd4c4689' }]],
        ['linear-0badf00d', [{ name: 'linear-0badf00d__issue_write', remoteToolName: 'issue_write', serverId: 'linear-0badf00d' }]],
      ]),
    };
    expect(sdkCallNameFor(two, 'call_linear_0badf00d_tool', { name: 'issue_write', args: {} }).toolName)
      .toBe('mcp__linear-0badf00d__issue_write');
  });

  it('leaves a search wrapper alone — it is a lookup, not an action', () => {
    expect(sdkCallNameFor(catalog, 'search_github_dd4c4689_tools', { query: 'pull request' }).toolName)
      .toBe('search_github_dd4c4689_tools');
  });

  it('leaves the SDK form, an unknown name, and a missing catalog alone', () => {
    expect(sdkCallNameFor(catalog, 'mcp__github-dd4c4689__pull_request_read', { a: 1 }))
      .toEqual({ toolName: 'mcp__github-dd4c4689__pull_request_read', args: { a: 1 } });
    expect(sdkCallNameFor(catalog, 'web_search', { q: 'x' }).toolName).toBe('web_search');
    expect(sdkCallNameFor(undefined, 'github-dd4c4689__pull_request_read', undefined).toolName)
      .toBe('github-dd4c4689__pull_request_read');
  });
});

// The dispatcher routes on the connector it reads off the first `__`, and a
// pseudo-connector segment is that route. So the name it needs has only the
// SDK wrapper removed — which is a different answer from the catalog name
// normalizeToolName recovers.
describe('dispatchNameFor: the wrapper off, the route left on', () => {
  it('strips only the SDK wrapper from a standard tool', () => {
    expect(dispatchNameFor('mcp__liftoff-tool-gateway__run_capability')).toBe('run_capability');
  });

  it('keeps a connector alias for the split', () => {
    expect(dispatchNameFor('mcp__liftoff-tool-gateway__google-mail-0105297e__send_email'))
      .toBe('google-mail-0105297e__send_email');
  });

  it('keeps a pseudo-connector segment, where normalizeToolName drops it', () => {
    const wrapped = 'mcp__liftoff-tool-gateway__agent_slack__slack_send_message';
    expect(dispatchNameFor(wrapped)).toBe('agent_slack__slack_send_message');
    expect(normalizeToolName(wrapped)).toBe('slack_send_message');
  });

  it('passes an unwrapped name through unchanged', () => {
    expect(dispatchNameFor('run_capability')).toBe('run_capability');
    expect(dispatchNameFor('gmail__send_email')).toBe('gmail__send_email');
    expect(dispatchNameFor('agent_slack__slack_send_message')).toBe('agent_slack__slack_send_message');
  });

  it('returns a malformed wrapper as-is rather than inventing a name', () => {
    expect(dispatchNameFor('mcp__nosecondseparator')).toBe('mcp__nosecondseparator');
  });
});
