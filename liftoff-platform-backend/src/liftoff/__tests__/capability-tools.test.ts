import { runCapabilitySearch, runCapability } from '../capability-tools';
import { discoverCapabilities } from '../../capability-discovery';
import type { DiscoveryResult, ScoredCandidate, CapabilitySpec } from '../../capability-discovery';
import {
  executeVendorTool,
  capabilityRequiresApproval,
  capabilityIsAffirmativeRead,
} from '../../capability-discovery/vendor-execution';
import { _clearCapabilityHandles, resolveCapabilityHandle } from '../../capability-discovery/handles';
import { fetchConnectorFunctions } from '../../connectors/connector-type-registry';
import { apifyPlatformConfigured, fetchApifyActorInputFields, fetchApifyActorInputSchema } from '../../capability-discovery/apify-executor';
import { resolveCredentialMap } from '../../capability-discovery/credential-scope';
import { isCooling } from '../../capability-discovery/vendor-gate';

jest.mock('../../infrastructure/logging', () => ({
  log: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.mock('../../capability-discovery', () => ({ discoverCapabilities: jest.fn() }));
jest.mock('../../connectors/connector-type-registry', () => ({
  fetchRegistry: jest.fn().mockResolvedValue(new Map()),
  fetchConnectorFunctions: jest.fn().mockResolvedValue([]),
}));
jest.mock('../../capability-discovery/vendor-execution', () => ({
  executeVendorTool: jest.fn(),
  // Classifies a candidate's approval class at mint time; default to read so the
  // existing vendor-hiding assertions see an ordinary (cap_r.) handle.
  capabilityRequiresApproval: jest.fn().mockResolvedValue(false),
  // Affirmatively a read, by default, so tails form; the cases that care set it.
  capabilityIsAffirmativeRead: jest.fn().mockResolvedValue(true),
}));
jest.mock('../../capability-discovery/apify-executor', () => ({
  apifyPlatformConfigured: jest.fn().mockReturnValue(false),
  fetchApifyActorInputFields: jest.fn().mockResolvedValue([]),
  fetchApifyActorInputSchema: jest.fn().mockResolvedValue(null),
}));
jest.mock('../../capability-discovery/credential-scope', () => ({
  resolveCredentialMap: jest.fn(),
  credentialCooling: jest.requireActual('../../capability-discovery/credential-scope').credentialCooling,
}));
jest.mock('../../capability-discovery/vendor-gate', () => ({
  isCooling: jest.fn().mockReturnValue(false),
}));
const mockCreateDataset = jest.fn();
const mockAppendRecords = jest.fn();
jest.mock('../../datasets/store', () => ({
  createDataset: (...a: unknown[]) => mockCreateDataset(...a),
  appendRecords: (...a: unknown[]) => mockAppendRecords(...a),
}));

const mockDiscover = discoverCapabilities as jest.MockedFunction<typeof discoverCapabilities>;
const mockExecute = executeVendorTool as jest.MockedFunction<typeof executeVendorTool>;
const mockRequiresApproval = capabilityRequiresApproval as jest.MockedFunction<typeof capabilityRequiresApproval>;
const mockReadOnly = capabilityIsAffirmativeRead as jest.MockedFunction<typeof capabilityIsAffirmativeRead>;
const mockFunctions = fetchConnectorFunctions as jest.MockedFunction<typeof fetchConnectorFunctions>;
const mockApifyOn = apifyPlatformConfigured as jest.MockedFunction<typeof apifyPlatformConfigured>;
const mockApifyFields = fetchApifyActorInputFields as jest.MockedFunction<typeof fetchApifyActorInputFields>;
const mockApifySchema = fetchApifyActorInputSchema as jest.MockedFunction<typeof fetchApifyActorInputSchema>;
const mockCredentials = resolveCredentialMap as jest.MockedFunction<typeof resolveCredentialMap>;
const mockIsCooling = isCooling as jest.MockedFunction<typeof isCooling>;

const SPEC = { mode: 'public_data', requiredOutputFields: [] } as unknown as CapabilitySpec;

const OK_VERDICT = { capabilityMatch: 3, inputSupplyable: 'yes', outputCovers: 'yes', shapeMatch: true, reason: 'best fit for TikTok posts via TikHub' } as const;

function vendorCandidate(overrides: Partial<ScoredCandidate> = {}): ScoredCandidate {
  return {
    source: 'connector_registry',
    sourceRef: 'tikhub:tiktok_fetch_user',
    title: 'TikHub — tiktok_fetch_user',
    description: 'TikHub TikTok API',
    mode: 'public_data',
    inputSchema: { type: 'object', properties: { uniqueId: { type: 'string' } } },
    connectorType: 'tikhub',
    capabilityBucket: 'social_media',
    judge: { ...OK_VERDICT },
    route: 'platform_vendor',
    evidence: null,
    finalScore: 2.4,
    ...overrides,
  };
}

function storeCandidate(actorId: string, overrides: Partial<ScoredCandidate> = {}): ScoredCandidate {
  return {
    source: 'apify_store',
    sourceRef: actorId,
    title: actorId,
    description: 'a store actor',
    mode: 'public_data',
    judge: { ...OK_VERDICT, reason: 'scrapes the posts' },
    route: 'blueprint',
    evidence: null,
    finalScore: 1.9,
    ...overrides,
  };
}

function nativeCandidate(): ScoredCandidate {
  return {
    source: 'native_tool',
    sourceRef: 'web_research',
    title: 'web_research',
    description: 'platform research',
    mode: 'public_data',
    judge: { capabilityMatch: 2, inputSupplyable: 'yes', outputCovers: 'partial', shapeMatch: true, reason: 'general web research' },
    route: 'native_tool',
    evidence: null,
    finalScore: 1.5,
  };
}

function result(candidates: ScoredCandidate[], spec: CapabilitySpec = SPEC): DiscoveryResult {
  return { spec, candidates, degraded: false };
}

/** Every capabilityId in a rendering, in order. */
function capabilityIds(searchOutput: string): string[] {
  return [...searchOutput.matchAll(/capabilityId: (cap_[A-Za-z0-9_.-]+)/g)].map((m) => m[1]);
}

/** Pull the first capabilityId out of a capability_search rendering, asserting
 *  one is present — keeps the cases free of non-null assertions. */
function firstCapabilityId(searchOutput: string): string {
  const ids = capabilityIds(searchOutput);
  expect(ids.length).toBeGreaterThan(0);
  return ids[0] ?? '';
}

/** The tail of a handle, as references, read the way run_capability reads it. */
function tailOf(id: string): string[] {
  return (resolveCapabilityHandle(id)?.fallbacks ?? []).map((e) => e.ref);
}

const platformCredentials = (type: string) => ({ connectorId: null, credentialRef: `internal:${type}` });

beforeEach(() => {
  jest.clearAllMocks();
  _clearCapabilityHandles();
  mockRequiresApproval.mockResolvedValue(false);
  mockReadOnly.mockResolvedValue(true);
  mockFunctions.mockResolvedValue([]);
  mockApifyOn.mockReturnValue(false);
  mockApifyFields.mockResolvedValue([]);
  mockApifySchema.mockResolvedValue(null);
  mockIsCooling.mockReturnValue(false);
  mockCredentials.mockResolvedValue(platformCredentials);
});

describe('capability_search hides the vendor', () => {
  it('returns opaque capabilityId handles, never a vendor name or connector type', async () => {
    mockDiscover.mockResolvedValue(result([vendorCandidate(), nativeCandidate()]));
    const out = await runCapabilitySearch('t1', { operation: 'fetch posts', entity: 'posts', mode: 'public_data' });

    expect(out).toMatch(/capabilityId: cap_/);
    expect(out.toLowerCase()).not.toContain('tikhub'); // vendor scrubbed
    expect(out).not.toContain('connectorType');
    expect(out).toContain('tiktok fetch user'); // action label (function name, brand-free)
    expect(out).toContain('args: uniqueId'); // arg names surfaced
    expect(out).toContain('web_research'); // native tool listed as "already have"
    expect(out).toContain('a data source'); // "TikHub" inside the reason was scrubbed
    expect(out).toContain('[Social media data]'); // vendor-agnostic capability label from the tree
  });
});

// The search judges each vendor on the credential THIS caller's run would use:
// the map is resolved once, from the account the caller supplied, and handed to
// discovery as the cooling predicate over the credential's key.
describe('capability_search is credential-aware', () => {
  it('resolves the caller\'s credentials once and hands discovery a cooling predicate keyed by them', async () => {
    mockCredentials.mockResolvedValue((type) => (type === 'apify'
      ? { connectorId: null, credentialRef: 'internal:apify' }
      : { connectorId: 'conn-9', credentialRef: 'connector:conn-9' }));
    mockIsCooling.mockImplementation((ref) => ref === 'connector:conn-9');
    mockDiscover.mockResolvedValue(result([vendorCandidate()]));

    await runCapabilitySearch('t1', { operation: 'x', entity: 'y', mode: 'public_data' }, 'acct-1');

    expect(mockCredentials).toHaveBeenCalledTimes(1);
    expect(mockCredentials).toHaveBeenCalledWith('t1', 'acct-1');
    const opts = mockDiscover.mock.calls[0][1] as { vendorCooling: (t: string) => boolean };
    expect(opts.vendorCooling('tikhub')).toBe(true); // the workspace connector is parked
    expect(opts.vendorCooling('apify')).toBe(false); // the platform account is not
  });

  it('with no account, judges every vendor on the platform credential', async () => {
    mockDiscover.mockResolvedValue(result([vendorCandidate()]));
    await runCapabilitySearch('t1', { operation: 'x', entity: 'y', mode: 'public_data' });
    expect(mockCredentials).toHaveBeenCalledWith('t1', undefined);
    const opts = mockDiscover.mock.calls[0][1] as { vendorCooling: (t: string) => boolean };
    mockIsCooling.mockImplementation((ref) => ref === 'internal:tikhub');
    expect(opts.vendorCooling('tikhub')).toBe(true);
  });
});

describe('run_capability resolves the opaque handle to the underlying vendor', () => {
  it('executes the underlying vendor tool with the account threaded, returns content', async () => {
    mockDiscover.mockResolvedValue(result([vendorCandidate()]));
    const search = await runCapabilitySearch('t1', { operation: 'fetch posts', entity: 'posts', mode: 'public_data' });
    const id = firstCapabilityId(search);

    mockExecute.mockResolvedValue({ success: true, content: '{"items":[{"video":"x"}]}', structuredContent: { items: [{ video: 'x' }] } });
    const run = await runCapability('t1', 'acct1', { capabilityId: id, args: { uniqueId: 'nasa' } });

    expect(mockExecute).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: 't1', accountId: 'acct1', connectorType: 'tikhub', toolName: 'tiktok_fetch_user', args: { uniqueId: 'nasa' } }),
    );
    expect(run).toEqual({ ok: true, empty: false, text: expect.stringContaining('items') });
  });

  it('refuses an unknown or expired capabilityId without executing anything', async () => {
    const run = await runCapability('t1', 'acct1', { capabilityId: 'cap_bogus', args: {} });
    expect(run).toMatchObject({ ok: false, kind: 'refused', text: expect.stringMatching(/not valid or has expired/) });
    expect(mockExecute).not.toHaveBeenCalled();
  });
});

