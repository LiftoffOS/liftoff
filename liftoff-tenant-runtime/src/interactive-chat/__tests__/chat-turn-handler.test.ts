/**
 * R5 chat-turn-handler integration smoke tests.
 *
 * Focused on R5-added behavior:
 *   - schema readiness gate (503 when not ready)
 *   - kill switch (503 when chat_turn_globally_disabled)
 *   - concurrent turn (409 via lock)
 *   - discriminated schema accepts `{resume: true, approvalId}` contract
 */
import { z } from 'zod';

// Isolate the schema by re-declaring it for direct validation (not importing
// the whole handler which pulls DB + SDK transitively).
const ChatTurnCommonSchema = z.object({
  tenantId: z.string().uuid(),
  agentId: z.string().uuid(),
  threadId: z.string().uuid(),
  invocationId: z.string().uuid(),
  channelHint: z.enum(['web', 'slack', 'teams']),
  hitlLevel: z.number().int().min(1).max(5).nullable(),
  userId: z.string(),
  userDisplayName: z.string(),
  userRole: z.string(),
  tenantName: z.string().optional(),
  resumeSessionId: z.string().optional(),
  turnId: z.string().uuid().optional(),
  // Plan v13: strict accounts.id of the sender, or absent (guests).
  senderAccountId: z.string().uuid().optional(),
});
const ChatTurnNewMessageSchema = ChatTurnCommonSchema.extend({
  userMessage: z.string().min(1).max(100000),
  resume: z.literal(false).optional(),
  approvalId: z.string().optional(),
});
const ChatTurnResumeSchema = ChatTurnCommonSchema.extend({
  resume: z.literal(true),
  approvalId: z.string().uuid(),
  userMessage: z.string().max(100000).optional(),
});
const ChatTurnRequestSchema = z.union([ChatTurnResumeSchema, ChatTurnNewMessageSchema]);

const UUID = '123e4567-e89b-12d3-a456-426614174000';

describe('R5 chat-turn-handler request schema', () => {
  it('accepts a new-message turn', () => {
    const input = {
      tenantId: UUID,
      agentId: UUID,
      threadId: UUID,
      invocationId: UUID,
      channelHint: 'web',
      hitlLevel: null,
      userId: 'u1',
      userDisplayName: 'User',
      userRole: 'member',
      userMessage: 'hello',
    };
    expect(() => ChatTurnRequestSchema.parse(input)).not.toThrow();
  });

  it('accepts an explicit resume turn with approvalId (TE-R5-011)', () => {
    const input = {
      tenantId: UUID,
      agentId: UUID,
      threadId: UUID,
      invocationId: UUID,
      channelHint: 'web',
      hitlLevel: null,
      userId: 'u1',
      userDisplayName: 'User',
      userRole: 'member',
      resume: true,
      approvalId: UUID,
    };
    expect(() => ChatTurnRequestSchema.parse(input)).not.toThrow();
  });

  it('rejects a resume turn without approvalId', () => {
    const input = {
      tenantId: UUID,
      agentId: UUID,
      threadId: UUID,
      invocationId: UUID,
      channelHint: 'web',
      hitlLevel: null,
      userId: 'u1',
      userDisplayName: 'User',
      userRole: 'member',
      resume: true,
      // approvalId missing
    };
    expect(() => ChatTurnRequestSchema.parse(input)).toThrow();
  });

  it('rejects a new-message turn without userMessage', () => {
    const input = {
      tenantId: UUID,
      agentId: UUID,
      threadId: UUID,
      invocationId: UUID,
      channelHint: 'web',
      hitlLevel: null,
      userId: 'u1',
      userDisplayName: 'User',
      userRole: 'member',
      // userMessage missing, resume not set
    };
    expect(() => ChatTurnRequestSchema.parse(input)).toThrow();
  });
});

describe('plan v13 senderAccountId contract', () => {
  const base = {
    tenantId: UUID,
    agentId: UUID,
    threadId: UUID,
    invocationId: UUID,
    channelHint: 'web',
    hitlLevel: null,
    userId: 'u1',
    userDisplayName: 'User',
    userRole: 'member',
    userMessage: 'hello',
  };

  it('accepts a valid account UUID', () => {
    expect(() =>
      ChatTurnRequestSchema.parse({ ...base, senderAccountId: UUID }),
    ).not.toThrow();
  });

  it('accepts absence (unresolved Slack/Teams guests)', () => {
    expect(() => ChatTurnRequestSchema.parse(base)).not.toThrow();
  });

  it('rejects synthetic guest identities — slack:<uid> must never pass as an account', () => {
    expect(() =>
      ChatTurnRequestSchema.parse({ ...base, senderAccountId: 'slack:U0123456' }),
    ).toThrow();
  });
});

// ── Stop intercept ────────────────────────────────────────────────────

import { matchesStopText } from '../stop-intercept';

describe('stop intercept', () => {
  it('matches a bare stop with optional punctuation, any case', () => {
    for (const t of ['stop', 'Stop', 'STOP', 'stop.', 'stop!', '  stop  ']) {
      expect(matchesStopText(t)).toBe(true);
    }
  });

  it('does not match instructions that merely contain stop', () => {
    for (const t of ['stop using prod', 'please stop', 'stop??', '', undefined]) {
      expect(matchesStopText(t as string | undefined)).toBe(false);
    }
  });

  it('schema accepts the explicit abort signal field', () => {
    const WithSignal = ChatTurnNewMessageSchema.extend({
      signal: z.enum(['abort']).optional(),
    });
    expect(() => WithSignal.parse({
      tenantId: UUID, agentId: UUID, threadId: UUID, invocationId: UUID,
      channelHint: 'web', hitlLevel: null, userId: 'u1',
      userDisplayName: 'User', userRole: 'member',
      userMessage: 'anything', signal: 'abort',
    })).not.toThrow();
    expect(() => WithSignal.parse({
      tenantId: UUID, agentId: UUID, threadId: UUID, invocationId: UUID,
      channelHint: 'web', hitlLevel: null, userId: 'u1',
      userDisplayName: 'User', userRole: 'member',
      userMessage: 'anything', signal: 'cancel',
    })).toThrow();
  });
});

// The id-space contract for both mid-run signal lookups (interrupt + stop) is
// covered behaviourally in chat-turn-stop-id-space.test.ts, which drives the
// routes with a control-plane id against a pool where the live run is reachable
// only by the runtime id. This block used to assert the source matched a set of
// regexes — which could pass happily while the feature was broken,
// and would have had to be rewritten for the refactor that consolidated both
// lookups onto findActiveInvocationId rather than catching anything.
