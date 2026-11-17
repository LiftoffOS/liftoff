// Mock internal agents data for development
// This file is gitignored - copy from internalAgents.template.ts if missing

import type { InternalAgent, InternalAgentVersion } from '../../services/internalAgents'

export function generateMockInternalAgents(): InternalAgent[] {
  const now = new Date().toISOString()
  return [
    {
      id: 'internal-agent-sales-001',
      role: 'Sales Outreach Agent',
      responsibilities: `## Responsibilities
Qualify inbound leads and assess fit based on company size, industry, and budget
## Goals
Increase qualified demo bookings by 40% while maintaining lead quality scores above 85%
## Workflows
Monitor new lead submissions, enrich with company data, score against ICP criteria, send personalized follow-up sequences
## Instructions
Always verify email deliverability before sending. Use casual but professional tone. Include relevant case studies based on industry.
## Outcomes
Qualified leads scheduled for demos with complete context notes for sales team`,
      additionalContext: `## Specific instructions
Focus on enterprise leads with 500+ employees first
## Rules
Never send more than 3 follow-up emails without a response
## Constraints
Only schedule demos during business hours in the prospect's timezone
## Edge cases
If prospect replies with out-of-office, pause sequence and resume when they return
## Anything to avoid
Avoid mentioning competitor names or making direct price comparisons`,
      integrations: [
        { id: 'salesforce', selectedObjects: ['Lead', 'Contact', 'Opportunity'] },
        { id: 'google_mail', selectedObjects: ['Emails', 'Drafts'] },
        { id: 'slack', selectedObjects: ['Messages', 'Channels'] },
        { id: 'google_calendar', selectedObjects: ['Events', 'Availability'] },
        { id: 'hubspot', selectedObjects: ['Contacts', 'Deals'] },
        { id: 'linkedin', selectedObjects: ['Connections', 'Messages'] },
        { id: 'google_sheets', selectedObjects: ['Spreadsheets'] },
        { id: 'zoom', selectedObjects: ['Meetings'] },
        { id: 'twilio', selectedObjects: ['Calls', 'SMS'] },
        { id: 'ext-agent-8', selectedObjects: [] },   // Calendar Manager
        { id: 'ext-agent-14', selectedObjects: [] },  // CRM Connector
      ],
      summary: 'AI-powered sales assistant that automates outbound prospecting workflows, qualifies inbound leads based on ICP criteria, and sends personalized follow-up sequences. Integrates with your CRM to maintain accurate records and schedule demos automatically.',
      temperature: 0.7,
      status: 'active',
      currentVersion: 3,
      tasksCompleted: 1247,
      tasks30d: 312,
      monthlyCost: 89.50,
      createdAt: '2024-01-15T10:00:00Z',
      updatedAt: now,
      lastActive: now,
      messagingNickname: null,
      lastActivity: null,
      lastActivityAction: null,
      workflowVisualizationSteps: null,
      autonomyOverride: null,
      aiVendorOverride: null,
    },
    {
      id: 'internal-agent-support-002',
      role: 'Customer Support Bot',
      responsibilities: `## Responsibilities
Triage incoming support requests and provide first-response assistance for common issues
## Goals
Resolve 60% of tickets without human escalation while maintaining 95%+ CSAT scores
## Workflows
Categorize tickets by type and urgency, search knowledge base for solutions, draft responses, escalate complex issues
## Instructions
Always acknowledge the customer's frustration before providing solutions. Include relevant help article links.
## Outcomes
Quick resolution for common issues, properly categorized and enriched tickets for escalations`,
      additionalContext: `## Specific instructions
Prioritize VIP customers (Enterprise tier) for immediate escalation if unresolved in 2 messages
## Rules
Never share internal system information or debug logs with customers
## Constraints
Response time must be under 5 minutes for first reply
## Edge cases
For billing disputes over $500, always escalate to finance team regardless of cause
## Anything to avoid
Avoid making promises about refunds or credits without manager approval`,
      integrations: [
        { id: 'zendesk', selectedObjects: ['Ticket', 'User'] },
        { id: 'slack', selectedObjects: ['Messages', 'Channels'] },
        { id: 'google_mail', selectedObjects: ['Emails'] },
        { id: 'notion', selectedObjects: ['Pages', 'Databases'] },
        { id: 'confluence', selectedObjects: ['Pages', 'Spaces'] },
        { id: 'jira', selectedObjects: ['Issues', 'Projects'] },
        { id: 'microsoft_teams', selectedObjects: ['Messages', 'Channels'] },
        { id: 'sentry', selectedObjects: ['Errors', 'Issues'] },
        { id: 'datadog', selectedObjects: ['Logs', 'Alerts'] },
        { id: 'ext-agent-2', selectedObjects: [] },   // Customer Support Assistant
        { id: 'ext-agent-9', selectedObjects: [] },   // Translation Service
        { id: 'ext-agent-19', selectedObjects: [] },  // Knowledge Base Search
      ],
      summary: 'First-line support bot that triages incoming tickets, searches the knowledge base for solutions, and provides instant responses to common issues. Escalates complex cases to human agents with full context and suggested resolutions.',
      temperature: 0.5,
      status: 'active',
      currentVersion: 5,
      tasksCompleted: 3892,
      tasks30d: 1024,
      monthlyCost: 156.00,
      createdAt: '2024-01-10T08:30:00Z',
      updatedAt: now,
      lastActive: now,
      messagingNickname: null,
      lastActivity: null,
      lastActivityAction: null,
      workflowVisualizationSteps: null,
      autonomyOverride: null,
      aiVendorOverride: null,
    },
    {
      id: 'internal-agent-onboarding-003',
      role: 'Onboarding Coordinator',
      responsibilities: `## Responsibilities
Guide new customers through product setup and ensure successful activation within first 14 days
## Goals
Achieve 80% activation rate with customers completing at least 3 core workflows
## Workflows
Send welcome sequence, monitor setup progress, provide proactive tips, schedule check-in calls when needed
## Instructions
Personalize messages based on customer's stated use case. Celebrate small wins to build momentum.
## Outcomes
Fully activated customers with clear understanding of product value`,
      integrations: [
        { id: 'hubspot', selectedObjects: ['Contact', 'Deal'] },
        { id: 'ext-agent-6', selectedObjects: [] },   // Email Sender
        { id: 'ext-agent-18', selectedObjects: [] },  // SMS Gateway
      ],
      summary: 'Guides new customers through product setup with personalized welcome sequences and proactive tips. Monitors activation milestones, celebrates progress, and schedules check-in calls when customers need additional support.',
      temperature: 0.6,
      status: 'active',
      currentVersion: 2,
      tasksCompleted: 456,
      tasks30d: 142,
      monthlyCost: 45.00,
      createdAt: '2024-02-01T14:00:00Z',
      updatedAt: now,
      lastActive: now,
      messagingNickname: null,
      lastActivity: null,
      lastActivityAction: null,
      workflowVisualizationSteps: null,
      autonomyOverride: null,
      aiVendorOverride: null,
    },
    {
      id: 'internal-agent-billing-004',
      role: 'Billing Assistant',
      responsibilities: `## Responsibilities
Process subscription changes, handle refund requests, and send payment reminders
## Goals
Reduce billing-related support tickets by 50% through proactive communication
## Workflows
Monitor failed payments, send dunning emails, process approved refunds, update subscription tiers
## Instructions
Always verify customer identity before making account changes. Document all billing modifications.
## Outcomes
Accurate billing records and timely payment collection with minimal customer friction`,
      additionalContext: `## Specific instructions
For annual subscriptions, offer a discounted rate to prevent cancellation
## Rules
Refunds over $1000 require manager approval in Slack before processing
## Constraints
Cannot modify invoices that have already been sent to accounting
## Edge cases
For chargebacks, immediately pause account and notify the fraud team
## Anything to avoid
Never discuss internal pricing flexibility or discount authorization levels`,
      integrations: [
        { id: 'stripe', selectedObjects: ['Customer', 'Subscription', 'Invoice'] },
        { id: 'ext-agent-10', selectedObjects: [] },  // Payment Processor
      ],
      summary: 'Handles subscription changes, processes approved refunds, and sends payment reminders to reduce billing-related support tickets. Monitors failed payments and runs dunning sequences while documenting all account modifications.',
      temperature: 0.3,
      status: 'active',
      currentVersion: 4,
      tasksCompleted: 892,
      tasks30d: 247,
      monthlyCost: 67.25,
      createdAt: '2024-01-20T11:00:00Z',
      updatedAt: now,
      lastActive: now,
      messagingNickname: null,
      lastActivity: null,
      lastActivityAction: null,
      workflowVisualizationSteps: null,
      autonomyOverride: null,
      aiVendorOverride: null,
    },
  ]
}

export function generateMockInternalAgentVersions(agent: InternalAgent): InternalAgentVersion[] {
  const versions: InternalAgentVersion[] = []
  for (let v = agent.currentVersion; v >= 1; v--) {
    versions.push({
      id: `${agent.id}-v${v}`,
      internalAgentId: agent.id,
      version: v,
      role: agent.role,
      responsibilities: agent.responsibilities,
      integrations: agent.integrations,
      additionalContext: agent.additionalContext || null,
      source: v === 1 ? 'create' : 'manual',
      createdBy: null,
      createdAt: new Date(Date.now() - (agent.currentVersion - v) * 24 * 60 * 60 * 1000).toISOString(),
    })
  }
  return versions
}

// Backward compatibility aliases
export const generateMockTeams = generateMockInternalAgents
export const generateMockTeamVersions = generateMockInternalAgentVersions
