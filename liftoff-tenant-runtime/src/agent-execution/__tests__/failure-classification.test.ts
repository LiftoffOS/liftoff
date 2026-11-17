import { classifyFailure, isRetryableFailureClass } from '../failure-classification';

describe('classifyFailure', () => {
  // 'transient_infra' used to absorb capacity, provider 5xx and network drops in
  // one value, so the only question it could answer was "retry?". It is still a
  // legal FailureClass for rows written before the split, but nothing produces
  // it any more.
  it('never returns the legacy transient_infra', () => {
    const samples: unknown[] = [
      { status: 429, message: 'Too Many Requests' },
      { status: 503, message: 'Service Unavailable' },
      { status: 529, message: 'Overloaded' },
      new Error('Anthropic API is overloaded'),
      new Error('rate limit exceeded'),
      new Error('socket hang up'),
    ];
    for (const s of samples) {
      expect(classifyFailure(s)).not.toBe('transient_infra');
    }
  });

  it('classifies provider capacity: 429/529 status, overloaded / rate-limit prose', () => {
    expect(classifyFailure({ status: 429, message: 'Too Many Requests' })).toBe('provider_capacity');
    expect(classifyFailure({ status: 529, message: 'Overloaded' })).toBe('provider_capacity');
    expect(classifyFailure(new Error('Anthropic API is overloaded'))).toBe('provider_capacity');
    expect(classifyFailure(new Error('rate limit exceeded'))).toBe('provider_capacity');
    expect(classifyFailure(new Error('ratelimit hit'))).toBe('provider_capacity');
    expect(classifyFailure(new Error('429 too many requests'))).toBe('provider_capacity');
  });

  it('classifies provider server errors on the STRUCTURED status', () => {
    expect(classifyFailure({ status: 500, message: 'oops' })).toBe('provider_server_error');
    expect(classifyFailure({ status: 502, message: 'oops' })).toBe('provider_server_error');
    expect(classifyFailure({ status: 503, message: 'Service Unavailable' })).toBe('provider_server_error');
    expect(classifyFailure({ status: 504, message: 'oops' })).toBe('provider_server_error');
    expect(classifyFailure(new Error('Internal server error from the model'))).toBe('provider_server_error');
  });

  // A 5xx in prose is more often a connector's upstream than our model
  // provider's, and tool_error has owned that shape since migration 308.
  it('leaves a bare 5xx in a message to tool_error', () => {
    expect(classifyFailure(new Error('upstream returned 502'))).toBe('tool_error');
  });

  it('classifies provider network drops', () => {
    expect(classifyFailure(new Error('socket hang up'))).toBe('provider_network');
    expect(classifyFailure(new Error('read ECONNRESET'))).toBe('provider_network');
    expect(classifyFailure(new Error('getaddrinfo EAI_AGAIN api.anthropic.com'))).toBe('provider_network');
    expect(classifyFailure(new TypeError('fetch failed'))).toBe('provider_network');
  });

  it('classifies provider auth — never retryable', () => {
    expect(classifyFailure({ status: 401, message: 'nope' })).toBe('provider_auth');
    expect(classifyFailure({ status: 403, message: 'nope' })).toBe('provider_auth');
    expect(classifyFailure(new Error('invalid_api_key'))).toBe('provider_auth');
    expect(classifyFailure(new Error('authentication_error: bad key'))).toBe('provider_auth');
    expect(classifyFailure(new Error('401 Unauthorized'))).toBe('provider_auth');
  });

  it('classifies provider quota — never retryable', () => {
    expect(classifyFailure({ status: 402, message: 'nope' })).toBe('provider_quota');
    expect(classifyFailure(new Error('insufficient_quota for this organization'))).toBe('provider_quota');
    expect(classifyFailure(new Error('Your credit balance is too low'))).toBe('provider_quota');
  });

  // The whole reason for the guarded status matching: a count is not a status
  // code, and reading one as auth or quota stops a run PERMANENTLY on an error
  // a retry would have cleared. Both halves of the guard are exercised here —
  // the digit boundary (a code buried in a longer number) and the context marker
  // (a bare code that is really a count).
  it('does not read a status code out of the middle of a longer number', () => {
    expect(classifyFailure(new Error('prompt used 402913 tokens of budget'))).not.toBe('provider_quota');
    expect(classifyFailure(new Error('sent 4012 messages'))).not.toBe('provider_auth');
    expect(classifyFailure(new Error('processed 14295 rows'))).not.toBe('provider_capacity');
  });

  it('does not read a bare count as a status code', () => {
    expect(classifyFailure(new Error('processed 401 records'))).toBe('unknown');
    expect(classifyFailure(new Error('skipped 402 rows for this batch'))).toBe('unknown');
    expect(classifyFailure(new Error('enqueued 429 follow-up tasks'))).toBe('unknown');
    expect(classifyFailure(new Error('summarised 403 conversations'))).toBe('unknown');
  });

  it('reads a status code when the message says it is one', () => {
    expect(classifyFailure(new Error('401 Unauthorized'))).toBe('provider_auth');
    expect(classifyFailure(new Error('HTTP 403 from the model endpoint'))).toBe('provider_auth');
    expect(classifyFailure(new Error('status: 429 — slow down'))).toBe('provider_capacity');
    expect(classifyFailure(new Error('Error 402: please add a payment method'))).toBe('provider_quota');
    expect(classifyFailure(new Error('the provider returned 529'))).toBe('provider_capacity');
  });

  // Our own subsystems are called "billing"; their failures are ours to retry,
  // not a customer's balance to top up.
  it('does not read our own billing subsystem as a customer quota problem', () => {
    expect(classifyFailure(new Error('billing publish failed'))).not.toBe('provider_quota');
    expect(classifyFailure(new Error('billing event write timed out'))).not.toBe('provider_quota');
  });

  it('classifies context_overflow, which retries only on a fresh session', () => {
    expect(classifyFailure(new Error('prompt is too long: 210000 tokens'))).toBe('context_overflow');
    expect(classifyFailure(new Error('maximum context length exceeded'))).toBe('context_overflow');
    expect(classifyFailure(new Error('context window is full'))).toBe('context_overflow');
  });

  it('classifies timeout: AbortError name + wall-clock / turn-timeout / timed-out messages', () => {
    const abort = new Error('aborted'); abort.name = 'AbortError';
    expect(classifyFailure(abort)).toBe('timeout');
    expect(classifyFailure(new Error('wall_clock_exceeded'))).toBe('timeout');
    expect(classifyFailure(new Error('turn timeout after 240s'))).toBe('timeout');
    expect(classifyFailure(new Error('request timed out'))).toBe('timeout');
  });

  it('classifies tool_error: ToolExecutionError, connector failure', () => {
    expect(classifyFailure(new Error('ToolExecutionError: gmail send failed'))).toBe('tool_error');
    expect(classifyFailure(new Error('connector salesforce failed'))).toBe('tool_error');
  });

  it('classifies validation: schema / zod / invalid input', () => {
    expect(classifyFailure(new Error('schema validation failed'))).toBe('validation');
    expect(classifyFailure(new Error('zod parse error'))).toBe('validation');
    expect(classifyFailure(new Error('invalid input for tool'))).toBe('validation');
    expect(classifyFailure(new Error('invalid argument'))).toBe('validation');
  });

  it('classifies agent_declined: declined / no action / nothing to do', () => {
    expect(classifyFailure(new Error('agent declined to act'))).toBe('agent_declined');
    expect(classifyFailure(new Error('no action required'))).toBe('agent_declined');
    expect(classifyFailure(new Error('nothing to do here'))).toBe('agent_declined');
  });

  it('falls back to unknown for unmatched errors and non-Error inputs', () => {
    expect(classifyFailure(new Error('something weird happened'))).toBe('unknown');
    expect(classifyFailure('a bare string with no signal')).toBe('unknown');
    expect(classifyFailure(null)).toBe('unknown');
    expect(classifyFailure(undefined)).toBe('unknown');
  });

  // Auth and quota lead the chain because retrying either is actively wrong:
  // the same rejected credential goes back out, or the same empty balance is
  // spent against.
  it('precedence: a never-retryable class wins over a retryable-looking message', () => {
    expect(classifyFailure({ status: 401, message: 'overloaded, timed out' })).toBe('provider_auth');
    expect(classifyFailure({ status: 402, message: 'rate limit exceeded' })).toBe('provider_quota');
    expect(classifyFailure({ status: 429, message: 'timed out waiting for rate limit' })).toBe('provider_capacity');
  });
});

