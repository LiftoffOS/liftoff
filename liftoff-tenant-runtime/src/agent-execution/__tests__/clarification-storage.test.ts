/**
 * Storage primitive shared by recovery-LLM and Anchor-intervention pause paths.
 * Verifies:
 *   - recovery_llm rows persist the full HybridResumeState
 *   - anchor_intervention rows persist a minimal pauseContext blob so the
 *     unified listing query's JSONB path resolves uniformly
 *   - DB column mapping for clarification_source / vendor_request_id
 *   - missing pauseState on recovery_llm throws (no silent NULL)
 *   - A1: the durable notification fires once per blocker, only where nobody is
 *     watching, and re-arms once the row leaves 'pending'
 */
import { insertClarificationRow } from '../clarification-storage';

const enqueueEscalationNotificationMock = jest.fn();
const resolveInternalAgentIdMock = jest.fn();

jest.mock('../../platform-callback/client', () => ({
  // The BYOK session opener asks the control plane whose key funds a run.
  // Null here means "no callback configured", which is the managed path and
  // exactly the behaviour these tests were written against.
  getPlatformCallbackClient: jest.fn(() => null),
  enqueueEscalationNotification: (...args: unknown[]) =>
    enqueueEscalationNotificationMock(...args),
}));
jest.mock('../../agent-lifecycle/resolve-runtime-agent-id', () => ({
  resolveInternalAgentId: (...args: unknown[]) => resolveInternalAgentIdMock(...args),
}));

const clientQueryMock = jest.fn();
const mockClient = { query: (...args: unknown[]) => clientQueryMock(...args) } as never;

/** Respond by STATEMENT, not by call position.
 *
 *  recovery_llm makes one more query than anchor_intervention (the dedup
 *  lookup), so a positional queue silently mis-feeds one of the two paths and
 *  fails somewhere unrelated. Dispatching on the SQL keeps each test honest and
 *  survives future queries being added. `dedupRows` lets a test simulate an
 *  already-open clarification. */
function primeClient(
  dedupRows: Array<{
    id: string; thread_id: string; notified_at?: Date | null;
    clarification_origin?: string | null; original_question?: string | null;
  }> = [],
) {
  clientQueryMock.mockReset();
  enqueueEscalationNotificationMock.mockReset();
  enqueueEscalationNotificationMock.mockResolvedValue(undefined);
  resolveInternalAgentIdMock.mockReset();
  resolveInternalAgentIdMock.mockResolvedValue('internal-a');
  clientQueryMock.mockImplementation(async (sql: string) => {
    if (/UPDATE agent_scheduled_invocations/i.test(sql)) return { rows: [] };
    if (/FROM agent_scheduled_invocations/i.test(sql)) return { rows: dedupRows };
    if (/INSERT INTO threads/i.test(sql)) return { rows: [{ id: 'new-th' }] };
    if (/INSERT INTO messages/i.test(sql)) return { rows: [] };
    if (/INSERT INTO agent_scheduled_invocations/i.test(sql)) return { rows: [{ id: 'sched-1' }] };
    throw new Error(`unexpected query: ${sql.slice(0, 80)}`);
  });
}

/** Locate a recorded query by statement rather than by call index. */
function findCall(fragment: string): [string, unknown[]] {
  const call = clientQueryMock.mock.calls.find(
    (c) => typeof c[0] === 'string' && (c[0] as string).includes(fragment),
  );
  if (!call) throw new Error(`no query matched: ${fragment}`);
  return call as [string, unknown[]];
}

beforeEach(() => primeClient());

