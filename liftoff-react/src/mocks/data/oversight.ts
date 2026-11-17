// Mock oversight/approval data for development
// This file is gitignored - copy from oversight.template.ts if missing

import type { ClarificationItem, HitlApproval, GateReason, PendingToolCall } from '../../services/oversight'

/** The windows the tenant runtime actually gives a reader, mirrored here so the
 *  mock queue shows the deadlines production shows.
 *
 *  - Approvals: `hitl_approval_requests.expires_at` defaults to NOW() + 24
 *    hours and the insert never overrides it.
 *  - Clarifications: the queue serves `fires_at AS expires_at`, and a parked
 *    run sets fires_at to now + 24 hours for a question, now + 7 days for a
 *    blocker (QUESTION_EXPIRY_MS / BLOCKER_EXPIRY_MS in the runtime's
 *    clarification-storage). A blocker is an ask against the workspace, like
 *    "re-share this sheet", which is still true tomorrow. */
const APPROVAL_EXPIRY_MS = 24 * 60 * 60 * 1000
const QUESTION_EXPIRY_MS = 24 * 60 * 60 * 1000
const BLOCKER_EXPIRY_MS = 7 * 24 * 60 * 60 * 1000

export function generateMockApprovals(): HitlApproval[] {
  const now = new Date()

  const agentNames = [
    'Sales Outreach Agent',
    'Customer Support Bot',
    'Billing Assistant',
    'Onboarding Coordinator',
    'Data Sync Agent',
    'Report Generator',
  ]

  /** One request the queue could really hold.
   *
   *  Tool names are the real thing, prefixed the way the dispatch surface
   *  prefixes them: the model calls a connector tool as
   *  `mcp__<connector>-<instance>__<tool>`, and the platform's own
   *  always-gated operations (governance-types SUPER_DESTRUCTIVE_OPERATIONS)
   *  are bare. The reason travels with the scenario rather than being drawn at
   *  random, because a gate reason is a statement about the call: only a name
   *  in MERGE_TO_MAIN_TOOL_NAMES can produce `merge_to_main`, and a mock that
   *  labelled a mail send as a merge taught the panel nothing.
   *
   *  `summary` is the card content the gate writes. `action` and `why` are the
   *  model's prose, as markdown. `detail` is NOT prose: hitl-card-content.ts
   *  assembles it mechanically as `connector · action — key value`, with values
   *  JSON.stringified and cut at 80 characters, and the blast-radius
   *  measurement appended after a second separator. These fixtures carry that
   *  shape verbatim. Hand-written sentences here would make mock mode show a
   *  tidy panel while the real panel shows a JSON blob.
   *
   *  One scenario deliberately has no summary at all, so the older-row path
   *  (flag off, nothing generated at the gate) still renders in mock mode. */
  interface Scenario {
    reason: GateReason
    hitlLevel: number
    toolCalls: PendingToolCall[]
    summary?: { action: string; why: string; detail: string }
  }

  const scenarios: Scenario[] = [
    {
      reason: 'communication_review',
      hitlLevel: 1,
      toolCalls: [{
        id: 'tc_001',
        name: 'mcp__google-mail-eaec0c30__send_message',
        input: {
          to: 'ops@bigcorp.example',
          subject: 'Your renewal options',
          body: 'Your plan renews on 1 April. Here are the options we can offer...',
          cc: ['account-manager@liftoff.example'],
        },
      }],
      summary: {
        action: 'Send **Your renewal options** to `ops@bigcorp.example`',
        why: 'The renewal window opens in **14 days** and nobody has contacted the account',
        detail: 'google · send_message — subject Your renewal options, to ops@bigcorp.example',
      },
    },
    {
      reason: 'super_destructive_gate',
      hitlLevel: 2,
      toolCalls: [{
        id: 'tc_002',
        name: 'export_all_data',
        input: { scope: 'tenant', format: 'jsonl', destination: 'gs://acme-exports/2026-08-13' },
      }],
      summary: {
        action: 'Export **every record in the workspace** to `gs://acme-exports/2026-08-13`',
        why: 'A data subject request covering the whole account came in through legal',
        detail: 'export_all_data — scope tenant',
      },
    },
    {
      // No summary: the panel falls back to the raw pending-tool-call list.
      reason: 'super_destructive_gate',
      hitlLevel: 2,
      toolCalls: [{
        id: 'tc_003',
        name: 'bulk_delete_users',
        input: { filter: { status: 'inactive', lastActiveBefore: '2025-01-01' }, estimatedCount: 2847 },
      }],
    },
    {
      reason: 'merge_to_main',
      hitlLevel: 2,
      toolCalls: [{
        id: 'tc_004',
        name: 'mcp__github-7d07a896__merge_pull_request',
        input: {
          owner: 'acme',
          repo: 'storefront',
          head: 'feature/checkout-copy',
          pullNumber: 482,
          mergeMethod: 'squash',
        },
      }],
      summary: {
        action: 'Merge pull request **#482** into `main` in `acme/storefront`',
        why: 'Both reviewers approved and checks are green on `a1b2c3d`',
        detail: 'github · merge_pull_request — repo storefront, owner acme',
      },
    },
    {
      reason: 'external_content_write',
      hitlLevel: 1,
      toolCalls: [{
        id: 'tc_005',
        name: 'mcp__google-sheets-9f1c2d44__update_values',
        input: {
          spreadsheetId: '1G833gSEJ1K-v0oWaYnBXuZaOxK3BtL9mumKVr2o964w',
          range: 'Pipeline!B2:D2',
          values: [['Renewal', '4999.00', 'From inbound mail']],
        },
      }],
      summary: {
        action: 'Write **3 cells** to `Pipeline!B2:D2` in the forecast sheet',
        why: 'The values were read out of an inbound email, so nothing here was written by anyone in the workspace',
        detail: 'google · update_values — spreadsheetId 1G833gSEJ1K-v0oWaYnBXuZaOxK3BtL9mumKVr2o964w',
      },
    },
    {
      reason: 'destructive_gate',
      hitlLevel: 2,
      toolCalls: [{
        id: 'tc_006',
        name: 'mcp__salesforce-4b71e0c9__delete_record',
        input: { sobject: 'Opportunity', recordId: '0065f00000ABCDEeAAP', reason: 'duplicate' },
      }],
      summary: {
        action: 'Delete Opportunity `0065f00000ABCDEeAAP` in Salesforce',
        why: 'It duplicates the record created from the same inbound form 20 minutes earlier',
        detail: 'salesforce · delete_record — sobject Opportunity',
      },
    },
    {
      reason: 'sensitive_work',
      hitlLevel: 2,
      toolCalls: [{
        id: 'tc_009',
        name: 'mcp__salesforce-4b71e0c9__update_record',
        input: {
          sobject: 'Opportunity',
          recordId: '0065f00000XYZQWaAAP',
          fields: { Amount: 48000, StageName: 'Closed Won' },
        },
      }],
      summary: {
        action: 'Close an opportunity at **$48,000** in Salesforce',
        why: 'The countersigned order form landed this morning and the record still reads Negotiation',
        detail: 'salesforce · update_record — sobject Opportunity',
      },
    },
    {
      reason: 'level_1_gate',
      hitlLevel: 1,
      toolCalls: [{
        id: 'tc_007',
        name: 'mcp__slack-3ab5c710__slack_send_message',
        input: {
          channel: '#customer-updates',
          text: 'Checkout latency is back to normal. Full write-up to follow.',
        },
      }],
      summary: {
        action: 'Post to **#customer-updates** in Slack',
        why: 'Every action this team takes is reviewed while it is still on its first week',
        detail: 'slack · slack_send_message — channel #customer-updates',
      },
    },
    {
      // A step recording its own declared result, whose single argument is an
      // object. This is the shape that showed the flattened line up: the
      // runtime has no priority key to pick, falls back to the first argument,
      // JSON.stringifies it and cuts it at 80 characters, so the panel used to
      // read `category {"type":"general","urgency":"Low",…`. The detail below
      // is that line verbatim.
      reason: 'level_1_gate',
      hitlLevel: 1,
      toolCalls: [{
        id: 'tc_010',
        name: 'mcp__liftoff-tools-dd7d80bd-85cc-4adf-8293-ee623ce27f46__record_step_output',
        input: {
          category: {
            type: 'general',
            urgency: 'Low',
            sensitive: false,
            prior_agent_replies: 0,
            summary: 'Customer asks whether the annual plan can be paid by invoice rather than card.',
          },
        },
      }],
      summary: {
        action: 'Record a step output with general category, low urgency, and non-sensitive classification.',
        why: 'Every action this team takes is reviewed while it is still on its first week',
        detail: 'liftoff · record_step_output — category {"type":"general","urgency":"Low","sensitive":false,"prior_agent_replies":0,"sum…',
      },
    },
    {
      // The one gate that is about size. The measurement the quantifier wrote
      // is appended to the flattened line after a second separator, and it is
      // the only part of that line the panel still shows: nothing else in the
      // request says how much this would touch.
      reason: 'blast_radius',
      hitlLevel: 2,
      toolCalls: [{
        id: 'tc_011',
        name: 'mcp__hubspot-b81d4f27__batch_update_contacts',
        input: {
          objectType: 'contacts',
          properties: { lifecyclestage: 'customer', hs_lead_status: 'CONNECTED' },
          inputs: [
            { id: '701340188', properties: { lifecyclestage: 'customer' } },
            { id: '701340192', properties: { lifecyclestage: 'customer' } },
          ],
        },
      }],
      summary: {
        action: 'Move **142 HubSpot contacts** to the customer lifecycle stage',
        why: 'The renewal import marks every one of them as closed won',
        detail: 'hubspot · batch_update_contacts — objectType contacts — This single action would affect 142 items (limit 50). This run would have affected 142 items in total (limit 100).',
      },
    },
    {
      reason: 'rate_limit_exceeded',
      hitlLevel: 1,
      toolCalls: [{
        id: 'tc_008',
        name: 'mcp__google-sheets-9f1c2d44__create_values',
        input: {
          spreadsheetId: '1G833gSEJ1K-v0oWaYnBXuZaOxK3BtL9mumKVr2o964w',
          range: 'Sync log!A:C',
          values: [['2026-08-13', 'retry', '1 row']],
        },
      }],
      summary: {
        action: 'Append a row to the sync log',
        why: 'This run has already made **1,000 calls** in the last hour, which is the ceiling for unattended work',
        detail: 'google · create_values — spreadsheetId 1G833gSEJ1K-v0oWaYnBXuZaOxK3BtL9mumKVr2o964w',
      },
    },
  ]

  const approvals: HitlApproval[] = []

  for (let i = 0; i < scenarios.length; i++) {
    const scenario = scenarios[i]
    const minutesAgo = Math.floor(Math.random() * 180) + 5
    const createdAt = new Date(now.getTime() - minutesAgo * 60 * 1000)

    // An approval expires a day after it was raised: hitl_approval_requests
    // sets expires_at to NOW() + 24 hours and nothing overrides it, so the
    // deadline a reader sees is almost always tomorrow's date and time.
    //
    // Two rows deliberately sit near the end of that window and one past it,
    // because the panel says something different in each state ("Decision
    // needed soon" under 15 minutes, an amber deadline under an hour, and
    // "Decision window passed" once it lapses). The old fixture put every row
    // inside four hours, which showed the urgent states as though they were
    // the normal ones and never produced the deadline shape production shows.
    let expiresAt: Date
    if (i === 0) {
      expiresAt = new Date(now.getTime() + 10 * 60 * 1000)
    } else if (i === 1) {
      expiresAt = new Date(now.getTime() + 40 * 60 * 1000)
    } else if (i === scenarios.length - 1) {
      expiresAt = new Date(now.getTime() - 30 * 60 * 1000)
    } else {
      expiresAt = new Date(createdAt.getTime() + APPROVAL_EXPIRY_MS)
    }

    approvals.push({
      id: `approval_${String(i).padStart(3, '0')}_${Date.now()}`,
      tenantId: 'tenant_mock',
      agentId: `agent_${String(i).padStart(3, '0')}`,
      agentName: agentNames[i % agentNames.length],
      hitlLevel: scenario.hitlLevel,
      pendingToolCalls: scenario.toolCalls,
      reason: scenario.reason,
      status: expiresAt < now ? 'expired' : 'pending',
      expiresAt: expiresAt.toISOString(),
      createdAt: createdAt.toISOString(),
      updatedAt: createdAt.toISOString(),
      actionSummary: scenario.summary?.action ?? null,
      whySummary: scenario.summary?.why ?? null,
      detail: scenario.summary?.detail ?? null,
    })
  }

  return approvals.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
}

