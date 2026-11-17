// conversations__list / conversation__read, and the trail they read.
//
// The plan for a standing team is drafted from what the CAIO actually DID for
// this person, here or in an earlier chat. Five properties: the trail is
// bounded and redacted before it is stored, and says what it does not hold;
// visibility is the product's own (read what the person could open, list
// what their history page lists); the read returns the transcript with each
// turn's trail, in order, in the shape the drafting instructions already
// expect; the work record is a deterministic rendering of that trail with
// the person's own browser segments in their place in time; and a segment
// read that fails is said, never hidden.
//
// Fixtures use three unrelated sites: a storefront's order page with a query
// string, a documentation site, and a web form.

jest.mock('../infrastructure/config', () => ({
  loadConfig: () => ({ PLATFORM_BACKEND_URL: 'http://pb', WORKFORCE_SERVICE_TOKEN: 'tok' }),
}));
jest.mock('../infrastructure/logging', () => ({
  log: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
const mockListThreads = jest.fn();
const mockGetThread = jest.fn();
const mockListMessages = jest.fn();
const mockRollingSummary = jest.fn();
jest.mock('../workforce-plans/chat-repository', () => ({
  createTurn: jest.fn(),
  listThreads: (...a: unknown[]) => mockListThreads(...a),
  getThread: (...a: unknown[]) => mockGetThread(...a),
  listMessages: (...a: unknown[]) => mockListMessages(...a),
  getThreadRollingSummary: (...a: unknown[]) => mockRollingSummary(...a),
}));

import { buildToolTrail, MAX_ENTRIES, MAX_STEPS, RECORD_GAP_TOOL, TOOL_CALL_CAP_REASON } from '../workforce-plans/tool-trail.js';
import { conversationsListTool, conversationReadTool, renderWorkRecord, readTakeovers } from '../workforce-plans/tools/conversations.js';
import { describeSegment, toRecordedCall, type TakeoverSegment, type TakeoverSegmentAction } from '../workforce-plans/work-record.js';
import type { RecordedAction, RecordedCall, RecordedSegment } from '@liftoffos/browser-record';
import type { WorkforcePlanToolContext } from '../workforce-plans/tools/types.js';

// The segment and the action this service reads from platform-backend are
// what the one prose renderer (@liftoffos/browser-record) takes. A field
// added on one side and not the other fails here, at compile time, rather
// than in the renderer at run time.
({} as TakeoverSegment) satisfies RecordedSegment;
({} as TakeoverSegmentAction) satisfies RecordedAction;

const ctx = { tenantId: 't1', accountId: 'acct-1', role: 'owner', threadId: 'thread-now' } as unknown as WorkforcePlanToolContext;

const ORDERS = 'https://shop.example.com/orders?status=open&page=2';
const DOCS = 'https://docs.example.org/guide/install';
const FORM = 'https://forms.example.net/intake';
const KEY = 'sk-ant-api03-' + 'A'.repeat(40);

let fetchSpy: jest.SpyInstance;

beforeEach(() => {
  jest.clearAllMocks();
  mockRollingSummary.mockResolvedValue(null);
  fetchSpy = jest.spyOn(global, 'fetch');
  // No segments unless a test says otherwise.
  fetchSpy.mockResolvedValue({ ok: true, status: 200, json: async () => ({ takeovers: [], truncated: false }) } as never);
});

afterEach(() => { fetchSpy.mockRestore(); });

function action(over: Partial<TakeoverSegmentAction> & { kind: string; url: string; at: string }): TakeoverSegmentAction {
  return {
    tag: '', role: '', name: '', inputType: '', value: '', valueDisposition: 'none', detail: '',
    urlTruncated: false, nameTruncated: false, valueTruncated: false, detailTruncated: false,
    urlProtectedDataOmitted: false, nameProtectedDataOmitted: false, detailProtectedDataOmitted: false,
    ...over,
  };
}

function segment(startedAt: string, endedAt: string | null, steps: TakeoverSegmentAction[], over: Partial<TakeoverSegment> = {}): TakeoverSegment {
  return { tool: 'person_takeover', steps, live: false, captureGap: false, gapReason: '', startedAt, endedAt, ...over };
}

describe('buildToolTrail', () => {
  it('keeps the tool, a redacted input and a bounded outcome, in call order', () => {
    const trail = buildToolTrail([
      { name: 'navigate_browser_session', input: { url: DOCS }, output: { message: `The browser is now on ${DOCS}` } },
      { name: 'run_capability', input: { capabilityId: 'cap_r.x', args: { symbol: 'SHOP' } }, output: 'price 130.20' },
    ]);
    expect(trail.map((t) => t.tool)).toEqual(['navigate_browser_session', 'run_capability']);
    expect(trail[0].input).toEqual({ url: DOCS });
    expect(trail[0].outcome).toBe(`{"message":"The browser is now on ${DOCS}"}`);
    expect(trail[1].outcome).toBe('price 130.20');
    // Other shapes are unchanged: no steps, no flags on a clean entry.
    expect(trail[1]).toEqual({ tool: 'run_capability', input: { capabilityId: 'cap_r.x', args: { symbol: 'SHOP' } }, outcome: 'price 130.20' });
  });

  it('bounds the outcome and replaces an oversized input with a note, never a broken JSON, and flags both', () => {
    const big = 'x'.repeat(5_000);
    const [entry] = buildToolTrail([{ name: 't', input: { body: big, to: 'a@x.com' }, output: big }]);
    expect(entry.outcome.length).toBeLessThanOrEqual(601);
    expect(entry.outcome.endsWith('…')).toBe(true);
    expect(entry.input).toEqual({ _omitted: expect.stringContaining('not kept'), keys: ['body', 'to'] });
    expect(entry).toMatchObject({ inputTruncated: true, outcomeTruncated: true });
    expect(entry.inputProtectedDataOmitted).toBeUndefined();
    expect(entry.outcomeProtectedDataOmitted).toBeUndefined();
  });

  it('keeps bounded steps and a message-only outcome for a browser task, with the completeness fields', () => {
    const steps = Array.from({ length: MAX_STEPS + 5 }, (_, i) => ({
      type: 'act', action: `click · the row ${i}`, pageUrl: ORDERS,
      actionTruncated: false, pageUrlTruncated: false, protectedDataOmitted: false, protectedKind: '', pageUrlProtectedDataOmitted: false,
      at: `2026-09-15T22:10:${String(i % 60).padStart(2, '0')}.000Z`,
    }));
    const [entry] = buildToolTrail([{
      name: 'run_browser_task',
      input: { prompt: 'open the open orders and read the second page' },
      output: {
        message: 'Read 20 open orders.', steps, stepsTruncated: false, captureGap: true, gapReason: 'cap',
        safeInstruction: 'open the open orders and read the second page', instructionTruncated: false, instructionProtectedDataOmitted: false,
      },
    }]);
    // The outcome is the message alone, never the steps serialised twice.
    expect(entry.outcome).toBe('Read 20 open orders.');
    expect(entry.steps).toHaveLength(MAX_STEPS);
    expect(entry.steps![0]).toEqual({
      type: 'act', action: 'click · the row 0', pageUrl: ORDERS,
      actionTruncated: false, pageUrlTruncated: false, protectedDataOmitted: false, protectedKind: '', pageUrlProtectedDataOmitted: false,
      at: '2026-09-15T22:10:00.000Z',
    });
    expect(entry).toMatchObject({ stepsTruncated: true, captureGap: true, gapReason: 'cap' });
    expect(entry.input).toEqual({ prompt: 'open the open orders and read the second page' });
  });

  it('upgrades a step flag when the final redaction changes its action or URL, rather than silently altering it', () => {
    const [entry] = buildToolTrail([{
      name: 'run_browser_task',
      input: { prompt: 'fill the intake form' },
      output: {
        message: 'Submitted.',
        steps: [{ type: 'act', action: `type ${KEY} into the token field`, pageUrl: `${FORM}?token=${KEY}`, at: null }],
        safeInstruction: 'fill the intake form',
      },
    }]);
    const [step] = entry.steps!;
    expect(step.action).not.toContain(KEY);
    expect(step.pageUrl).not.toContain(KEY);
    expect(step).toMatchObject({ protectedDataOmitted: true, protectedKind: 'sensitive_text', pageUrlProtectedDataOmitted: true, at: null });
  });

  it('stores only the returned safe instruction and its markers for a browser call with a protected raw prompt', () => {
    const rawPrompt = `log in to ${FORM} with password hunter2-synthetic and submit the intake`;
    const [entry] = buildToolTrail([{
      name: 'run_browser_task',
      input: { prompt: rawPrompt },
      output: {
        message: 'That instruction carries protected data; it was not sent to the browser.',
        safeInstruction: `log in to ${FORM} with password [redacted] and submit the intake`,
        instructionTruncated: true,
        instructionProtectedDataOmitted: true,
      },
    }]);
    expect(entry.input).toEqual({ prompt: `log in to ${FORM} with password [redacted] and submit the intake [protected data omitted] [truncated]` });
    expect(JSON.stringify(entry)).not.toContain('hunter2-synthetic');
    expect(entry).toMatchObject({ inputTruncated: true, inputProtectedDataOmitted: true });
    expect(entry.steps).toBeUndefined();
  });

  it('a navigate call stores the safe URL under input.url', () => {
    const [entry] = buildToolTrail([{
      name: 'navigate_browser_session',
      input: { url: `${ORDERS}&reset_token=abc` },
      output: { message: `The browser is now on ${ORDERS}`, safeInstruction: `${ORDERS}&reset_token=[redacted]`, instructionProtectedDataOmitted: true },
    }]);
    expect(entry.input).toEqual({ url: `${ORDERS}&reset_token=[redacted] [protected data omitted]` });
    expect(entry.inputProtectedDataOmitted).toBe(true);
  });

  it('keeps the first forty calls of a turn and ends with one record_gap sentinel naming the rest', () => {
    const calls = Array.from({ length: 60 }, (_, i) => ({ name: `t${i}`, input: {}, output: null }));
    const trail = buildToolTrail(calls);
    expect(trail).toHaveLength(MAX_ENTRIES + 1);
    expect(trail[MAX_ENTRIES - 1].tool).toBe('t39');
    expect(trail[MAX_ENTRIES]).toEqual({
      tool: RECORD_GAP_TOOL,
      input: { omitted: 20 },
      outcome: '20 later tool calls of this turn are not in the record',
      captureGap: true,
      gapReason: TOOL_CALL_CAP_REASON,
    });
    // Exactly forty is not a gap.
    expect(buildToolTrail(calls.slice(0, 40))).toHaveLength(40);
  });
});

describe('conversations__list', () => {
  const threads = [
    { id: 'thread-now', accountId: 'acct-1', title: 'Order sweep', createdAt: '2026-09-15T22:00:00Z', updatedAt: '2026-09-15T22:30:00Z', workforcePlanId: null },
    { id: 'thread-old', accountId: 'acct-1', title: 'Lead list', createdAt: '2026-09-14T10:00:00Z', updatedAt: '2026-09-14T11:00:00Z', workforcePlanId: 'plan-1' },
    { id: 'thread-colleague', accountId: 'acct-2', title: 'Someone else', createdAt: '2026-09-13T10:00:00Z', updatedAt: '2026-09-13T11:00:00Z', workforcePlanId: null },
  ];

  it('lists what the history page lists, asking with the caller\'s real role', async () => {
    mockListThreads.mockResolvedValue({ threads, hasMore: false });
    const out = await conversationsListTool.execute({}, ctx) as { conversations: Array<Record<string, unknown>> };
    // The repository applies the page's rule (owner/admin: all; member: own);
    // the tool does not second-guess it.
    expect(mockListThreads).toHaveBeenCalledWith('t1', 'acct-1', 'owner', { limit: 20 });
    expect(out.conversations.map((c) => c.conversationId)).toEqual(['thread-now', 'thread-old', 'thread-colleague']);
    expect(out.conversations[0]).toMatchObject({ isThisConversation: true, startedByYou: true, hasPlan: false });
    expect(out.conversations[1]).toMatchObject({ isThisConversation: false, hasPlan: true, title: 'Lead list' });
    expect(out.conversations[2]).toMatchObject({ startedByYou: false });
  });
});

describe('conversation__read', () => {
  const messages = [
    { id: 'm3', role: 'assistant', content: 'Here is the install guide.', attachments: [], toolTrail: [{ tool: 'navigate_browser_session', input: { url: DOCS }, outcome: 'ok' }], createdAt: '2026-09-15T22:10:00Z' },
    { id: 'm2', role: 'user', content: 'Find the install steps.', attachments: [{ kind: 'upload', name: 'notes.pdf' }], toolTrail: [], createdAt: '2026-09-15T22:05:00Z' },
  ];
  const thread = { id: 'thread-now', accountId: 'acct-1', title: 'Install guide', createdAt: '2026-09-15T22:00:00Z', workforcePlanId: null };

  it('reads this conversation by default, oldest first, each turn naming its work-record steps, and asks for its segments', async () => {
    mockGetThread.mockResolvedValue(thread);
    mockListMessages.mockResolvedValue({ messages, hasMore: false });
    const out = await conversationReadTool.execute({}, ctx) as Record<string, unknown>;
    expect(mockGetThread).toHaveBeenCalledWith('thread-now', 't1');
    expect(out.found).toBe(true);
    expect(out.transcript).toEqual([
      { speaker: 'person', text: 'Find the install steps.', attachments: ['notes.pdf'], steps: [] },
      { speaker: 'you', text: 'Here is the install guide.', attachments: [], steps: [1] },
    ]);
    expect(out.workRecord).toEqual([`1. open ${DOCS} → ok`]);
    expect(out.transcriptOmitted).toBe(0);
    expect(out.transcriptTruncated).toBe(false);
    expect(out.takeovers).toEqual([]);
    expect(out.takeoversUnavailable).toBeUndefined();
    expect(out.takeoversTruncated).toBeUndefined();
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://pb/api/internal/assistant-browser/takeovers');
    expect((init.headers as Record<string, string>)['X-Service-Auth']).toBe('tok');
    expect(JSON.parse(init.body as string)).toEqual({ tenantId: 't1', threadId: 'thread-now' });
  });

  it('a read by id asks for that id\'s segments, not this thread\'s', async () => {
    mockGetThread.mockResolvedValue({ ...thread, id: 'thread-old', title: 'Lead list' });
    mockListMessages.mockResolvedValue({ messages: [], hasMore: false });
    const out = await conversationReadTool.execute({ conversationId: 'thread-old' }, ctx) as Record<string, unknown>;
    expect(out).toMatchObject({ found: true, conversationId: 'thread-old' });
    expect(JSON.parse((fetchSpy.mock.calls[0] as [string, RequestInit])[1].body as string)).toEqual({ tenantId: 't1', threadId: 'thread-old' });
  });

  it('merges the person\'s segments into the record and returns them oldest first', async () => {
    mockGetThread.mockResolvedValue(thread);
    mockListMessages.mockResolvedValue({ messages, hasMore: false });
    const seg = segment('2026-09-15T22:12:00Z', '2026-09-15T22:13:00Z', [
      action({ kind: 'navigate', url: ORDERS, at: '2026-09-15T22:12:05Z' }),
      action({ kind: 'click', url: ORDERS, tag: 'a', role: 'link', name: 'Order 1042', at: '2026-09-15T22:12:20Z' }),
    ]);
    fetchSpy.mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ takeovers: [seg], truncated: true }) } as never);
    const out = await conversationReadTool.execute({}, ctx) as Record<string, unknown>;
    expect(out.workRecord).toEqual([
      `1. open ${DOCS} → ok`,
      `2. The person drove the browser themselves (22:12:00Z to 22:13:00Z): opened ${ORDERS}; clicked link "Order 1042"`,
    ]);
    expect(out.takeovers).toEqual([seg]);
    expect(out.takeoversTruncated).toBe(true);
    // A segment is not a message.
    expect((out.transcript as unknown[]).length).toBe(2);
  });

  it('says takeoversUnavailable when the segment read fails, and still returns the record', async () => {
    mockGetThread.mockResolvedValue(thread);
    mockListMessages.mockResolvedValue({ messages, hasMore: false });
    fetchSpy.mockResolvedValueOnce({ ok: false, status: 503, json: async () => ({}) } as never);
    const out = await conversationReadTool.execute({}, ctx) as Record<string, unknown>;
    expect(out.found).toBe(true);
    expect(out.takeoversUnavailable).toBe(true);
    expect(out.takeovers).toEqual([]);
    expect(out.workRecord).toEqual([`1. open ${DOCS} → ok`]);
  });

  it('readTakeovers answers null on a thrown fetch and on a body without a list', async () => {
    fetchSpy.mockRejectedValueOnce(new Error('ECONNREFUSED'));
    expect(await readTakeovers('t1', 'thread-now')).toBeNull();
    fetchSpy.mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({}) } as never);
    expect(await readTakeovers('t1', 'thread-now')).toBeNull();
  });

  // The read lands in the model's context whole and is re-sent every round,
  // so a long conversation keeps its newest messages and its whole work record.
  it('keeps the newest messages whole within the budget, says how many it left out, and keeps every step', async () => {
    const long = Array.from({ length: 30 }, (_, i) => ({
      id: `m${30 - i}`,
      role: i % 2 === 0 ? 'assistant' : 'user',
      content: `${i % 2 === 0 ? 'reply' : 'ask'} ${30 - i} ${'x'.repeat(3000)}`,
      attachments: [],
      toolTrail: i % 2 === 0 ? [{ tool: 'run_capability', input: { capabilityId: 'cap_r.x' }, outcome: 'ok' }] : [],
      createdAt: `2026-09-15T22:${String(59 - i).padStart(2, '0')}:00Z`,
    }));
    mockGetThread.mockResolvedValue({ ...thread, title: 'Long' });
    mockListMessages.mockResolvedValue({ messages: long, hasMore: false });
    const out = await conversationReadTool.execute({}, ctx) as { transcript: Array<{ text: string; steps: number[] }>; transcriptOmitted: number; workRecord: string[] };
    const total = out.transcript.reduce((n, m) => n + m.text.length, 0);
    expect(total).toBeLessThanOrEqual(40_000);
    expect(out.transcript.length).toBeGreaterThan(1);
    expect(out.transcript.length + out.transcriptOmitted).toBe(30);
    // The newest message is kept, whole, and names the last step.
    expect(out.transcript[out.transcript.length - 1].text.startsWith('reply 30 ')).toBe(true);
    expect(out.transcript[out.transcript.length - 1].steps).toEqual([15]);
    expect(out.workRecord).toHaveLength(15);
  });

  it('reads a colleague\'s conversation in the same workspace, what the open route allows', async () => {
    mockGetThread.mockResolvedValue({ id: 'thread-colleague', accountId: 'acct-2', title: 'Someone else', createdAt: '2026-09-13T10:00:00Z', workforcePlanId: null });
    mockListMessages.mockResolvedValue({ messages: [], hasMore: false });
    const out = await conversationReadTool.execute({ conversationId: 'thread-colleague' }, ctx) as Record<string, unknown>;
    expect(out).toMatchObject({ found: true, conversationId: 'thread-colleague', startedByYou: false });
  });

  it('a conversation outside the workspace is not found (getThread is tenant-scoped)', async () => {
    mockGetThread.mockResolvedValue(null);
    const out = await conversationReadTool.execute({ conversationId: 'nope' }, ctx);
    expect((out as { found: boolean }).found).toBe(false);
    expect(mockListMessages).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('tells the CAIO the record holds the person\'s own segments in their place', () => {
    const description = conversationReadTool.definition.description;
    expect(description).toContain('the segments the person drove the browser themselves');
    expect(description).not.toMatch(/—/);
    expect(description).not.toMatch(/\b\w+n't\b|\b\w+'(re|ll|ve|d)\b/);
  });
});