// The tail: what a handle carries for the chain to continue with. Only
// actual reads that fit, other vendors first, and nothing for a write.
describe('the tail a handle is minted with', () => {
  const three = () => [
    vendorCandidate({ sourceRef: 'tikhub:a', connectorType: 'tikhub' }),
    vendorCandidate({ sourceRef: 'tikhub:b', connectorType: 'tikhub' }),
    vendorCandidate({ sourceRef: 'strale:c', connectorType: 'strale' }),
    vendorCandidate({ sourceRef: 'nasdaq:d', connectorType: 'nasdaq' }),
  ];

  it('orders other vendors first, in rank order, then the same vendor\'s remaining entries', async () => {
    mockDiscover.mockResolvedValue(result(three()));
    const ids = capabilityIds(await runCapabilitySearch('t1', { operation: 'x', entity: 'y', mode: 'public_data' }));
    expect(tailOf(ids[0])).toEqual(['strale:c', 'nasdaq:d', 'tikhub:b']);
    expect(tailOf(ids[1])).toEqual(['strale:c', 'nasdaq:d', 'tikhub:a']);
    expect(tailOf(ids[2])).toEqual(['tikhub:a', 'tikhub:b', 'nasdaq:d']);
  });

  it('a store actor sits in a tail as apify:run_actor carrying its actor id, and never on the model boundary', async () => {
    mockApifyOn.mockReturnValue(true);
    mockDiscover.mockResolvedValue(result([vendorCandidate({ sourceRef: 'tikhub:a' }), storeCandidate('clockworks/tiktok-scraper')]));
    const out = await runCapabilitySearch('t1', { operation: 'x', entity: 'y', mode: 'public_data' });
    expect(out.toLowerCase()).not.toContain('clockworks');
    const [primary, actor] = capabilityIds(out);
    expect(resolveCapabilityHandle(primary)?.fallbacks).toEqual([{ ref: 'apify:run_actor', presetArgs: { actorId: 'clockworks/tiktok-scraper' } }]);
    expect(resolveCapabilityHandle(actor)?.presetArgs).toEqual({ actorId: 'clockworks/tiktok-scraper' });
    expect(tailOf(actor)).toEqual(['tikhub:a']);
  });

  it('a write-class handle has no tail, and a write is in nobody else\'s tail', async () => {
    mockRequiresApproval.mockImplementation(async (ref) => ref === 'google_mail:send_email');
    mockReadOnly.mockImplementation(async (ref) => ref !== 'google_mail:send_email');
    mockDiscover.mockResolvedValue(result([
      vendorCandidate({ sourceRef: 'google_mail:send_email', connectorType: 'google_mail', mode: 'own_account' }),
      vendorCandidate({ sourceRef: 'google_mail:search_email', connectorType: 'google_mail', mode: 'own_account' }),
    ], { mode: 'own_account', requiredOutputFields: [] } as unknown as CapabilitySpec));
    const [send, search] = capabilityIds(await runCapabilitySearch('t1', { operation: 'send', entity: 'message', mode: 'own_account' }));
    expect(send.startsWith('cap_w.')).toBe(true);
    expect(tailOf(send)).toEqual([]);
    expect(tailOf(search)).toEqual([]);
  });

  // A registry 'write' maps to dataChanges, which the approval gate does not
  // hold — so it mints a cap_r. handle — and it is still not a read.
  it('an unheld registry write is offered as cap_r. yet excluded from every automatic tail, and gets none', async () => {
    mockReadOnly.mockImplementation(async (ref) => ref !== 'google_sheets:append_values');
    mockDiscover.mockResolvedValue(result([
      vendorCandidate({ sourceRef: 'google_sheets:search_spreadsheets', connectorType: 'google_sheets', mode: 'own_account' }),
      vendorCandidate({ sourceRef: 'google_sheets:append_values', connectorType: 'google_sheets', mode: 'own_account' }),
      vendorCandidate({ sourceRef: 'airtable:list_records', connectorType: 'airtable', mode: 'own_account' }),
    ], { mode: 'own_account', requiredOutputFields: [] } as unknown as CapabilitySpec));
    const [search, append, list] = capabilityIds(await runCapabilitySearch('t1', { operation: 'x', entity: 'y', mode: 'own_account' }));
    expect(append.startsWith('cap_r.')).toBe(true);
    expect(tailOf(append)).toEqual([]);
    expect(tailOf(search)).toEqual(['airtable:list_records']);
    expect(tailOf(list)).toEqual(['google_sheets:search_spreadsheets']);
  });

  it('admits only a good fit: capabilityMatch >= 2, shapeMatch, and full output cover when fields are required', async () => {
    mockDiscover.mockResolvedValue(result([
      vendorCandidate({ sourceRef: 'tikhub:a' }),
      vendorCandidate({ sourceRef: 'strale:weak', connectorType: 'strale', judge: { ...OK_VERDICT, capabilityMatch: 1 } }),
      vendorCandidate({ sourceRef: 'nasdaq:shape', connectorType: 'nasdaq', judge: { ...OK_VERDICT, shapeMatch: false } }),
      vendorCandidate({ sourceRef: 'gloria:partial', connectorType: 'gloria', judge: { ...OK_VERDICT, outputCovers: 'partial' } }),
      vendorCandidate({ sourceRef: 'gloria:good', connectorType: 'gloria', judge: { ...OK_VERDICT, capabilityMatch: 2 } }),
    ], { mode: 'public_data', requiredOutputFields: ['url'] } as unknown as CapabilitySpec));
    const ids = capabilityIds(await runCapabilitySearch('t1', { operation: 'x', entity: 'y', mode: 'public_data', requiredOutputFields: ['url'] }));
    expect(tailOf(ids[0])).toEqual(['gloria:good']);
  });

  it('a partial output cover is admitted when the request names no required fields', async () => {
    mockDiscover.mockResolvedValue(result([
      vendorCandidate({ sourceRef: 'tikhub:a' }),
      vendorCandidate({ sourceRef: 'gloria:partial', connectorType: 'gloria', judge: { ...OK_VERDICT, outputCovers: 'partial' } }),
    ]));
    const ids = capabilityIds(await runCapabilitySearch('t1', { operation: 'x', entity: 'y', mode: 'public_data' }));
    expect(tailOf(ids[0])).toEqual(['gloria:partial']);
  });
});

