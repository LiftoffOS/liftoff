// Chat-turn attribution backfill — matcher + job tests (plan v13 Change 5).
// Covers: sanity-bound (outbox-delayed timestamps are NOT the matcher),
// duplicate identical user messages, redaction collisions, truncated
// objectives, failed turns (no reply / interleaved), competing assistant
// candidates, idempotency, mid-turn rollback, HMAC equality across the
// export/match boundary, and the fingerprint-mismatch zero-writes abort.

import {
  planThreadAssignments,
  SANITY_BOUND_MS,
  type ExportRow,
  type ThreadMessage,
} from '../chat-turn-backfill/matcher';
import {
  computeSanitizerFingerprint,
  hmacSanitized,
  sanitizeContent,
} from '../chat-turn-backfill/sanitizer-contract';

const T0 = '2026-07-17T21:00:00.000Z';
const at = (offsetSec: number) => new Date(Date.parse(T0) + offsetSec * 1000).toISOString();

const KEY = Buffer.from('run-scoped-test-key');
const TENANT = '11111111-1111-1111-1111-111111111111';
const AGENT = '22222222-2222-2222-2222-222222222222';
const THREAD = '33333333-3333-3333-3333-333333333333';
const SENDER = '44444444-4444-4444-4444-444444444444';

let seq = 0;
function row(overrides: Partial<ExportRow> = {}): ExportRow {
  seq += 1;
  return {
    tenantId: TENANT,
    internalAgentId: AGENT,
    threadId: THREAD,
    invocationId: `00000000-0000-4000-8000-${String(seq).padStart(12, '0')}`,
    originalCreatedAt: at(0),
    senderAccountId: SENDER,
    objectiveHmac: hmacSanitized(KEY, sanitizeContent('hello world')),
    truncated: false,
    ...overrides,
  };
}

function userMsg(id: string, content: string, offsetSec: number, turnId: string | null = null): ThreadMessage {
  return {
    id,
    role: 'user',
    agentId: null,
    createdAt: at(offsetSec),
    turnId,
    contentHmac: turnId === null ? hmacSanitized(KEY, sanitizeContent(content)) : undefined,
  };
}

function assistantMsg(id: string, offsetSec: number, agentId: string = AGENT, turnId: string | null = null): ThreadMessage {
  return { id, role: 'assistant', agentId, createdAt: at(offsetSec), turnId };
}

