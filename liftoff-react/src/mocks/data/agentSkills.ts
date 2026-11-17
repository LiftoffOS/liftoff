// Mock agent skills data for development

export interface AgentSkill {
  id: string
  name: string
  description: string
  instruction: string
  tags: string[]
  usefulnessScore: number
  status: string
  createdAt: string
}

export interface AgentSkillsResponse {
  skills: AgentSkill[]
}

const SKILL_POOL: Omit<AgentSkill, 'id' | 'createdAt' | 'usefulnessScore'>[] = [
  {
    name: 'Prospect Qualification',
    description: 'Evaluate inbound leads against ICP criteria and assign qualification tier',
    instruction: `## Prospect Qualification

When evaluating a new prospect, score them against the following criteria:

**Firmographic fit (40 points)**
- Company size 50–500 employees: +20 pts
- Industry in target verticals (SaaS, fintech, e-commerce): +15 pts
- HQ in North America or Western Europe: +5 pts

**Behavioral signals (30 points)**
- Opened ≥3 emails in last 30 days: +15 pts
- Visited pricing page: +10 pts
- Attended a webinar: +5 pts

**Intent data (30 points)**
- G2 or Capterra review activity: +15 pts
- Competitor comparison keyword search: +10 pts
- Job posting for relevant roles: +5 pts

**Tiers**
- Score ≥70: Tier 1 — route to AE immediately
- Score 40–69: Tier 2 — enroll in nurture sequence, flag for SDR follow-up in 7 days
- Score <40: Tier 3 — marketing nurture only, no SDR outreach`,
    tags: ['sales', 'qualification', 'crm'],
    status: 'active',
  },
  {
    name: 'Support Ticket Triage',
    description: 'Classify incoming support tickets by severity, product area, and required expertise',
    instruction: `## Support Ticket Triage

For each incoming support ticket, determine:

**Severity classification**
- P0 (Critical): Service down, data loss risk, or security incident — page on-call immediately
- P1 (High): Core feature broken for multiple users — assign to senior engineer within 1 hour
- P2 (Medium): Feature degraded or workaround exists — assign within 4 hours
- P3 (Low): Cosmetic issues, feature requests, documentation — queue for next business day

**Product area routing**
- Auth / login issues → @auth-team
- Billing / subscription → @billing-team
- API / integrations → @platform-team
- UI / dashboard → @frontend-team
- Data / exports → @data-team

**Auto-resolution criteria**
If the ticket matches a known resolved issue in the knowledge base with >90% confidence, send the resolution article and ask the customer to confirm before routing to an agent.`,
    tags: ['support', 'triage', 'classification'],
    status: 'active',
  },
  {
    name: 'Outbound Email Sequencing',
    description: 'Write and schedule personalized outbound email sequences for target accounts',
    instruction: `## Outbound Email Sequencing

**Touch cadence** (adjust based on tier — see Prospect Qualification skill)
- Day 1: Initial outreach (personalized to recent company news or LinkedIn activity)
- Day 4: Follow-up #1 — lead with value prop relevant to their industry
- Day 9: Follow-up #2 — case study or social proof from similar company
- Day 16: Break-up email — acknowledge they're busy, leave the door open

**Subject line rules**
- Max 8 words
- No "Quick question" — overused, low open rate
- Reference something specific to them (company name, recent funding, product launch)
- A/B test: send 50% with question format, 50% with statement format

**Body rules**
- First sentence must not start with "I" or "We"
- Reference their LinkedIn headline or recent company news in the opener
- Value prop in ≤2 sentences
- Single CTA — never more than one ask per email
- Sign off with first name only

**Do not email**
- Anyone who unsubscribed in last 12 months
- Contacts at companies already in active deal stage
- Leads from healthcare vertical on Fridays`,
    tags: ['sales', 'email', 'outbound'],
    status: 'active',
  },
  {
    name: 'Weekly Pipeline Report',
    description: 'Compile pipeline metrics from CRM data and format as executive summary',
    instruction: `## Weekly Pipeline Report

Run every Monday at 8:00 AM PT. Pull data from Salesforce for the prior week (Mon–Sun).

**Required metrics**
- New MQLs created
- MQL → SQL conversion rate (this week vs 4-week avg)
- New SQLs created
- Opportunities opened (by stage)
- Opportunities closed-won (revenue + count)
- Opportunities closed-lost (count + top loss reason)
- Pipeline coverage ratio (total open pipeline / quarterly quota)
- Average deal cycle time (days from SQL to close-won)

**Format**
Export as Google Sheets using columns: Lead Name, Company, ICP Score, Stage, Next Action, Owner. Include the Owner column — reports without it have been rejected.

**Distribution**
Post summary in #revenue-ops Slack channel. Attach full spreadsheet. Ping @vp-sales directly if pipeline coverage drops below 3×.

**Anomaly flags**
- Coverage < 3×: flag as 🔴
- Win rate < 25%: flag as 🟡
- Average cycle time > 45 days: flag as 🟡`,
    tags: ['reporting', 'salesforce', 'pipeline'],
    status: 'active',
  },
  {
    name: 'Billing Dispute Resolution',
    description: 'Evaluate and resolve customer billing disputes using defined authorization thresholds',
    instruction: `## Billing Dispute Resolution

**Authorization thresholds (no escalation required)**
- Disputes ≤ $50: apply one-time courtesy credit automatically, no questions asked
- Disputes $51–$200: verify the charge in Stripe, confirm it matches the customer's subscription tier; if charge is correct, explain clearly; if discrepancy found, issue credit
- Disputes > $200: escalate to billing-escalations channel, do not resolve autonomously

**Investigation steps**
1. Pull transaction history from Stripe for the disputed period
2. Match against subscription events (upgrades, downgrades, seat changes)
3. Check for any failed payment retries that may have double-charged
4. If customer was on trial, confirm trial-end notification was sent

**Communication rules**
- Acknowledge the dispute within 2 hours during business hours (9 AM–6 PM PT)
- Use empathetic language — never defensive
- Provide specific transaction IDs in your response
- Offer a 15-minute call for disputes > $100 where the customer requests it

**Escalation**
Post in #billing-escalations with @here for disputes > $500 only. Using @channel has caused team complaints — do not use it.`,
    tags: ['billing', 'support', 'finance'],
    status: 'active',
  },
  {
    name: 'Customer Health Scoring',
    description: 'Calculate and update customer health scores based on product usage and engagement signals',
    instruction: `## Customer Health Scoring

Update scores weekly. Pull from: product analytics (Amplitude), support tickets (Zendesk), and CRM (Salesforce).

**Scoring model (0–100)**

Product engagement (40 pts)
- DAU/MAU ratio ≥ 0.4: +20 pts
- Core feature adoption ≥ 3 features: +15 pts
- Mobile app usage: +5 pts

Support health (30 pts)
- Zero P0/P1 tickets in last 30 days: +20 pts
- CSAT score ≥ 4.5: +10 pts

Relationship signals (30 pts)
- Executive sponsor engaged (opened last QBR invite): +15 pts
- Expansion conversation in last 90 days: +10 pts
- NPS ≥ 8: +5 pts

**Health tiers**
- Green (70–100): Healthy — schedule quarterly check-in
- Yellow (40–69): At risk — CSM outreach within 5 business days
- Red (0–39): Critical — escalate to CS Manager, initiate save play

**Churn signals (override to Red immediately)**
- Champion departed the company
- Requested data export
- Billing contact changed to procurement/legal`,
    tags: ['customer-success', 'health-scoring', 'churn'],
    status: 'active',
  },
  {
    name: 'Contract Renewal Workflow',
    description: 'Manage the end-to-end renewal process from 90-day notice through signature',
    instruction: `## Contract Renewal Workflow

**90 days out**
- Pull list of accounts renewing in next 90 days from Salesforce
- Check health score — Red accounts get CS Manager looped in immediately
- Send renewal intent email to primary contact + executive sponsor

**60 days out**
- Schedule renewal call with AE + CSM
- Prepare renewal deck: usage summary, ROI metrics, proposed renewal terms
- Flag any pricing changes to billing team for updated quote generation

**30 days out**
- Send DocuSign with renewal agreement
- Follow up every 5 business days if unsigned
- Escalate to VP of Sales if no response after 3 follow-ups

**Renewal terms**
- Standard renewal: same terms, 3% annual price increase
- Multi-year (2+ yr): eligible for 5% discount, requires VP approval
- Downgrades: must go through CS Manager review before accepting

**Closed-lost procedure**
If customer does not renew, log loss reason in Salesforce (required field) and initiate offboarding checklist within 24 hours of contract end.`,
    tags: ['sales', 'renewals', 'contracts'],
    status: 'active',
  },
  {
    name: 'Escalation Routing',
    description: 'Route complex or sensitive issues to the correct human owner based on type and urgency',
    instruction: `## Escalation Routing

Use this skill when an issue exceeds autonomous resolution authority or requires human judgment.

**Routing matrix**

| Issue type | Urgency | Route to |
|------------|---------|----------|
| Security incident | Any | @security-on-call (PagerDuty) immediately |
| Legal / compliance request | Any | legal@company.com + @head-of-legal |
| Media inquiry | Any | @pr-team Slack channel |
| Enterprise customer complaint | High | @vp-customer-success |
| Billing dispute > $200 | High | #billing-escalations with @here |
| Product outage | Critical | @on-call-engineer (PagerDuty) |
| Data deletion request (GDPR) | High | privacy@company.com, log in compliance tracker |

**Escalation message format**
Include in every escalation:
1. Customer name and ARR tier
2. Summary of issue (2–3 sentences)
3. Steps already taken
4. Recommended next action
5. Link to relevant ticket or thread

**What NOT to escalate**
- Routine billing questions ≤ $50 — resolve autonomously
- Feature requests — log in product board, close ticket
- Password resets — route to self-service portal`,
    tags: ['escalation', 'routing', 'support'],
    status: 'active',
  },
]

function simpleHash(str: string): number {
  let h = 0
  for (let i = 0; i < str.length; i++) {
    h = (Math.imul(31, h) + str.charCodeAt(i)) | 0
  }
  return Math.abs(h)
}

function deterministicDate(seed: number, index: number): string {
  const msBack = ((seed * (index + 1)) % (60 * 24 * 60 * 60 * 1000))
  return new Date(Date.now() - msBack).toISOString()
}

export function generateMockAgentSkills(internalAgentId: string): AgentSkill[] {
  const hash = simpleHash(internalAgentId)
  // Pick 2–5 skills deterministically based on agent ID
  const count = 2 + (hash % 4)
  const startIndex = hash % SKILL_POOL.length

  const skills: AgentSkill[] = []
  for (let i = 0; i < count; i++) {
    const poolIndex = (startIndex + i) % SKILL_POOL.length
    const poolEntry = SKILL_POOL[poolIndex]
    skills.push({
      id: `skill-${internalAgentId}-${poolIndex}-${hash + i}`,
      ...poolEntry,
      usefulnessScore: 5 + ((hash + i * 7) % 20),
      createdAt: deterministicDate(hash, i),
    })
  }

  return skills
}
