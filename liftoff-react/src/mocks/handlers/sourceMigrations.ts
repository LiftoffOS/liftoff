// MSW handlers for Liftoff Switch (source migrations).
//
// Local dev runs entirely against MSW, so an endpoint with no handler here is
// an endpoint the wizard cannot exercise on localhost — the request falls
// through, the fetch fails, and the page renders its error state.
//
// The mock keeps one migration in module state and mutates it, so the wizard's
// real state machine drives the UI: converting actually progresses item by
// item, activating actually moves to done, and the stage the URL lands on
// follows the record exactly as it does in production.
//
// Change SCENARIO below to start on a different stage.

import { http, HttpResponse } from 'msw'
// Typed against the real service contract on purpose: a mock that drifts from
// the shape the wizard actually consumes is worse than no mock, because local
// dev then proves something production will not do.
import type {
  MigrationState as State,
  MigrationSource,
  MigrationView,
} from '../../services/sourceMigrations'

/** Which stage local dev opens on.
 *
 *  'none' means NO migration exists, which is the entry page: the screen that
 *  shows the `switch --from` command. It is only reachable in that state, since
 *  any existing migration resumes to its own stage — so it needs its own
 *  setting to be reviewable at all.
 *
 *  'importing' walks the whole flow from review. Pre-payment stages (review,
 *  setup, subscribe) are navigable by hand once a migration exists; conversion
 *  onwards is driven by the record, so either walk the flow or name that state
 *  here. */
// Asserted rather than annotated: TypeScript narrows a const to its literal,
// which makes every comparison against the other options provably false and
// turns this dev switch into a compile error the moment you use it.
const SCENARIO = 'importing' as State | 'none'

/** Set true to exercise the "choose a plan first" branch of subscribe. */
const PAYMENT_REQUIRED = false

/** Set false for an all-green finish; true leaves one member failed so the
 *  "did not build" state is reviewable. */
const FAIL_LAST_ITEM = true

const PAUSE_GUIDANCE: Record<string, { command: string; steps: string[]; supervisedNote: string }> = {
  openclaw: {
    command: 'openclaw gateway stop --disable --force --json',
    steps: [
      'Run this command in your terminal to stop the OpenClaw gateway.',
      'If launchd or systemd owns the gateway, disable that service too.',
      'Leave your OpenClaw files in place.',
    ],
    supervisedNote:
      'Liftoff does not run this command and cannot see whether OpenClaw is still running. ' +
      'If equivalent schedules stay active there, the same work can run twice.',
  },
  hermes: {
    command: 'hermes gateway stop',
    steps: [
      'Run this command in your terminal to stop the Hermes gateway.',
      'If launchd or systemd owns the gateway, disable that service too.',
      'Leave your Hermes files in place.',
    ],
    supervisedNote:
      'Liftoff does not run this command and cannot see whether Hermes is still running. ' +
      'If equivalent schedules stay active there, the same work can run twice.',
  },
}

