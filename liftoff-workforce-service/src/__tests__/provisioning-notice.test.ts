// The sentence at the end of provisioning.
//
// The CAIO promises "they will appear on the Teams page shortly", and without
// this notice it says nothing again. A multi-team plan can take minutes, so a
// plan that succeeds completely still looks, as far as the chat is concerned,
// as if nothing had happened.
//
// The notice must be accurate in every terminal shape, because it is the only
// thing the person will read: claiming a failed team is ready is worse than the
// silence it replaces.

jest.mock('../infrastructure/logging.js', () => ({
  log: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const mockAppendMessage = jest.fn();
jest.mock('../workforce-plans/chat-repository.js', () => ({
  createTurn: jest.fn(),
  appendMessage: (...a: unknown[]) => mockAppendMessage(...a),
}));

const mockWithTenantContext = jest.fn();
jest.mock('../infrastructure/rls.js', () => ({
  withTenantContext: (tenantId: string, fn: unknown) => mockWithTenantContext(tenantId, fn),
}));

const mockMirror = jest.fn();
jest.mock('../workforce-plans/mirror.js', () => ({
  mirrorNoticeToLiftoff: (...a: unknown[]) => mockMirror(...a),
}));

const mockNotify = jest.fn();
jest.mock('../workforce-plans/reply-notification.js', () => ({
  notifyTeamPlanReply: (...a: unknown[]) => mockNotify(...a),
}));

import {
  buildProvisioningNotice,
  postProvisioningNotice,
} from '../workforce-plans/provisioning-notice.js';

const TENANT = 'dd7d80bd-3b77-4677-817c-053fdb8668cd';
const PLAN = 'plan-1';
const THREAD = 'thread-1';

/** Stand in for the tenant-scoped client, returning one thread id. */
function threadLookupReturns(threadId: string | null) {
  mockWithTenantContext.mockImplementation(async (_t: string, fn: (c: unknown) => unknown) =>
    fn({ query: async () => ({ rows: threadId ? [{ id: threadId }] : [] }) }),
  );
}

beforeEach(() => {
  jest.clearAllMocks();
  threadLookupReturns(THREAD);
  mockAppendMessage.mockResolvedValue({ id: 'm1' });
  mockMirror.mockResolvedValue(true);
  mockNotify.mockResolvedValue(undefined);
});

// The person chose Launch Now, and the sentence says what starting came to,
// in the workspace's own words when it could not.
describe('buildProvisioningNotice with launch outcomes', () => {
  it('says the teams started', () => {
    const text = buildProvisioningNotice(
      [
        { specId: 's1', name: 'Lead Research', provisioningStatus: 'completed' },
        { specId: 's2', name: 'Outreach', provisioningStatus: 'completed' },
      ],
      new Map([['s1', { started: true }], ['s2', { started: true }]]),
    );
    expect(text).toBe('Lead Research and Outreach are set up and started.');
  });

  it('carries the workspace\'s own reason for a team that could not start, and where it is', () => {
    const text = buildProvisioningNotice(
      [
        { specId: 's1', name: 'Lead Research', provisioningStatus: 'completed' },
        { specId: 's2', name: 'Outreach', provisioningStatus: 'completed' },
      ],
      new Map([
        ['s1', { started: true }],
        ['s2', { started: false, reason: 'required_connector_missing', message: 'Outreach needs Gmail connected before it can start.' }],
      ]),
    );
    expect(text).toBe(
      'Lead Research is set up and started. ' +
      'Outreach is set up but could not start: Outreach needs Gmail connected before it can start. ' +
      'It is on the Teams page in draft status. Once that is resolved, ask me to start it and I will.',
    );
  });

  it('says nothing started when the workspace has no plan, and still offers the failed one again', () => {
    const text = buildProvisioningNotice(
      [
        { specId: 's1', name: 'Lead Research', provisioningStatus: 'completed' },
        { specId: 's2', name: 'Outreach', provisioningStatus: 'failed' },
      ],
      new Map([['s1', { started: false, reason: 'payment_required', message: 'This workspace needs an active plan before agents can run. Please subscribe to a plan to continue.' }]]),
    );
    expect(text).toBe(
      'Lead Research is set up but could not start: This workspace needs an active plan before agents can run. Please subscribe to a plan to continue. ' +
      'It is on the Teams page in draft status. Once that is resolved, ask me to start it and I will. ' +
      'Outreach could not be set up. Ask me to try that one again when you are ready.',
    );
  });

  it('never claims a team that has no outcome started', () => {
    const text = buildProvisioningNotice(
      [{ specId: 's1', name: 'Lead Research', provisioningStatus: 'completed' }],
      new Map(),
    );
    expect(text).toContain('Lead Research is set up but could not start: It was not started.');
  });
});

// The notice is told to the person where they asked; platform-backend decides
// where that is from the thread's own binding.
describe('postProvisioningNotice tells the approver', () => {
  it('notifies the approver with the thread and the text, between turns', async () => {
    await postProvisioningNotice({
      tenantId: TENANT,
      planId: PLAN,
      specs: [{ specId: 's1', name: 'Lead Research', provisioningStatus: 'completed' }],
      launches: new Map([['s1', { started: true }]]),
      accountId: 'acct-approver',
    });
    expect(mockNotify).toHaveBeenCalledWith({
      tenantId: TENANT,
      accountId: 'acct-approver',
      threadId: THREAD,
      text: 'Lead Research is set up and started.',
      via: null,
    });
  });

  it('tells nobody beyond the thread when the plan has no recorded approver', async () => {
    await postProvisioningNotice({
      tenantId: TENANT,
      planId: PLAN,
      specs: [{ name: 'Lead Research', provisioningStatus: 'completed' }],
      accountId: null,
    });
    expect(mockAppendMessage).toHaveBeenCalledTimes(1);
    expect(mockNotify).not.toHaveBeenCalled();
  });
});

describe('buildProvisioningNotice', () => {
  it('names one team and points at the Teams page', () => {
    const text = buildProvisioningNotice([
      { name: 'Lead Research', provisioningStatus: 'completed' },
    ]);

    expect(text).toBe(
      'Lead Research is set up. It is on the Teams page in draft status, ready for you to review and start it.',
    );
  });

  it('names two teams with the plural form', () => {
    const text = buildProvisioningNotice([
      { name: 'Lead Research', provisioningStatus: 'completed' },
      { name: 'Outbound Outreach', provisioningStatus: 'completed' },
    ]);

    expect(text).toContain('Lead Research and Outbound Outreach are set up.');
    expect(text).toContain('They are on the Teams page');
  });

  it('lists three or more with a final "and"', () => {
    const text = buildProvisioningNotice([
      { name: 'A', provisioningStatus: 'completed' },
      { name: 'B', provisioningStatus: 'completed' },
      { name: 'C', provisioningStatus: 'completed' },
    ]);

    expect(text).toContain('A, B and C are set up.');
  });

  it('says plainly when nothing was created', () => {
    const text = buildProvisioningNotice([
      { name: 'Lead Research', provisioningStatus: 'failed' },
      { name: 'Outbound Outreach', provisioningStatus: 'failed' },
    ]);

    expect(text).toContain('could not be set up, so nothing was created');
    expect(text).not.toContain('Teams page');
  });

  it('reports a partial outcome without claiming the failed one is ready', () => {
    const text = buildProvisioningNotice([
      { name: 'Lead Research', provisioningStatus: 'failed' },
      { name: 'Outbound Outreach', provisioningStatus: 'completed' },
    ]);

    expect(text).toContain('Outbound Outreach is set up and on the Teams page');
    expect(text).toContain('review and start it');
    expect(text).toContain('Lead Research could not be set up');
    expect(text).toContain('try that one again');
  });

  it('treats a skipped spec as neither created nor failed', () => {
    // 'skipped' is deliberate non-action, not an outcome to report. Announcing
    // it as ready would be the same class of lie as the connector catalog
    // reporting an absent app as unsupported.
    const text = buildProvisioningNotice([
      { name: 'Already There', provisioningStatus: 'skipped' },
      { name: 'Lead Research', provisioningStatus: 'completed' },
    ]);

    expect(text).toContain('Lead Research is set up.');
    expect(text).not.toContain('Already There');
  });

  it('says nothing at all when every spec was skipped', () => {
    expect(
      buildProvisioningNotice([{ name: 'Already There', provisioningStatus: 'skipped' }]),
    ).toBeNull();
  });

  it('says nothing for an empty plan', () => {
    expect(buildProvisioningNotice([])).toBeNull();
  });

  it('falls back to a readable label when a spec has no name', () => {
    const text = buildProvisioningNotice([{ provisioningStatus: 'completed' }]);
    expect(text).toContain('agent 1 is set up.');
  });

  it('names the button that exists, and no synonym for it', () => {
    // The Teams page button reads "Start Team". It has never read Activate or
    // Launch: the one "Activate Team" string in the frontend is in a Storybook
    // file. This sentence is the last thing somebody reads before being asked to
    // act, so a wrong verb sends them looking for a control that is not there.
    // "activate" and "launch" are both natural English for this, which is
    // exactly why this needs a test rather than care.
    const samples = [
      buildProvisioningNotice([{ name: 'A', provisioningStatus: 'completed' }]),
      buildProvisioningNotice([
        { name: 'A', provisioningStatus: 'completed' },
        { name: 'B', provisioningStatus: 'completed' },
      ]),
      buildProvisioningNotice([
        { name: 'A', provisioningStatus: 'completed' },
        { name: 'B', provisioningStatus: 'failed' },
      ]),
    ];

    for (const text of samples) {
      expect(text).toMatch(/review and start (it|them)\./);
      expect(text).not.toMatch(/activate/i);
      expect(text).not.toMatch(/launch/i);
    }
  });

  it('agrees with itself about one team versus several', () => {
    expect(buildProvisioningNotice([{ name: 'A', provisioningStatus: 'completed' }]))
      .toContain('review and start it.');
    expect(
      buildProvisioningNotice([
        { name: 'A', provisioningStatus: 'completed' },
        { name: 'B', provisioningStatus: 'completed' },
      ]),
    ).toContain('review and start them.');
  });

  it('obeys the product voice rules the CAIO prompt enforces', () => {
    // This text is composed in code, so nothing else checks it. No em dash, no
    // contractions, and never the word "agent" for a team.
    const samples = [
      buildProvisioningNotice([{ name: 'A', provisioningStatus: 'completed' }]),
      buildProvisioningNotice([{ name: 'A', provisioningStatus: 'failed' }]),
      buildProvisioningNotice([
        { name: 'A', provisioningStatus: 'completed' },
        { name: 'B', provisioningStatus: 'failed' },
      ]),
    ];

    for (const text of samples) {
      expect(text).not.toMatch(/—/);
      expect(text).not.toMatch(/\b\w+'(t|re|ve|ll|s)\b/);
      expect(text).not.toMatch(/\bagents?\b/i);
    }
  });
});

describe('postProvisioningNotice', () => {
  const specs = [{ name: 'Lead Research', provisioningStatus: 'completed' }];

  it('writes into the plan thread and mirrors to Liftoff', async () => {
    await postProvisioningNotice({ tenantId: TENANT, planId: PLAN, specs });

    expect(mockAppendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ threadId: THREAD, tenantId: TENANT, role: 'assistant' }),
    );
    expect(mockMirror).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: TENANT, delegateThreadId: THREAD }),
    );
  });

  it('writes the plan thread FIRST, so a failed mirror costs a copy not the notice', async () => {
    const order: string[] = [];
    mockAppendMessage.mockImplementation(async () => {
      order.push('append');
      return { id: 'm1' };
    });
    mockMirror.mockImplementation(async () => {
      order.push('mirror');
      return true;
    });

    await postProvisioningNotice({ tenantId: TENANT, planId: PLAN, specs });

    expect(order).toEqual(['append', 'mirror']);
  });

  it('posts nothing when the plan has no chat thread', async () => {
    threadLookupReturns(null);

    await postProvisioningNotice({ tenantId: TENANT, planId: PLAN, specs });

    expect(mockAppendMessage).not.toHaveBeenCalled();
    expect(mockMirror).not.toHaveBeenCalled();
  });

  it('posts nothing when there is nothing to announce', async () => {
    await postProvisioningNotice({
      tenantId: TENANT,
      planId: PLAN,
      specs: [{ name: 'Already There', provisioningStatus: 'skipped' }],
    });

    expect(mockAppendMessage).not.toHaveBeenCalled();
  });

  it('never throws, because the caller has already recorded the plan as terminal', async () => {
    // A notice that cannot be delivered must not fail the Cloud Task, which
    // would retry provisioning work that already succeeded.
    mockAppendMessage.mockRejectedValue(new Error('db down'));

    await expect(
      postProvisioningNotice({ tenantId: TENANT, planId: PLAN, specs }),
    ).resolves.toBeUndefined();
  });

  it('still delivers the notice when the mirror fails', async () => {
    mockMirror.mockRejectedValue(new Error('pb unreachable'));

    await expect(
      postProvisioningNotice({ tenantId: TENANT, planId: PLAN, specs }),
    ).resolves.toBeUndefined();
    expect(mockAppendMessage).toHaveBeenCalled();
  });
});