// ── Prose that borrows a network failure's words ─────────────────────────────
//
// An agent narrating a DOWN CONNECTOR writes the same words undici
// throws for a genuine socket failure, and the difference matters twice over: a
// connector outage mislabelled provider_network reads wrong to an operator, and
// it is marked retryable, so the run is re-attempted against an integration that
// is still down.
describe('classifyFailure — a connector outage is not a provider network drop', () => {
  it.each([
    'Google Sheets integration is unreachable (all API calls return "fetch failed").',
    'Google Sheets integration is currently inaccessible ("fetch failed" on all read/write attempts).',
    'The Slack connector returned a network error on every attempt.',
  ])('does not call it provider_network: %s', (m) => {
    expect(classifyFailure(new Error(m))).not.toBe('provider_network');
  });

  it('still catches a REAL provider network drop', () => {
    // errno-style tokens stand alone — no agent narrates an ECONNRESET.
    expect(classifyFailure(new Error('read ECONNRESET'))).toBe('provider_network');
    expect(classifyFailure(new Error('socket hang up'))).toBe('provider_network');
    // And bare prose with no integration named is still a provider drop.
    expect(classifyFailure(new TypeError('fetch failed'))).toBe('provider_network');
  });

  it('leaves the deterministic failures unretryable', () => {
    for (const m of [
      'column "tenant_id" of relation "workflow_escalations" does not exist',
      'insert or update on table "workflow_escalations" violates foreign key constraint',
      'Claude Code executable not found at /app/node_modules/@anthropic-ai/claude-agent-sdk/cli.js',
      '400 claude-sonnet-4-6 is not a valid model ID',
    ]) {
      expect(isRetryableFailureClass(classifyFailure(new Error(m)))).toBe(false);
    }
  });
});