function buildMigration(source: string): MigrationView {
  return {
    source: source as MigrationSource,
    id: '33333333-3333-4333-8333-333333333333',
    state: SCENARIO === 'none' ? 'importing' : SCENARIO,
    itemCount: 4,
    convertedCount: 0,
    unsupportedCount: 4,
    items: [
      // A schedule is the member's trigger. "Weekly competitive brief" is a
      // second cron on the research agent, so it becomes a member of its own —
      // Liftoff gives each member exactly one trigger.
      { sourceRef: 'agent:research', role: 'Competitive Research', state: 'pending', cronExpr: '0 7 * * *' },
      { sourceRef: 'agent:triage', role: 'Support Triage', state: 'pending', cronExpr: '0 * * * *' },
      { sourceRef: 'agent:reporting', role: 'Weekly Reporting', state: 'pending' },
      {
        sourceRef: 'agent:research::routine:weekly-brief',
        role: 'Weekly competitive brief',
        state: 'pending',
        cronExpr: '0 9 * * 1',
      },
    ],
    // No payment requirement locally: with one, the subscribe stage renders
    // "See plans" and sends you to pricing, so conversion, cutover and done are
    // unreachable and cannot be reviewed. Flip PAYMENT_REQUIRED below to see
    // the other branch.
    requirements: PAYMENT_REQUIRED
      ? [{ kind: 'payment' as const, detail: 'Choose a plan to build the imported team.' }]
      : [],
    webPath: `/dashboard/switch/${source}/review`,
    onboardingComplete: true,
    // Recorded on the migration for support, never rendered in the wizard.
    // The importer packs to fit, does not host anything on a customer's
    // behalf, and does not recreate the source harness's temporary helpers —
    // so none of this is a question the person importing can answer.
    unsupportedItems: [
      {
        sourceRef: 'mcp:localtools',
        reason: 'stdio_mcp_requires_hosting',
        detail:
          '"localtools" ran as a program on your own machine. Liftoff runs in the cloud and ' +
          'cannot reach it, so this tool does not come across. If you need it, connect an ' +
          'equivalent Liftoff connection, or point Liftoff at your own server later.',
      },
      {
        sourceRef: 'agent:triage',
        reason: 'transient_delegation_not_an_identity',
        detail:
          '"Support Triage" was set up to hand work to "scratch-worker". In OpenClaw that is a ' +
          'temporary helper rather than a permanent team member, so Liftoff did not create one ' +
          'for it.',
      },
      // Recorded for support, deliberately never rendered.
      {
        sourceRef: 'config:experimentalTelemetry',
        reason: 'unknown_configuration_field',
        detail:
          'The configuration field "experimentalTelemetry" is not recognised by this importer ' +
          'version and was not imported. Its value is not included in this report.',
      },
    ],
    hostingRequirements: [
      {
        sourceRef: 'mcp:localtools',
        name: 'localtools',
        command: 'npx',
        args: ['-y', '@acme/local-mcp'],
        reason: 'stdio_mcp_requires_hosting',
      },
    ],
    routines: [
      {
        sourceRef: 'routine:weekly-brief',
        name: 'Weekly competitive brief',
        cronExpr: '0 9 * * 1',
        accepted: true,
        enabledInSource: true,
        firstRunStatus: 'awaiting',
      },
      {
        sourceRef: 'routine:hourly-triage',
        name: 'Hourly ticket triage',
        cronExpr: '0 * * * *',
        accepted: true,
        enabledInSource: true,
        firstRunStatus: 'awaiting',
      },
    ],
    connections: [
      {
        sourceRef: 'channel:slack',
        kind: 'catalog',
        connectorType: 'slack',
        displayName: 'Slack',
        connectorId: 'c0000000-0000-4000-8000-000000000001',
        status: 'needs_reconnect',
      },
      {
        sourceRef: 'channel:github',
        kind: 'catalog',
        connectorType: 'github',
        displayName: 'GitHub',
        connectorId: 'c0000000-0000-4000-8000-000000000002',
        status: 'needs_reconnect',
      },
      {
        sourceRef: 'mcp:reporting',
        kind: 'mcp_http',
        connectorType: 'custom_mcp_server',
        displayName: 'reporting',
        endpointUrl: 'https://mcp.example.com/reporting',
        authScheme: 'bearer',
        connectorId: 'c0000000-0000-4000-8000-000000000003',
        status: 'needs_reconnect',
      },
    ],
    consentCandidates: ['team-handbook.md', 'escalation-policy.md'],
    libraryApprovals: [],
    pauseGuidance: PAUSE_GUIDANCE.openclaw,
  }
}

const ALL_STATES: Array<State | 'none'> = [
  'none',
  'importing',
  'setup_required',
  'payment_required',
  'conversion_queued',
  'converting',
  'conversion_ready',
  'ready_to_cutover',
  'active',
  'failed',
]