describe('renderWorkRecord', () => {
  it('numbers every call across the conversation in order, with arguments and outcomes clipped to one line', () => {
    const record = renderWorkRecord([
      { role: 'user', toolTrail: [] },
      { role: 'assistant', toolTrail: [
        { tool: 'navigate_browser_session', input: { url: DOCS }, outcome: 'Page: Install\nlong body' },
        { tool: 'run_capability', input: { capabilityId: 'cap_r.x', args: { symbol: 'SHOP' } }, outcome: '$130.20' },
      ] },
      { role: 'user', toolTrail: [] },
      { role: 'assistant', toolTrail: [
        { tool: 'run_capability', input: { _omitted: 'input of 9000 characters not kept', keys: ['body'] }, outcome: '' },
      ] },
    ] as never);
    expect(record).toEqual([
      `1. open ${DOCS} → Page: Install long body`,
      '2. run_capability (capabilityId: cap_r.x, args: {"symbol":"SHOP"}) → $130.20',
      '3. run_capability (input of 9000 characters not kept)',
    ]);
  });

  it('projects a trail entry onto the package\'s call: a pane tool\'s one argument is the instruction, any other tool keeps its name', () => {
    const navigate = toRecordedCall({ tool: 'navigate_browser_session', input: { url: DOCS }, outcome: 'ok' });
    (navigate satisfies RecordedCall);
    expect(navigate).toMatchObject({ tool: 'navigate_browser_session', instruction: DOCS, outcome: 'ok', personTookOver: false, steps: null, gapReason: '' });
    expect(toRecordedCall({ tool: 'run_browser_task', input: { prompt: 'work the orders' }, outcome: 'Done.' }).instruction).toBe('work the orders');
    expect(toRecordedCall({ tool: 'run_capability', input: { capabilityId: 'cap_r.x' }, outcome: '' }).instruction).toBe('run_capability (capabilityId: cap_r.x)');
    expect(toRecordedCall({ tool: 'team_update', input: {}, outcome: '' }).instruction).toBe('team_update');
    // The flags cross by name, and a stepsTruncated that is false is absent, as the package spells it.
    expect(toRecordedCall({
      tool: 'run_browser_task', input: { prompt: 'x' }, outcome: 'y', steps: [],
      inputTruncated: true, inputProtectedDataOmitted: true, outcomeTruncated: true, outcomeProtectedDataOmitted: true,
      captureGap: true, gapReason: 'cap', stepsTruncated: true,
    })).toEqual({
      tool: 'run_browser_task', instruction: 'x', outcome: 'y', personTookOver: false, steps: [], createdAt: '',
      instructionTruncated: true, instructionProtectedDataOmitted: true, outcomeTruncated: true, outcomeProtectedDataOmitted: true,
      captureGap: true, gapReason: 'cap', stepsTruncated: true,
    });
    expect('stepsTruncated' in toRecordedCall({ tool: 'x', input: {}, outcome: '', stepsTruncated: false })).toBe(false);
  });

  it('renders a browser task\'s steps as sub-lines, and its completeness and change flags beside the entry', () => {
    const record = renderWorkRecord([
      { role: 'assistant', createdAt: '2026-09-15T22:10:00Z', toolTrail: [{
        tool: 'run_browser_task', input: { prompt: 'read the install guide [protected data omitted]' }, outcome: 'Read it.',
        inputProtectedDataOmitted: true, outcomeTruncated: true, captureGap: true, gapReason: 'reconciliation_uncertain', stepsTruncated: true,
        steps: [
          { type: 'goto', action: DOCS, pageUrl: '', actionTruncated: false, pageUrlTruncated: false, protectedDataOmitted: false, protectedKind: '', pageUrlProtectedDataOmitted: false, at: null },
          { type: 'act', action: 'click · the Requirements section', pageUrl: DOCS, actionTruncated: true, pageUrlTruncated: false, protectedDataOmitted: false, protectedKind: '', pageUrlProtectedDataOmitted: true, at: null },
          { type: 'act', action: 'type · into the API key field', pageUrl: DOCS, actionTruncated: false, pageUrlTruncated: false, protectedDataOmitted: true, protectedKind: 'authentication', pageUrlProtectedDataOmitted: false, at: null },
        ],
      }] },
    ] as never);
    expect(record).toEqual([
      '1. read the install guide [protected data omitted] → Read it. [part of the instruction is protected] [outcome cut short] [part of this task was not observed: the observed and reported steps could not be matched exactly] [older steps omitted from this record]',
      `   - goto ${DOCS}`,
      `   - act · click · the Requirements section (on ${DOCS}) [action cut short] [part of the address is protected]`,
      `   - act · type · into the API key field (on ${DOCS}) [authentication value not recorded]`,
    ]);
  });

  it('renders a record_gap sentinel as a missing range', () => {
    const record = renderWorkRecord([
      { role: 'assistant', createdAt: '2026-09-15T22:10:00Z', toolTrail: [
        { tool: 'run_capability', input: { capabilityId: 'cap_r.x' }, outcome: 'ok' },
        { tool: RECORD_GAP_TOOL, input: { omitted: 3 }, outcome: '3 later tool calls of this turn are not in the record', captureGap: true, gapReason: TOOL_CALL_CAP_REASON },
      ] },
    ] as never);
    expect(record).toEqual([
      '1. run_capability (capabilityId: cap_r.x) → ok',
      '2. [3 later tool calls of this turn are not in the record]',
    ]);
  });

  describe('segment placement', () => {
    const task = (steps: Array<[string, string | null]>) => ({
      tool: 'run_browser_task', input: { prompt: 'work through the open orders' }, outcome: 'Done.',
      steps: steps.map(([name, at]) => ({
        type: 'act', action: `click · ${name}`, pageUrl: ORDERS,
        actionTruncated: false, pageUrlTruncated: false, protectedDataOmitted: false, protectedKind: '', pageUrlProtectedDataOmitted: false, at,
      })),
    });
    const conversation = (steps: Array<[string, string | null]>) => [
      { role: 'user', createdAt: '2026-09-15T22:00:00Z', toolTrail: [] },
      { role: 'assistant', createdAt: '2026-09-15T22:20:00Z', toolTrail: [task(steps)] },
      { role: 'user', createdAt: '2026-09-15T22:30:00Z', toolTrail: [] },
      { role: 'assistant', createdAt: '2026-09-15T22:40:00Z', toolTrail: [{ tool: 'run_capability', input: { capabilityId: 'cap_r.x' }, outcome: 'ok' }] },
    ] as never;
    const timed: Array<[string, string]> = [
      ['Order 1042', '2026-09-15T22:05:00Z'],
      ['Order 1043', '2026-09-15T22:10:00Z'],
      ['Order 1044', '2026-09-15T22:15:00Z'],
    ];
    const clicked = (name: string, at: string) => action({ kind: 'click', url: ORDERS, tag: 'a', role: 'link', name, at });
    const line = (from: string, to: string, name: string) =>
      `The person drove the browser themselves (${from} to ${to}): on ${ORDERS}; clicked link "${name}"`;

    it('before the first timestamped sub-step', () => {
      const seg = segment('2026-09-15T22:01:00Z', '2026-09-15T22:02:00Z', [clicked('Order 1041', '2026-09-15T22:01:30Z')]);
      const record = renderWorkRecord(conversation(timed), [seg]);
      expect(record).toEqual([
        '1. work through the open orders → Done.',
        `2. ${line('22:01:00Z', '22:02:00Z', 'Order 1041')}`,
        `   - (step 1 continued) act · click · Order 1042 (on ${ORDERS})`,
        `   - (step 1 continued) act · click · Order 1043 (on ${ORDERS})`,
        `   - (step 1 continued) act · click · Order 1044 (on ${ORDERS})`,
        '3. run_capability (capabilityId: cap_r.x) → ok',
      ]);
    });

    it('between two timestamped sub-steps: after the last step before its start and before the first step after its end', () => {
      const seg = segment('2026-09-15T22:11:00Z', '2026-09-15T22:12:00Z', [clicked('Order 1050', '2026-09-15T22:11:30Z')]);
      const record = renderWorkRecord(conversation(timed), [seg]);
      expect(record).toEqual([
        '1. work through the open orders → Done.',
        `   - act · click · Order 1042 (on ${ORDERS})`,
        `   - act · click · Order 1043 (on ${ORDERS})`,
        `2. ${line('22:11:00Z', '22:12:00Z', 'Order 1050')}`,
        `   - (step 1 continued) act · click · Order 1044 (on ${ORDERS})`,
        '3. run_capability (capabilityId: cap_r.x) → ok',
      ]);
    });

    it('after the last timestamped sub-step, and after every message at the end', () => {
      const during = segment('2026-09-15T22:16:00Z', '2026-09-15T22:17:00Z', [clicked('Order 1045', '2026-09-15T22:16:30Z')]);
      const later = segment('2026-09-15T22:50:00Z', null, [clicked('Order 1099', '2026-09-15T22:50:30Z')], { live: true });
      const record = renderWorkRecord(conversation(timed), [later, during]);
      expect(record).toEqual([
        '1. work through the open orders → Done.',
        `   - act · click · Order 1042 (on ${ORDERS})`,
        `   - act · click · Order 1043 (on ${ORDERS})`,
        `   - act · click · Order 1044 (on ${ORDERS})`,
        `2. ${line('22:16:00Z', '22:17:00Z', 'Order 1045')}`,
        '3. run_capability (capabilityId: cap_r.x) → ok',
        `4. The person drove the browser themselves (from 22:50:00Z): on ${ORDERS}; clicked link "Order 1099" [still driving]`,
      ]);
    });

    it('a native step without a time of its own keeps its place beside the observed steps around it', () => {
      // The middle step is the vendor's own (the observer missed it): it
      // takes the preceding observed step's time, so a segment that ended
      // between the second and third observed times still goes after it.
      const mixed: Array<[string, string | null]> = [
        ['Order 1042', '2026-09-15T22:05:00Z'],
        ['Order 1043', null],
        ['Order 1044', '2026-09-15T22:15:00Z'],
      ];
      const seg = segment('2026-09-15T22:11:00Z', '2026-09-15T22:12:00Z', [clicked('Order 1050', '2026-09-15T22:11:30Z')]);
      const record = renderWorkRecord(conversation(mixed), [seg]);
      expect(record).toEqual([
        '1. work through the open orders → Done.',
        `   - act · click · Order 1042 (on ${ORDERS})`,
        `   - act · click · Order 1043 (on ${ORDERS})`,
        `2. ${line('22:11:00Z', '22:12:00Z', 'Order 1050')}`,
        `   - (step 1 continued) act · click · Order 1044 (on ${ORDERS})`,
        '3. run_capability (capabilityId: cap_r.x) → ok',
      ]);
      // A leading untimed step takes the first timed step's time.
      const leading: Array<[string, string | null]> = [['Order 1041', null], ['Order 1042', '2026-09-15T22:05:00Z']];
      const early = segment('2026-09-15T22:01:00Z', '2026-09-15T22:02:00Z', [clicked('Order 1000', '2026-09-15T22:01:30Z')]);
      expect(renderWorkRecord(conversation(leading), [early]).slice(0, 4)).toEqual([
        '1. work through the open orders → Done.',
        `2. ${line('22:01:00Z', '22:02:00Z', 'Order 1000')}`,
        `   - (step 1 continued) act · click · Order 1041 (on ${ORDERS})`,
        `   - (step 1 continued) act · click · Order 1042 (on ${ORDERS})`,
      ]);
    });

    it('falls back to after the turn when the sub-steps carry no timestamps', () => {
      const legacy: Array<[string, null]> = [['Order 1042', null], ['Order 1043', null]];
      const seg = segment('2026-09-15T22:11:00Z', '2026-09-15T22:12:00Z', [clicked('Order 1050', '2026-09-15T22:11:30Z')]);
      const record = renderWorkRecord(conversation(legacy), [seg]);
      expect(record).toEqual([
        '1. work through the open orders → Done.',
        `   - act · click · Order 1042 (on ${ORDERS})`,
        `   - act · click · Order 1043 (on ${ORDERS})`,
        `2. ${line('22:11:00Z', '22:12:00Z', 'Order 1050')}`,
        '3. run_capability (capabilityId: cap_r.x) → ok',
      ]);
    });

    it('a tie is broken by the order the runtime returned', () => {
      const first = segment('2026-09-15T22:11:00Z', '2026-09-15T22:11:30Z', [clicked('Order 1050', '2026-09-15T22:11:10Z')]);
      const second = segment('2026-09-15T22:11:00Z', '2026-09-15T22:11:40Z', [clicked('Order 1051', '2026-09-15T22:11:20Z')]);
      const record = renderWorkRecord(conversation(timed), [first, second]);
      expect(record.slice(3, 5)).toEqual([
        `2. ${line('22:11:00Z', '22:11:30Z', 'Order 1050')}`,
        `3. ${line('22:11:00Z', '22:11:40Z', 'Order 1051')}`,
      ]);
      const reversed = renderWorkRecord(conversation(timed), [second, first]);
      expect(reversed.slice(3, 5)).toEqual([
        `2. ${line('22:11:00Z', '22:11:40Z', 'Order 1051')}`,
        `3. ${line('22:11:00Z', '22:11:30Z', 'Order 1050')}`,
      ]);
    });

    it('a segment before every message goes first', () => {
      const seg = segment('2026-09-15T21:00:00Z', '2026-09-15T21:01:00Z', [clicked('Order 1000', '2026-09-15T21:00:30Z')]);
      const record = renderWorkRecord(conversation(timed), [seg]);
      expect(record[0]).toBe(`1. ${line('21:00:00Z', '21:01:00Z', 'Order 1000')}`);
      expect(record[1]).toBe('2. work through the open orders → Done.');
    });
  });
});