/** A search over `refs`, each candidate's schema in the registry, returning
 *  the primary's handle. `schemas` maps '<type>:<fn>' to its input schema. */
async function searchWith(
  refs: string[],
  schemas: Record<string, unknown> = {},
  requiredOutputFields: string[] = [],
): Promise<string[]> {
  mockFunctions.mockImplementation(async (type) =>
    Object.entries(schemas)
      .filter(([ref]) => ref.startsWith(`${type}:`))
      .map(([ref, inputSchema]) => ({
        name: ref.slice(ref.indexOf(':') + 1), description: '', categories: ['read'],
        inputSchema: inputSchema as { type: 'object'; properties: Record<string, unknown>; required?: string[] },
      })));
  mockDiscover.mockResolvedValue(result(
    refs.map((r) => vendorCandidate({ sourceRef: r, connectorType: r.split(':')[0], inputSchema: schemas[r] })),
    { mode: 'public_data', requiredOutputFields } as unknown as CapabilitySpec,
  ));
  return capabilityIds(await runCapabilitySearch('t1', { operation: 'x', entity: 'y', mode: 'public_data', requiredOutputFields }));
}

const Q_SCHEMA = { type: 'object', properties: { q: { type: 'string' }, limit: { type: 'integer' } }, required: ['q'] };
const KEYWORD_SCHEMA = { type: 'object', properties: { keyword: { type: 'string' }, count: { type: 'integer' } }, required: ['keyword'] };

const failed = (reason = 'primary vendor down') => ({ success: false as const, reason });
const answered = (content = 'backup ok') => ({ success: true as const, content, structuredContent: { items: [{ id: 1 }] } });