describe('planThreadAssignments', () => {
  it('attributes a clean turn (HMAC equality across the export/match boundary)', () => {
    const r = row({ objectiveHmac: hmacSanitized(KEY, sanitizeContent('hello world')) });
    const plan = planThreadAssignments(
      [r],
      [userMsg('u1', 'hello world', 0), assistantMsg('a1', 5)],
    );
    expect(plan.assignments).toEqual([
      { row: r, userMessageId: 'u1', assistantMessageId: 'a1' },
    ]);
  });

  it('matches on SANITIZED equality — raw content containing PII still matches its redacted objective', () => {
    const raw = 'email me at somebody@example.com about the launch';
    const r = row({ objectiveHmac: hmacSanitized(KEY, sanitizeContent(raw)) });
    const plan = planThreadAssignments(
      [r],
      [userMsg('u1', raw, 0), assistantMsg('a1', 5)],
    );
    expect(plan.assignments).toHaveLength(1);
  });

  it('ignores delayed timestamps within the sanity bound and skips beyond it', () => {
    const ok = planThreadAssignments(
      [row({ originalCreatedAt: at(3600) })], // 1h drift: outbox-style delay, fine
      [userMsg('u1', 'hello world', 0), assistantMsg('a1', 5)],
    );
    expect(ok.assignments).toHaveLength(1);

    const beyond = planThreadAssignments(
      [row({ originalCreatedAt: new Date(Date.parse(T0) + SANITY_BOUND_MS + 60_000).toISOString() })],
      [userMsg('u1', 'hello world', 0), assistantMsg('a1', 5)],
    );
    expect(beyond.assignments).toHaveLength(0);
    expect(beyond.skips.sanityBound).toBe(1);
  });

  it('skips duplicate identical user messages', () => {
    const plan = planThreadAssignments(
      [row()],
      [userMsg('u1', 'hello world', 0), userMsg('u2', 'hello world', 10), assistantMsg('a1', 15)],
    );
    expect(plan.assignments).toHaveLength(0);
    expect(plan.skips.duplicateUser).toBe(1);
  });

  it('skips redaction collisions (two different raws, same sanitized value)', () => {
    // Both redact to identical strings ("my email is [EMAIL]" style), so both
    // candidates carry the same HMAC — indistinguishable, unprovable.
    const rawA = 'my email is alice@example.com';
    const rawB = 'my email is bob@example.com';
    const sameSanitized = sanitizeContent(rawA);
    expect(sanitizeContent(rawB)).toBe(sameSanitized);
    const r = row({ objectiveHmac: hmacSanitized(KEY, sameSanitized) });
    const plan = planThreadAssignments(
      [r],
      [userMsg('u1', rawA, 0), userMsg('u2', rawB, 10), assistantMsg('a1', 15)],
    );
    expect(plan.assignments).toHaveLength(0);
    expect(plan.skips.duplicateUser).toBe(1);
  });

  it('skips truncated objectives and reports them', () => {
    const plan = planThreadAssignments(
      [row({ truncated: true })],
      [userMsg('u1', 'hello world', 0), assistantMsg('a1', 5)],
    );
    expect(plan.assignments).toHaveLength(0);
    expect(plan.skips.truncated).toBe(1);
  });

  it('skips two audit rows competing for one user message', () => {
    const plan = planThreadAssignments(
      [row(), row()],
      [userMsg('u1', 'hello world', 0), assistantMsg('a1', 5)],
    );
    expect(plan.assignments).toHaveLength(0);
    expect(plan.skips.competingAudit).toBe(2);
  });

  it('does NOT misattribute a failed turn: the next reply after an intervening user message is not stolen', () => {
    const r1 = row({ objectiveHmac: hmacSanitized(KEY, sanitizeContent('first question')) });
    const r2 = row({ objectiveHmac: hmacSanitized(KEY, sanitizeContent('second question')) });
    const plan = planThreadAssignments(
      [r1, r2],
      [
        userMsg('u1', 'first question', 0),   // turn failed — no reply
        userMsg('u2', 'second question', 60),
        assistantMsg('a1', 65),               // belongs to u2
      ],
    );
    expect(plan.assignments).toEqual([
      { row: r2, userMessageId: 'u2', assistantMessageId: 'a1' },
    ]);
    expect(plan.skips.interleaved).toBe(1);
  });

  it('skips when no attributable assistant reply exists at all', () => {
    const plan = planThreadAssignments(
      [row()],
      [userMsg('u1', 'hello world', 0), assistantMsg('a1', 5, 'some-other-agent')],
    );
    expect(plan.assignments).toHaveLength(0);
    expect(plan.skips.noAssistant).toBe(1);
  });

  it('is idempotent at plan level: already-attributed messages are never candidates', () => {
    const plan = planThreadAssignments(
      [row()],
      [
        userMsg('u1', 'hello world', 0, 'existing-turn'),
        assistantMsg('a1', 5, AGENT, 'existing-turn'),
      ],
    );
    expect(plan.assignments).toHaveLength(0);
    expect(plan.skips.noUserMatch).toBe(1);
  });
});

// ── Job-level: fingerprint gate + rollback ────────────────────────────

const mockDownload = jest.fn();
const mockDelete = jest.fn().mockResolvedValue(undefined);
const mockAccessSecretVersion = jest.fn();
const mockDestroySecretVersion = jest.fn().mockResolvedValue(undefined);

jest.mock('@google-cloud/storage', () => ({
  Storage: jest.fn(() => ({
    bucket: jest.fn(() => ({
      file: jest.fn(() => ({ download: mockDownload, delete: mockDelete })),
    })),
  })),
}));

jest.mock('@google-cloud/secret-manager', () => ({
  SecretManagerServiceClient: jest.fn(() => ({
    accessSecretVersion: mockAccessSecretVersion,
    destroySecretVersion: mockDestroySecretVersion,
  })),
}));