/** Scenario override from the page URL, e.g. ?mock=none or ?mock=converting.
 *
 *  MSW browser handlers run in the page, so window.location is readable here.
 *  Without this, seeing a stage means editing a file and restarting, which
 *  makes reviewing the UI far more painful than it needs to be. */
function activeScenario(): State | 'none' {
  if (typeof window !== 'undefined') {
    const q = new URLSearchParams(window.location.search).get('mock')
    if (q && (ALL_STATES as string[]).includes(q)) return q as State | 'none'
  }
  return SCENARIO
}

let migration = buildMigration('openclaw')
/** The scenario the current record was built from, so a poll can tell "the URL
 *  asked for something different" apart from "the flow moved on". */
let lastScenario: State | 'none' = SCENARIO

function webPathFor(state: State, source: string): string {
  const base = `/dashboard/switch/${source}`
  if (state === 'conversion_queued' || state === 'converting') return `${base}/building`
  if (state === 'conversion_ready' || state === 'ready_to_cutover' || state === 'active')
    return `${base}/done`
  return `${base}/review`
}

/** Advance one team member per read while building.
 *
 *  The wizard polls /latest, not /:id, so this has to run on the read it
 *  actually makes — otherwise the building stage sits at "0 of N ready"
 *  forever and looks broken. */
/** Mark the last member failed, so the state that needs an action is
 *  reviewable however you arrive at the finish — walking the flow or jumping
 *  straight to it with ?mock=active. */
let failureApplied = false

function applyFailure(): void {
  if (!FAIL_LAST_ITEM || migration.items.length < 2) return
  // Once only. A retry that always fails again makes it impossible to review
  // the thing a retry is FOR: the row resolving.
  if (failureApplied) return
  failureApplied = true
  migration.items = migration.items.map((item, idx) =>
    idx === migration.items.length - 1
      ? {
          ...item,
          state: 'failed' as const,
          destinationAgentId: undefined,
          lastError: 'The model timed out',
        }
      : item,
  )
  migration.convertedCount = migration.items.filter((i) => i.state === 'converted').length
}

const IN_FLIGHT = ['pending', 'distilling', 'creating']

function advanceIfBuilding(): void {
  // Driven by the ITEMS, not by the migration state. A targeted retry leaves
  // the migration finished and puts one row back in flight, and gating on the
  // migration state would leave that row spinning forever.
  const next = migration.items.findIndex((i) => IN_FLIGHT.includes(i.state))
  if (next < 0) return

  migration.items = migration.items.map((item, idx) =>
    idx === next
      ? { ...item, state: 'converted' as const, destinationAgentId: `agent-${idx + 1}`, lastError: undefined }
      : item,
  )
  migration.convertedCount = migration.items.filter((i) => i.state === 'converted').length

  if (migration.items.every((i) => i.state === 'converted')) {
    // Fail the last one on purpose, the first time through. A wizard reviewed
    // only against the happy path hides the state that matters most: the one
    // where something did not build and the person has to decide what to do.
    applyFailure()
    migration.state = 'ready_to_cutover'
  }
}

function view(): MigrationView {
  return { ...migration, webPath: webPathFor(migration.state, migration.source) }
}

