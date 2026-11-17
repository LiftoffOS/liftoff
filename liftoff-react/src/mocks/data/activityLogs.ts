// Mock activity logs data for development
// This file is gitignored - copy from activityLogs.template.ts if missing

import type { AgentAuditLog } from '../../services/activityLogs'

// Shared mock logs instance - generated once and shared across handlers
// This ensures activity logs and corrections handlers reference the same data
let sharedMockLogs: AgentAuditLog[] | null = null
let lastGeneratedAt: number = 0

// Get the shared mock logs instance, regenerating if stale (older than 1 hour)
export function getSharedMockLogs(): AgentAuditLog[] {
  const now = Date.now()
  const oneHour = 60 * 60 * 1000

  if (!sharedMockLogs || now - lastGeneratedAt > oneHour) {
    sharedMockLogs = generateMockActivityLogs()
    lastGeneratedAt = now
  }

  return sharedMockLogs
}

export function generateMockActivityLogs(): AgentAuditLog[] {
  const now = new Date()

  const detailedLogs: Array<{
    action: string
    inputArgs: Record<string, unknown>
    outputSummary: string
    teamId: string
    triggeredBy: string
  }> = [
    {
      action: 'send_email',
      teamId: 'team-sales-001',
      triggeredBy: 'agent',
      inputArgs: {
        to: 'sarah.johnson@acmecorp.com',
        cc: ['sales-team@company.com'],
        subject: 'Follow-up: Enterprise Plan Discussion',
        templateId: 'sales-followup-v3',
        templateVariables: {
          recipientName: 'Sarah',
          companyName: 'Acme Corp',
          meetingDate: '2024-03-20',
          proposalLink: 'https://app.company.com/proposals/acme-2024'
        },
        trackOpens: true,
        trackClicks: true,
        scheduledFor: null
      },
      outputSummary: 'Email successfully delivered to sarah.johnson@acmecorp.com.\n\nDelivery details:\n- Message ID: msg_8x7k2mN9p\n- Sent via: SendGrid\n- Open tracking: Enabled\n- Click tracking: Enabled\n\nRecipient engagement history:\n- Previous emails: 3\n- Open rate: 100%\n- Last interaction: 2 days ago'
    },
    {
      action: 'process_refund',
      teamId: 'team-billing-004',
      triggeredBy: 'human:finance@company.com',
      inputArgs: {
        orderId: 'ORD-2024-8847',
        customerId: 'cust_enterprise_acme',
        customerEmail: 'billing@acmecorp.com',
        refundAmount: 2499.99,
        currency: 'USD',
        reason: 'service_downtime_compensation',
        refundMethod: 'original_payment_method',
        paymentMethodLast4: '4242',
        notifyCustomer: true,
        internalNotes: 'Approved by finance team due to SLA breach on March 15'
      },
      outputSummary: 'Refund processed successfully.\n\nTransaction details:\n- Refund ID: ref_Nx92kL8m\n- Amount: $2,499.99 USD\n- Method: Visa ending in 4242\n- Processing time: 3-5 business days\n\nCustomer notification sent to billing@acmecorp.com.\nInternal ticket #TKT-9982 updated with refund confirmation.'
    },
    {
      action: 'create_ticket',
      teamId: 'team-support-002',
      triggeredBy: 'event:webhook_received',
      inputArgs: {
        source: 'zendesk_webhook',
        customerEmail: 'mike.chen@startup.io',
        customerId: 'cust_startup_io',
        subject: 'API Integration Issue - Authentication Failing',
        description: 'Customer reports 401 errors when calling /api/v2/users endpoint. Started occurring after recent deployment.',
        priority: 'high',
        category: 'technical_support',
        tags: ['api', 'authentication', 'integration'],
        attachments: ['error_log_2024-03-18.txt'],
        previousTickets: ['TKT-8821', 'TKT-8756']
      },
      outputSummary: 'Support ticket created successfully.\n\nTicket details:\n- Ticket ID: TKT-9001\n- Priority: High\n- Assigned queue: Technical Support L2\n- Estimated first response: 2 hours\n\nAutomated actions taken:\n- Customer acknowledgment email sent\n- Related tickets linked (TKT-8821, TKT-8756)\n- Engineering team notified via Slack #api-support\n- Knowledge base article KB-2847 suggested to customer'
    },
    {
      action: 'update_subscription',
      teamId: 'team-billing-004',
      triggeredBy: 'cron',
      inputArgs: {
        customerId: 'cust_growth_labs',
        customerName: 'Growth Labs Inc',
        currentPlan: 'professional',
        newPlan: 'enterprise',
        billingCycle: 'annual',
        effectiveDate: '2024-04-01',
        prorationBehavior: 'create_prorations',
        addOns: ['advanced_analytics', 'priority_support', 'custom_integrations'],
        seats: 50,
        previousSeats: 25,
        discountCode: 'ANNUAL20'
      },
      outputSummary: 'Subscription upgraded successfully.\n\nChanges applied:\n- Plan: Professional → Enterprise\n- Seats: 25 → 50\n- Billing cycle: Monthly → Annual\n- Add-ons activated: 3\n\nFinancial impact:\n- Prorated credit: $847.50\n- New annual amount: $29,940.00\n- Discount applied: 20% (ANNUAL20)\n- Final charge: $23,952.00\n\nNext billing date: April 1, 2024'
    },
    {
      action: 'generate_report',
      teamId: 'team-sales-001',
      triggeredBy: 'cron',
      inputArgs: {
        reportType: 'quarterly_sales_performance',
        reportName: 'Q1 2024 Sales Report',
        dateRange: { start: '2024-01-01', end: '2024-03-31' },
        metrics: ['revenue', 'deals_closed', 'pipeline_value', 'conversion_rate', 'avg_deal_size'],
        groupBy: ['sales_rep', 'region', 'product_line'],
        format: 'pdf',
        includeCharts: true,
        recipients: ['sales-leadership@company.com', 'ceo@company.com'],
        scheduleDelivery: '2024-04-01T09:00:00Z'
      },
      outputSummary: 'Report generated and scheduled for delivery.\n\nReport summary:\n- Total pages: 28\n- Charts included: 12\n- Data points analyzed: 4,892\n\nKey findings:\n- Q1 Revenue: $2.4M (+18% YoY)\n- Deals closed: 47 (+12% QoQ)\n- Avg deal size: $51,064\n- Win rate: 34%\n\nReport saved to: /reports/Q1-2024-sales.pdf\nScheduled delivery: April 1, 2024 at 9:00 AM UTC'
    },
    {
      action: 'sync_data',
      teamId: 'team-onboarding-003',
      triggeredBy: 'event:schedule_trigger',
      inputArgs: {
        source: {
          system: 'salesforce',
          objects: ['Contact', 'Account', 'Opportunity'],
          filters: { lastModified: 'last_24_hours', status: ['active', 'pending'] }
        },
        destination: { system: 'data_warehouse', schema: 'crm_staging', writeMode: 'upsert' },
        options: { batchSize: 500, retryOnFailure: true, maxRetries: 3, notifyOnComplete: true }
      },
      outputSummary: 'Data synchronization completed successfully.\n\nSync statistics:\n- Contacts synced: 892 (234 new, 658 updated)\n- Accounts synced: 156 (42 new, 114 updated)\n- Opportunities synced: 78 (31 new, 47 updated)\n\nProcessing details:\n- Total records: 1,126\n- Duration: 4m 23s\n- Throughput: 4.3 records/sec\n- Conflicts resolved: 7\n- Errors: 0\n\nNext scheduled sync: Tomorrow at 2:00 AM UTC'
    },
    {
      action: 'analyze_sentiment',
      teamId: 'team-support-002',
      triggeredBy: 'agent',
      inputArgs: {
        conversationId: 'conv_support_8x2k9m',
        customerId: 'cust_retail_plus',
        channel: 'live_chat',
        messageCount: 12,
        analysisType: 'full',
        includeKeyTopics: true,
        includeActionItems: true,
        language: 'en'
      },
      outputSummary: 'Sentiment analysis completed.\n\nOverall sentiment: Mixed → Positive (improved during conversation)\n- Initial sentiment: 0.32 (frustrated)\n- Final sentiment: 0.78 (satisfied)\n- Sentiment trend: Improving ↑\n\nKey topics identified:\n1. Billing discrepancy (resolved)\n2. Feature request: bulk export\n3. Positive feedback on support response time\n\nAction items extracted:\n- Follow up on bulk export feature request\n- Send confirmation of billing adjustment\n\nCustomer health score updated: 72 → 81'
    },
    {
      action: 'schedule_meeting',
      teamId: 'team-sales-001',
      triggeredBy: 'agent',
      inputArgs: {
        meetingType: 'product_demo',
        title: 'Liftoff Platform Demo - TechStart Inc',
        organizer: 'alex.rivera@company.com',
        attendees: [
          { email: 'jennifer.wu@techstart.com', name: 'Jennifer Wu', role: 'CTO' },
          { email: 'david.kim@techstart.com', name: 'David Kim', role: 'Engineering Lead' }
        ],
        duration: 45,
        proposedTimes: ['2024-03-22T14:00:00-07:00', '2024-03-22T16:00:00-07:00', '2024-03-25T10:00:00-07:00'],
        location: 'zoom',
        agenda: ['Platform overview', 'Integration capabilities', 'Pricing discussion', 'Q&A'],
        sendCalendarInvite: true,
        includeConferenceLink: true
      },
      outputSummary: 'Meeting scheduled successfully.\n\nMeeting details:\n- Date: March 22, 2024\n- Time: 2:00 PM - 2:45 PM PDT\n- Location: Zoom (link included in invite)\n\nAttendees confirmed:\n- Jennifer Wu (CTO) - Accepted\n- David Kim (Engineering Lead) - Pending\n- Alex Rivera (Host) - Organizer\n\nCalendar invites sent to all attendees.\nZoom meeting link: https://zoom.us/j/98765432\nMeeting prep doc created in Google Drive.'
    },
    {
      action: 'route_inquiry',
      teamId: 'team-support-002',
      triggeredBy: 'event:webhook_received',
      inputArgs: {
        inquiryId: 'inq_2024_8892',
        customerEmail: 'ops@manufacturing.co',
        customerId: 'cust_mfg_co',
        inquiryType: 'technical',
        subject: 'API Rate Limiting Questions',
        content: 'We need clarification on rate limits for the batch processing endpoint...',
        currentQueue: 'general_support',
        customerTier: 'enterprise',
        previousInteractions: 8,
        csat_score: 4.2,
        urgencyIndicators: ['enterprise_customer', 'technical_question']
      },
      outputSummary: 'Inquiry routed to specialized queue.\n\nRouting decision:\n- From: General Support\n- To: Technical Support (Enterprise)\n- Reason: Technical inquiry from Enterprise customer\n\nAssignment details:\n- Assigned to: Technical Support L2 Team\n- Specialist: Available in 15 minutes\n- Estimated first response: 1 hour\n- SLA deadline: 4 hours\n\nContext provided to agent:\n- Customer tier: Enterprise\n- Account health: Good (4.2 CSAT)\n- Related KB articles attached: 3'
    },
    {
      action: 'create_invoice',
      teamId: 'team-billing-004',
      triggeredBy: 'cron',
      inputArgs: {
        customerId: 'cust_consulting_group',
        customerName: 'Premier Consulting Group',
        billingEmail: 'accounts@premiercg.com',
        invoiceType: 'subscription',
        billingPeriod: { start: '2024-03-01', end: '2024-03-31' },
        lineItems: [
          { description: 'Enterprise Plan - 100 seats', quantity: 1, unitPrice: 4999.00 },
          { description: 'Advanced Analytics Add-on', quantity: 1, unitPrice: 499.00 },
          { description: 'Priority Support', quantity: 1, unitPrice: 299.00 },
          { description: 'Additional API calls (overage)', quantity: 50000, unitPrice: 0.002 }
        ],
        taxRate: 0.0875,
        paymentTerms: 'net_30',
        currency: 'USD'
      },
      outputSummary: 'Invoice generated and sent.\n\nInvoice details:\n- Invoice #: INV-2024-0892\n- Customer: Premier Consulting Group\n- Period: March 1-31, 2024\n\nLine items:\n- Enterprise Plan (100 seats): $4,999.00\n- Advanced Analytics: $499.00\n- Priority Support: $299.00\n- API overage (50K calls): $100.00\n- Subtotal: $5,897.00\n- Tax (8.75%): $515.99\n- Total: $6,412.99\n\nPayment due: April 30, 2024\nInvoice sent to: accounts@premiercg.com'
    },
    {
      action: 'send_notification',
      teamId: 'team-onboarding-003',
      triggeredBy: 'agent',
      inputArgs: {
        notificationType: 'onboarding_milestone',
        recipientId: 'user_new_admin_8x2k',
        recipientEmail: 'admin@newcustomer.com',
        channels: ['email', 'in_app', 'slack'],
        templateId: 'onboarding_week1_complete',
        templateVariables: {
          userName: 'Amanda',
          companyName: 'NewCustomer Inc',
          completedSteps: ['account_setup', 'team_invite', 'first_integration'],
          nextSteps: ['configure_workflows', 'set_permissions'],
          progressPercent: 60
        },
        priority: 'normal',
        trackEngagement: true
      },
      outputSummary: 'Milestone notification sent successfully.\n\nDelivery status:\n- Email: Delivered ✓\n- In-app: Displayed ✓\n- Slack: Delivered to #newcustomer-onboarding ✓\n\nNotification content:\n- Template: Week 1 Complete\n- Personalized for: Amanda @ NewCustomer Inc\n- Progress shown: 60%\n\nEngagement tracking enabled.\nOnboarding dashboard updated with milestone completion.'
    },
    {
      action: 'update_crm_record',
      teamId: 'team-sales-001',
      triggeredBy: 'human:john.smith@company.com',
      inputArgs: {
        recordType: 'opportunity',
        recordId: 'opp_bigdeal_2024',
        updates: {
          stage: 'negotiation',
          amount: 125000,
          probability: 75,
          closeDate: '2024-04-15',
          nextSteps: 'Send revised proposal with volume discount',
          competitorNotes: 'Also evaluating Competitor X - we have feature advantage'
        },
        relatedContacts: ['contact_cto_bigco', 'contact_cfo_bigco'],
        syncToSalesforce: true,
        notifyTeam: true
      },
      outputSummary: 'Opportunity record updated.\n\nChanges made:\n- Stage: Proposal → Negotiation\n- Amount: $100,000 → $125,000\n- Probability: 50% → 75%\n- Close date: March 31 → April 15\n\nSync status:\n- Salesforce: Synced ✓\n- Data warehouse: Queued\n\nNotifications sent:\n- Sales manager notified of stage change\n- Deal room updated with new information\n- Forecast dashboard refreshed'
    }
  ]

  const logs: AgentAuditLog[] = []

  for (let i = 0; i < detailedLogs.length; i++) {
    const detail = detailedLogs[i]
    const minutesAgo = Math.floor(Math.random() * 720) + 5
    const createdAt = new Date(now.getTime() - minutesAgo * 60 * 1000)

    logs.push({
      id: `log_${String(i).padStart(4, '0')}_${now.getTime()}`,
      tenantId: 'tenant_mock',
      internalAgentId: detail.teamId,
      userId: detail.triggeredBy.startsWith('human:') ? detail.triggeredBy.replace('human:', '') : null,
      threadId: `thread_${String(i).padStart(3, '0')}_${Math.random().toString(36).slice(2, 8)}`,
      invocationId: `inv_${Math.random().toString(36).slice(2, 12)}`,
      externalAgentId: null,
      action: detail.action,
      inputArgs: detail.inputArgs,
      outputSummary: detail.outputSummary,
      outcome: 'success',
      errorCode: null,
      triggeredBy: detail.triggeredBy,
      durationMs: Math.floor(Math.random() * 4000) + 500,
      createdAt: createdAt.toISOString(),
      agentName: detail.teamId,
      triggeredByAgentName: null,
      proxyKeyId: null,
      preActionSnapshot: null,
      postActionSnapshot: null,
      externalResponse: null,
      snapshotStatus: null,
    })
  }

  // Add error and gated examples
  const errorLogs: AgentAuditLog[] = [
    {
      id: `log_err_001_${now.getTime()}`,
      tenantId: 'tenant_mock',
      internalAgentId: 'team-billing-004',
      userId: null,
      threadId: 'thread_err_001',
      invocationId: 'inv_err_x8k2m',
      externalAgentId: null,
      action: 'process_refund',
      inputArgs: {
        orderId: 'ORD-2024-INVALID',
        customerId: 'cust_unknown',
        refundAmount: 500.00,
        reason: 'customer_request'
      },
      outputSummary: null,
      outcome: 'error',
      errorCode: 'INVALID_ORDER_ID',
      triggeredBy: 'agent',
      durationMs: 234,
      createdAt: new Date(now.getTime() - 45 * 60 * 1000).toISOString(),
      agentName: 'team-billing-004',
      triggeredByAgentName: null,
      proxyKeyId: null,
      preActionSnapshot: null,
      postActionSnapshot: null,
      externalResponse: null,
      snapshotStatus: null,
    },
    {
      id: `log_err_002_${now.getTime()}`,
      tenantId: 'tenant_mock',
      internalAgentId: 'team-support-002',
      userId: null,
      threadId: 'thread_err_002',
      invocationId: 'inv_err_9m2xk',
      externalAgentId: null,
      action: 'sync_data',
      inputArgs: {
        source: { system: 'salesforce', objects: ['Contact'] },
        destination: { system: 'data_warehouse', schema: 'crm' }
      },
      outputSummary: null,
      outcome: 'error',
      errorCode: 'RATE_LIMIT_EXCEEDED',
      triggeredBy: 'cron',
      durationMs: 1892,
      createdAt: new Date(now.getTime() - 90 * 60 * 1000).toISOString(),
      agentName: 'team-support-002',
      triggeredByAgentName: null,
      proxyKeyId: null,
      preActionSnapshot: null,
      postActionSnapshot: null,
      externalResponse: null,
      snapshotStatus: null,
    },
    {
      id: `log_gated_001_${now.getTime()}`,
      tenantId: 'tenant_mock',
      internalAgentId: 'team-billing-004',
      userId: null,
      threadId: 'thread_gated_001',
      invocationId: 'inv_gated_k82m',
      externalAgentId: null,
      action: 'process_refund',
      inputArgs: {
        orderId: 'ORD-2024-9912',
        customerId: 'cust_enterprise_vip',
        refundAmount: 15000.00,
        reason: 'contract_renegotiation',
        notes: 'Large refund requires human approval per policy'
      },
      outputSummary: 'Awaiting human approval. Refund amount exceeds automatic approval threshold ($5,000). Request escalated to Finance team.',
      outcome: 'gated',
      errorCode: null,
      triggeredBy: 'agent',
      durationMs: null,
      createdAt: new Date(now.getTime() - 15 * 60 * 1000).toISOString(),
      agentName: 'team-billing-004',
      triggeredByAgentName: null,
      proxyKeyId: null,
      preActionSnapshot: null,
      postActionSnapshot: null,
      externalResponse: null,
      snapshotStatus: null,
    },
    {
      id: `log_gated_002_${now.getTime()}`,
      tenantId: 'tenant_mock',
      internalAgentId: 'team-sales-001',
      userId: null,
      threadId: 'thread_gated_002',
      invocationId: 'inv_gated_m92x',
      externalAgentId: null,
      action: 'send_email',
      inputArgs: {
        to: 'ceo@fortune500.com',
        cc: ['board@fortune500.com'],
        subject: 'Partnership Proposal - Strategic Alliance',
        templateId: 'executive_outreach',
        templateVariables: {
          recipientName: 'Mr. Thompson',
          proposalValue: '$2.5M annual contract'
        }
      },
      outputSummary: 'Awaiting human approval. Executive-level communication requires review before sending. Draft saved for review.',
      outcome: 'gated',
      errorCode: null,
      triggeredBy: 'agent',
      durationMs: null,
      createdAt: new Date(now.getTime() - 30 * 60 * 1000).toISOString(),
      agentName: 'team-sales-001',
      triggeredByAgentName: null,
      proxyKeyId: null,
      preActionSnapshot: null,
      postActionSnapshot: null,
      externalResponse: null,
      snapshotStatus: null,
    }
  ]

  logs.push(...errorLogs)

  // Add external agent activity logs
  const externalAgentLogs: AgentAuditLog[] = [
    {
      id: `log_ext_001_${now.getTime()}`,
      tenantId: 'tenant_mock',
      internalAgentId: null,
      userId: null,
      threadId: 'thread_ext_001',
      invocationId: 'inv_ext_a1b2c',
      externalAgentId: 'ext-agent-1',
      action: 'analyze_data',
      inputArgs: { dataset: 'Q1_sales.csv', metrics: ['revenue', 'growth'] },
      outputSummary: 'Analysis complete. Revenue up 12% QoQ, growth rate exceeds targets.',
      outcome: 'success',
      errorCode: null,
      triggeredBy: 'agent',
      durationMs: 3200,
      createdAt: new Date(now.getTime() - 15 * 60 * 1000).toISOString(),
      agentName: 'ext-agent-1',
      triggeredByAgentName: null,
      proxyKeyId: null,
      preActionSnapshot: null,
      postActionSnapshot: null,
      externalResponse: null,
      snapshotStatus: null,
    },
    {
      id: `log_ext_002_${now.getTime()}`,
      tenantId: 'tenant_mock',
      internalAgentId: null,
      userId: null,
      threadId: 'thread_ext_002',
      invocationId: 'inv_ext_d3e4f',
      externalAgentId: 'ext-agent-1',
      action: 'generate_report',
      inputArgs: { reportType: 'executive_summary', period: 'Q1-2024' },
      outputSummary: 'Executive summary report generated with 5 key insights.',
      outcome: 'success',
      errorCode: null,
      triggeredBy: 'agent',
      durationMs: 4500,
      createdAt: new Date(now.getTime() - 45 * 60 * 1000).toISOString(),
      agentName: 'ext-agent-1',
      triggeredByAgentName: null,
      proxyKeyId: null,
      preActionSnapshot: null,
      postActionSnapshot: null,
      externalResponse: null,
      snapshotStatus: null,
    },
    {
      id: `log_ext_003_${now.getTime()}`,
      tenantId: 'tenant_mock',
      internalAgentId: null,
      userId: null,
      threadId: 'thread_ext_003',
      invocationId: 'inv_ext_g5h6i',
      externalAgentId: 'ext-agent-2',
      action: 'respond_to_ticket',
      inputArgs: { ticketId: 'TKT-2024-1234', category: 'billing' },
      outputSummary: 'Response drafted and sent to customer. Issue resolved.',
      outcome: 'success',
      errorCode: null,
      triggeredBy: 'agent',
      durationMs: 1800,
      createdAt: new Date(now.getTime() - 25 * 60 * 1000).toISOString(),
      agentName: 'ext-agent-2',
      triggeredByAgentName: null,
      proxyKeyId: null,
      preActionSnapshot: null,
      postActionSnapshot: null,
      externalResponse: null,
      snapshotStatus: null,
    },
    {
      id: `log_ext_004_${now.getTime()}`,
      tenantId: 'tenant_mock',
      internalAgentId: null,
      userId: null,
      threadId: 'thread_ext_004',
      invocationId: 'inv_ext_j7k8l',
      externalAgentId: 'ext-agent-2',
      action: 'categorize_issue',
      inputArgs: { ticketId: 'TKT-2024-1235' },
      outputSummary: 'Issue categorized as: Technical Support - API Integration.',
      outcome: 'success',
      errorCode: null,
      triggeredBy: 'agent',
      durationMs: 500,
      createdAt: new Date(now.getTime() - 55 * 60 * 1000).toISOString(),
      agentName: 'ext-agent-2',
      triggeredByAgentName: null,
      proxyKeyId: null,
      preActionSnapshot: null,
      postActionSnapshot: null,
      externalResponse: null,
      snapshotStatus: null,
    },
    {
      id: `log_ext_005_${now.getTime()}`,
      tenantId: 'tenant_mock',
      internalAgentId: null,
      userId: null,
      threadId: 'thread_ext_005',
      invocationId: 'inv_ext_m9n0o',
      externalAgentId: 'ext-agent-3',
      action: 'review_code',
      inputArgs: { prNumber: 456, repository: 'frontend' },
      outputSummary: 'Code review complete. 3 suggestions, 1 security concern flagged.',
      outcome: 'success',
      errorCode: null,
      triggeredBy: 'agent',
      durationMs: 8200,
      createdAt: new Date(now.getTime() - 120 * 60 * 1000).toISOString(),
      agentName: 'ext-agent-3',
      triggeredByAgentName: null,
      proxyKeyId: null,
      preActionSnapshot: null,
      postActionSnapshot: null,
      externalResponse: null,
      snapshotStatus: null,
    },
    {
      id: `log_ext_006_${now.getTime()}`,
      tenantId: 'tenant_mock',
      internalAgentId: null,
      userId: null,
      threadId: 'thread_ext_006',
      invocationId: 'inv_ext_p1q2r',
      externalAgentId: 'ext-agent-6',
      action: 'send_email',
      inputArgs: { templateId: 'welcome_onboarding', to: 'newuser@example.com' },
      outputSummary: 'Welcome email sent successfully to new user.',
      outcome: 'success',
      errorCode: null,
      triggeredBy: 'agent',
      durationMs: 1200,
      createdAt: new Date(now.getTime() - 180 * 60 * 1000).toISOString(),
      agentName: 'ext-agent-6',
      triggeredByAgentName: null,
      proxyKeyId: null,
      preActionSnapshot: null,
      postActionSnapshot: null,
      externalResponse: null,
      snapshotStatus: null,
    },
    {
      id: `log_ext_007_${now.getTime()}`,
      tenantId: 'tenant_mock',
      internalAgentId: null,
      userId: null,
      threadId: 'thread_ext_007',
      invocationId: 'inv_ext_s3t4u',
      externalAgentId: 'ext-agent-1',
      action: 'predict_trends',
      inputArgs: { metric: 'customer_churn', horizon: '90_days' },
      outputSummary: 'Trend prediction complete. Churn risk identified for 12 accounts.',
      outcome: 'success',
      errorCode: null,
      triggeredBy: 'agent',
      durationMs: 5600,
      createdAt: new Date(now.getTime() - 240 * 60 * 1000).toISOString(),
      agentName: 'ext-agent-1',
      triggeredByAgentName: null,
      proxyKeyId: null,
      preActionSnapshot: null,
      postActionSnapshot: null,
      externalResponse: null,
      snapshotStatus: null,
    },
    {
      id: `log_ext_008_${now.getTime()}`,
      tenantId: 'tenant_mock',
      internalAgentId: null,
      userId: null,
      threadId: 'thread_ext_008',
      invocationId: 'inv_ext_v5w6x',
      externalAgentId: 'ext-agent-2',
      action: 'respond_to_ticket',
      inputArgs: { ticketId: 'TKT-2024-1236', category: 'feature_request' },
      outputSummary: 'Feature request acknowledged and logged to product backlog.',
      outcome: 'success',
      errorCode: null,
      triggeredBy: 'agent',
      durationMs: 900,
      createdAt: new Date(now.getTime() - 300 * 60 * 1000).toISOString(),
      agentName: 'ext-agent-2',
      triggeredByAgentName: null,
      proxyKeyId: null,
      preActionSnapshot: null,
      postActionSnapshot: null,
      externalResponse: null,
      snapshotStatus: null,
    },
  ]

  logs.push(...externalAgentLogs)

  return logs.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
}