// The directed continuation: another candidate runs automatically only when
// the model's arguments fit its COMPLETE schema unchanged; otherwise the model
// is handed the candidate and what it takes.
describe('run_capability continues to the next candidate, safely', () => {
  it('a contract-compatible fallback runs in-call with the same values and no borrowed idempotency key', async () => {
    const [id] = await searchWith(['tikhub:a', 'strale:b'], { 'tikhub:a': Q_SCHEMA, 'strale:b': Q_SCHEMA });
    mockExecute.mockResolvedValueOnce(failed()).mockResolvedValueOnce(answered());
    const run = await runCapability('t1', 'acct1', { capabilityId: id, args: { q: 'shopify', limit: 5 } }, { caller: 'agent', idempotencyKey: 'act-1' });
    expect(mockExecute).toHaveBeenCalledTimes(2);
    expect(mockExecute.mock.calls[0][0]).toMatchObject({ connectorType: 'tikhub', toolName: 'a', idempotencyKey: 'act-1' });
    expect(mockExecute.mock.calls[1][0]).toMatchObject({ connectorType: 'strale', toolName: 'b', args: { q: 'shopify', limit: 5 } });
    expect(mockExecute.mock.calls[1][0]).not.toHaveProperty('idempotencyKey');
    expect(run).toEqual({ ok: true, empty: false, text: 'backup ok' });
  });

  it('a contract-incompatible fallback is a handoff: the hint, a fresh id, and the remainder as its tail', async () => {
    const [id] = await searchWith(['tikhub:a', 'strale:b', 'nasdaq:c'], { 'tikhub:a': Q_SCHEMA, 'strale:b': KEYWORD_SCHEMA, 'nasdaq:c': Q_SCHEMA });
    mockExecute.mockResolvedValueOnce(failed());
    const run = await runCapability('t1', 'acct1', { capabilityId: id, args: { q: 'shopify' } });
    expect(mockExecute).toHaveBeenCalledTimes(1);
    expect(run.ok).toBe(false);
    expect(run.ok === false && run.kind).toBe('handoff');
    expect(run.text).toContain('takes: keyword (string, required), count (integer)');
    expect(run.text).toContain('mapping your values onto those argument names');
    // The leak check reads the prose, not the handle: the handle is opaque
    // ciphertext, so any short digit or letter run can occur inside it.
    const fresh = run.text.match(/capabilityId (cap_[A-Za-z0-9_.-]+)/)?.[1] ?? '';
    expect(fresh).not.toBe('');
    expect(run.text.replace(fresh, '').toLowerCase()).not.toMatch(/tikhub|strale|nasdaq|402|credit|balance/);
    expect(resolveCapabilityHandle(fresh)?.primaryRef).toBe('strale:b');
    expect(tailOf(fresh)).toEqual(['nasdaq:c']);
  });

  it('a vendor already attempted in this call is left out of the handoff\'s tail', async () => {
    const [id] = await searchWith(
      ['tikhub:a', 'strale:b', 'tikhub:d', 'nasdaq:c'],
      { 'tikhub:a': Q_SCHEMA, 'strale:b': KEYWORD_SCHEMA, 'tikhub:d': Q_SCHEMA, 'nasdaq:c': Q_SCHEMA },
    );
    mockExecute.mockResolvedValueOnce(failed());
    const run = await runCapability('t1', 'acct1', { capabilityId: id, args: { q: 'shopify' } });
    const fresh = run.text.match(/capabilityId (cap_[A-Za-z0-9_.-]+)/)?.[1] ?? '';
    expect(tailOf(fresh)).toEqual(['nasdaq:c']); // tikhub:d dropped — tikhub was attempted
  });

  it('a candidate with no complete schema is skipped: nothing runs automatically and nothing is hinted', async () => {
    const [id] = await searchWith(['tikhub:a', 'strale:b', 'nasdaq:c'], { 'tikhub:a': Q_SCHEMA, 'nasdaq:c': Q_SCHEMA });
    mockExecute.mockResolvedValueOnce(failed()).mockResolvedValueOnce(answered('from c'));
    const run = await runCapability('t1', 'acct1', { capabilityId: id, args: { q: 'shopify' } });
    expect(mockExecute.mock.calls.map((c) => c[0].connectorType)).toEqual(['tikhub', 'nasdaq']);
    expect(run).toEqual({ ok: true, empty: false, text: 'from c' });
  });

  it('a candidate whose required arguments do not all fit the hint bound is skipped rather than handed off', async () => {
    const wide = {
      type: 'object',
      properties: Object.fromEntries(Array.from({ length: 14 }, (_, i) => [`r${i}`, { type: 'string' }])),
      required: Array.from({ length: 14 }, (_, i) => `r${i}`),
    };
    const [id] = await searchWith(['tikhub:a', 'strale:wide', 'nasdaq:c'], { 'tikhub:a': Q_SCHEMA, 'strale:wide': wide, 'nasdaq:c': KEYWORD_SCHEMA });
    mockExecute.mockResolvedValueOnce(failed());
    const run = await runCapability('t1', 'acct1', { capabilityId: id, args: { q: 'shopify' } });
    expect(run.ok === false && run.kind).toBe('handoff');
    expect(resolveCapabilityHandle(run.text.match(/capabilityId (cap_[A-Za-z0-9_.-]+)/)?.[1] ?? '')?.primaryRef).toBe('nasdaq:c');
  });

  it('the arguments must fit as they are: a type mismatch or an undeclared name is a handoff, not a coerced run', async () => {
    // The first choice takes `limit` as a string and the continuation
    // candidate as an integer: the model's values fit the one it chose, and
    // the next one is handed over rather than run with a coerced value.
    const LOOSE_LIMIT = { type: 'object', properties: { q: { type: 'string' }, limit: { type: 'string' } }, required: ['q'] };
    const [id] = await searchWith(['tikhub:a', 'strale:b'], { 'tikhub:a': LOOSE_LIMIT, 'strale:b': Q_SCHEMA });
    mockExecute.mockResolvedValueOnce(failed());
    const run = await runCapability('t1', 'acct1', { capabilityId: id, args: { q: 'shopify', limit: '5' } });
    expect(mockExecute).toHaveBeenCalledTimes(1);
    expect(run.ok === false && run.kind).toBe('handoff');
  });

  // A source can enforce a narrower schema than the vendor behind it: a
  // reseller turns a scraper's five TEST cities into a hard enum while the
  // scraper itself takes free text. The routing schema is what that source
  // will accept; the model is never shown it, and every automatic candidate —
  // the first choice included — is checked against it before a call is spent.
  describe('the routing schema decides whether a source is called at all', () => {
    const CITY_ENUM = {
      type: 'object',
      properties: { location: { type: 'string', enum: ['Austin, TX', 'Chicago, IL', 'Los Angeles, CA', 'New York, NY', 'Seattle, WA'] }, page: { type: 'integer' } },
      required: ['location'],
    };
    const ANY_CITY = {
      type: 'object',
      properties: { location: { type: 'string', examples: ['Austin, TX', 'Seattle, WA'] }, page: { type: 'integer' } },
      required: ['location'],
    };

    /** A search whose candidates each carry a model-facing schema and, where
     *  given, the stricter schema the source really enforces. */
    async function searchWithRouting(
      refs: string[],
      schemas: Record<string, { inputSchema: unknown; routingSchema?: unknown }>,
    ): Promise<string[]> {
      mockFunctions.mockImplementation(async (type) =>
        Object.entries(schemas)
          .filter(([ref]) => ref.startsWith(`${type}:`))
          .map(([ref, s]) => ({
            name: ref.slice(ref.indexOf(':') + 1),
            description: '',
            categories: ['read'],
            inputSchema: s.inputSchema as { type: 'object'; properties: Record<string, unknown>; required?: string[] },
            ...(s.routingSchema ? { routingSchema: s.routingSchema as { type: 'object'; properties: Record<string, unknown>; required?: string[] } } : {}),
          })));
      mockDiscover.mockResolvedValue(result(
        refs.map((r) => vendorCandidate({ sourceRef: r, connectorType: r.split(':')[0], inputSchema: schemas[r]?.inputSchema })),
      ));
      return capabilityIds(await runCapabilitySearch('t1', { operation: 'x', entity: 'y', mode: 'public_data', requiredOutputFields: [] }));
    }

    it('skips the FIRST CHOICE without a request when the source would refuse the arguments', async () => {
      // Palo Alto: the model-facing schema takes any string, the source's own
      // takes five cities. Before this, the call went out, came back "HTTP
      // 400 Invalid request" in 126ms, charged nothing, and ended the turn.
      const [id] = await searchWithRouting(['locus:homes', 'strale:b'], {
        'locus:homes': { inputSchema: ANY_CITY, routingSchema: CITY_ENUM },
        'strale:b': { inputSchema: ANY_CITY },
      });
      mockExecute.mockResolvedValueOnce(answered('from strale'));
      const run = await runCapability('t1', 'acct1', { capabilityId: id, args: { location: 'Palo Alto, CA' } });
      // Nothing was dispatched to the source that would have refused it, and
      // the continuation — whose own schema accepts the same arguments — ran.
      expect(mockExecute).toHaveBeenCalledTimes(1);
      expect(mockExecute.mock.calls[0][0]).toMatchObject({ connectorType: 'strale', toolName: 'b', args: { location: 'Palo Alto, CA' } });
      expect(run).toEqual({ ok: true, empty: false, text: 'from strale' });
    });

    it('calls the first choice when the arguments DO fit what the source accepts', async () => {
      const [id] = await searchWithRouting(['locus:homes', 'strale:b'], {
        'locus:homes': { inputSchema: ANY_CITY, routingSchema: CITY_ENUM },
        'strale:b': { inputSchema: ANY_CITY },
      });
      mockExecute.mockResolvedValueOnce(answered('from locus'));
      const run = await runCapability('t1', 'acct1', { capabilityId: id, args: { location: 'Los Angeles, CA' } });
      expect(mockExecute).toHaveBeenCalledTimes(1);
      expect(mockExecute.mock.calls[0][0]).toMatchObject({ connectorType: 'locus', toolName: 'homes' });
      expect(run).toEqual({ ok: true, empty: false, text: 'from locus' });
    });

    it('judges a TAIL candidate by the same schema, and hands off when none accepts the arguments', async () => {
      const [id] = await searchWithRouting(['tikhub:a', 'locus:homes'], {
        'tikhub:a': { inputSchema: ANY_CITY },
        'locus:homes': { inputSchema: ANY_CITY, routingSchema: CITY_ENUM },
      });
      mockExecute.mockResolvedValueOnce(failed());
      const run = await runCapability('t1', 'acct1', { capabilityId: id, args: { location: 'Palo Alto, CA' } });
      // The first choice ran and failed; the continuation candidate's model-
      // facing schema would have accepted these arguments, and its routing
      // schema does not, so it is handed over rather than called.
      expect(mockExecute).toHaveBeenCalledTimes(1);
      expect(run.ok === false && run.kind).toBe('handoff');
      // The handoff's hint is the MODEL-facing schema: the strict list is not
      // the truth about what may be asked for, and must never be shown.
      expect(run.text).toContain('takes: location (string, required), page (integer)');
      expect(run.text).not.toContain('Austin');
    });

    it('tells the model its arguments are wrong when the schema IT was offered rejected them', async () => {
      // Skipping the first choice must not turn a fixable mistake into a
      // blank "no result". The source never saw the call, and the model is
      // told exactly what it would have been told had the source refused it.
      const [id] = await searchWithRouting(['tikhub:a'], { 'tikhub:a': { inputSchema: ANY_CITY } });
      const run = await runCapability('t1', 'acct1', { capabilityId: id, args: { location: 42 } });
      expect(mockExecute).not.toHaveBeenCalled();
      expect(run.ok === false && run.kind).toBe('invalid_arguments');
      expect(run.text).toContain('rejected the arguments');
      expect(run.text).toContain('"location" is integer, not string');
    });

    it('says NOTHING about the arguments when only the source\'s own narrower schema rejected them', async () => {
      // The model sent what it was invited to send. Telling it the value is
      // not allowed would teach it to narrow to five cities that the vendor
      // behind this source does not even enforce.
      const [id] = await searchWithRouting(['locus:homes'], {
        'locus:homes': { inputSchema: ANY_CITY, routingSchema: CITY_ENUM },
      });
      const run = await runCapability('t1', 'acct1', { capabilityId: id, args: { location: 'Palo Alto, CA' } });
      expect(mockExecute).not.toHaveBeenCalled();
      expect(run.ok === false && run.kind).toBe('refused');
      expect(run.text).toContain('did not return a result');
      expect(run.text).not.toContain('rejected the arguments');
      expect(run.text).not.toContain('Austin');
    });

    it('an APPROVED write whose arguments do not fit is told so, not handed a blank no-result', async () => {
      // A write-class handle never has a tail, so there is nothing to fall
      // through to: without this the person who approved the call gets a run
      // that did nothing and a model that cannot say why.
      mockRequiresApproval.mockResolvedValue(true);
      const [id] = await searchWithRouting(['tikhub:send'], {
        'tikhub:send': { inputSchema: { type: 'object', properties: { to: { type: 'string' }, body: { type: 'string' } }, required: ['to', 'body'] } },
      });
      const run = await runCapability('t1', 'acct1', { capabilityId: id, args: { to: 'someone' } }, { caller: 'agent', approved: true });
      expect(mockExecute).not.toHaveBeenCalled();
      expect(run.ok === false && run.kind).toBe('invalid_arguments');
      expect(run.text).toContain('required argument "body" is missing');
    });

    it('a tail that CAN take the arguments still answers, whatever the first choice thought of them', async () => {
      const [id] = await searchWithRouting(['tikhub:a', 'strale:b'], {
        'tikhub:a': { inputSchema: { type: 'object', properties: { q: { type: 'string' } }, required: ['q'] } },
        'strale:b': { inputSchema: ANY_CITY },
      });
      mockExecute.mockResolvedValueOnce(answered('from strale'));
      const run = await runCapability('t1', 'acct1', { capabilityId: id, args: { location: 'Palo Alto, CA' } });
      expect(mockExecute.mock.calls.map((c) => c[0].connectorType)).toEqual(['strale']);
      expect(run).toEqual({ ok: true, empty: false, text: 'from strale' });
    });

    it('a source with no routing schema is still judged by its own input schema', async () => {
      const [id] = await searchWithRouting(['tikhub:a', 'strale:b'], {
        'tikhub:a': { inputSchema: CITY_ENUM },
        'strale:b': { inputSchema: ANY_CITY },
      });
      mockExecute.mockResolvedValueOnce(answered('from strale'));
      const run = await runCapability('t1', 'acct1', { capabilityId: id, args: { location: 'Palo Alto, CA' } });
      expect(mockExecute.mock.calls.map((c) => c[0].connectorType)).toEqual(['strale']);
      expect(run).toEqual({ ok: true, empty: false, text: 'from strale' });
    });
  });

  it('one attempted endpoint per vendor: a vendor that failed gets no second endpoint in this call', async () => {
    const [id] = await searchWith(['tikhub:a', 'strale:b', 'tikhub:c'], { 'tikhub:a': Q_SCHEMA, 'strale:b': Q_SCHEMA, 'tikhub:c': Q_SCHEMA });
    mockExecute.mockResolvedValueOnce(failed()).mockResolvedValueOnce(failed('strale down'));
    const run = await runCapability('t1', 'acct1', { capabilityId: id, args: { q: 'x' } });
    expect(mockExecute.mock.calls.map((c) => `${c[0].connectorType}:${c[0].toolName}`)).toEqual(['tikhub:a', 'strale:b']);
    expect(run).toMatchObject({ ok: false, kind: 'refused' });
  });

  it('a cooling vendor\'s entries are skipped before any work on them', async () => {
    const [id] = await searchWith(['tikhub:a', 'strale:b', 'nasdaq:c'], { 'tikhub:a': Q_SCHEMA, 'strale:b': Q_SCHEMA, 'nasdaq:c': Q_SCHEMA });
    mockIsCooling.mockImplementation((ref) => ref === 'internal:strale');
    mockExecute.mockResolvedValueOnce(failed()).mockResolvedValueOnce(answered('from c'));
    const run = await runCapability('t1', 'acct1', { capabilityId: id, args: { q: 'x' } });
    expect(mockExecute.mock.calls.map((c) => c[0].connectorType)).toEqual(['tikhub', 'nasdaq']);
    expect(mockFunctions).not.toHaveBeenCalledWith('strale');
    expect(run).toEqual({ ok: true, empty: false, text: 'from c' });
  });

  it('a credential the executor found cooling is not an attempt against that vendor', async () => {
    const [id] = await searchWith(['tikhub:a', 'strale:b'], { 'tikhub:a': Q_SCHEMA, 'strale:b': Q_SCHEMA });
    mockExecute
      .mockResolvedValueOnce({ success: false, skipped: 'cooling', reason: 'credential internal:tikhub is cooling' })
      .mockResolvedValueOnce(answered('from b'));
    const run = await runCapability('t1', 'acct1', { capabilityId: id, args: { q: 'x' } });
    expect(run).toEqual({ ok: true, empty: false, text: 'from b' });
  });

  it('the read class is re-read before each automatic run: a candidate that drifted to a write is skipped', async () => {
    const [id] = await searchWith(['tikhub:a', 'strale:b', 'nasdaq:c'], { 'tikhub:a': Q_SCHEMA, 'strale:b': Q_SCHEMA, 'nasdaq:c': Q_SCHEMA });
    mockReadOnly.mockImplementation(async (ref) => ref !== 'strale:b');
    mockExecute.mockResolvedValueOnce(failed()).mockResolvedValueOnce(answered('from c'));
    const run = await runCapability('t1', 'acct1', { capabilityId: id, args: { q: 'x' } });
    expect(mockExecute.mock.calls.map((c) => c[0].connectorType)).toEqual(['tikhub', 'nasdaq']);
    expect(run).toEqual({ ok: true, empty: false, text: 'from c' });
  });

  it('a paid run that may have started stops the chain: no second source, a neutral non-success', async () => {
    const [id] = await searchWith(['tikhub:a', 'strale:b'], { 'tikhub:a': Q_SCHEMA, 'strale:b': Q_SCHEMA });
    mockExecute.mockResolvedValueOnce({ success: false, reason: 'the source timed out', autoFailoverSafe: false });
    const run = await runCapability('t1', 'acct1', { capabilityId: id, args: { q: 'x' } });
    expect(mockExecute).toHaveBeenCalledTimes(1);
    expect(run).toMatchObject({ ok: false, kind: 'refused' });
    expect(run.text).not.toMatch(/timed out|tikhub/i);
  });

  it('with no tail entry left, the outcome is the neutral no-result', async () => {
    const [id] = await searchWith(['tikhub:a']);
    mockExecute.mockResolvedValueOnce(failed());
    const run = await runCapability('t1', 'acct1', { capabilityId: id, args: {} });
    expect(run).toMatchObject({ ok: false, kind: 'refused' });
    expect(run.text).toContain('did not return a result');
  });
});