export const sourceMigrationsHandlers = [
  http.get('*/api/source-migrations/latest', ({ request }) => {
    const scenario = activeScenario()
    // The entry page (the CLI command) only exists when there is no migration.
    if (scenario === 'none') return HttpResponse.json({ migration: null })

    const source = new URL(request.url).searchParams.get('source') ?? 'openclaw'
    // Rebuild only when the SOURCE or the requested scenario CHANGES — never
    // because the migration has moved on. Comparing against migration.state
    // meant every poll after Continue snapped the record back to the scenario
    // in the URL, so the flow could never advance past review.
    if (migration.source !== source || lastScenario !== scenario) {
      lastScenario = scenario
      migration = buildMigration(source)
      failureApplied = false
      migration.state = scenario
      migration.pauseGuidance = PAUSE_GUIDANCE[source] ?? PAUSE_GUIDANCE.openclaw
      if (scenario === 'converting' || scenario === 'conversion_queued') {
        migration.items = migration.items.map((i) => ({ ...i, state: 'distilling' as const }))
      }
      if (scenario === 'conversion_ready' || scenario === 'ready_to_cutover' || scenario === 'active') {
        migration.items = migration.items.map((i, idx) => ({
          ...i,
          state: 'converted' as const,
          destinationAgentId: `agent-${idx + 1}`,
        }))
        migration.convertedCount = migration.items.length
        applyFailure()
      }
    }
    advanceIfBuilding()
    return HttpResponse.json({ migration: view() })
  }),

  // Conversion. Each poll advances one item, so the progress stage animates the
  // way it will in production rather than jumping straight to done.
  http.post('*/api/source-migrations/:id/convert', async ({ request }) => {
    const body = (await request.json().catch(() => ({}))) as { sourceRefs?: string[] }
    const only = body.sourceRefs

    // A targeted retry on a finished migration does NOT rewind the migration:
    // one row is rebuilding, the import as a whole is still done. Mirrors the
    // backend, which is what the real wizard reads.
    const finished = migration.state === 'conversion_ready' || migration.state === 'ready_to_cutover'
    if (!only?.length || !finished) migration.state = 'converting'

    migration.items = migration.items.map((i) =>
      !only?.length || only.includes(i.sourceRef)
        ? { ...i, state: 'distilling' as const, lastError: undefined }
        : i,
    )
    migration.convertedCount = migration.items.filter((i) => i.state === 'converted').length
    return HttpResponse.json(view())
  }),

  http.post('*/api/source-migrations/:id/consent', async ({ request }) => {
    const body = (await request.json()) as { approvedArtifactNames?: string[] }
    migration.libraryApprovals = body.approvedArtifactNames ?? []
    return HttpResponse.json(view())
  }),

  http.post('*/api/source-migrations/:id/routines/accept', async ({ request }) => {
    const body = (await request.json()) as { sourceRef?: string; accepted?: boolean }
    migration.routines = migration.routines.map((r) =>
      r.sourceRef === body.sourceRef ? { ...r, accepted: Boolean(body.accepted) } : r,
    )
    return HttpResponse.json({ ok: true })
  }),

  // Launch Now. Every built member starts, and the wizard hands over to Teams.
  http.post('*/api/source-migrations/:id/activate', () => {
    migration.state = 'active'
    return HttpResponse.json(view())
  }),

  // Polled by the converting stage. Advances one item per call.
  http.get('*/api/source-migrations/:id', () => {
    if (migration.state === 'converting') {
      const next = migration.items.findIndex((i) => i.state !== 'converted')
      if (next >= 0) {
        migration.items = migration.items.map((item, idx) =>
          idx === next
            ? { ...item, state: 'converted' as const, destinationAgentId: `agent-${idx + 1}` }
            : item,
        )
        migration.convertedCount = migration.items.filter((i) => i.state === 'converted').length
      }
      if (migration.items.every((i) => i.state === 'converted')) {
        migration.state = 'ready_to_cutover'
      }
    }
    return HttpResponse.json(view())
  }),

  http.post('*/api/source-migrations', () => HttpResponse.json(view(), { status: 201 })),

  http.put('*/api/source-migrations/:id/bundle', () => HttpResponse.json(view())),

  http.post(
    '*/api/source-migrations/:id/connections/:connectorId/complete-import',
    ({ params }) => {
      migration.connections = migration.connections.map((c) =>
        c.connectorId === params.connectorId ? { ...c, status: 'active' as const } : c,
      )
      return HttpResponse.json({ connectorId: params.connectorId, toolCount: 7 })
    },
  ),
]