// ── Somebody else's failure, wearing our status codes ────────────────────────
//
// Found by driving a real agent against a tool that a governance gate denies.
// The gateway puts its OWN status code in the message, and the provider rules
// key on status codes — so a gate doing its job read as our model-provider
// rejecting a credential. The retry outcome was already safe (auth is never
// retried); what was wrong was the label, and a label that sends an operator to
// rotate a working key is worse than no label.
describe('classifyFailure — a tool-gateway failure is not a provider failure', () => {
  it('classifies a governance denial relayed by the gateway as a tool error', () => {
    const real = 'Error: TOOL_ERROR {"error":"tool-gateway execute failed: HTTP 403 '
      + '{\\"error\\":\\"Governance authorize denied: decision=HITL_REQUIRED\\"}"}';
    expect(classifyFailure(new Error(real))).toBe('tool_error');
    expect(isRetryableFailureClass(classifyFailure(new Error(real)))).toBe(false);
  });

  it.each([
    'tool-gateway execute failed: HTTP 401 unauthorized',
    'TOOL_ERROR {"error":"HTTP 429 rate limited by the connector"}',
    'ToolExecutionError: HTTP 500 from the upstream',
    'MCP server returned HTTP 403',
  ])('does not read a gateway status as a provider one: %s', (m) => {
    expect(classifyFailure(new Error(m))).toBe('tool_error');
  });

  // The provider's OWN errors must still classify — the guard is about who
  // owns the failure, not about the presence of a status code.
  it('still classifies a genuine provider failure', () => {
    expect(classifyFailure({ status: 401, message: 'nope' })).toBe('provider_auth');
    expect(classifyFailure(new Error('401 Unauthorized'))).toBe('provider_auth');
    expect(classifyFailure(new Error('status: 429 — slow down'))).toBe('provider_capacity');
  });
});

// Production's most common tool failure, by count. It was landing in 'unknown',
// which reads as "nobody has classified this yet" and hides a failure whose
// cause is stated in its own message.
describe('classifyFailure — a repeatedly-failing tool names itself', () => {
  it.each([
    'Tool call repeatedly failing (3x): __builtin:search__search — Agent has no binding for connector "__builtin:search"',
    "Tool call repeatedly failing (3x): __builtin:search__search — Permission denied: Connector '__builtin:search'",
  ])('classifies it tool_error, not unknown: %s', (m) => {
    expect(classifyFailure(new Error(m))).toBe('tool_error');
    expect(isRetryableFailureClass(classifyFailure(new Error(m)))).toBe(false);
  });
});

