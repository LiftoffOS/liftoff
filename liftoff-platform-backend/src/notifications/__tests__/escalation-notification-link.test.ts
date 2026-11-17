/**
 * Where an escalation notification sends the reader, and where it must not.
 *
 * Three different things arrive as type 'escalation':
 *
 *   'blocker' / 'clarification' — the run PARKED. There is a row in the review
 *     queue, answering it resumes the work, and a "Review now" button is right.
 *   'escalation' — the run ENDED and left a record. Records left the customer
 *     queue when it narrowed to parked runs, so a link to /dashboard/review
 *     promises an item that is not there: the reader arrives at their other
 *     pending work, or at an empty queue, having been told something needs
 *     their attention.
 *
 * A terminal escalation now DOES have an honest destination: it opens a chat
 * thread and links to that. What it still must never do is point at the review
 * queue. The escalation's own threadId is not the linkable one either — for an
 * autonomous run it belongs to the RUNTIME's `threads` table while
 * /dashboard/agents/chat reads `agent_chat_threads` here.
 *
 * Two traps pinned here. First, the dead queue link was reinstated in TWO
 * places: the router hardcoded it AND the email renderer falls back to
 * REVIEW_LINK whenever eventLink is absent, so removing it from one alone
 * changes nothing. Second, both cards used to hardcode review-queue WORDING for
 * whatever url they were handed — under which a chat link reads "answer it in
 * the review queue" and goes somewhere else entirely.
 */
import { escalationLeadLine } from '../email';
import { buildReviewCard } from '../../agent-chat/teams-adapter/cards';
import { buildReviewBlocks } from '../../agent-chat/slack-adapter/review-dm-notifier';

