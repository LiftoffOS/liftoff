// Dev-only preview of the template detail step, with inline editing live.
//
// The real screen is four clicks and a login away: sign in, reach
// /dashboard/agents/explore, wait for the catalog, open a template. Every look
// at a hover state or a chip costs that round trip, and none of it exercises
// anything the editing behaviour depends on — DetailStep reads no tenant and
// makes no call of its own.
//
// So this mounts the REAL <DetailStep /> with a REAL catalog template and the
// REAL draft plumbing the wizard uses: the same `drafts` object, the same
// `markdownFromDraft` on the way out. Nothing here is a stand-in for the
// editing itself. What is stubbed is only what sits around it — Continue
// reports what it would have sent instead of advancing, so the text a hire
// would actually be built from is visible on screen.
//
// `useConnectorCatalog` inside DetailStep is gated on an auth session
// (`enabled: !!user`), so with nobody signed in it never fires and the
// integrations row simply renders without connector icons. That is why this
// route is deliberately NOT wrapped in ProtectedRoute.
//
// Loaded only under import.meta.env.DEV — see the conditional lazy() in
// App.tsx, which tree-shakes this module and its chunk out of production.

import { useEffect, useRef, useState } from 'react'
import { DetailStep, type SummaryState } from '../pages/Dashboard/AgentExplorePage'
import { markdownFromDraft, type ProseDraft } from '../utils/inlineProse'
import { PREVIEW_TEMPLATE } from './previewTemplate'
import '../pages/Dashboard/AgentUpdatePage.css'
import '../pages/Dashboard/AgentExplorePage.css'

type DraftField = 'responsibilities' | 'additionalContext'

export default function TemplateDetailPreviewRoute() {
  const [drafts, setDrafts] = useState<Record<DraftField, ProseDraft | null>>({
    responsibilities: null,
    additionalContext: null,
  })
  const [draftRole, setDraftRole] = useState<string | null>(null)
  /** What Continue would send, so the round trip is inspectable here rather
   *  than only in a network tab on a real hire. */
  const [sent, setSent] = useState<string | null>(null)

  // The one thing here that is NOT the real implementation. The description
  // rewrite calls a platform-backend route that does not exist yet, so this
  // stands in for it on a timer to make the skeleton and the settled line
  // visible. The real page shows the same three states in the same order.
  const [summary, setSummary] = useState<SummaryState>({ status: 'template' })
  const timer = useRef<number | null>(null)
  const simulateRewrite = () => {
    if (timer.current) window.clearTimeout(timer.current)
    setSummary({ status: 'refreshing' })
    timer.current = window.setTimeout(() => {
      setSummary({
        status: 'ready',
        text: 'Handles accounts payable end to end on your own matching and approval rules, '
          + 'runs payment batches, and keeps finance current on aging.',
      })
    }, 1100)
  }
  useEffect(() => () => { if (timer.current) window.clearTimeout(timer.current) }, [])

  const effective = (field: DraftField) =>
    drafts[field] ? markdownFromDraft(drafts[field]!) : PREVIEW_TEMPLATE[field]

  /** Exactly what the distill call would carry. */
  const payload = () => [
    `role: ${draftRole ?? PREVIEW_TEMPLATE.role}`,
    '',
    effective('responsibilities'),
    '',
    effective('additionalContext'),
  ].join('\n')

  return (
    <>
      <DetailStep
        card={PREVIEW_TEMPLATE}
        template={PREVIEW_TEMPLATE}
        onUse={() => setSent(payload())}
        onBack={() => setSent(null)}
        drafts={drafts}
        onDraftChange={(field, next) => {
          setDrafts(prev => ({ ...prev, [field]: next }))
          simulateRewrite()
        }}
        draftRole={draftRole}
        onRoleChange={(role) => { setDraftRole(role); simulateRewrite() }}
        summary={summary}
      />

      {sent && (
        <div className="dev-preview__payload">
          <div className="dev-preview__payload-head">
            <strong>What would be distilled</strong>
            <button type="button" onClick={() => setSent(null)}>Close</button>
          </div>
          {/* Source text, tokens and all. Every {{connector:...}} still present
              here is a destination the hire will resolve against the person's
              own connection; one missing is one they have deliberately cut. */}
          <pre>{sent}</pre>
        </div>
      )}
    </>
  )
}