describe('insertClarificationRow', () => {
  describe('recovery_llm source', () => {
    it('persists the full HybridResumeState into workflow_resume_payload', async () => {
      const pauseState = {
        kind: 'hybrid-pause',
        pauseReason: 'ask_user',
        // Any extra HybridResumeState fields flow through.
        recoveryHistory: [{ note: 'one' }],
      } as never;

      const { scheduledRowId, threadId } = await insertClarificationRow({
        client: mockClient,
        tenantId: 't',
        agentId: 'a',
        invocationId: 'inv-1',
        threadId: 'th-1',
        pausedAtStepId: 'step-1',
        question: 'Continue?',
        source: { kind: 'recovery_llm' },
        pauseState,
        interactive: true,
      });

      expect(scheduledRowId).toBe('sched-1');
      expect(threadId).toBe('th-1');

      const scheduledInsert = findCall('INSERT INTO agent_scheduled_invocations');
      const sql = scheduledInsert[0] as string;
      const params = scheduledInsert[1] as unknown[];

      expect(sql).toContain('clarification_source');
      expect(sql).toContain('vendor_request_id');

      // params[6]=objective, params[8]=workflow_resume_payload JSON,
      // params[9]=clarification_source, params[10]=vendor_request_id
      expect(params[6]).toBe('clarification-expiry');
      const payload = JSON.parse(params[8] as string);
      expect(payload.kind).toBe('hybrid-pause');
      expect(payload.pauseReason).toBe('ask_user');
      expect(payload.pauseContext).toEqual({ originalQuestion: 'Continue?', threadId: 'th-1' });
      expect(payload.recoveryHistory).toEqual([{ note: 'one' }]);
      expect(params[9]).toBe('recovery_llm');
      expect(params[10]).toBeNull();
    });

    it('dedupes against an unanswered clarification instead of asking again', async () => {
      // The recovery advisor sits on the common anomaly path and can now pick
      // ask_user. A pause releases the per-agent lock and closes its trigger
      // row, so a scheduled agent keeps ticking — without this an agent on a
      // 1-minute cron whose blocker recurs would open 1,440 clarifications a
      // day, each with its own thread, question and 24h expiry task.
      primeClient([{ id: 'sched-existing', thread_id: 'th-existing' }]);

      const { scheduledRowId, threadId } = await insertClarificationRow({
        client: mockClient,
        tenantId: 't',
        agentId: 'a',
        invocationId: 'inv-9',
        threadId: null,
        pausedAtStepId: null,
        question: 'Which sheet?',
        source: { kind: 'recovery_llm' },
        pauseState: { kind: 'hybrid-pause' } as never,
        interactive: false,
      });

      expect(scheduledRowId).toBe('sched-existing');
      expect(threadId).toBe('th-existing');
      // Nothing new written: no second question posted at the user, no second
      // expiry task armed.
      const statements = clientQueryMock.mock.calls.map(c => c[0] as string);
      expect(statements.some(s => s.includes('INSERT INTO messages'))).toBe(false);
      expect(statements.some(s => s.includes('INSERT INTO agent_scheduled_invocations'))).toBe(false);
      expect(statements.some(s => s.includes('INSERT INTO threads'))).toBe(false);
    });

    it('scopes dedup to recovery_llm — chat clarifications are unaffected', async () => {
      // anchor_intervention is user-initiated and one per turn; it must not be
      // suppressed by an unrelated open advisor question.
      primeClient([{ id: 'sched-existing', thread_id: 'th-existing' }]);

      const { scheduledRowId } = await insertClarificationRow({
        client: mockClient,
        tenantId: 't',
        agentId: 'a',
        invocationId: 'inv-10',
        threadId: 'th-2',
        pausedAtStepId: null,
        question: 'Click button?',
        source: { kind: 'anchor_intervention', vendorRequestId: 'r' },
        pauseState: null,
        interactive: true,
      });

      expect(scheduledRowId).toBe('sched-1');
    });

    it('throws when pauseState is null (recovery_llm requires state)', async () => {
      await expect(insertClarificationRow({
        client: mockClient,
        tenantId: 't',
        agentId: 'a',
        invocationId: 'inv-1',
        threadId: 'th-1',
        pausedAtStepId: null,
        question: 'q?',
        source: { kind: 'recovery_llm' },
        pauseState: null,
        interactive: false,
      })).rejects.toThrow(/HybridResumeState/);
    });
  });

  describe('anchor_intervention source', () => {
    it('persists a minimal pauseContext blob (no HybridResumeState) and the vendorRequestId column', async () => {
      const { scheduledRowId } = await insertClarificationRow({
        client: mockClient,
        tenantId: 't',
        agentId: 'a',
        invocationId: 'inv-2',
        threadId: 'th-2',
        pausedAtStepId: null,
        question: 'Click button?',
        source: { kind: 'anchor_intervention', vendorRequestId: 'req-42' },
        pauseState: null,
        interactive: true,
      });

      expect(scheduledRowId).toBe('sched-1');
      const params = findCall('INSERT INTO agent_scheduled_invocations')[1] as unknown[];
      const payload = JSON.parse(params[8] as string);
      // Verifies the design decision in the plan: the JSONB path
      // workflow_resume_payload->'pauseContext'->>'originalQuestion' resolves
      // identically in both sources for the unified listing query.
      expect(payload).toEqual({
        pauseContext: { originalQuestion: 'Click button?', threadId: 'th-2' },
      });
      // No HybridResumeState fields leaked in.
      expect(payload.kind).toBeUndefined();
      expect(payload.pauseReason).toBeUndefined();
      expect(params[9]).toBe('anchor_intervention');
      expect(params[10]).toBe('req-42');
      // Listed on the review page: every row not parked under "Only
      // exceptions" is, and an absent `notify` reads as true.
      expect(params[13]).toBe(true);
    });
  });

  describe('thread creation when threadId is null', () => {
    beforeEach(() => primeClient());

    it('creates a new thread with a "Clarification needed: ..." title', async () => {
      const { threadId } = await insertClarificationRow({
        client: mockClient,
        tenantId: 't',
        agentId: 'a',
        invocationId: 'inv-3',
        threadId: null,
        pausedAtStepId: null,
        question: 'Long question text exceeds eighty characters? '.repeat(3),
        source: { kind: 'anchor_intervention', vendorRequestId: 'r' },
        pauseState: null,
        interactive: true,
      });
      expect(threadId).toBe('new-th');
      const threadInsert = findCall('INSERT INTO threads');
      expect(threadInsert[0]).toContain('INSERT INTO threads');
      const title = threadInsert[1][2] as string;
      expect(title.startsWith('Clarification needed: ')).toBe(true);
      // The plan caps the question at 80 chars when generating the title (truncated with ...)
      expect(title.length).toBeLessThanOrEqual('Clarification needed: '.length + 80);
    });
  });

  // A1: a parked blocker used to be an escalation, and escalations notified.
  // These pin the three things that regression cost us: that somebody is told,
  // that a recurring blocker tells them once, and that the telling comes back
  // once the question has been answered.
  describe('durable notification (A1)', () => {
    /** The shape the recovery advisor produces for a scheduled run: no stream
     *  sink, so nobody is watching. `threadId` varies — a first blocker has
     *  none, a blocker after a resume carries the thread forward — and that is
     *  deliberately NOT what decides whether anyone is told. */
    function parkPauseNobodyIsWatching(
      question = 'Share the sheet with the service account',
      threadId: string | null = null,
    ) {
      return insertClarificationRow({
        client: mockClient,
        tenantId: 't',
        agentId: 'a',
        invocationId: 'inv-a1',
        threadId,
        pausedAtStepId: null,
        question,
        source: { kind: 'recovery_llm' },
        pauseState: { kind: 'hybrid-pause' } as never,
        interactive: false,
      });
    }

    it('fires exactly one notification, through the escalation sender', async () => {
      await parkPauseNobodyIsWatching();

      expect(enqueueEscalationNotificationMock).toHaveBeenCalledTimes(1);
      expect(enqueueEscalationNotificationMock).toHaveBeenCalledWith({
        tenantId: 't',
        agentId: 'a',
        // Translated out of runtime space: PB's recipient lookup reads
        // internal_agents, which a raw runtime id matches silently and wrongly.
        internalAgentId: 'internal-a',
        invocationId: 'inv-a1',
        // The clarification row is this record's identity.
        escalationId: 'sched-1',
        reason: 'Share the sheet with the service account',
        threadId: 'new-th',
        // Unstated origin reads as a question, which is the pre-existing
        // behaviour every row written before migration 352 relies on.
        recordKind: 'clarification',
      });
      expect(resolveInternalAgentIdMock).toHaveBeenCalledWith('t', 'a', 'clarification-notify');
    });

    it('under the Escalation setting "Only exceptions", a question still parks and writes its row, and nobody is told (notify: false)', async () => {
      // The setting changes notification, not correctness: the run cannot
      // proceed without the value, so the row is written and the run pauses.
      const { scheduledRowId, deduped } = await insertClarificationRow({
        client: mockClient,
        tenantId: 't',
        agentId: 'a',
        invocationId: 'inv-a1',
        threadId: null,
        pausedAtStepId: 's2',
        question: 'Which sheet should I write to?',
        source: { kind: 'recovery_llm', origin: 'question' },
        pauseState: { kind: 'hybrid-pause' } as never,
        interactive: false,
        notify: false,
      });
      expect(scheduledRowId).toBe('sched-1');
      expect(deduped).toBe(false);
      const [sql, params] = findCall('INSERT INTO agent_scheduled_invocations') as [string, unknown[]];
      expect(enqueueEscalationNotificationMock).not.toHaveBeenCalled();
      // Not an item on the review page either: the same decision files the
      // row under the run's paused state (review_listed, migration 430), and
      // the review queue's predicate reads that column.
      expect(sql).toContain('review_listed');
      expect(params[13]).toBe(false);
      // The dedup retry respects it too: an open row nobody was told about
      // stays untold under the setting.
      primeClient([{ id: 'sched-open', thread_id: 'th-open', notified_at: null, clarification_origin: 'question' }]);
      await insertClarificationRow({
        client: mockClient, tenantId: 't', agentId: 'a', invocationId: 'inv-a1', threadId: null, pausedAtStepId: 's2',
        question: 'Which sheet should I write to?', source: { kind: 'recovery_llm', origin: 'question' },
        pauseState: { kind: 'hybrid-pause' } as never, interactive: false, notify: false,
      });
      expect(enqueueEscalationNotificationMock).not.toHaveBeenCalled();
    });

    it('sends nothing on a second tick while the question is still open', async () => {
      // The dedup finds the open row and returns early. A 1-minute cron hitting
      // the same blocker must not send 1,440 notifications a day.
      //
      // notified_at is set because that is what "already told" means: the flood
      // this guards against is a SECOND telling. An open row nobody was told
      // about is a different case, covered by the retry test below.
      primeClient([{ id: 'sched-open', thread_id: 'th-open', notified_at: new Date() }]);

      const { scheduledRowId } = await parkPauseNobodyIsWatching();

      expect(scheduledRowId).toBe('sched-open');
      expect(enqueueEscalationNotificationMock).not.toHaveBeenCalled();
    });

    it('notifies again once the previous question has been answered', async () => {
      // Answering enqueues a resume that marks the row 'fired', so the dedup
      // lookup finds nothing and the next blocker is a fresh occurrence.
      primeClient([{ id: 'sched-open', thread_id: 'th-open', notified_at: new Date() }]);
      await parkPauseNobodyIsWatching();
      expect(enqueueEscalationNotificationMock).not.toHaveBeenCalled();

      primeClient();
      await parkPauseNobodyIsWatching('The sheet is still not shared');

      expect(enqueueEscalationNotificationMock).toHaveBeenCalledTimes(1);
      expect(enqueueEscalationNotificationMock.mock.calls[0][0]).toMatchObject({
        reason: 'The sheet is still not shared',
      });
    });

    it('notifies a blocker raised after a resume, which carries a threadId', async () => {
      // The regression this guards: a run resumed once its question was
      // answered gets ctx.threadId set to the blocker thread, so treating "has
      // a threadId" as "a person is here" silences the second blocker
      // completely. The answer came back through Cloud Tasks; nobody is
      // watching that thread.
      await parkPauseNobodyIsWatching('The sheet is shared but is read-only', 'th-blocker');

      expect(enqueueEscalationNotificationMock).toHaveBeenCalledTimes(1);
      expect(enqueueEscalationNotificationMock.mock.calls[0][0]).toMatchObject({
        threadId: 'th-blocker',
        reason: 'The sheet is shared but is read-only',
      });
    });

    it('stays silent for an interactive-chat clarification', async () => {
      // A live chat turn carries a stream sink, so somebody is reading the
      // reply as it arrives. Notifying them about the question on their screen
      // is noise.
      await insertClarificationRow({
        client: mockClient,
        tenantId: 't',
        agentId: 'a',
        invocationId: 'inv-chat',
        threadId: 'th-live',
        pausedAtStepId: null,
        question: 'Which of these two addresses?',
        source: { kind: 'recovery_llm' },
        pauseState: { kind: 'hybrid-pause' } as never,
        interactive: true,
      });

      expect(enqueueEscalationNotificationMock).not.toHaveBeenCalled();
    });

    it('stays silent for an anchor_intervention hand-off', async () => {
      await insertClarificationRow({
        client: mockClient,
        tenantId: 't',
        agentId: 'a',
        invocationId: 'inv-anchor',
        threadId: null,
        pausedAtStepId: null,
        question: 'Solve the captcha',
        source: { kind: 'anchor_intervention', vendorRequestId: 'r' },
        pauseState: null,
        // Deliberately the notifying value, so this proves the source guard
        // does the suppressing on its own rather than riding the audience gate.
        interactive: false,
      });

      expect(enqueueEscalationNotificationMock).not.toHaveBeenCalled();
    });

    it('still parks the run when the notification fails', async () => {
      // The pause row is the thing that matters: the queue is the backstop when
      // the notification cannot be sent.
      enqueueEscalationNotificationMock.mockRejectedValue(new Error('platform down'));

      const { scheduledRowId, threadId } = await parkPauseNobodyIsWatching();

      expect(scheduledRowId).toBe('sched-1');
      expect(threadId).toBe('new-th');
      expect(findCall('INSERT INTO agent_scheduled_invocations')).toBeTruthy();
    });

    it('stamps notified_at only after the send succeeds', async () => {
      await parkPauseNobodyIsWatching();

      const stamp = findCall('UPDATE agent_scheduled_invocations');
      expect(stamp[0]).toContain('notified_at = NOW()');
      expect(stamp[1]).toEqual(['sched-1']);
    });

    it('leaves notified_at unset when the send fails, so a retry is possible', async () => {
      enqueueEscalationNotificationMock.mockRejectedValue(new Error('platform down'));

      await parkPauseNobodyIsWatching();

      const stamped = clientQueryMock.mock.calls.some(
        c => typeof c[0] === 'string' && (c[0] as string).includes('notified_at = NOW()'),
      );
      expect(stamped).toBe(false);
    });

    it('retries on a later tick when the open row was never notified', async () => {
      // The dedup suppresses a second ASK. It must not suppress a first TELL:
      // if the earlier send failed, nobody knows the run is parked, and
      // returning early again would leave it that way until the window lapsed.
      primeClient([{
        id: 'sched-open', thread_id: 'th-open', notified_at: null,
        original_question: 'Share the sheet with the service account',
      }]);

      await parkPauseNobodyIsWatching('A differently worded retry of the same blocker');

      expect(enqueueEscalationNotificationMock).toHaveBeenCalledTimes(1);
      expect(enqueueEscalationNotificationMock.mock.calls[0][0]).toMatchObject({
        escalationId: 'sched-open',
        threadId: 'th-open',
        // The question that is actually parked, not this tick's rephrasing of
        // it: the latter was never asked and appears in no thread or queue.
        reason: 'Share the sheet with the service account',
      });
      expect(findCall('UPDATE agent_scheduled_invocations')[1]).toEqual(['sched-open']);
      // A notification links to the review queue, so the row it announces is
      // listed there: a question parked under "Only exceptions" that this
      // tick announces (the setting changed since) becomes an item.
      expect(findCall('UPDATE agent_scheduled_invocations')[0]).toContain('review_listed = true');
    });

    it('does not re-notify an open row somebody was already told about', async () => {
      primeClient([{ id: 'sched-open', thread_id: 'th-open', notified_at: new Date() }]);

      await parkPauseNobodyIsWatching();

      expect(enqueueEscalationNotificationMock).not.toHaveBeenCalled();
    });

    it('announces a blocker as a blocker and a question as a question', async () => {
      await parkPauseNobodyIsWatching();
      expect(enqueueEscalationNotificationMock.mock.calls[0][0]).toMatchObject({
        recordKind: 'clarification',
      });

      primeClient();
      await insertClarificationRow({
        client: mockClient,
        tenantId: 't',
        agentId: 'a',
        invocationId: 'inv-b',
        threadId: null,
        pausedAtStepId: null,
        question: 'Share the sheet with the service account',
        source: { kind: 'recovery_llm', origin: 'blocker' },
        pauseState: { kind: 'hybrid-pause' } as never,
        interactive: false,
      });
      expect(enqueueEscalationNotificationMock.mock.calls[0][0]).toMatchObject({
        recordKind: 'blocker',
      });
    });
  });

  // A2 and A3.2: a blocker is not a question, and the row has to say so.
  describe('blocker origin', () => {
    async function park(origin: 'question' | 'blocker' | undefined) {
      primeClient();
      await insertClarificationRow({
        client: mockClient,
        tenantId: 't',
        agentId: 'a',
        invocationId: 'inv-o',
        threadId: null,
        pausedAtStepId: null,
        question: 'Share the sheet with the service account',
        source: { kind: 'recovery_llm', origin },
        pauseState: { kind: 'hybrid-pause' } as never,
        interactive: false,
      });
    }

    it('titles a blocker thread "Blocked:" rather than "Clarification needed:"', async () => {
      await park('blocker');
      expect(findCall('INSERT INTO threads')[1][2]).toBe(
        'Blocked: Share the sheet with the service account',
      );
    });

    it('keeps the clarification title for a question', async () => {
      await park('question');
      expect(findCall('INSERT INTO threads')[1][2]).toBe(
        'Clarification needed: Share the sheet with the service account',
      );
    });

    it('persists the origin, defaulting an unstated one to question', async () => {
      await park('blocker');
      expect(findCall('INSERT INTO agent_scheduled_invocations')[1][11]).toBe('blocker');

      await park(undefined);
      expect(findCall('INSERT INTO agent_scheduled_invocations')[1][11]).toBe('question');
    });

    it('holds a blocker open for a week and a question for a day', async () => {
      const before = Date.now();
      await park('blocker');
      const blockerFiresAt = findCall('INSERT INTO agent_scheduled_invocations')[1][5] as Date;
      // Seven days, allowing for the clock moving during the test.
      const blockerDays = (blockerFiresAt.getTime() - before) / (24 * 60 * 60 * 1000);
      expect(blockerDays).toBeGreaterThan(6.9);
      expect(blockerDays).toBeLessThan(7.1);

      await park('question');
      const questionFiresAt = findCall('INSERT INTO agent_scheduled_invocations')[1][5] as Date;
      const questionDays = (questionFiresAt.getTime() - before) / (24 * 60 * 60 * 1000);
      expect(questionDays).toBeGreaterThan(0.9);
      expect(questionDays).toBeLessThan(1.1);
    });
  });
});