export function generateMockClarifications(): ClarificationItem[] {
  const now = new Date()

  const samples: Array<Omit<ClarificationItem, 'kind' | 'id' | 'tenantId' | 'createdAt' | 'expiresAt'> & {
    /** Fixture-only, and deliberately not part of ClarificationItem: the queue
     *  query does not select clarification_origin, so the frontend never learns
     *  which kind it has. It only decides the window here, because a blocker
     *  stays open for a week and a question for a day. */
    blocker?: boolean
  }> = [
    {
      agentId: 'agent_001',
      agentName: 'Sales Outreach Agent',
      threadId: 'thread_clr_001',
      question: 'The contact has two listed phone numbers. Which one should I use for the follow-up call?',
      source: 'recovery_llm',
      vendorRequestId: null,
    },
    {
      agentId: 'agent_004',
      agentName: 'Onboarding Coordinator',
      threadId: 'thread_clr_002',
      question: 'Anchor Browser hit a CAPTCHA on the supplier portal. Want me to retry or skip this vendor?',
      source: 'anchor_intervention',
      vendorRequestId: 'anchor_req_8f2c1a',
    },
    {
      agentId: 'agent_002',
      agentName: 'Customer Support Bot',
      threadId: 'thread_clr_003',
      question: 'The customer mentioned a refund but did not specify the order. Should I ask them to confirm the order ID?',
      source: 'recovery_llm',
      vendorRequestId: null,
    },
    // A long one, written as markdown the way the recovery model writes them:
    // ids in backticks, the ask in bold, the options numbered. Here so mock
    // mode exercises the rendered panel and not only one-line questions.
    //
    // A blocker rather than a question: nobody can answer "re-share the sheet"
    // from the panel, they have to go and do it, so the runtime holds it open
    // for a week instead of a day.
    {
      blocker: true,
      agentId: 'agent_005',
      agentName: 'Data Sync Agent',
      threadId: 'thread_clr_004',
      question: `Please do one or more of the following for spreadsheet **1G833gSEJ1K-v0oWaYnBXuZaOxK3BtL9mumKVr2o964w**:

1. **Re-share the sheet** with the Google Sheets service account used by this integration (integration ID: \`2b820bc9-afb3-4e15\`) and grant it at least **Viewer** access, or **Editor** if it needs to write.
2. **Confirm the first tab (gid=0) exists** and has not been deleted, hidden, or renamed in a way that prevents access.
3. **Confirm the header row is present**. The workflow expects column names on row 1, including a URL column and columns for the amount raised.

Once access is restored, re-run the workflow from the beginning.

The Google Sheets connector returned \`undefined\` (no data) when reading the spreadsheet, so it either lacks access or the tab does not exist in a readable state. Nothing was written during this run.`,
      source: 'recovery_llm',
      vendorRequestId: null,
    },
  ]

  return samples.map(({ blocker, ...s }, i) => {
    const minutesAgo = Math.floor(Math.random() * 90) + 3
    const createdAt = new Date(now.getTime() - minutesAgo * 60 * 1000)
    const expiresAt = new Date(
      createdAt.getTime() + (blocker ? BLOCKER_EXPIRY_MS : QUESTION_EXPIRY_MS),
    )
    return {
      kind: 'clarification',
      id: `clarification_${String(i).padStart(3, '0')}_${Date.now()}`,
      tenantId: 'tenant_mock',
      createdAt: createdAt.toISOString(),
      expiresAt: expiresAt.toISOString(),
      ...s,
    }
  })
}

let mockApprovals: HitlApproval[] | null = null
let mockClarifications: ClarificationItem[] | null = null
let lastGeneratedAt: number = 0

function refreshIfStale(): void {
  const now = Date.now()
  const thirtyMinutes = 30 * 60 * 1000
  if (!mockApprovals || !mockClarifications || now - lastGeneratedAt > thirtyMinutes) {
    mockApprovals = generateMockApprovals()
    mockClarifications = generateMockClarifications()
    lastGeneratedAt = now
  }
}

export function getMockApprovals(): HitlApproval[] {
  refreshIfStale()
  return mockApprovals!
}

export function getMockClarifications(): ClarificationItem[] {
  refreshIfStale()
  return mockClarifications!
}

export function removeMockClarification(id: string): void {
  refreshIfStale()
  mockClarifications = mockClarifications!.filter((c) => c.id !== id)
}