// "Ran" is not "answered": an empty envelope from a source that ran continues
// the chain, and an exhausted chain that saw one is a truthful empty success.
describe('run_capability treats an empty answer as no answer', () => {
  const empty = (structuredContent: unknown) => ({ success: true as const, content: JSON.stringify(structuredContent), structuredContent });

  it.each([
    ['a bare empty list', []],
    ['{ items: [] }', { items: [] }],
    ['{ results: [] }', { results: [] }],
    ['a blank string', '   '],
    ['a vendor wrapper with metadata only', { code: 200, message: 'ok', data: { list: [], total: 0 }, router: '/api/x' }],
  ])('continues past %s to the next candidate', async (_label, value) => {
    const [id] = await searchWith(['tikhub:a', 'strale:b'], { 'tikhub:a': Q_SCHEMA, 'strale:b': Q_SCHEMA });
    mockExecute.mockResolvedValueOnce(empty(value)).mockResolvedValueOnce(answered('from b'));
    const run = await runCapability('t1', 'acct1', { capabilityId: id, args: { q: 'x' } });
    expect(mockExecute).toHaveBeenCalledTimes(2);
    expect(run).toEqual({ ok: true, empty: false, text: 'from b' });
  });

  it('exhausted after an empty run, the outcome is ok with empty:true and the neutral text', async () => {
    const [id] = await searchWith(['tikhub:a', 'strale:b'], { 'tikhub:a': Q_SCHEMA, 'strale:b': Q_SCHEMA });
    mockExecute.mockResolvedValueOnce(empty({ items: [] })).mockResolvedValueOnce(empty([]));
    const run = await runCapability('t1', 'acct1', { capabilityId: id, args: { q: 'x' } });
    expect(run).toEqual({ ok: true, empty: true, text: expect.stringContaining('did not return a result') });
  });

  it('an empty answer counts as that vendor\'s one attempt', async () => {
    const [id] = await searchWith(['tikhub:a', 'strale:b', 'tikhub:c'], { 'tikhub:a': Q_SCHEMA, 'strale:b': Q_SCHEMA, 'tikhub:c': Q_SCHEMA });
    mockExecute.mockResolvedValueOnce(empty([])).mockResolvedValueOnce(failed('strale down'));
    await runCapability('t1', 'acct1', { capabilityId: id, args: { q: 'x' } });
    expect(mockExecute.mock.calls.map((c) => `${c[0].connectorType}:${c[0].toolName}`)).toEqual(['tikhub:a', 'strale:b']);
  });

  it('a write\'s small confirmation is its answer, never an empty result', async () => {
    mockRequiresApproval.mockResolvedValue(true);
    mockReadOnly.mockResolvedValue(false);
    mockDiscover.mockResolvedValue(result([vendorCandidate({ sourceRef: 'google_mail:send_email', connectorType: 'google_mail', mode: 'own_account' })], { mode: 'own_account', requiredOutputFields: [] } as unknown as CapabilitySpec));
    const [id] = capabilityIds(await runCapabilitySearch('t1', { operation: 'send', entity: 'message', mode: 'own_account' }));
    mockExecute.mockResolvedValueOnce({ success: true, content: '{"status":"sent"}', structuredContent: { status: 'sent' } });
    const run = await runCapability('t1', 'acct1', { capabilityId: id, args: { to: 'x@y.com' } }, { caller: 'agent', approved: true });
    expect(run).toEqual({ ok: true, empty: false, text: '{"status":"sent"}' });
  });

  // A registry write the approval gate does not hold (dataChanges) mints a
  // cap_r. handle; it is still a write, and `{ success: true }` is what an
  // append returns, not a miss.
  it('an unheld registry write\'s confirmation is its answer too — decided from the true class, not the handle marker', async () => {
    mockReadOnly.mockImplementation(async (ref) => ref !== 'google_sheets:append_values');
    mockDiscover.mockResolvedValue(result([vendorCandidate({ sourceRef: 'google_sheets:append_values', connectorType: 'google_sheets', mode: 'own_account' })], { mode: 'own_account', requiredOutputFields: [] } as unknown as CapabilitySpec));
    const [id] = capabilityIds(await runCapabilitySearch('t1', { operation: 'append', entity: 'rows', mode: 'own_account' }));
    expect(id.startsWith('cap_r.')).toBe(true);
    mockExecute.mockResolvedValueOnce({ success: true, content: '{"success":true}', structuredContent: { success: true } });
    const run = await runCapability('t1', 'acct1', { capabilityId: id, args: { values: [['a']] } });
    expect(run).toEqual({ ok: true, empty: false, text: '{"success":true}' });
  });

  // Approval switches the tail off, not the truth of the answer: an approved
  // READ that came back empty is empty.
  it('an approved read that answers nothing is ok with empty:true, and walks no tail', async () => {
    const [id] = await searchWith(['tikhub:a', 'strale:b'], { 'tikhub:a': Q_SCHEMA, 'strale:b': Q_SCHEMA });
    mockExecute.mockResolvedValueOnce(empty({ items: [] }));
    const run = await runCapability('t1', 'acct1', { capabilityId: id, args: { q: 'x' } }, { caller: 'agent', approved: true });
    expect(mockExecute).toHaveBeenCalledTimes(1);
    expect(run).toEqual({ ok: true, empty: true, text: expect.stringContaining('did not return a result') });
  });

  // The class is re-read at run time: a primary that drifted to a write since
  // its handle was minted walks no tail, whatever the handle carries.
  it('a primary whose classification drifted to a write since mint walks no tail', async () => {
    const [id] = await searchWith(['tikhub:a', 'strale:b'], { 'tikhub:a': Q_SCHEMA, 'strale:b': Q_SCHEMA });
    expect(tailOf(id)).toEqual(['strale:b']);
    mockReadOnly.mockImplementation(async (ref) => ref !== 'tikhub:a');
    mockExecute.mockResolvedValueOnce(failed());
    const run = await runCapability('t1', 'acct1', { capabilityId: id, args: { q: 'x' } });
    expect(mockExecute).toHaveBeenCalledTimes(1);
    expect(run).toMatchObject({ ok: false, kind: 'refused' });
  });
});