describe('describeSegment', () => {
  it('a point segment carries its kind through the record and opens as a point, never as a drive', () => {
    const point: TakeoverSegment = {
      ...segment('2026-09-15T22:05:07Z', '2026-09-15T22:05:07Z', [
        action({ kind: 'point', url: DOCS, tag: 'a', role: 'link', name: 'Sports', at: '2026-09-15T22:05:07Z' }),
      ]),
      kind: 'point',
    };
    expect(describeSegment(point)).toBe(`The person pointed in the browser (22:05:07Z): on ${DOCS}; pointed at link "Sports"`);
    const record = renderWorkRecord([
      { role: 'user', createdAt: '2026-09-15T22:00:00Z', toolTrail: [] },
      { role: 'assistant', createdAt: '2026-09-15T22:01:00Z', toolTrail: [{ tool: 'navigate_browser_session', input: { url: DOCS }, outcome: 'opened' }] },
    ] as never, [point]);
    expect(record[1]).toBe(`2. The person pointed in the browser (22:05:07Z): on ${DOCS}; pointed at link "Sports"`);
  });

  it('renders every action kind, the page named once when it changes, values quoted with JSON escaping and control characters removed', () => {
    const seg = segment('2026-09-15T22:05:07Z', '2026-09-15T22:06:39Z', [
      action({ kind: 'navigate', url: FORM, at: '2026-09-15T22:05:08Z' }),
      action({ kind: 'click', url: FORM, tag: 'input', role: 'textbox', name: 'Full name', inputType: 'text', at: '2026-09-15T22:05:10Z' }),
      action({ kind: 'change', url: FORM, tag: 'input', role: 'textbox', name: 'Full name', inputType: 'text', value: 'Ada "Countess" Lovelace', valueDisposition: 'recorded', at: '2026-09-15T22:05:20Z' }),
      action({ kind: 'change', url: FORM, tag: 'input', role: 'textbox', name: 'Password', inputType: 'password', valueDisposition: 'authentication_omitted', at: '2026-09-15T22:05:25Z' }),
      action({ kind: 'change', url: FORM, tag: 'input', role: 'textbox', name: 'Card number', inputType: 'text', valueDisposition: 'payment_omitted', at: '2026-09-15T22:05:26Z' }),
      action({ kind: 'change', url: FORM, tag: 'input', role: 'textbox', name: 'National ID', inputType: 'text', valueDisposition: 'sensitive_identity_omitted', at: '2026-09-15T22:05:27Z' }),
      action({ kind: 'change', url: FORM, tag: 'input', role: '', name: 'Attachment', inputType: 'file', valueDisposition: 'file_omitted', at: '2026-09-15T22:05:28Z' }),
      action({ kind: 'change', url: FORM, tag: 'textarea', role: 'textbox', name: 'Notes', valueDisposition: 'sensitive_text_omitted', at: '2026-09-15T22:05:29Z' }),
      action({ kind: 'enter', url: FORM, tag: 'input', role: 'textbox', name: 'Search', value: 'refund', valueDisposition: 'recorded', at: '2026-09-15T22:05:30Z' }),
      action({ kind: 'submit', url: FORM, tag: 'form', role: 'form', name: 'Intake', at: '2026-09-15T22:05:31Z' }),
      action({ kind: 'key', url: DOCS, tag: 'body', role: '', name: '', detail: 'Ctrl+F', at: '2026-09-15T22:05:40Z' }),
      action({ kind: 'scroll', url: DOCS, detail: 'scrolled to 40% of the page', at: '2026-09-15T22:05:41Z' }),
      action({ kind: 'drag', url: DOCS, tag: 'div', role: 'listitem', name: 'Step 2', detail: 'the Step 1 card', at: '2026-09-15T22:05:42Z' }),
      action({ kind: 'contextmenu', url: DOCS, tag: 'a', role: 'link', name: 'Download', at: '2026-09-15T22:05:43Z' }),
      action({ kind: 'hover', url: DOCS, tag: 'button', role: 'button', name: 'Copy', at: '2026-09-15T22:05:44Z' }),
    ]);
    expect(describeSegment(seg)).toBe(
      'The person drove the browser themselves (22:05:07Z to 22:06:39Z): '
      + `opened ${FORM}; `
      + 'clicked textbox "Full name"; '
      + 'entered "Ada \\"Countess\\" Lovelace" in textbox "Full name"; '
      + 'entered authentication data in textbox "Password" (not recorded); '
      + 'entered payment data in textbox "Card number" (not recorded); '
      + 'entered sensitive identity data in textbox "National ID" (not recorded); '
      + 'selected a file in input "Attachment" (not recorded); '
      + 'entered sensitive credential-shaped text in textbox "Notes" (not recorded); '
      + 'pressed Enter in textbox "Search" ("refund"); '
      + 'submitted form "Intake"; '
      + `on ${DOCS}; `
      + 'pressed Ctrl+F in an unnamed body; '
      + 'scrolled to 40% of the page; '
      + 'dragged the Step 1 card to listitem "Step 2"; '
      + 'opened the context menu on link "Download"; '
      + 'hovered over button "Copy"',
    );
  });

  it('renders the three suffixes, each closed gap reason as its phrase, and an unknown reason generically', () => {
    const steps = [action({ kind: 'click', url: ORDERS, tag: 'a', role: 'link', name: 'Order 1042', at: '2026-09-15T22:12:20Z' })];
    const base = `The person drove the browser themselves (from 22:12:00Z): on ${ORDERS}; clicked link "Order 1042"`;
    expect(describeSegment(segment('2026-09-15T22:12:00Z', null, steps, { captureGap: true, gapReason: 'lost_owner', live: true, stepsTruncated: true })))
      .toBe(`${base} [part of this segment was not observed: the browser was handed to another instance] [still driving] [older actions omitted from this read]`);
    for (const [reason, phrase] of [
      ['cap', 'the action limit was reached'],
      ['disabled', 'capture was off'],
      ['never_attached', 'the recorder could not attach'],
      ['frame_unavailable', 'a page or frame could not be observed'],
      ['not_answered', 'the browser did not answer'],
      ['something_new', 'part of it was not observed'],
    ]) {
      expect(describeSegment(segment('2026-09-15T22:12:00Z', null, steps, { captureGap: true, gapReason: reason })))
        .toBe(`${base} [part of this segment was not observed: ${phrase}]`);
    }
  });

  it('renders the explicit URL, name, value and detail truncation markers and every protected-text omission flag', () => {
    const seg = segment('2026-09-15T22:12:00Z', '2026-09-15T22:13:00Z', [
      action({ kind: 'navigate', url: `${ORDERS}&token=[redacted]`, urlTruncated: true, urlProtectedDataOmitted: true, at: '2026-09-15T22:12:05Z' }),
      action({ kind: 'change', url: `${ORDERS}&token=[redacted]`, tag: 'input', role: 'textbox', name: 'A very long label', nameTruncated: true, nameProtectedDataOmitted: true, value: 'a long value', valueDisposition: 'recorded', valueTruncated: true, at: '2026-09-15T22:12:10Z' }),
      action({ kind: 'key', url: `${ORDERS}&token=[redacted]`, tag: 'body', detail: 'Ctrl+', detailTruncated: true, detailProtectedDataOmitted: true, at: '2026-09-15T22:12:11Z' }),
      action({ kind: 'change', url: `${ORDERS}&token=[redacted]`, tag: 'input', role: 'textbox', name: 'Old field', valueDisposition: 'legacy_unavailable', at: '2026-09-15T22:12:12Z' }),
    ]);
    expect(describeSegment(seg)).toBe(
      'The person drove the browser themselves (22:12:00Z to 22:13:00Z): '
      + `opened ${ORDERS}&token=[redacted] [address cut short] [part of the address is protected]; `
      + 'entered "a long value" [value cut short] in textbox "A very long label" [name cut short] [part of the name is protected]; '
      + 'pressed Ctrl+ [detail cut short] [part of the detail is protected] in an unnamed body; '
      + 'entered a value in textbox "Old field" (not recorded) '
      + '[part of this segment was not observed: an entered value was not recorded]',
    );
  });

  it('a segment with no observed action says so', () => {
    expect(describeSegment(segment('2026-09-15T22:12:00Z', '2026-09-15T22:13:00Z', [])))
      .toBe('The person drove the browser themselves (22:12:00Z to 22:13:00Z): no action was observed');
  });
});