// ── The structured taxonomy leads; the prose path stays as the fallback ──────
//
// classifyFailure is ~90 lines of regex over error_message, and three commits in
// one day patched misfires in it. Where a provider hands us a structured
// failure, that decides — the regexes only run when there is nothing better.
describe('classifyFailure with a structured provider failure', () => {
  it.each([
    ['auth', 'provider_auth'],
    ['quota', 'provider_quota'],
    ['rate_limit', 'provider_capacity'],
    ['overloaded', 'provider_capacity'],
    ['server_error', 'provider_server_error'],
    ['network', 'provider_network'],
    ['invalid_request', 'validation'],
    ['refusal', 'agent_declined'],
    ['safety', 'agent_declined'],
    ['malformed_response', 'provider_server_error'],
  ] as const)('%s → %s', (kind, expected) => {
    expect(classifyFailure(new Error('anything at all'), { kind })).toBe(expected);
  });

  // The evidence beats the prose. This message would read as a clean success to
  // every regex in the function.
  it('overrides a message the regexes would classify differently', () => {
    expect(classifyFailure(new Error('all good here'), { kind: 'quota' })).toBe('provider_quota');
  });

  // 'unknown' means the engine had nothing structured to read, not that the
  // failure is unclassifiable. Recording it as a classification would throw away
  // the prose evidence we do have.
  it('falls through to the prose path on an unknown kind', () => {
    expect(classifyFailure(new Error('401 Unauthorized'), { kind: 'unknown' })).toBe('provider_auth');
  });

  it('falls through to the prose path when no failure was captured', () => {
    expect(classifyFailure(new Error('429 Too Many Requests'))).toBe('provider_capacity');
  });

  // A governance denial is not a provider failure, and that stays true however
  // confident the taxonomy is about the status code the denial carried.
  it("still yields to somebody else's failure", () => {
    const toolGatewayDenial = new Error(
      'TOOL_ERROR {"error":"tool-gateway execute failed: HTTP 403 (Governance authorize denied)"}',
    );
    expect(classifyFailure(toolGatewayDenial, { kind: 'auth', status: 403 })).toBe('tool_error');
  });
});

// ── adapter_internal ─────────────────────────────────────────────────────────
//
// For example `item.content.map is not a function` — a TypeError thrown inside
// the OpenAI SDK when our adapter hands it an assistant item whose `content` is
// a string. No provider is involved, so nothing carries a status or an error
// type, and without this bucket it classifies as `unknown`: the bucket that is
// supposed to mean "nobody has looked at this yet".
describe('classifyFailure: a runtime fault is our bug, not a provider failure', () => {
  it('classifies a thrown TypeError as adapter_internal, not unknown', () => {
    const err = new TypeError('item.content.map is not a function');
    expect(classifyFailure(err)).toBe('adapter_internal');
  });

  it('classifies the other JS runtime constructors the same way', () => {
    expect(classifyFailure(new RangeError('out of range'))).toBe('adapter_internal');
    expect(classifyFailure(new ReferenceError('x is not defined'))).toBe('adapter_internal');
  });

  it('does NOT treat a generic Error as a runtime fault', () => {
    // Every SDK throws bare Errors deliberately; reading those as our bug would
    // swallow real provider failures.
    expect(classifyFailure(new Error('Provider overloaded'))).not.toBe('adapter_internal');
  });

  it('does not let a runtime fault message be blamed on a vendor', () => {
    // The regex block below would otherwise match 'connection' in a stack-trace
    // message and answer provider_network for a bug of ours.
    const err = new TypeError("Cannot read properties of undefined (reading 'connection')");
    expect(classifyFailure(err)).toBe('adapter_internal');
  });

  it('a governance denial still wins, even wrapped in a TypeError', () => {
    // isSomeoneElsesFailure is checked first and stays first: a gate doing its
    // job is not an adapter defect.
    const err = new TypeError('TOOL_ERROR {"error":"Governance authorize denied"}');
    expect(classifyFailure(err)).toBe('tool_error');
  });

  it('is never auto-retried — the same input reproduces it', () => {
    expect(isRetryableFailureClass('adapter_internal')).toBe(false);
  });
});

// The boundary that the constructor alone gets wrong. Node's fetch throws a
// TypeError for a genuine network drop, so `name === 'TypeError'` cannot mean
// "our bug" on its own — it would mislabel an outage AND suppress the retry
// that recovers from it.
describe('adapter_internal vs a transport failure wearing a TypeError', () => {
  it('leaves undici transport TypeErrors to the transport patterns', () => {
    expect(classifyFailure(new TypeError('fetch failed'))).toBe('provider_network');
  });

  it('a transport TypeError the patterns do not name stays unknown, not our bug', () => {
    // `TypeError: terminated` (undici, response stream died) has no pattern in
    // the block below, so it classifies as `unknown` — and that is the honest
    // answer. It was `unknown` before this change too. What matters is that it
    // does NOT become `adapter_internal`: accusing our own code because a
    // stream dropped would put a provider incident on the defect list.
    expect(classifyFailure(new TypeError('terminated'))).toBe('unknown');
  });

  it('keeps those retryable', () => {
    expect(isRetryableFailureClass(classifyFailure(new TypeError('fetch failed')))).toBe(true);
  });

  it('still calls a genuine adapter TypeError our bug', () => {
    expect(classifyFailure(new TypeError('item.content.map is not a function')))
      .toBe('adapter_internal');
  });
});