// The truth of a run is its status, not its text. The text on failure names
// no cause; the status says whether anything ran, which the runtime needs to
// report a failed tool call rather than a success that sent nothing.
describe('run_capability reports what actually happened', () => {
  async function readHandle(refs: string[] = ['tikhub:primary_fn', 'apify:backup_actor']) {
    mockDiscover.mockResolvedValue(result(refs.map((r) => vendorCandidate({ sourceRef: r, connectorType: r.split(':')[0] }))));
    const search = await runCapabilitySearch('t1', { operation: 'x', entity: 'y', mode: 'public_data' });
    return firstCapabilityId(search);
  }

  it('a refused run is ok:false with kind refused and the neutral text', async () => {
    const id = await readHandle(['tikhub:only_fn']);
    mockExecute.mockResolvedValue({ success: false, reason: 'google_mail has no platform execution path yet' });
    const run = await runCapability('t1', 'acct1', { capabilityId: id, args: {} });
    expect(run).toMatchObject({ ok: false, kind: 'refused' });
    expect(run.text).not.toMatch(/google_mail|platform execution path/); // cause stays in the logs
  });

  it('an approval that the surface cannot request is ok:false with kind requires_approval', async () => {
    const id = await readHandle(['tikhub:only_fn']);
    mockExecute.mockResolvedValue({ success: false, requiresApproval: true, reason: 'write-class' });
    const run = await runCapability('t1', 'acct1', { capabilityId: id, args: {} });
    expect(run).toMatchObject({ ok: false, kind: 'requires_approval' });
  });

  it('reads a flattened shape — the fields beside capabilityId — as the arguments', async () => {
    const id = await readHandle(['tikhub:only_fn']);
    mockExecute.mockResolvedValue(answered('ok'));
    await runCapability('t1', 'acct1', { capabilityId: id, to: 'x@y.com', subject: 's' });
    expect(mockExecute).toHaveBeenCalledWith(expect.objectContaining({ args: { to: 'x@y.com', subject: 's' } }));
  });

  it('treats an empty `args` as absent so a flattened call is not read as no arguments', async () => {
    const id = await readHandle(['tikhub:only_fn']);
    mockExecute.mockResolvedValue(answered('ok'));
    await runCapability('t1', 'acct1', { capabilityId: id, args: {}, to: 'x@y.com' });
    expect(mockExecute).toHaveBeenCalledWith(expect.objectContaining({ args: { to: 'x@y.com' } }));
  });

  it('reads the arguments from a JSON-encoded `arguments` as well as `args`', async () => {
    const id = await readHandle(['tikhub:only_fn']);
    mockExecute.mockResolvedValue(answered('ok'));
    await runCapability('t1', 'acct1', { capabilityId: id, arguments: JSON.stringify({ to: 'x@y.com' }) });
    expect(mockExecute).toHaveBeenCalledWith(expect.objectContaining({ args: { to: 'x@y.com' } }));
  });
});