const mockScopedQuery = jest.fn();
jest.mock('../../infrastructure/database', () => ({
  withTenantScope: jest.fn(async (_tenantId: string, fn: (client: { query: typeof mockScopedQuery }) => unknown) =>
    fn({ query: mockScopedQuery })),
  closePools: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../../infrastructure/logging', () => ({
  log: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import { runBackfill } from '../backfill-chat-turn-attribution';

describe('runBackfill fingerprint gate', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.BACKFILL_EXPORT_BUCKET = 'test-bucket';
    process.env.BACKFILL_EXPORT_OBJECT = 'runs/test/export.jsonl';
    process.env.BACKFILL_HMAC_SECRET = 'projects/example-project/secrets/s/versions/1';
    delete process.env.BACKFILL_DRY_RUN;
  });

  it('aborts with ZERO writes on sanitizer fingerprint mismatch — and still cleans up', async () => {
    const header = {
      kind: 'chat-turn-attribution-export',
      sanitizerFingerprint: 'not-the-local-fingerprint',
      protoGenVersion: '0.12.0',
      exportedAt: new Date().toISOString(),
    };
    mockDownload.mockResolvedValueOnce([Buffer.from(JSON.stringify(header) + '\n')]);

    await expect(runBackfill()).rejects.toThrow('sanitizer contract fingerprint mismatch');
    expect(mockScopedQuery).not.toHaveBeenCalled();          // zero writes
    expect(mockAccessSecretVersion).not.toHaveBeenCalled();  // aborted before key load
    expect(mockDelete).toHaveBeenCalled();                   // cleanup ran
    expect(mockDestroySecretVersion).toHaveBeenCalled();
  });

  it('proceeds past the gate when the fingerprint matches', async () => {
    const header = {
      kind: 'chat-turn-attribution-export',
      sanitizerFingerprint: computeSanitizerFingerprint(),
      protoGenVersion: '0.13.0',
      exportedAt: new Date().toISOString(),
    };
    mockDownload.mockResolvedValueOnce([Buffer.from(JSON.stringify(header) + '\n')]);
    mockAccessSecretVersion.mockResolvedValueOnce([
      { payload: { data: Buffer.from(KEY.toString('base64')) } },
    ]);

    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => undefined);
    await runBackfill();
    logSpy.mockRestore();
    expect(mockAccessSecretVersion).toHaveBeenCalled();
    expect(mockDelete).toHaveBeenCalled();
    expect(mockDestroySecretVersion).toHaveBeenCalled();
  });

  it('mid-turn rollback: an affected-row check failure counts as rollback, not attribution', async () => {
    const header = {
      kind: 'chat-turn-attribution-export',
      sanitizerFingerprint: computeSanitizerFingerprint(),
      protoGenVersion: '0.13.0',
      exportedAt: new Date().toISOString(),
    };
    const exportRow: ExportRow = {
      tenantId: TENANT,
      internalAgentId: AGENT,
      threadId: THREAD,
      invocationId: '00000000-0000-4000-8000-00000000beef',
      originalCreatedAt: at(0),
      senderAccountId: SENDER,
      objectiveHmac: hmacSanitized(KEY, sanitizeContent('hello world')),
      truncated: false,
    };
    mockDownload.mockResolvedValueOnce([
      Buffer.from(JSON.stringify(header) + '\n' + JSON.stringify(exportRow) + '\n'),
    ]);
    mockAccessSecretVersion.mockResolvedValueOnce([
      { payload: { data: Buffer.from(KEY.toString('base64')) } },
    ]);

    // Load phase: thread row + messages.
    mockScopedQuery
      .mockResolvedValueOnce({ rows: [{ channel: 'web', deleted_at: null }] })
      .mockResolvedValueOnce({
        rows: [
          { id: 'u1', role: 'user', agent_id: null, content: 'hello world', created_at: new Date(T0), turn_id: null },
          { id: 'a1', role: 'assistant', agent_id: AGENT, content: 'reply', created_at: new Date(Date.parse(T0) + 5000), turn_id: null },
        ],
      })
      // Apply phase: turn INSERT ok, user UPDATE ok, assistant UPDATE FAILS the check.
      .mockResolvedValueOnce({ rowCount: 1 })
      .mockResolvedValueOnce({ rowCount: 1 })
      .mockResolvedValueOnce({ rowCount: 0 });

    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => undefined);
    await runBackfill();

    const printed = JSON.parse(logSpy.mock.calls.slice(-1)[0][0]);
    logSpy.mockRestore();
    expect(printed.backfillReport.web.rollbacks).toBe(1);
    expect(printed.backfillReport.web.attributed).toBe(0);
  });
});
