// Whether a chat thread is visible to a caller, per surface.
//
// One dispatch for every reader of a share: creating a link must not mint one
// for a thread the caller cannot see, resolving must re-ask because threads
// soft-delete after a link exists, and an MCP conversation id (a share id)
// must open only what the dashboard would open for the same person.
//
// Three of the four kinds now answer the same way: agent chat always did, and
// insights and liftoff joined them in migration 351. Before that, those two
// surfaces applied an owner/admin-sees-all versus member/viewer-sees-own matrix,
// and that matrix broke sharing, which this dispatch exists to serve:
// a link opened for the person who created it and 404'd for the colleague they
// sent it to, because the reader failed the author check. Sharing a private
// thread is not something a share link could ever have fixed, so the surfaces
// stopped being private.
//
// The switch stays rather than collapsing to one call, because team_plan is
// genuinely different: its threads live in another service's database, so
// existence is an HTTP question, and workforce-service owns whatever rule it
// applies. Passing it the caller's identity is what keeps that possible.

import type { TenantMemberRole } from '../tenant-members/types';
import * as chatRepo from '../agent-chat/chat-repository';
import * as insightsChatRepo from '../insights/chat-repository';
import * as liftoffChatRepo from '../liftoff/chat-repository';
import type { ChatThreadKind } from './repository';
import { teamPlanThreadExists } from '../workforce-plans/team-plan-thread-client';

export async function threadVisibleToCaller(params: {
  threadKind: ChatThreadKind;
  threadId: string;
  tenantId: string;
  accountId: string;
  role: TenantMemberRole;
}): Promise<boolean> {
  const { threadKind, threadId, tenantId, accountId, role } = params;

  switch (threadKind) {
    case 'team_plan':
      // Team-plan threads live in the `workforce` database, so existence is
      // checked over HTTP with the caller's identity attached.
      return teamPlanThreadExists({ threadId, tenantId, accountId, role });

    case 'insights':
      return !!(await insightsChatRepo.getThread(threadId, tenantId));

    case 'liftoff':
      return !!(await liftoffChatRepo.getThread(threadId, tenantId));

    case 'agent':
    default:
      // Membership was established before we got here, so existence
      // (deleted_at IS NULL, right tenant) is the whole check.
      return !!(await chatRepo.getThread(threadId, tenantId));
  }
}