// A person approves ONE operation on ONE target. A refusal must not turn into
// a different function or a different mailbox under the same approval, so a
// write-class capability — and any approved call — runs its own reference only.
describe('no continuation under a write-class handle or an approval', () => {
  async function handleWith(refs: string[], write: boolean, schemas: Record<string, unknown> = {}) {
    mockRequiresApproval.mockResolvedValue(write);
    mockFunctions.mockImplementation(async (type) =>
      Object.entries(schemas)
        .filter(([ref]) => ref.startsWith(`${type}:`))
        .map(([ref, inputSchema]) => ({
          name: ref.slice(ref.indexOf(':') + 1), description: '', categories: ['read'],
          inputSchema: inputSchema as { type: 'object'; properties: Record<string, unknown>; required?: string[] },
        })));
    mockDiscover.mockResolvedValue(result(refs.map((r) => vendorCandidate({ sourceRef: r, connectorType: r.split(':')[0], inputSchema: schemas[r] }))));
    const search = await runCapabilitySearch('t1', { operation: 'send', entity: 'message', mode: 'public_data' });
    mockRequiresApproval.mockResolvedValue(false);
    return firstCapabilityId(search);
  }

  it('a write-class handle tries only its primary reference', async () => {
    const id = await handleWith(['google_mail:send_email', 'outlook:send_email'], true);
    expect(id.startsWith('cap_w.')).toBe(true);
    mockExecute.mockResolvedValue({ success: false, reason: 'declined' });
    const run = await runCapability('t1', 'acct1', { capabilityId: id, args: { to: 'x@y.com' } }, { caller: 'agent', approved: true });
    expect(mockExecute).toHaveBeenCalledTimes(1);
    expect(mockExecute).toHaveBeenCalledWith(expect.objectContaining({ connectorType: 'google_mail', toolName: 'send_email', approved: true }));
    expect(run).toMatchObject({ ok: false, kind: 'refused' });
  });

  it('an approved call on a read-class handle also does not continue', async () => {
    const id = await handleWith(['tikhub:primary_fn', 'strale:backup'], false, { 'tikhub:primary_fn': Q_SCHEMA, 'strale:backup': Q_SCHEMA });
    mockExecute.mockResolvedValue({ success: false, reason: 'declined' });
    await runCapability('t1', 'acct1', { capabilityId: id, args: { q: 'x' } }, { caller: 'agent', approved: true });
    expect(mockExecute).toHaveBeenCalledTimes(1);
  });

  it('an unapproved read-class handle keeps the continuation', async () => {
    const id = await handleWith(['tikhub:primary_fn', 'strale:backup'], false, { 'tikhub:primary_fn': Q_SCHEMA, 'strale:backup': Q_SCHEMA });
    mockExecute.mockResolvedValueOnce({ success: false, reason: 'down' }).mockResolvedValueOnce(answered('backup'));
    const run = await runCapability('t1', 'acct1', { capabilityId: id, args: { q: 'x' } });
    expect(mockExecute).toHaveBeenCalledTimes(2);
    expect(run).toEqual({ ok: true, empty: false, text: 'backup' });
  });

  // The one failure the model can put right is the one it is told about:
  // the source's own account of what is wrong with the arguments, vendor
  // scrubbed, and no continuation — a different source run with those
  // arguments answers a different question with a result that looks like one.
  it('a primary that rejects the arguments is reported as such, and nothing else is tried', async () => {
    const id = await handleWith(['zoho:list_accounts', 'zoho:list_leads'], false, { 'zoho:list_accounts': Q_SCHEMA, 'zoho:list_leads': Q_SCHEMA });
    mockExecute.mockResolvedValueOnce({
      success: false,
      argumentsRejected: true,
      reason: 'Invalid request data provided\n- Input should be a valid string on parameter `fields` (per TikHub)',
    });
    const run = await runCapability('t1', 'acct1', { capabilityId: id, args: { q: 'x' } });
    expect(mockExecute).toHaveBeenCalledTimes(1);
    expect(run.ok).toBe(false);
    expect(run.ok === false && run.kind).toBe('invalid_arguments');
    expect(run.text).toContain('rejected the arguments');
    expect(run.text).toContain('Input should be a valid string on parameter `fields`');
    expect(run.text).toContain('run the same capabilityId again');
    expect(run.text.toLowerCase()).not.toContain('tikhub');
  });

  it('a fallback that rejects the arguments is one attempt among others', async () => {
    const id = await handleWith(['tikhub:primary_fn', 'strale:backup'], false, { 'tikhub:primary_fn': Q_SCHEMA, 'strale:backup': Q_SCHEMA });
    mockExecute
      .mockResolvedValueOnce({ success: false, reason: 'down' })
      .mockResolvedValueOnce({ success: false, argumentsRejected: true, reason: 'Field input.searchTerms must be array' });
    const run = await runCapability('t1', 'acct1', { capabilityId: id, args: { q: 'x' } });
    expect(mockExecute).toHaveBeenCalledTimes(2);
    expect(run.ok === false && run.kind).toBe('refused');
  });
});

describe('capability_search says what each argument is', () => {
  it('reads a connector function’s schema from the registry when discovery carries none', async () => {
    mockFunctions.mockResolvedValueOnce([
      {
        name: 'list_accounts',
        description: 'List CRM accounts',
        inputSchema: { type: 'object', properties: { fields: { type: 'string' }, page: { type: 'integer' } }, required: ['fields'] },
        categories: ['read'],
      },
    ]);
    mockDiscover.mockResolvedValue(result([
      vendorCandidate({ sourceRef: 'zoho:list_accounts', connectorType: 'zoho', inputSchema: undefined }),
    ]));
    const out = await runCapabilitySearch('t1', { operation: 'list', entity: 'accounts', mode: 'own_account' });
    expect(mockFunctions).toHaveBeenCalledWith('zoho');
    expect(out).toContain('args: fields (string, required), page (integer)');
  });

  it('lists type and whether required, required first', async () => {
    mockDiscover.mockResolvedValue(result([
      vendorCandidate({
        inputSchema: {
          type: 'object',
          properties: {
            page: { type: 'integer' },
            fields: { type: 'string' },
            ids: { type: 'array', items: { type: 'string' } },
          },
          required: ['fields'],
        },
      }),
    ]));
    const out = await runCapabilitySearch('t1', { operation: 'list', entity: 'accounts', mode: 'own_account' });
    expect(out).toContain('args: fields (string, required), page (integer), ids (array of string)');
  });
});

// A capabilityId is a promise the model can run it. A reference that names a
// system but no function cannot be run, so it is not offered.
describe('a candidate with no function is not offered as a capability', () => {
  it('leaves the connector-level candidate out of the results', async () => {
    mockDiscover.mockResolvedValue(result([
      vendorCandidate({ sourceRef: 'google_mail', connectorType: 'google_mail', title: 'Gmail', mode: 'own_account' }),
      vendorCandidate({ sourceRef: 'tikhub:tiktok_fetch_user' }),
    ]));
    const out = await runCapabilitySearch('t1', { operation: 'x', entity: 'y', mode: 'public_data' });
    // Exactly one handle is offered, and it is the executable one.
    const handles = out.match(/capabilityId: cap_[wr]\.[A-Za-z0-9_-]+/g) ?? [];
    expect(handles).toHaveLength(1);
    expect(out).toContain('tiktok fetch user');
  });
});

// A store actor's continuation validates against the actor's COMPLETE input
// schema, fetched for validation — the display hint is a truncated summary.
describe('a store actor in the chain', () => {
  it('runs automatically only when the arguments fit its full schema, and hands off otherwise', async () => {
    mockApifyOn.mockReturnValue(true);
    mockFunctions.mockResolvedValue([{ name: 'a', description: '', categories: ['read'], inputSchema: Q_SCHEMA as never }]);
    mockDiscover.mockResolvedValue(result([vendorCandidate({ sourceRef: 'tikhub:a', inputSchema: Q_SCHEMA }), storeCandidate('clockworks/tiktok-scraper')]));
    const [id] = capabilityIds(await runCapabilitySearch('t1', { operation: 'x', entity: 'y', mode: 'public_data' }));

    // The full schema declares `searchTerms` as an array of strings; `q` is not declared.
    mockApifySchema.mockResolvedValue({ type: 'object', properties: { searchTerms: { type: 'array', items: { type: 'string' } } }, required: ['searchTerms'] });
    mockExecute.mockResolvedValueOnce(failed());
    const run = await runCapability('t1', 'acct1', { capabilityId: id, args: { q: 'shopify' } });
    expect(mockApifySchema).toHaveBeenCalledWith('clockworks/tiktok-scraper');
    expect(run.ok === false && run.kind).toBe('handoff');
    expect(run.text).toContain('takes: searchTerms (array of string, required)');
    expect(run.text.toLowerCase()).not.toContain('clockworks');
    expect(run.text.toLowerCase()).not.toContain('apify');
    const fresh = run.text.match(/capabilityId (cap_[A-Za-z0-9_.-]+)/)?.[1] ?? '';
    expect(resolveCapabilityHandle(fresh)).toMatchObject({ primaryRef: 'apify:run_actor', presetArgs: { actorId: 'clockworks/tiktok-scraper' } });

    // With fitting arguments, the actor runs in-call with its actor id from
    // the tail entry — and the first choice, whose own schema declares no
    // `searchTerms`, is skipped without a request rather than dispatched to
    // be refused.
    jest.clearAllMocks();
    mockExecute.mockResolvedValueOnce(answered('scraped'));
    const second = await runCapability('t1', 'acct1', { capabilityId: id, args: { searchTerms: ['shopify'] } });
    expect(mockExecute).toHaveBeenCalledTimes(1);
    expect(mockExecute.mock.calls[0][0]).toMatchObject({ connectorType: 'apify', toolName: 'run_actor', presetArgs: { actorId: 'clockworks/tiktok-scraper' }, args: { searchTerms: ['shopify'] } });
    expect(second).toEqual({ ok: true, empty: false, text: 'scraped' });
  });
});