describe('escalationLeadLine', () => {
  it('does not claim a terminal escalation needs approval', () => {
    // Nothing is approvable: the run is over. Saying "approval" sends someone
    // hunting for an Approve button that cannot exist.
    const line = escalationLeadLine('Ops Copilot', 'escalation');
    expect(line).not.toMatch(/approval/i);
    expect(line).toBe('Ops Copilot stopped and needs you to know why.');
  });

  it('says a blocker needs an action taken', () => {
    expect(escalationLeadLine('Ops Copilot', 'blocker')).toBe(
      'Ops Copilot cannot continue until someone acts.',
    );
  });

  it('says a clarification needs an answer', () => {
    expect(escalationLeadLine('Ops Copilot', 'clarification')).toBe(
      'Ops Copilot is waiting on an answer.',
    );
  });

  it('treats an unstated kind as terminal, which is what an older runtime sends', () => {
    expect(escalationLeadLine('Ops Copilot', undefined)).toBe(
      'Ops Copilot stopped and needs you to know why.',
    );
  });

  it('obeys the copy rules for every variant', () => {
    for (const kind of ['blocker', 'clarification', 'escalation', undefined] as const) {
      const line = escalationLeadLine('Ops Copilot', kind);
      expect(line).not.toMatch(/\bagent\b/i);
      expect(line).not.toContain('—');
      expect(line).not.toMatch(/\w'\w/);
    }
  });
});

describe('the cards only point at the queue when the queue holds it', () => {
  // The real builders, not a restatement of the rule. `linkUrl` empty is how
  // the router says "this record has no queue item".
  it('Teams shows the button for a parked run', () => {
    const card = buildReviewCard({
      agentName: 'Ops Copilot',
      reviewId: 'r1',
      notice: { reason: 'Share the sheet', linkUrl: 'https://app.example.com/dashboard/review' },
    });
    const json = JSON.stringify(card);
    expect(json).toContain('Open review queue');
    expect(json).toContain('/dashboard/review');
  });

  it('Teams omits the button for a terminal record', () => {
    const card = buildReviewCard({
      agentName: 'Ops Copilot',
      reviewId: 'r1',
      notice: { reason: 'Eighteen duplicate rows found; nothing written', linkUrl: '' },
    });
    const json = JSON.stringify(card);
    expect(json).not.toContain('Open review queue');
    expect(json).not.toContain('/dashboard/review');
    // The substance still reaches the reader.
    expect(json).toContain('Eighteen duplicate rows found');
  });

  it('Slack shows the queue line for a parked run', () => {
    const blocks = buildReviewBlocks(
      { reviewId: 'r1', tenantId: 't', agentId: 'a', assigneeAccountIds: [],
        notice: true, noticeReason: 'Share the sheet',
        noticeLinkUrl: 'https://app.example.com/dashboard/review' } as never,
      'channel', 'Ops Copilot',
    );
    expect(JSON.stringify(blocks)).toContain('review queue');
  });

  it('Slack omits the queue line for a terminal record', () => {
    const blocks = buildReviewBlocks(
      { reviewId: 'r1', tenantId: 't', agentId: 'a', assigneeAccountIds: [],
        notice: true, noticeReason: 'Eighteen duplicate rows found; nothing written' } as never,
      'channel', 'Ops Copilot',
    );
    const json = JSON.stringify(blocks);
    expect(json).not.toContain('review queue');
    expect(json).not.toContain('/dashboard/review');
    expect(json).toContain('Eighteen duplicate rows found');
  });
});

describe('a terminal escalation points at its conversation, never at the queue', () => {
  it('Teams labels a chat link for what it is', () => {
    const card = buildReviewCard({
      agentName: 'Ops Copilot',
      reviewId: 'r1',
      notice: {
        reason: 'Grant the service account access to the sheet',
        linkUrl: 'https://app.example.com/dashboard/agents/chat?agentId=a1&thread=t1',
        linkKind: 'chat',
      },
    });
    const json = JSON.stringify(card);
    expect(json).toContain('Open the conversation');
    // The label that would send the reader to a page without the item on it.
    expect(json).not.toContain('Open review queue');
    expect(json).not.toContain('/dashboard/review');
  });

  it('Teams still says review queue for a parked run', () => {
    const card = buildReviewCard({
      agentName: 'Ops Copilot',
      reviewId: 'r1',
      notice: { reason: 'Share the sheet', linkUrl: 'https://app.example.com/dashboard/review', linkKind: 'review' },
    });
    expect(JSON.stringify(card)).toContain('Open review queue');
  });

  it('Slack words a chat link as a conversation, not as the queue', () => {
    const blocks = buildReviewBlocks(
      { reviewId: 'r1', tenantId: 't', agentId: 'a', assigneeAccountIds: [],
        notice: true, noticeReason: 'Grant access',
        noticeLinkUrl: 'https://app.example.com/dashboard/agents/chat?agentId=a1&thread=t1',
        noticeLinkKind: 'chat' } as never,
      'channel', 'Ops Copilot',
    );
    const json = JSON.stringify(blocks);
    expect(json).toContain('the conversation');
    expect(json).not.toContain('review queue');
    expect(json).not.toContain('/dashboard/review');
  });

  it('Slack still says review queue for a parked run', () => {
    const blocks = buildReviewBlocks(
      { reviewId: 'r1', tenantId: 't', agentId: 'a', assigneeAccountIds: [],
        notice: true, noticeReason: 'Share the sheet',
        noticeLinkUrl: 'https://app.example.com/dashboard/review',
        noticeLinkKind: 'review' } as never,
      'channel', 'Ops Copilot',
    );
    expect(JSON.stringify(blocks)).toContain('review queue');
  });

  it('says nothing at all when there is nowhere to send anyone', () => {
    const blocks = buildReviewBlocks(
      { reviewId: 'r1', tenantId: 't', agentId: 'a', assigneeAccountIds: [],
        notice: true, noticeReason: 'Provider unreachable' } as never,
      'channel', 'Ops Copilot',
    );
    const json = JSON.stringify(blocks);
    expect(json).not.toContain('review queue');
    expect(json).not.toContain('the conversation');
  });
});
