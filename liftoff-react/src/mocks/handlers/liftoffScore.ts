import { http, HttpResponse } from 'msw'
import type { LiftoffScoreEntry, LiftoffScoreResponse } from '../../types/liftoffScore'

/**
 * Mock LiftoffScore.
 *
 * Period selects the state so dev:mock reaches all three without a backend:
 *   today      -> too_early
 *   last_week  -> on_hold
 *   everything -> ok
 *
 * Drivers are written the way the real ones must be: a complete sentence in
 * units a person already understands, never a rating.
 */

const AI: LiftoffScoreEntry[] = [
  {
    entityKey: 'ai_team:agt_4c1a', kind: 'ai_team', group: 'ai',
    displayName: 'Finance Agent', accountId: null, email: null,
    taskCount: 61, score: 82, band: 'strong', confidence: 'high',
    resultsBand: 'strong', teamworkBand: 'good',
    drivers: [
      { kind: 'helping', dimension: 'results', label: '9 in 10 tasks accepted first time', benchmark: null },
      { kind: 'hurting', dimension: 'teamwork', label: 'Takes 2.1 rounds of back and forth per task', benchmark: '(best here: 1.2)' },
    ],
    action: {
      label: 'Grant access to Google Sheets',
      href: '/dashboard/connections',
      hoursSavedPerMonth: 4,
      evidence: {
        quote: 'Share the billing sheet with the service account so I can write to it.',
        occurrences: 6,
      },
    },
    rated: true, notRatedReason: null, tasksToRate: null,
  },
  {
    entityKey: 'ai_team:agt_9d02', kind: 'ai_team', group: 'ai',
    displayName: 'Revenue Agent', accountId: null, email: null,
    taskCount: 34, score: 61, band: 'needs_work', confidence: 'high',
    resultsBand: 'good', teamworkBand: 'needs_work',
    drivers: [
      { kind: 'helping', dimension: 'teamwork', label: 'Flags blockers before they stall the task, 8 times in 10', benchmark: null },
      { kind: 'hurting', dimension: 'teamwork', label: 'Stops for approval on 7 in 10 tasks, mostly routine ones', benchmark: '(typical: 2 in 10)' },
    ],
    action: {
      label: 'Loosen the approval step for routine outreach',
      href: '/dashboard/oversight',
      hoursSavedPerMonth: 9,
    },
    rated: true, notRatedReason: null, tasksToRate: null,
  },
  {
    entityKey: 'external_collaborator:ext_51bb', kind: 'external_collaborator', group: 'ai',
    displayName: 'Support Agent', accountId: null, email: null,
    taskCount: 27, score: 43, band: 'poor', confidence: 'medium',
    resultsBand: 'needs_work', teamworkBand: 'poor',
    drivers: [
      { kind: 'hurting', dimension: 'results', label: 'Half of its work comes back for a redo', benchmark: '(typical: 1 in 8)' },
      { kind: 'hurting', dimension: 'teamwork', label: 'Takes 5.4 rounds of back and forth per task', benchmark: '(best here: 1.2)' },
    ],
    action: {
      label: 'Narrow its role, it covers three unrelated areas today',
      href: '/dashboard/agents',
      hoursSavedPerMonth: 12,
    },
    rated: true, notRatedReason: null, tasksToRate: null,
  },
  {
    entityKey: 'ai_team:agt_7e33', kind: 'ai_team', group: 'ai',
    displayName: 'Ops Agent', accountId: null, email: null,
    taskCount: 3, score: null, band: null, confidence: null,
    resultsBand: null, teamworkBand: null, drivers: [], action: null,
    rated: false, notRatedReason: 'too_early', tasksToRate: 3,
  },
]

const PEOPLE: LiftoffScoreEntry[] = [
  {
    entityKey: 'person:acct_1f77', kind: 'person', group: 'person',
    displayName: 'Sarah Chen', accountId: 'acct_1f77', email: 'sarah.chen@example.com',
    taskCount: 38, score: 78, band: 'strong', confidence: 'high',
    resultsBand: 'strong', teamworkBand: 'strong',
    drivers: [
      { kind: 'helping', dimension: 'teamwork', label: 'Gives the full picture up front on 9 in 10 tasks', benchmark: null },
      { kind: 'helping', dimension: 'results', label: 'Work she oversees is almost never redone', benchmark: null },
    ],
    action: null,
    rated: true, notRatedReason: null, tasksToRate: null,
  },
  {
    entityKey: 'person:acct_3ba2', kind: 'person', group: 'person',
    displayName: 'Priya Raman', accountId: 'acct_3ba2', email: 'priya.raman@example.com',
    taskCount: 29, score: 64, band: 'good', confidence: 'medium',
    resultsBand: 'good', teamworkBand: 'good',
    drivers: [
      { kind: 'helping', dimension: 'teamwork', label: 'Unblocks a waiting task in under an hour', benchmark: '(workspace average: 5 hrs)' },
      { kind: 'hurting', dimension: 'results', label: 'Her briefs often leave out what "done" looks like', benchmark: null },
    ],
    action: {
      label: 'Try the task template on her next few tasks',
      href: '/dashboard/knowledge',
      hoursSavedPerMonth: 2,
    },
    rated: true, notRatedReason: null, tasksToRate: null,
  },
  {
    entityKey: 'person:acct_c410', kind: 'person', group: 'person',
    displayName: 'Marcus Webb', accountId: 'acct_c410', email: 'marcus.webb@example.com',
    taskCount: 21, score: 48, band: 'needs_work', confidence: 'early',
    resultsBand: 'needs_work', teamworkBand: 'needs_work',
    drivers: [
      { kind: 'helping', dimension: 'results', label: 'Reviews carefully, rarely waves through work that fails later', benchmark: null },
      { kind: 'hurting', dimension: 'teamwork', label: 'Takes 4.8 rounds of back and forth per task', benchmark: '(best here: 1.4)' },
    ],
    action: {
      label: 'Pair him with Finance Agent, the strongest here',
      href: '/dashboard/agents',
      hoursSavedPerMonth: 3,
    },
    rated: true, notRatedReason: null, tasksToRate: null,
  },
  {
    entityKey: 'person:acct_ab04', kind: 'person', group: 'person',
    displayName: 'Dana Whitfield', accountId: 'acct_ab04', email: 'dana.whitfield@example.com',
    taskCount: 5, score: null, band: null, confidence: null,
    resultsBand: null, teamworkBand: null, drivers: [], action: null,
    rated: false, notRatedReason: 'single_partner', tasksToRate: null,
  },
]

function buildResponse(period: string): LiftoffScoreResponse {
  if (period === 'today') {
    return {
      period, status: 'too_early', taskCount: 11,
      computedAt: '2026-08-23T04:00:11Z', groups: [], entries: [],
    }
  }
  if (period === 'last_week') {
    return {
      period, status: 'on_hold', taskCount: 96,
      computedAt: '2026-08-23T04:00:11Z', groups: [], entries: [],
    }
  }
  return {
    period, status: 'ok', taskCount: 214,
    computedAt: '2026-08-23T04:00:11Z',
    groups: [
      { key: 'ai', ratedCount: 3, hoursSavedPerMonthAvailable: 25 },
      { key: 'person', ratedCount: 3, hoursSavedPerMonthAvailable: 5 },
    ],
    entries: [...AI, ...PEOPLE],
  }
}

export const liftoffScoreHandlers = [
  http.get('*/api/score', ({ request }) => {
    const period = new URL(request.url).searchParams.get('period') ?? 'this_month'
    return HttpResponse.json(buildResponse(period))
  }),
]