// A result larger than one message is parked as a dataset and the model gets
// its view, never the records; a result that fits comes back whole; a later
// run can add to a dataset the model names.
describe('run_capability parks a large result as a dataset', () => {
  const wide = (i: number) => ({ id: i, title: `Post ${i}`, body: 'x'.repeat(2500) });
  const big = Array.from({ length: 27 }, (_, i) => wide(i));
  const fields = [
    { name: 'id', type: 'number', present: 1 },
    { name: 'title', type: 'text', present: 1, avgChars: 6, sample: 'Post 0' },
    { name: 'body', type: 'text', present: 1, avgChars: 2500 },
  ];
  beforeEach(() => { mockCreateDataset.mockReset(); mockAppendRecords.mockReset(); });

  it('keeps the records, scoped to the job, and hands the model the view with the id, the fields and a sample', async () => {
    mockDiscover.mockResolvedValue(result([vendorCandidate()]));
    const id = firstCapabilityId(await runCapabilitySearch('t1', { operation: 'fetch posts', entity: 'posts', mode: 'public_data' }));
    mockExecute.mockResolvedValue({ success: true, content: 'rendered-by-executor', structuredContent: big });
    mockCreateDataset.mockResolvedValue({ id: '2f6f2a2e-0d4c-4e0e-9a6e-2c6b7f3f1a11', recordCount: 27, added: 27, truncated: false, fields, run: 1 });
    const run = await runCapability('t1', 'acct1', { capabilityId: id, args: { uniqueId: 'nasa' } }, { scope: { kind: 'liftoff_thread', id: 'thread-9' } });
    expect(run.ok).toBe(true);
    expect(run.text).toContain('27 records were fetched and kept as dataset 2f6f2a2e-0d4c-4e0e-9a6e-2c6b7f3f1a11 ("tiktok fetch user: uniqueId nasa")');
    expect(run.text).toContain('body (text, avg 2.5k chars)');
    expect(run.text).toContain('"title":"Post 0"');
    expect(run.text).not.toContain('Post 5');
    expect(run.text).toContain('dataset_query');
    expect(run.text).toContain('dataset_extract');
    expect(run.text).not.toContain('rendered-by-executor');
    expect(mockCreateDataset).toHaveBeenCalledWith('t1', {
      scope: { kind: 'liftoff_thread', id: 'thread-9' },
      label: 'tiktok fetch user: uniqueId nasa',
      source: 'connector_registry',
      sourceRef: 'tikhub:tiktok_fetch_user',
      records: big,
    });
  });

  it('a result that fits is returned as the executor rendered it, and nothing is kept', async () => {
    mockDiscover.mockResolvedValue(result([vendorCandidate()]));
    const id = firstCapabilityId(await runCapabilitySearch('t1', { operation: 'fetch posts', entity: 'posts', mode: 'public_data' }));
    mockExecute.mockResolvedValue({ success: true, content: '[{"id":1}]', structuredContent: [{ id: 1 }] });
    const run = await runCapability('t1', 'acct1', { capabilityId: id, args: {} });
    expect(run).toEqual({ ok: true, empty: false, text: '[{"id":1}]' });
    expect(mockCreateDataset).not.toHaveBeenCalled();
  });

  it('a later run adds to the dataset the model names, and says which run its records are', async () => {
    mockDiscover.mockResolvedValue(result([vendorCandidate()]));
    const id = firstCapabilityId(await runCapabilitySearch('t1', { operation: 'fetch posts', entity: 'posts', mode: 'public_data' }));
    mockExecute.mockResolvedValue({ success: true, content: 'rendered', structuredContent: big });
    mockAppendRecords.mockResolvedValue({ id: '2f6f2a2e-0d4c-4e0e-9a6e-2c6b7f3f1a11', recordCount: 54, added: 27, truncated: false, fields, run: 2 });
    const run = await runCapability('t1', 'acct1', { capabilityId: id, args: { uniqueId: 'esa' }, appendTo: '2f6f2a2e-0d4c-4e0e-9a6e-2c6b7f3f1a11' });
    expect(mockAppendRecords).toHaveBeenCalledWith('t1', '2f6f2a2e-0d4c-4e0e-9a6e-2c6b7f3f1a11', big);
    expect(mockCreateDataset).not.toHaveBeenCalled();
    expect(run.text).toContain('This run added 27 records (_run 2); the dataset now holds 54.');
  });

  it('a small later run still lands in the dataset the model names, whole result inline', async () => {
    mockDiscover.mockResolvedValue(result([vendorCandidate()]));
    const id = firstCapabilityId(await runCapabilitySearch('t1', { operation: 'fetch posts', entity: 'posts', mode: 'public_data' }));
    mockExecute.mockResolvedValue({ success: true, content: '[{"id":1}]', structuredContent: [{ id: 1 }] });
    mockAppendRecords.mockResolvedValue({ id: '2f6f2a2e-0d4c-4e0e-9a6e-2c6b7f3f1a11', recordCount: 28, added: 1, truncated: false, fields, run: 2 });
    const run = await runCapability('t1', 'acct1', { capabilityId: id, args: {}, appendTo: '2f6f2a2e-0d4c-4e0e-9a6e-2c6b7f3f1a11' });
    expect(run.text).toBe('[{"id":1}]\n\nThese 1 records were also added to dataset 2f6f2a2e-0d4c-4e0e-9a6e-2c6b7f3f1a11 (now 28 records; this run is _run 2).');
  });

  it('a dataset that cannot be added to starts a new one, and says so', async () => {
    mockDiscover.mockResolvedValue(result([vendorCandidate()]));
    const id = firstCapabilityId(await runCapabilitySearch('t1', { operation: 'fetch posts', entity: 'posts', mode: 'public_data' }));
    mockExecute.mockResolvedValue({ success: true, content: 'rendered', structuredContent: big });
    mockAppendRecords.mockResolvedValue(null);
    mockCreateDataset.mockResolvedValue({ id: '3a6f2a2e-0d4c-4e0e-9a6e-2c6b7f3f1a22', recordCount: 27, added: 27, truncated: false, fields, run: 1 });
    const run = await runCapability('t1', 'acct1', { capabilityId: id, args: {}, appendTo: '2f6f2a2e-0d4c-4e0e-9a6e-2c6b7f3f1a11' });
    expect(run.text).toContain('kept as dataset 3a6f2a2e-0d4c-4e0e-9a6e-2c6b7f3f1a22');
    expect(run.text).toContain('could not be added to');
  });

  it('when nothing could be kept, the model gets the rendering, which says what it left out', async () => {
    mockDiscover.mockResolvedValue(result([vendorCandidate()]));
    const id = firstCapabilityId(await runCapabilitySearch('t1', { operation: 'fetch posts', entity: 'posts', mode: 'public_data' }));
    mockExecute.mockResolvedValue({ success: true, content: 'rendered-by-executor', structuredContent: big });
    mockCreateDataset.mockResolvedValue(null);
    const run = await runCapability('t1', 'acct1', { capabilityId: id, args: {} });
    expect(run).toEqual({ ok: true, empty: false, text: 'rendered-by-executor' });
  });
});

// A no-argument call must reach the vendor as {}: the control fields of the
// input (appendTo, and an absent one) are not arguments.
describe('run_capability with no arguments', () => {
  it('forwards {} to the executor, not the control fields', async () => {
    mockDiscover.mockResolvedValue(result([vendorCandidate()]));
    const id = firstCapabilityId(await runCapabilitySearch('t1', { operation: 'list categories', entity: 'categories', mode: 'public_data' }));
    mockExecute.mockResolvedValue({ success: true, content: '[{"id":1}]', structuredContent: [{ id: 1 }] });
    await runCapability('t1', 'acct1', { capabilityId: id, args: {}, appendTo: undefined });
    expect(mockExecute.mock.calls[0][0]).toMatchObject({ args: {} });
    expect(Object.keys(mockExecute.mock.calls[0][0].args)).toEqual([]);
    jest.clearAllMocks();
    mockExecute.mockResolvedValue({ success: true, content: '[{"id":1}]', structuredContent: [{ id: 1 }] });
    await runCapability('t1', 'acct1', { capabilityId: id, args: {}, appendTo: '2f6f2a2e-0d4c-4e0e-9a6e-2c6b7f3f1a11' });
    expect(Object.keys(mockExecute.mock.calls[0][0].args)).toEqual([]);
  });
});
