import { http, HttpResponse } from 'msw'
import type { VisualizationBlock, TableGroupRow } from '../../types/insights'

/**
 * Generate mock insights report blocks matching the exact output shape
 * of report-service.ts: generateReport().
 *
 * Real block order:
 *   1. 4 metric cards (Tasks Completed, Total Cost, Success Rate, Average Response Time)
 *   2. AI Workforce Activity bar chart
 *   3. Human Workforce Activity bar chart
 *   4. Task Volume trend chart (stacked AI/human)
 *   5. Cost Breakdown table (groups: per-agent, per-person payroll, Platform analytics)
 *
 * The Cost Breakdown table uses TableGroupRow groups, not flat rows. Each
 * agent group has Creation/Updates/Invocations sub-rows; each person row is a
 * flat group with no sub-rows. There is no "Infrastructure" or "LLM API Calls"
 * bucket — those don't exist on the backend.
 */
function generateMockBlocks(period: string): VisualizationBlock[] {
  const multiplier = period === 'today' ? 0.15
    : period === 'yesterday' ? 0.14
    : period === 'last_week' ? 1
    : period === 'this_month' ? 4.2
    : period === 'last_month' ? 4
    : period === 'this_quarter' ? 12
    : period === 'last_quarter' ? 11.5
    : period === 'this_year' ? 48
    : 1 // this_week default

  const totalTasks = Math.round(1247 * multiplier)
  const totalCost = Math.round(4832 * multiplier) / 100 * 100
  const successRate = 94.2

  // Data hoisted above metric cards so totalOus can be computed for the OU card.
  //
  // After the OU-native billing rewrite, /insights reads ou_consumed and
  // customer_cost_usd directly from cost_attribution_events — no display-time
  // USD-to-OU conversion. The mock retains the old USD-to-OU heuristic
  // (DEMO_USD_PER_OU) only to populate the OU column for the Cost Breakdown
  // table here, since the demo data is keyed on USD. Real /insights queries do
  // not divide.
  const fmt = (n: number) => `$${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
  const DEMO_USD_PER_OU = 0.099 // mock-only; not a billing rate
  const usdToDemoOus = (usd: number) => Math.round(usd / DEMO_USD_PER_OU)
  const fmtOus = (usd: number) => usd > 0 ? usdToDemoOus(usd).toLocaleString() : '—'

  const agentCosts = [
    { name: 'Sales Outreach', creation: 12.50, updates: 8.20, invocations: Math.round(845 * multiplier * 100) / 100 },
    { name: 'Customer Support', creation: 9.80, updates: 4.10, invocations: Math.round(612 * multiplier * 100) / 100 },
    { name: 'Onboarding', creation: 11.20, updates: 6.50, invocations: Math.round(389 * multiplier * 100) / 100 },
    { name: 'Billing Assistant', creation: 7.40, updates: 2.30, invocations: Math.round(214 * multiplier * 100) / 100 },
  ]

  const externalAgentCosts = [
    { name: 'Stripe Connector', discovery: 4.20, discoveryUpdates: 1.80, invocations: Math.round(98 * multiplier * 100) / 100 },
    { name: 'HubSpot Sync', discovery: 5.60, discoveryUpdates: 0.00, invocations: Math.round(72 * multiplier * 100) / 100 },
  ]

  const platformAnalytics = Math.round(45 * multiplier * 100) / 100

  // Internal agent compute + external agent discovery LLM calls (both are real
  // Anthropic API spend). External agent Invocations are flat subscription fees
  // already passed through to the customer and are excluded.
  const totalOus =
    agentCosts.flatMap(a => [a.creation, a.updates, a.invocations])
      .reduce((sum, c) => sum + usdToDemoOus(c), 0) +
    externalAgentCosts.flatMap(ea => [ea.discovery, ea.discoveryUpdates])
      .reduce((sum, c) => sum + usdToDemoOus(c), 0)

  const blocks: VisualizationBlock[] = []

  // ── 4 Metric Cards ────────────────────────────────────────────────────

  blocks.push({
    type: 'metric_card',
    label: 'Tasks Completed',
    value: totalTasks.toLocaleString(),
    trend: 'up',
    trendText: '+18.3% vs previous period',
  })

  blocks.push({
    type: 'metric_card',
    label: 'Operating Units Used',
    value: totalOus.toLocaleString(),
    trend: 'up',
    trendText: '+18.3% vs previous period',
  })

  blocks.push({
    type: 'metric_card',
    label: 'Total Cost',
    value: `$${totalCost.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`,
    trend: 'down',
    trendText: '-7.2% vs previous period',
    lowerIsBetter: true,
  })

  blocks.push({
    type: 'metric_card',
    label: 'Success Rate',
    value: `${successRate}%`,
    trend: 'flat',
    trendText: 'Same as previous period',
  })

  // ── AI Workforce Activity (horizontal bar chart) ─────────────────────

  blocks.push({
    type: 'bar_chart',
    title: 'AI Workforce Activity',
    data: [
      { label: 'Sales Outreach', value: Math.round(423 * multiplier), max: Math.round(500 * multiplier) },
      { label: 'Customer Support', value: Math.round(381 * multiplier), max: Math.round(500 * multiplier) },
      { label: 'Onboarding', value: Math.round(245 * multiplier), max: Math.round(500 * multiplier) },
      { label: 'Billing Assistant', value: Math.round(198 * multiplier), max: Math.round(500 * multiplier) },
    ],
    variant: 'horizontal',
    valueSuffix: 'tasks',
  })

  // ── Human Workforce Activity (horizontal bar chart) ──────────────────

  blocks.push({
    type: 'bar_chart',
    title: 'Human Workforce Activity',
    data: [
      { label: 'Sarah Chen (Owner)', value: 47, max: 50 },
      { label: 'Jane Smith', value: 32, max: 50 },
      { label: 'Bob Johnson', value: 28, max: 50 },
      { label: 'Alice Williams', value: 15, max: 50 },
      { label: 'Marco Rossi', value: 12, max: 50 },
    ],
    variant: 'horizontal',
    valueSuffix: 'tasks',
  })

  // ── Task Volume (trend chart, stacked AI vs human) ───────────────────

  const seg = (ai: number, human: number) => ({
    segments: [
      { label: 'AI Workforce', value: ai, color: 'var(--color-black)' },
      { label: 'Human Workforce', value: human, color: 'var(--color-gray-300)' },
    ],
  })

  if (period === 'today' || period === 'yesterday') {
    blocks.push({
      type: 'trend_chart',
      title: 'Task Volume',
      data: [
        { label: '9am', value: 28, max: 45, ...seg(22, 6) },
        { label: '10am', value: 42, max: 45, ...seg(35, 7) },
        { label: '11am', value: 38, max: 45, ...seg(30, 8) },
        { label: '12pm', value: 22, max: 45, ...seg(18, 4) },
        { label: '1pm', value: 35, max: 45, ...seg(28, 7) },
        { label: '2pm', value: 44, max: 45, ...seg(36, 8) },
        { label: '3pm', value: 40, max: 45, ...seg(33, 7) },
        { label: '4pm', value: 31, max: 45, ...seg(25, 6) },
      ],
    })
  } else {
    blocks.push({
      type: 'trend_chart',
      title: 'Task Volume',
      data: [
        { label: 'Mon', value: Math.round(180 * multiplier), max: Math.round(250 * multiplier), ...seg(Math.round(150 * multiplier), Math.round(30 * multiplier)) },
        { label: 'Tue', value: Math.round(210 * multiplier), max: Math.round(250 * multiplier), ...seg(Math.round(175 * multiplier), Math.round(35 * multiplier)) },
        { label: 'Wed', value: Math.round(195 * multiplier), max: Math.round(250 * multiplier), ...seg(Math.round(160 * multiplier), Math.round(35 * multiplier)) },
        { label: 'Thu', value: Math.round(240 * multiplier), max: Math.round(250 * multiplier), ...seg(Math.round(200 * multiplier), Math.round(40 * multiplier)) },
        { label: 'Fri', value: Math.round(220 * multiplier), max: Math.round(250 * multiplier), ...seg(Math.round(185 * multiplier), Math.round(35 * multiplier)) },
        { label: 'Sat', value: Math.round(85 * multiplier), max: Math.round(250 * multiplier), ...seg(Math.round(80 * multiplier), Math.round(5 * multiplier)) },
        { label: 'Sun', value: Math.round(62 * multiplier), max: Math.round(250 * multiplier), ...seg(Math.round(58 * multiplier), Math.round(4 * multiplier)) },
      ],
    })
  }

  // ── Cost Breakdown (table with groups) ───────────────────────────────
  // Real backend builds groups: one per internal agent (Creation/Updates/
  // Invocations), one per external agent (same), one flat row per person
  // (payroll), and one Platform analytics group for unattributed LLM spend.

  const groups: TableGroupRow[] = []

  for (const agent of agentCosts) {
    const total = agent.creation + agent.updates + agent.invocations
    const agentTotalOus = usdToDemoOus(agent.creation) + usdToDemoOus(agent.updates) + usdToDemoOus(agent.invocations)
    groups.push({
      label: agent.name,
      summary: { category: agent.name, ous: agentTotalOus.toLocaleString(), amount: fmt(total), percent: '0' },
      rows: [
        { category: 'Creation', ous: fmtOus(agent.creation), amount: fmt(agent.creation), percent: '' },
        { category: 'Updates', ous: fmtOus(agent.updates), amount: fmt(agent.updates), percent: '' },
        { category: 'Invocations', ous: fmtOus(agent.invocations), amount: fmt(agent.invocations), percent: '' },
      ],
    })
  }

  for (const ea of externalAgentCosts) {
    const total = ea.discovery + ea.discoveryUpdates + ea.invocations
    const eaLlmOus = usdToDemoOus(ea.discovery) + usdToDemoOus(ea.discoveryUpdates)
    groups.push({
      label: ea.name,
      summary: { category: ea.name, ous: eaLlmOus > 0 ? eaLlmOus.toLocaleString() : '—', amount: fmt(total), percent: '0' },
      rows: [
        { category: 'Creation', ous: fmtOus(ea.discovery), amount: fmt(ea.discovery), percent: '' },
        { category: 'Updates', ous: fmtOus(ea.discoveryUpdates), amount: fmt(ea.discoveryUpdates), percent: '' },
        { category: 'Invocations', ous: '—', amount: fmt(ea.invocations), percent: '' },
      ],
    })
  }

  if (platformAnalytics > 0) {
    groups.push({
      label: 'Platform analytics',
      summary: { category: 'Platform analytics', ous: '—', amount: fmt(platformAnalytics), percent: '0' },
      rows: [],
    })
  }

  // Compute % of Total on summaries (matches backend)
  const costTotal = groups.reduce((sum, g) => {
    const amt = parseFloat(String(g.summary.amount).replace(/[$,]/g, ''))
    return sum + (isNaN(amt) ? 0 : amt)
  }, 0)
  if (costTotal > 0) {
    for (const g of groups) {
      const amt = parseFloat(String(g.summary.amount).replace(/[$,]/g, ''))
      g.summary.percent = `${((amt / costTotal) * 100).toFixed(1)}%`
      for (const row of g.rows) {
        const subAmt = parseFloat(String(row.amount).replace(/[$,]/g, ''))
        row.percent = `${((subAmt / costTotal) * 100).toFixed(1)}%`
      }
    }
  }

  // Sort by amount descending (matches backend)
  groups.sort((a, b) => {
    const aAmt = parseFloat(String(a.summary.amount).replace(/[$,]/g, ''))
    const bAmt = parseFloat(String(b.summary.amount).replace(/[$,]/g, ''))
    return bAmt - aAmt
  })

  blocks.push({
    type: 'table',
    title: 'Cost Breakdown',
    columns: [
      { key: 'category', label: 'Category' },
      { key: 'ous', label: 'Operating Units Used' },
      { key: 'amount', label: 'Cost' },
      { key: 'percent', label: '% of Total' },
    ],
    rows: [],
    groups,
  })

  return blocks
}

export const insightsHandlers = [
  // GET /api/insights/report
  http.get(`*/api/insights/report`, ({ request }) => {
    const url = new URL(request.url)
    const period = url.searchParams.get('period') || 'this_week'

    const blocks = generateMockBlocks(period)

    return HttpResponse.json({ blocks })
  }),

  // GET /api/insights/counts — default mock workspace is populated, so
  // isEmpty=false. Individual tests can override with server.use() when
  // they need to render the empty-state path.
  http.get(`*/api/insights/counts`, () => {
    return HttpResponse.json({
      agentCount: 3,
      invocationCount: 142,
      auditCount: 87,
      isEmpty: false,
    })
  }),
]
