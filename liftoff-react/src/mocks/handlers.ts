// Combined MSW handlers for development and testing
// This file aggregates all domain-specific handlers

import { accountHandlers } from './handlers/account'
import { agentChatHandlers } from './handlers/agentChat'
import { internalAgentsHandlers } from './handlers/internalAgents'
import { activityLogsHandlers } from './handlers/activityLogs'
import { oversightHandlers } from './handlers/oversight'
import { connectorsHandlers } from './handlers/connectors'
import { tenantsHandlers } from './handlers/tenants'
import { tenantMembersHandlers } from './handlers/tenantMembers'
import { externalAgentsHandlers } from './handlers/externalAgents'
import { correctionsHandlers } from './handlers/corrections'
import { personAssignmentsHandlers } from './handlers/personAssignments'
import { inviteRequestsHandlers } from './handlers/inviteRequests'
import { insightsHandlers } from './handlers/insights'
import { liftoffScoreHandlers } from './handlers/liftoffScore'
import { claudeCodeProxyHandlers } from './handlers/claudeCodeProxy'
import { agentTemplatesHandlers } from './handlers/agentTemplates'
import { agentMemoryHandlers } from './handlers/agentMemories'
import { billingHandlers } from './handlers/billing'
import { workforceHandlers } from './handlers/workforce'
import { knowledgeHandlers } from './handlers/knowledge'
import { browserSessionsHandlers } from './handlers/browserSessions'
import { sourceMigrationsHandlers } from './handlers/sourceMigrations'
import { referralsHandlers } from './handlers/referrals'
import { oauthConsentHandlers } from './handlers/oauthConsent'

export const handlers = [
  ...oauthConsentHandlers,
  ...sourceMigrationsHandlers,
  ...workforceHandlers,
  ...accountHandlers,
  ...agentChatHandlers,
  ...internalAgentsHandlers,
  ...activityLogsHandlers,
  ...oversightHandlers,
  ...connectorsHandlers,
  ...tenantsHandlers,
  ...tenantMembersHandlers,
  ...externalAgentsHandlers,
  ...correctionsHandlers,
  ...personAssignmentsHandlers,
  ...inviteRequestsHandlers,
  ...insightsHandlers,
  ...liftoffScoreHandlers,
  ...claudeCodeProxyHandlers,
  ...agentTemplatesHandlers,
  ...agentMemoryHandlers,
  ...billingHandlers,
  ...knowledgeHandlers,
  ...browserSessionsHandlers,
  ...referralsHandlers,
]
