import { useState, useEffect, useRef, useMemo, useCallback, createElement } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useNavigate, useSearchParams } from 'react-router'
import { BackButton, Button, Markdown, RoleInput, StatusDot, TextInput, Tooltip } from '../../components'
import SegmentedControl from '../../components/SegmentedControl/SegmentedControl'
import InlineProse from '../../components/InlineProse/InlineProse'
import InlineText from '../../components/InlineProse/InlineText'
import { TEAM_LIMITS } from '../../constants/limits'
import { ApiError } from '../../services/api'

/** Cached against a text whose description could not be written because the
 *  route is not deployed. Distinct from '' (asked, and the answer was nothing),
 *  which hides the line. */
const TEMPLATE_SUMMARY_UNSUPPORTED = '\u0000unsupported'

/** The line under the role name. `unavailable` is shown as nothing at all —
 *  see the catch in refreshSummary for why a stale line is worse. */
export type SummaryState =
  | { status: 'template' }
  | { status: 'refreshing' }
  | { status: 'ready'; text: string }
  | { status: 'unavailable' }
import {
  draftFromMarkdown,
  draftIsEdited,
  joinProseBlocks,
  markdownFromDraft,
  type ProseDraft,
} from '../../utils/inlineProse'
import { useAgentTemplates } from '../../hooks/useAgentTemplates'
import { useIntegrations } from '../../hooks/useIntegrations'
import { useConnectors } from '../../hooks/useConnectors'
import { useIntegrationConnect } from '../../hooks/useIntegrationConnect'
import { useCreateInternalAgent } from '../../hooks/useInternalAgents'
import { useToast } from '../../contexts/ToastContext'
import { usePlanGate } from '../../components/Dashboard/planGateContext'
import { useTenant } from '../../hooks/useTenant'
import { useConnectorCatalog, type ConnectorDef } from '../../hooks/useConnectorCatalog'
import LoadingStep from './AgentBuilder/steps/LoadingStep'
import CompletionStep from './AgentBuilder/steps/CompletionStep'
import type { SelectedIntegration } from '../../components/IntegrationsSelector'
import { getIntegrationIcon } from '../../components/icons/integrationIconRegistry'
import type { ConnectorType } from '../../services/connections'
import {
  distillInternalAgentStream,
  type DistillOutput,
  type DistillStage,
} from '../../services/internalAgents'
import { mergeDistillIntegrationConfigs } from '../../utils/mergeDistillIntegrationConfigs'
import { assembleTemplateIntegrations } from '../../utils/assembleTemplateIntegrations'
import Checkbox from '../../components/Checkbox/Checkbox'
import {
  DEPARTMENT_LABELS,
  capabilitiesOf,
  getAgentTemplate,
  buildTokenResolver,
  describeEditedTemplate,
  typesForRequirement,
  uniqueByFamily,
  type AgentTemplate,
  type AgentTemplateCard,
  type ConnectorRequirement,
  type RequirementObject,
  type DepartmentCategory,
} from '../../services/agentTemplates'
import ActivityIcon from '../../assets/icons/activity.svg?react'
import BarChartIcon from '../../assets/icons/bar-chart.svg?react'
import BookOpenIcon from '../../assets/icons/book-open.svg?react'
import ChipIcon from '../../assets/icons/chip.svg?react'
import ClipboardIcon from '../../assets/icons/clipboard.svg?react'
import DollarIcon from '../../assets/icons/dollar.svg?react'
import FileTextIcon from '../../assets/icons/file-text.svg?react'
import MessageCircleMoreIcon from '../../assets/icons/message-circle-more.svg?react'
import PeopleIcon from '../../assets/icons/people.svg?react'
import BriefcaseIcon from '../../assets/icons/briefcase.svg?react'
import ServerIcon from '../../assets/icons/server.svg?react'
import TriangleAlertIcon from '../../assets/icons/triangle-alert.svg?react'
import TrendUpIcon from '../../assets/icons/trend-up.svg?react'
import CubeIcon from '../../assets/icons/cube.svg?react'
import SearchXIcon from '../../assets/icons/search-x.svg?react'
import CloudUploadIcon from '../../assets/icons/cloud-upload.svg?react'
import ChevronDownIcon from '../../assets/icons/chevron-down.svg?react'
import ObjectPicker, { type PickedObject } from '../../components/ObjectPicker/ObjectPicker'
import './AgentExplorePage.css'
import './AgentUpdatePage.css'
import './AgentBuilder/AgentBuilder.css'
import './ConnectionsPage.css'
// The connector step renders .connection-card / .connections-grid, whose rules
// live in connectionCard.css. ConnectionsPage.css does not carry them, so
// without this the whole step renders unstyled.
import './connectionCard.css'
// The knowledge page's group styles: a connection's picks are listed under its
// row with the same markup, so the same stylesheet loads rather than the rules
// being restated here.
import './KnowledgePage.css'
// Renders .integration-chip / .integrations-section directly (the required/
// optional connector chips); those rules moved out of AgentBuilder.css into the
// shared integrationsSelector.css.
import '../../components/integrationsSelector.css'
// Connecting GitHub here opens the App install-target picker, which is styled by
// the shared connection-modal rules.
import '../../components/connectionModals.css'
import { track } from '../../lib/analytics'

// ─── Icon mapping ─────────────────────────────────────────────────────────────

type IconComponent = React.FC<React.SVGProps<SVGSVGElement>>

const TEMPLATE_ICONS: Record<string, IconComponent> = {
  'customer-support-representative': MessageCircleMoreIcon,
  'sales-development-representative': TrendUpIcon,
  'marketing-campaign-operator': BarChartIcon,
  'accounts-payable-clerk': ClipboardIcon,
  'accounts-receivable-clerk': DollarIcon,
  'recruiting-coordinator': PeopleIcon,
  'hr-policy-specialist': BookOpenIcon,
  'employee-onboarding-specialist': BriefcaseIcon,
  'incident-triage-specialist': TriangleAlertIcon,
  'incident-manager': TriangleAlertIcon,
  'contract-specialist': FileTextIcon,
  'code-reviewer': ChipIcon,
  'software-quality-analyst': ActivityIcon,
  'product-operations-manager': BarChartIcon,
  'sprint-retrospective-lead': ClipboardIcon,
  'revenue-operations-analyst': TrendUpIcon,
  'crm-operations-specialist': SearchXIcon,
  'customer-success-manager': MessageCircleMoreIcon,
  'release-manager': ClipboardIcon,
  'technical-writer': FileTextIcon,
}

const DEPT_FALLBACK_ICONS: Record<DepartmentCategory, IconComponent> = {
  customer_support: MessageCircleMoreIcon,
  sales: TrendUpIcon,
  marketing: BarChartIcon,
  finance: DollarIcon,
  hr: PeopleIcon,
  legal: FileTextIcon,
  operations: ServerIcon,
  engineering: ChipIcon,
  other: CubeIcon,
}

function getTemplateIcon(template: AgentTemplateCard): IconComponent {
  return TEMPLATE_ICONS[template.id] ?? DEPT_FALLBACK_ICONS[template.departmentCategory] ?? CubeIcon
}

const ALL_DEPARTMENTS: DepartmentCategory[] = [
  'sales', 'marketing', 'customer_support', 'engineering', 'operations', 'legal',
  'hr', 'finance', 'other',
]

// ─── Helpers ──────────────────────────────────────────────────────────────────

const CAPABILITY_LABELS: Record<string, string> = {
  calendar: 'Calendar',
  meeting_notes: 'Meeting Notes',
  crm: 'CRM',
  cloud_storage: 'Cloud Storage',
  email_marketing: 'Email Systems',
  support_ticketing: 'Support Systems',
  accounting: 'Accounting',
  hris: 'HR Systems',
  ats: 'ATS',
  incident_management: 'Incident Management',
  error_tracking: 'Error Monitoring',
  project_management: 'Project Management',
  enrichment: 'Enrichment',
  // Acronyms the title-case fallback would render as "Seo" / "Cms".
  seo: 'SEO',
  cms: 'CMS',
}

// Preferred display order for connectors within a capability group.
// Connectors not listed here sort after the listed ones in their original order.
const CAPABILITY_CONNECTOR_ORDER: Record<string, string[]> = {
  cloud_storage: ['google_drive', 'microsoft_onedrive', 'microsoft_sharepoint', 'dropbox', 'box'],
}

// Derives capability → [connectorType] by inverting ConnectorDef.capabilities[] from the catalog.
// This replaces the old hand-maintained CAPABILITY_CONNECTOR_TYPES map — the catalog is the
// single source of truth, so new connectors and capabilities appear here automatically.
function buildCapabilityConnectorTypes(connectors: ConnectorDef[]): Record<string, string[]> {
  const map: Record<string, string[]> = {}
  for (const connector of connectors) {
    if (connector.status !== 'available') continue
    for (const binding of connector.capabilities ?? []) {
      ;(map[binding.capability] ??= []).push(connector.type)
    }
  }
  for (const [capability, order] of Object.entries(CAPABILITY_CONNECTOR_ORDER)) {
    if (map[capability]) {
      map[capability].sort((a, b) => {
        const ai = order.indexOf(a)
        const bi = order.indexOf(b)
        if (ai === -1 && bi === -1) return 0
        if (ai === -1) return 1
        if (bi === -1) return -1
        return ai - bi
      })
    }
  }
  return map
}

function typeToLabel(connectorType: string): string {
  const integrationId = connectorType
  return integrationId.replace(/_/g, ' ').replace(/\b\w/g, l => l.toUpperCase())
}

function capabilityLabel(capability: string): string {
  return CAPABILITY_LABELS[capability] ?? capability.replace(/_/g, ' ').replace(/\b\w/g, l => l.toUpperCase())
}

/** What the requirement is called on the card.
 *
 *  A requirement that accepts either of two families is read as the choice it
 *  is: "Cloud Storage or Documents". Naming only the first would make the
 *  second family look unsupported to the one person it was added for. */
function connectorLabel(connector: ConnectorRequirement): string {
  if (connector.connectorType) return typeToLabel(connector.connectorType)
  const caps = capabilitiesOf(connector)
  if (caps.length > 0) return caps.map(capabilityLabel).join(' or ')
  return 'Unknown'
}

function connectorIcon(connector: ConnectorRequirement) {
  if (!connector.connectorType) return null
  return getIntegrationIcon(connector.connectorType)
}

function CapabilityIconStack({ types }: { types: string[] }) {
  return (
    <span className="capability-icon-stack">
      {types.slice(0, 3).map((t) => (
        <span key={t} className="capability-icon-stack__icon">{getIntegrationIcon(t)}</span>
      ))}
    </span>
  )
}

/** Tooltip body for a capability: every connector that satisfies it, named the
 *  way the vendor brands it. `displayName` comes off the catalog rather than
 *  titleising the type, which would read "Hubspot" and "Cal Com". Order is the
 *  catalog's, so the first rows match the icons stacked on the chip. */
function CapabilityConnectorRows({ types, byType }: { types: string[]; byType: Map<string, ConnectorDef> }) {
  return (
    <span className="connector-tooltip">
      {types.map(t => (
        <span key={t} className="connector-tooltip__row">
          <span className="connector-tooltip__icon">{getIntegrationIcon(t)}</span>
          {byType.get(t)?.displayName ?? typeToLabel(t)}
        </span>
      ))}
    </span>
  )
}

/** One requirement in the "What should they work with?" list. A capability chip
 *  stands in for a group of apps, so hovering it lists them; a chip that already
 *  names one specific app has nothing further to reveal. */
function ConnectorChip({
  connector,
  capabilityMap,
  byType,
}: {
  connector: ConnectorRequirement
  capabilityMap: Record<string, string[]>
  byType: Map<string, ConnectorDef>
}) {
  const types = connector.connectorType ? [] : typesForRequirement(connector, capabilityMap)

  const chip = (
    <span className="integration-chip explore-detail__chip">
      {connector.connectorType
        ? <span className="integration-chip__icon">{connectorIcon(connector)}</span>
        : <CapabilityIconStack types={types} />
      }
      {connectorLabel(connector)}
    </span>
  )

  // The catalog is its own query. Until it lands there is nothing to list, and
  // an empty tooltip would open as a blank pill.
  if (types.length === 0) return chip

  return (
    <Tooltip text={<CapabilityConnectorRows types={types} byType={byType} />} position="top">
      {chip}
    </Tooltip>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// STEP 1 — GALLERY
// ─────────────────────────────────────────────────────────────────────────────

interface TemplateCardProps {
  template: AgentTemplateCard
  connectedTypes: Set<string>
  capabilityMap: Record<string, string[]>
  onClick: () => void
}

function TemplateCard({ template, capabilityMap, onClick }: TemplateCardProps) {
  const families = uniqueByFamily(template.requiredConnectors)
  const visibleConnectors = families.slice(0, 4)
  const extra = families.length - visibleConnectors.length

  return (
    <div
      className="template-card"
      onClick={onClick}
      role="button"
      tabIndex={0}
      onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') onClick() }}
    >
      {/* Hero zone */}
      <div className={`template-card__hero template-card__hero--${template.departmentCategory}`}>
        <div className="template-card__hero-icon">
          {createElement(getTemplateIcon(template))}
        </div>
      </div>

      {/* Body */}
      <div className="template-card__body">
        <h3 className="template-card__name">{template.displayName}</h3>
        <p className="template-card__desc">{template.description}</p>
      </div>

      {/* Footer */}
      <div className="template-card__footer">
        <div className="template-card__connector-icons">
          {visibleConnectors.map(c => (
            <Tooltip key={c.id} text={connectorLabel(c)} position="top">
              {c.connectorType
                ? <div className="template-card__connector-icon">{connectorIcon(c)}</div>
                : <CapabilityIconStack types={typesForRequirement(c, capabilityMap)} />
              }
            </Tooltip>
          ))}
          {extra > 0 && (
            <span className="template-card__connector-more">+{extra}</span>
          )}
        </div>
      </div>
    </div>
  )
}

function SkeletonCard() {
  return (
    <div className="template-card template-card--skeleton">
      <div className="template-card__hero skeleton-block skeleton-pulse" style={{ background: 'var(--color-gray-100)' }} />
      <div className="template-card__body">
        <div className="skeleton-block skeleton-pulse" style={{ height: 16, width: '65%' }} />
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4, marginTop: 4 }}>
          <div className="skeleton-block skeleton-pulse" style={{ height: 12, width: '100%' }} />
          <div className="skeleton-block skeleton-pulse" style={{ height: 12, width: '80%' }} />
        </div>
      </div>
      <div className="template-card__footer">
        <div style={{ display: 'flex', gap: 4 }}>
          {[1,2,3].map(i => <div key={i} className="skeleton-block skeleton-pulse" style={{ width: 20, height: 20, borderRadius: 4 }} />)}
        </div>
        <div className="skeleton-block skeleton-pulse" style={{ height: 12, width: 40, borderRadius: 4 }} />
      </div>
    </div>
  )
}

interface GalleryStepProps {
  onSelect: (template: AgentTemplateCard) => void
  onBack: () => void
  /** Seeds the search box, from the `?role=` a hero visitor carried over. */
  prefilledSearch?: string
}

function GalleryStep({ onSelect, onBack, prefilledSearch }: GalleryStepProps) {
  const navigate = useNavigate()
  const [activeFilter, setActiveFilter] = useState<'all' | DepartmentCategory>('all')
  const [searchQuery, setSearchQuery] = useState(prefilledSearch ?? '')
  // Only ever true while a request is in flight, so the "not pending" half is
  // derived and the effect no longer has to switch it back off a frame late.
  const [skeletonDelayPassed, setSkeletonDelayPassed] = useState(false)
  const skeletonRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const browsedRef = useRef(false)
  useEffect(() => {
    if (browsedRef.current) return
    browsedRef.current = true
    track('team_explore_template_browsed', {})
  }, [])

  const { data, isPending } = useAgentTemplates()
  // `connected` is the live-connection array (status 'connected' | 'needs_reconnect');
  // the `integrations` array is catalog-only (status 'available' | 'planned') and never
  // carries a connected status, so building connectedTypes from it always yielded an
  // empty set — every template's required connectors rendered as "not connected" even
  // when GitHub/GitLab/etc. were connected (matching the Connections page, which uses
  // `connected`). Use `connected` here so the two surfaces agree.
  const { connected } = useIntegrations()
  const { connectors: catalogConnectors } = useConnectorCatalog()
  const capabilityMap = useMemo(() => buildCapabilityConnectorTypes(catalogConnectors), [catalogConnectors])

  // Never shown once the request has landed, whatever the timer did.
  const showSkeleton = isPending && skeletonDelayPassed

  // Delayed skeleton
  useEffect(() => {
    if (isPending) {
      skeletonRef.current = setTimeout(() => setSkeletonDelayPassed(true), 150)
    } else if (skeletonRef.current) {
      clearTimeout(skeletonRef.current)
    }
    return () => { if (skeletonRef.current) clearTimeout(skeletonRef.current) }
  }, [isPending])

  const connectedTypes = new Set(
    connected
      .filter(i => i.connectorType)
      .map(i => i.connectorType as string),
  )

  const allTemplates = useMemo(() => data?.templates ?? [], [data?.templates])
  const query = searchQuery.trim().toLowerCase()

  const matchesQuery = useCallback(
    (t: AgentTemplateCard) =>
      !query ||
      t.displayName.toLowerCase().includes(query) ||
      t.description.toLowerCase().includes(query) ||
      t.role.toLowerCase().includes(query),
    [query],
  )

  // Compute per-dept counts (for building filter options — always from full list)
  const deptCounts: Partial<Record<DepartmentCategory, number>> = {}
  allTemplates.forEach(t => {
    deptCounts[t.departmentCategory] = (deptCounts[t.departmentCategory] ?? 0) + 1
  })

  // Build SegmentedControl options from departments that have at least one template
  const filterOptions: Array<{ value: 'all' | DepartmentCategory; label: string }> = [
    { value: 'all', label: 'All' },
    ...ALL_DEPARTMENTS
      .filter(d => (deptCounts[d] ?? 0) > 0)
      .map(d => ({ value: d as DepartmentCategory, label: DEPARTMENT_LABELS[d] })),
  ]

  // Group templates by department, applying both dept filter and search query.
  // Memoized because an effect below is keyed on it, and the arrays here are
  // rebuilt on every render.
  const sections = useMemo(
    () => activeFilter !== 'all'
      ? [{ dept: activeFilter, templates: allTemplates.filter(t => t.departmentCategory === activeFilter && matchesQuery(t)) }]
      : ALL_DEPARTMENTS
          .map(dept => ({ dept, templates: allTemplates.filter(t => t.departmentCategory === dept && matchesQuery(t)) }))
          .filter(s => s.templates.length > 0),
    [activeFilter, allTemplates, matchesQuery],
  )

  const isZeroResultsBuilder = !isPending && sections.length === 0 && !!query
  const isBuilderMode = isZeroResultsBuilder
  const builderRole = searchQuery
  const setBuilderRole = setSearchQuery

  // Debounced search event — fire 300ms after user stops typing.
  useEffect(() => {
    if (!searchQuery) return
    const totalCount = sections.reduce((acc, s) => acc + s.templates.length, 0)
    const handle = setTimeout(() => {
      track('team_explore_template_searched', {
        query_length: searchQuery.length,
        result_count: totalCount,
      })
    }, 300)
    return () => clearTimeout(handle)
  }, [searchQuery, sections])

  const handleBackClick = isBuilderMode ? () => setSearchQuery('') : onBack

  // Embedded hire_gallery with a prefilled role: defer rendering the gallery
  // shell until templates have loaded. Without this, the user briefly sees
  // the "Hire agents" header + empty state before the component re-renders
  // into the no-results inline builder (because `isBuilderMode` is gated on
  // `!isPending`). Render the same .agent-builder shell the inline builder
  // uses so the transition into builder mode is seamless — same wrapper,
  // spinner swaps for the role form.
  if (prefilledSearch && isPending) {
    // Drop the .agent-builder__content wrapper here — that wrapper is a
    // 560px-wide block with text-align:center (which centers inline content
    // only). The spinner is a block element, so it would sit left-aligned.
    // Render the spinner as a direct flex child of .agent-builder so the
    // parent's align-items/justify-content:center handles both axes.
    return (
      <div className="agent-builder">
        <div className="loading-spinner" aria-label="Loading templates" />
      </div>
    )
  }

  if (isBuilderMode) {
    return (
      <div className="agent-builder">
        <BackButton onClick={handleBackClick} />
        <div className="agent-builder__content">
          <form
            className="agent-builder-step explore-gallery__inline-builder"
            onSubmit={e => {
              e.preventDefault()
              const r = builderRole.trim()
              if (!r) return
              navigate(`/dashboard/agents/build?role=${encodeURIComponent(r)}`)
            }}
          >
            <RoleInput
              value={builderRole}
              onChange={setBuilderRole}
              titleAs="h1"
              titleClassName="agent-builder-step__header"
              focusOnMount
            />
            <div className="agent-builder-nav">
              <Button
                variant="primary"
                onClick={() => {
                  const r = builderRole.trim()
                  if (!r) return
                  navigate(`/dashboard/agents/build?role=${encodeURIComponent(r)}`)
                }}
                disabled={!builderRole.trim()}
              >
                Continue
              </Button>
            </div>
          </form>
        </div>
      </div>
    )
  }

  return (
    <div className="agent-update">
      <BackButton onClick={onBack} />

      <div className="agent-update__header">
        <div className="agent-update__header-actions">
          <Tooltip text="Import Local Setup">
            <button
              type="button"
              className="explore-gallery__icon-btn"
              onClick={() => {
                track('switch_entry_clicked', { source: 'explore_header' })
                navigate('/dashboard/switch')
              }}
              aria-label="Import Local Setup"
            >
              <CloudUploadIcon />
            </button>
          </Tooltip>
          <Button
            variant="primary"
            onClick={() => navigate('/dashboard/agents/build')}
          >
            Custom Agent
          </Button>
        </div>
      </div>

      <div className="agent-update__content">
        <div>
          <h1 className="explore-gallery__title">Hire agents</h1>
          <p className="explore-gallery__subtitle">
            agents for every department. Connect your apps and launch instantly.
          </p>
        </div>

        {/* Category filter */}
        <SegmentedControl
          options={filterOptions}
          value={activeFilter}
          onChange={setActiveFilter}
        />

        {/* Search */}
        <TextInput
          variant="search"
          placeholder="Search"
          value={searchQuery}
          onChange={e => setSearchQuery(e.target.value)}
        />

        {/* Content */}
        {showSkeleton && isPending ? (
          <div className="explore-gallery__section">
            <div className="explore-gallery__grid">
              {Array.from({ length: 8 }, (_, i) => <SkeletonCard key={i} />)}
            </div>
          </div>
        ) : sections.length === 0 ? (
          <div className="explore-gallery__empty">
            <p className="explore-gallery__empty-title">No templates found</p>
            <p className="explore-gallery__empty-body">
              {activeFilter !== 'all'
                ? `No templates in ${DEPARTMENT_LABELS[activeFilter]} yet — more coming soon.`
                : 'No templates available yet.'}
            </p>
          </div>
        ) : (
          sections.map(({ dept, templates }) => (
            <section key={dept} className="explore-gallery__section">
              {activeFilter === 'all' && (
                <div className="explore-gallery__section-header">
                  <h2 className="explore-gallery__section-title">{DEPARTMENT_LABELS[dept]}</h2>
                  <span className="explore-gallery__section-count">{templates.length}</span>
                </div>
              )}
              <div className="explore-gallery__grid">
                {templates.map(t => (
                  <TemplateCard
                    key={t.id}
                    template={t}
                    connectedTypes={connectedTypes}
                    capabilityMap={capabilityMap}
                    onClick={() => onSelect(t)}
                  />
                ))}
              </div>
            </section>
          ))
        )}
      </div>
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// STEP 2 — DETAIL VIEW
// ─────────────────────────────────────────────────────────────────────────────
// ─────────────────────────────────────────────────────────────────────────────

/** Placeholder for a prose section whose body has not arrived yet. Only ever
 *  seen by someone who opens a fold within the first moments of the page. */
function DetailProseSkeleton() {
  return (
    <div className="explore-detail__prose-skeleton" aria-hidden="true">
      <span className="skeleton-block" />
      <span className="skeleton-block" />
      <span className="skeleton-block" />
    </div>
  )
}

/** The one-line description under the role name.
 *
 *  The catalog's own sentence until somebody rewrites a line, at which point it
 *  describes a team that no longer exists — so it is replaced by a skeleton
 *  while a new one is written rather than left standing. The skeleton keeps the
 *  two-line shape of a typical description so nothing below it moves. */
function TemplateSummary({ summary, fallback }: { summary: SummaryState; fallback: string }) {
  if (summary.status === 'refreshing') {
    return (
      <p className="explore-detail__description explore-detail__description--pending" aria-busy="true">
        <span className="sr-only">Rewriting the description</span>
        {/* Three bars, not two. A real description runs to a median of 256
            characters, which is about three lines in this column, so a
            two-line skeleton jumped the page when the sentence landed. */}
        <span className="explore-detail__summary-skeleton skeleton-pulse" aria-hidden="true">
          <span className="skeleton-text" />
          <span className="skeleton-text" />
          <span className="skeleton-text" />
        </span>
      </p>
    )
  }
  // Says what happened, in the space the description occupied.
  //
  // Not the catalog's sentence, which now describes a team that does not exist.
  // Not nothing either: the line vanishing pulls everything below it upward and
  // explains none of it. And deliberately not the skeleton left running, which
  // is the worst of the three — a skeleton promises something is arriving, so
  // leaving one pulsing after a failure keeps making a promise the page cannot
  // keep, and the animation holds the eye on a thing that will never change.
  if (summary.status === 'unavailable') {
    return (
      <p className="explore-detail__description explore-detail__description--failed" role="status">
        This description could not be updated
      </p>
    )
  }
  return (
    <p className="explore-detail__description">
      {summary.status === 'ready' ? summary.text : fallback}
    </p>
  )
}

interface DetailStepProps {
  /** Always present: the gallery card the person clicked. Carries everything
   *  above the fold, so the page paints without waiting on anything. */
  card: AgentTemplateCard
  /** The fetched body, null until it arrives. Only the two collapsed prose
   *  sections need it, and both start closed, so the fetch is normally over
   *  before there is anything to show. */
  template: AgentTemplate | null
  /** The body failed to load. Continue stays disabled: every step past here
   *  distills from that body, so advancing without it would build the wrong
   *  agent rather than fail loudly. */
  loadFailed?: boolean
  onUse: () => void
  onBack: () => void
  /** The person's version of each field, null until they rewrite a line.
   *  Held on the wizard rather than in here so it survives every step of the
   *  flow — the collapsibles unmount their contents when closed, and a draft
   *  living inside one would be destroyed by folding the section. */
  drafts: TemplateDrafts
  onDraftChange: (field: DraftField, next: ProseDraft) => void
  /** What they have renamed this team to, or null while it is still the
   *  template's own name. */
  draftRole: string | null
  onRoleChange: (role: string) => void
  summary: SummaryState
}

/** The two template fields a person can rewrite here. */
type DraftField = 'responsibilities' | 'additionalContext'
type TemplateDrafts = Record<DraftField, ProseDraft | null>

/** A template's guidance, one part at a time.
 *
 *  The stored string is a document: five `## Heading` parts running to a few
 *  hundred words. Opening it whole hands the reader all of it at once, so the
 *  parts become a segmented control and exactly one panel renders. Guidance
 *  with a single part (or none) has nothing to switch between and just reads. */
function SectionedProse({
  markdown,
  template,
  draft,
  onDraftChange,
}: {
  markdown: string
  template: AgentTemplate
  /** The person's version of this field, or null while it is still ours. */
  draft: ProseDraft | null
  onDraftChange: (next: ProseDraft) => void
}) {
  // The template's own text, parsed once. `draft` shadows it the moment
  // anything is rewritten; until then the two are identical and this is what
  // renders.
  const pristine = useMemo(() => draftFromMarkdown(markdown), [markdown])
  const sections = draft ?? pristine

  const resolveToken = useMemo(() => buildTokenResolver(template), [template])

  // Nothing is typed into the template's input fields yet — they are on the
  // connectors step, after this one — so every declared input reads as its
  // `fallback` here, which is the phrase the backend substitutes for a blank
  // at hire. Undeclared braces stay literal text.
  const isInputToken = useMemo(() => {
    const ids = new Set((template.inputs ?? []).map(i => i.id))
    return (id: string) => ids.has(id)
  }, [template])

  const intro = sections.filter(s => s.heading === null)
  const parts = sections.filter(s => s.heading !== null)

  // Index as the value, not the heading: a document is free to repeat a
  // heading, and two options sharing a value would switch as one.
  const [active, setActive] = useState(0)
  const current = parts[active] ?? parts[0]
  const currentIndex = current ? sections.indexOf(current) : -1

  /** Apply a change to one part's blocks, leaving every other part alone. */
  const editPart = (partIndex: number, blocks: ProseDraft[number]['blocks']) => {
    onDraftChange(sections.map((section, i) =>
      i === partIndex ? { ...section, blocks } : section,
    ))
  }

  return (
    <div className="explore-detail__parts">
      {/* No catalog template currently opens with text above its first
          heading, but one is allowed to, and it stays read-only: it is not part
          of any named part, so there is no heading for the control to switch
          to and nothing to mark as edited. */}
      {intro.map((section, i) => (
        <Markdown key={i} className="explore-detail__prose">{joinProseBlocks(section.blocks)}</Markdown>
      ))}

      {parts.length > 1 && (
        <SegmentedControl
          options={parts.map((section, i) => ({
            value: String(i),
            label: section.heading!,
          }))}
          value={String(active)}
          onChange={(value) => setActive(Number(value))}
        />
      )}

      {current && currentIndex >= 0 && (
        <div className="explore-detail__prose">
          <InlineProse
            blocks={current.blocks}
            resolveToken={resolveToken}
            isInputToken={isInputToken}
            onChange={(blocks) => editPart(currentIndex, blocks)}
          />
        </div>
      )}
    </div>
  )
}

/** A titled block that opens on click, collapsed until then. Matches the
 *  Advanced Settings collapsibles on the team update page. */
function DetailCollapsible({
  title,
  titleAs: TitleTag = 'h3',
  children,
  onOpen,
}: {
  title: string
  titleAs?: 'h2' | 'h3'
  children: React.ReactNode
  onOpen?: () => void
}) {
  const [open, setOpen] = useState(false)
  return (
    <section className="agent-update__section agent-update__collapsible">
      <button
        type="button"
        className="agent-update__collapsible-header"
        aria-expanded={open}
        onClick={() => {
          if (!open) onOpen?.()
          setOpen(!open)
        }}
      >
        <TitleTag className="agent-update__section-title">{title}</TitleTag>
        <ChevronDownIcon
          className={`agent-update__collapsible-icon ${open ? 'agent-update__collapsible-icon--open' : ''}`}
        />
      </button>
      {open && <div className="agent-update__collapsible-content">{children}</div>}
    </section>
  )
}

export function DetailStep({
  card,
  template,
  loadFailed,
  onUse,
  onBack,
  drafts,
  onDraftChange,
  draftRole,
  onRoleChange,
  summary,
}: DetailStepProps) {
  const { connectors: catalogConnectors, byType } = useConnectorCatalog()
  const capabilityMap = useMemo(() => buildCapabilityConnectorTypes(catalogConnectors), [catalogConnectors])

  const openSection = (section: string) =>
    track('team_explore_detail_section_opened', { template_id: card.id, section })

  return (
    <div className="agent-update">
      <BackButton onClick={onBack} />

      <div className="agent-update__header">
        <div className="agent-update__header-actions">
          <Button variant="primary" onClick={onUse} disabled={!template}>Continue</Button>
        </div>
      </div>

      <div className="agent-update__content">
        {/* Meta */}
        <div>
          {/* Every catalog template has displayName === role, so there is no
              ambiguity about which field this edits: it sets the role, which is
              what the distiller, the create call, the connector step copy and
              the confirmation screen all read. */}
          <InlineText
            as="h1"
            className="explore-detail__title"
            value={draftRole ?? card.displayName}
            onChange={onRoleChange}
            maxLength={TEAM_LIMITS.ROLE_MAX}
            editLabel="Rename this team"
          />
          <TemplateSummary summary={summary} fallback={card.description} />
        </div>

        {loadFailed && (
          <p className="explore-detail__load-error" role="alert">
            This template could not be loaded. Please go back and try again.
          </p>
        )}

        {/* The two prose sections fold, so each one is a card whose header is
            its heading. A section whose content reads on arrival (the connector
            chips below) keeps a plain heading instead.

            Both render unconditionally: their bodies come from the fetch, and
            gating the headers on it would make them appear a beat after the
            page. "How they operate" is still conditional on content, but the
            catalog validator requires additionalContext on every template, so
            that only ever hides it while the fetch is in flight. */}
        <DetailCollapsible
          title="What they do"
          titleAs="h2"
          onOpen={() => openSection('What they do')}
        >
          {template ? (
            <SectionedProse
              markdown={template.responsibilities}
              template={template}
              draft={drafts.responsibilities}
              onDraftChange={(next) => onDraftChange('responsibilities', next)}
            />
          ) : <DetailProseSkeleton />}
        </DetailCollapsible>

        <DetailCollapsible
          title="How they operate"
          titleAs="h2"
          onOpen={() => openSection('How they operate')}
        >
          {template ? (
            <SectionedProse
              markdown={template.additionalContext}
              template={template}
              draft={drafts.additionalContext}
              onDraftChange={(next) => onDraftChange('additionalContext', next)}
            />
          ) : <DetailProseSkeleton />}
        </DetailCollapsible>

        {/* Integrations */}
        {(card.requiredConnectors.length > 0 || card.optionalConnectors.length > 0) && (
          <section className="agent-update__section">
            <h2 className="agent-update__section-title">What should they work with?</h2>
            <div className="integrations-sections">
              {card.requiredConnectors.length > 0 && (
                <div className="integrations-section">
                  <span className="integrations-section__label">Required</span>
                  <div className="integrations-chips">
                    {uniqueByFamily(card.requiredConnectors).map(c => (
                      <ConnectorChip key={c.id} connector={c} capabilityMap={capabilityMap} byType={byType} />
                    ))}
                  </div>
                </div>
              )}
              {card.optionalConnectors.length > 0 && (
                <div className="integrations-section">
                  <span className="integrations-section__label">Optional</span>
                  <div className="integrations-chips">
                    {uniqueByFamily(card.optionalConnectors).map(c => (
                      <ConnectorChip key={c.id} connector={c} capabilityMap={capabilityMap} byType={byType} />
                    ))}
                  </div>
                </div>
              )}
            </div>
          </section>
        )}
      </div>
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// STEP 3 — CONNECTOR SETUP
// ─────────────────────────────────────────────────────────────────────────────

interface ConnectorSetupStepProps {
  template: AgentTemplate
  /** What this team is being hired under, which is not `template.role` once
   *  somebody has renamed it on the detail step. */
  roleLabel: string
  onContinue: () => void
  onBack: () => void
  resolvedObjects: ResolvedObjects
  onResolveObject: (key: string, value: PickedObject & { connectorId: string }) => void
  /** Keys of picks this connection cannot enumerate, so they can never be
   *  answered. */
  unanswerableObjects: ReadonlySet<string>
  onUnanswerableObject: (key: string) => void
  /** Connections this team was taken off, by connector id. */
  excludedConnections: ReadonlySet<string>
  onToggleConnection: (connectorId: string, use: boolean) => void
  inputValues: TemplateInputValues
  onInputChange: (id: string, value: string) => void
}

/** Answers to the template's declared inputs, keyed by input id. Typed by the
 *  person hiring, on this step, and never inferred from a workspace name or a
 *  connected account. */
export type TemplateInputValues = Record<string, string>

/** Resolved objects, keyed `<requirementId>:<objectId>`. Lives on the step
 *  rather than in the template so a person can change a pick without
 *  disconnecting, and so the gate below can read it synchronously. */
type ResolvedObjects = Record<string, PickedObject & { connectorId: string }>

/** Which requirement, object and connection a picker was opened for. */
interface PickerTarget {
  req: ConnectorRequirement
  /** Everything this connection needs named. One tree answers all of it in one
   *  pass: there is no step, no order, and nothing to advance through. */
  objects: RequirementObject[]
  connectorId: string
  connectorName: string
}

function ConnectorSetupStep({ template, roleLabel, onContinue, onBack, resolvedObjects, onResolveObject, unanswerableObjects, onUnanswerableObject, excludedConnections, onToggleConnection, inputValues, onInputChange }: ConnectorSetupStepProps) {
  // Use `connected` (live connections), not the catalog-only `integrations` array —
  // the latter never carries a 'connected' status, so connectedTypes was always empty
  // and `allRequiredConnected` never became true, wrongly blocking setup. See the
  // list-view note above.
  const { connected } = useIntegrations()
  const { connect, connecting, installTargetModal } = useIntegrationConnect()
  const [connectingType, setConnectingType] = useState<string | null>(null)
  const { connectors: catalogConnectors } = useConnectorCatalog()
  const capabilityMap = useMemo(() => buildCapabilityConnectorTypes(catalogConnectors), [catalogConnectors])

  const connectedTypes = new Set(
    connected
      .filter(i => i.connectorType)
      .map(i => i.connectorType as string),
  )

  const [picker, setPicker] = useState<PickerTarget | null>(null)

  /** The live connection backing a requirement, or null. Object pickers need a
   *  connector INSTANCE id to browse, which the requirement itself never
   *  carries: it names a type or a capability, and the instance only exists
   *  once the person has actually connected something.
   *
   *  Returns `connector.id`, NOT the entry's own `id`. For a multiInstance type
   *  the latter is a composite `"${type}:${uuid}"` (useIntegrations.ts), which
   *  browse cannot resolve, so the picker came back empty for exactly the
   *  connectors people are most likely to have. The knowledge page reads
   *  `connector.id` for the same reason. */
  const connectionFor = (req: ConnectorRequirement): { id: string } | null => {
    const hit = connectionsFor(req)[0]
    return hit ? { id: hit.id } : null
  }

  /** Every live connection that satisfies a requirement, in the order the
   *  workspace holds them.
   *
   *  More than one is normal: a capability names a whole family, so a workspace
   *  running Zoho and HubSpot satisfies `crm` twice. Callers that act on a
   *  specific row must use its own connection rather than resolving the
   *  requirement again, which would answer with whichever comes back first. */
  const connectionsFor = (req: ConnectorRequirement): Array<{ id: string; type: string }> => {
    const types = typesForRequirement(req, capabilityMap)
    return connected
      .filter(i => i.connectorType && types.includes(i.connectorType as string) && i.connector?.id)
      .map(i => ({ id: i.connector!.id as string, type: i.connectorType as string }))
  }

  /** The connections this team will actually be hired with. Everything the
   *  requirement matches, minus what the person took it off. */
  const usedConnectionsFor = (req: ConnectorRequirement) =>
    connectionsFor(req).filter(c => !excludedConnections.has(c.id))

  /** Whether a row offers the choice at all.
   *
   *  Every connected row of an optional requirement, however many connections
   *  there are, because a connection that cannot be declined is one that always
   *  binds: a workspace connects Slack once, for something, and this team then
   *  gets it whether or not it was meant to. A required requirement offers the
   *  choice only where two or more connections compete, since the last one
   *  cannot be cleared and a tick that refuses to move is a lie. */
  const offersChoice = (req: ConnectorRequirement) =>
    template.optionalConnectors.some(o => o.id === req.id) || connectionsFor(req).length > 1

  /** Whether this team uses this connection.
   *
   *  The tick carries it alone. The row already names the connection and sits
   *  under a heading that says what it is for, so a caption beside the box
   *  repeats what the card has said twice. The name assistive tech reads is
   *  passed instead, since a bare checkbox announces nothing. */
  const renderUseToggle = (req: ConnectorRequirement, connectorLabel: string, connectorId?: string) => {
    if (!connectorId || !offersChoice(req)) return null
    return (
      <Checkbox
        checked={!excludedConnections.has(connectorId)}
        onChange={(use: boolean) => {
          onToggleConnection(connectorId, use)
          track('team_explore_connection_toggled', {
            template_id: template.id,
            requirement_id: req.id,
            used: use,
          })
        }}
        ariaLabel={`Use ${connectorLabel} for this team`}
      />
    )
  }

  const objectKey = (req: ConnectorRequirement, obj: RequirementObject) => `${req.id}:${obj.id}`

  // Satisfied when a connected type matches and the team has not been taken off
  // every instance of it. Taking a team off all its CRMs leaves it with no CRM,
  // and a required requirement is the thing that cannot be empty.
  //
  // Connectedness is decided by type, not by the instance list: an entry whose
  // `connector.id` this view cannot resolve is still a connection, and a person
  // cannot act on an id they never see. Exclusions are keyed by id, so they
  // apply only where ids exist.
  const allRequiredConnected = template.requiredConnectors.every(req => {
    const types = typesForRequirement(req, capabilityMap)
    if (!types.some(t => connectedTypes.has(t))) return false
    const instances = connectionsFor(req)
    return instances.length === 0 || instances.some(c => !excludedConnections.has(c.id))
  })

  /** A required object is as load-bearing as the connection itself: a team told
   *  to write a digest with nowhere to write it is not ready.
   *
   *  Only on a REQUIRED connector. An optional connector never holds the hire,
   *  and it does not get to hold it through the back door either: a workspace
   *  with Slack already connected is not a workspace that asked this team to
   *  post anything, and the connection is there because somebody connected it
   *  once, for something else. Blocking on its channel makes an optional tool
   *  mandatory for every template that mentions one. The pick is still offered
   *  on the row, and an unanswered one substitutes to the object's own phrase
   *  ("your team channel") rather than leaving a hole.
   *
   *  Nor does a pick the connection cannot enumerate block. The picker tells
   *  that person they may continue without choosing one, and a required pick
   *  with an empty list behind it would otherwise leave the button dead with
   *  nothing they could do about it. */
  const allRequiredObjectsResolved = template.requiredConnectors
    .every(req => {
      if (!usedConnectionsFor(req).length) return true
      return (req.objects ?? [])
        .filter(o => o.required)
        .every(o => {
          const key = objectKey(req, o)
          const pick = resolvedObjects[key]
          // A pick made on a connection the team was then taken off is not an
          // answer: that folder is not reachable by anything being hired.
          const live = pick && !excludedConnections.has(pick.connectorId)
          return Boolean(live) || unanswerableObjects.has(key)
        })
    })

  // Capability groups whose already-decided alternatives the person asked to see
  // again. Keyed by requirement id, empty by default.
  const [expandedCapabilities, setExpandedCapabilities] = useState<Set<string>>(new Set())

  // Only the inputs the template marked required gate Continue. An optional one
  // makes the team better; it should never stand between a person and a hire.
  const templateInputs = template.inputs ?? []
  const inputsAnswered = templateInputs
    .filter(i => i.required)
    .every(i => (inputValues[i.id] ?? '').trim().length > 0)
  const canContinue = allRequiredConnected && allRequiredObjectsResolved && inputsAnswered

  const handleConnect = async (connectorType: string, label: string, req?: ConnectorRequirement) => {
    setConnectingType(connectorType)
    const ok = await connect(connectorType as ConnectorType, label)
    if (ok) {
      track('team_explore_required_connector_connected', {
        template_id: template.id,
        connector_type: connectorType,
      })
      // Ask for the destination at the one moment it is both answerable and
      // obviously relevant: they just connected this tool for this reason.
      // Asking earlier is impossible (no connection to browse) and asking later
      // means a disabled Continue with no visible cause. connect() runs the
      // provider in a POPUP, so this component never unmounted and the pending
      // requirement is still in hand.
      const objects = req?.objects ?? []
      if (req && objects.length) {
        // Same rule as connectionFor: browse needs `connector.id`, never the
        // entry id, which is composite for multiInstance types.
        const instanceId = connected.find(i => i.connectorType === connectorType)?.connector?.id
        if (instanceId) {
          setPicker({ req, objects, connectorId: instanceId, connectorName: label })
        }
      }
    }
    setConnectingType(null)
  }

  /** The button a connected row carries for each object it still needs named.
   *
   *  Deliberately the same `connection-card__connect` button the knowledge page
   *  uses for "Select Files", and that this very card uses for "+ Connect", so
   *  a person meets one affordance in one place rather than a new kind of link.
   *  The label carries the STATE, because an unresolved required object has to
   *  be visible: dismiss the modal and Continue stays disabled, so the row is
   *  the only thing that explains why. It is also the edit path once set. */
  const renderObjectRows = (
    req: ConnectorRequirement,
    connectorLabelText: string,
    /** The connection this row IS. A capability row renders per connected
     *  vendor, and the picks belong to the one the person clicked, not to
     *  whichever the workspace happens to list first. */
    connectorId?: string,
  ) => {
    const conn = connectorId ? { id: connectorId } : connectionFor(req)
    const objects = req.objects ?? []
    if (!conn?.id || !objects.length) return null
    // Nothing to name on a connection this team is not being hired with.
    if (excludedConnections.has(conn.id)) return null
    // ONE button per connection, whatever it needs picked.
    //
    // A row rendering a button per object gave "Connected  Select Folder
    // Select File", which asks a person to understand our data model before
    // they can answer: they have to know that a folder and a file are two
    // separate questions, and which one they are answering. The connection is
    // the unit they recognise, so the row offers one way in and the modal asks
    // for whatever that connection needs.
    // A stable verb, as on the knowledge page. What was chosen is listed below
    // the row rather than shown on the control.
    const chosen = objects
      .map(o => resolvedObjects[objectKey(req, o)])
      .filter((v): v is PickedObject & { connectorId: string } => Boolean(v))
    const label = chosen.length === 0 ? 'Select' : 'Manage'

    return (
      <div className="connection-card__objects">
        <button
          type="button"
          className={`connection-card__connect${chosen.length ? ' connection-card__connect--reimport' : ''}`}
          onClick={() => setPicker({
            req, objects, connectorId: conn.id, connectorName: connectorLabelText,
          })}
        >
          {label}
        </button>
      </div>
    )
  }

  /** What has been chosen, listed under the connection's row. Same markup the
   *  knowledge page uses for imported files. */
  const renderPicks = (req: ConnectorRequirement) => {
    const objects = req.objects ?? []
    if (!objects.length || !connectionFor(req)) return null

    // What was chosen, and nothing else. This list is the connection's contents,
    // not a form: a row for something nobody picked puts the template's own
    // question on the card, where it reads as content the person is meant to
    // act on.
    const chosen = objects
      .map(o => resolvedObjects[objectKey(req, o)])
      .filter((v): v is PickedObject & { connectorId: string } => Boolean(v))
      .filter(v => !excludedConnections.has(v.connectorId))
    if (!chosen.length) return null

    return (
      <div className="knowledge-group">
        {chosen.map(pick => (
          <div className="knowledge-item" key={pick.id}>
            <div className="knowledge-item__icon"><FileTextIcon /></div>
            <div className="knowledge-item__content">
              <span className="knowledge-item__title">{pick.title}</span>
            </div>
          </div>
        ))}
      </div>
    )
  }

  // Renders a specific (non-capability) connector as a single card
  const renderCard = (req: ConnectorRequirement) => {
    const type = req.connectorType!
    const connected = connectedTypes.has(type)
    const label = connectorLabel(req)
    const isConnecting = connectingType === type && connecting
    return (
      <div key={req.id}>
        <div className={`connection-card${connected ? ' connection-card--connected' : ' connection-card--available'}`}>
          <div className="connection-card__icon">{connectorIcon(req)}</div>
          <div className="connection-card__content">
            <h3 className="connection-card__name">{label}</h3>
            <span className="connection-card__type">{req.description}</span>
          </div>
          {connected ? (
            // Status and the control share the row's right-hand column: what
            // this connection is, and the one thing left to do to it.
            <div className="connection-card__actions">
              {renderUseToggle(req, label, connectionFor(req)?.id)}
              <div className="connection-card__status"><StatusDot variant="connected" />Connected</div>
              {renderObjectRows(req, label)}
            </div>
          ) : (
            <button
              className="connection-card__connect"
              onClick={() => handleConnect(type, label, req)}
              disabled={isConnecting || (connecting && !isConnecting)}
            >
              {isConnecting ? 'Connecting…' : '+ Connect'}
            </button>
          )}
        </div>
        {renderPicks(req)}
      </div>
    )
  }

  // Renders a capability group: each connector type as a standard connection-card,
  // all wrapped in a rounded-corner rectangle. A requirement that accepts either
  // of two families is ONE group listing both families' apps, because to the
  // person connecting it there is one question and any one answer ends it.
  const renderCapabilityCard = (req: ConnectorRequirement) => {
    const allTypes = typesForRequirement(req, capabilityMap)
    const capLabel = connectorLabel(req)

    // Once one vendor in a group is connected, the rest are answered questions.
    // A capability with eight alternatives kept eight rows on screen forever,
    // pushing every later capability below the fold, and asking a person to
    // re-read seven tools they have already decided against. The requirement is
    // met; the alternatives collapse behind one control and stay reachable for
    // anyone who wants to add a second.
    const satisfied = allTypes.some(t => connectedTypes.has(t))
    const hidden = satisfied ? allTypes.filter(t => !connectedTypes.has(t)) : []
    const showAll = expandedCapabilities.has(req.id)
    const types = satisfied && !showAll
      ? allTypes.filter(t => connectedTypes.has(t))
      : allTypes

    return (
      <div key={req.id} className="capability-group">
        <div className="capability-group__header">
          <CapabilityIconStack types={allTypes} />
          <div className="connection-card__content">
            <h3 className="connection-card__name">{capLabel}</h3>
            <span className="connection-card__type">{req.description}</span>
          </div>
        </div>
        {types.map(type => {
          const label = typeToLabel(type)
          const icon = getIntegrationIcon(type)
          const connected = connectedTypes.has(type)
          const isConnecting = connectingType === type && connecting
          return (
            <div key={type}>
              <div className={`connection-card${connected ? ' connection-card--connected' : ' connection-card--available'}`}>
                <div className="connection-card__icon">{icon}</div>
                <div className="connection-card__content">
                  <h3 className="connection-card__name">{label}</h3>
                </div>
                {connected ? (
                  // The pick belongs to the requirement, but it is asked for on
                  // the row that says "Connected": that is the vendor it will
                  // be made against. More than one row in a group can be
                  // connected, so the row hands its OWN connection to the
                  // picker rather than letting the requirement resolve one.
                  <div className="connection-card__actions">
                    {renderUseToggle(req, label, connectionsFor(req).find(c => c.type === type)?.id)}
                    <div className="connection-card__status"><StatusDot variant="connected" />Connected</div>
                    {renderObjectRows(req, label, connectionsFor(req).find(c => c.type === type)?.id)}
                  </div>
                ) : (
                  <button
                    className="connection-card__connect"
                    onClick={() => handleConnect(type, label, req)}
                    disabled={isConnecting || (connecting && !isConnecting)}
                  >
                    {isConnecting ? 'Connecting…' : '+ Connect'}
                  </button>
                )}
              </div>
              {/* Under the connected vendor, never at the end of the group,
                  where it reads as loose text belonging to nothing. */}
              {connected && renderPicks(req)}
            </div>
          )
        })}
        {hidden.length > 0 && (
          // Three dots explain nothing on their own, and a native `title` gives
          // a delayed OS tooltip in a font that belongs to no design here.
          <Tooltip position="top" text={showAll ? 'Show Less' : 'Show More'}>
            <button
              type="button"
              className="capability-group__more"
              onClick={() => setExpandedCapabilities(prev => {
                const next = new Set(prev)
                if (next.has(req.id)) next.delete(req.id)
                else next.add(req.id)
                return next
              })}
              aria-expanded={showAll}
              aria-label={showAll
                ? `Hide the other ${capLabel} tools`
                : `Show ${hidden.length} other ${capLabel} ${hidden.length === 1 ? 'tool' : 'tools'}`}
            >
              <ChevronDownIcon
                className="capability-group__more-icon"
                width={16}
                height={16}
                aria-hidden="true"
              />
            </button>
          </Tooltip>
        )}
      </div>
    )
  }

  const renderConnectorList = (connectors: ConnectorRequirement[]) => (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-3)' }}>
      {connectors.filter(c => c.connectorType).length > 0 && (
        <div className="connections-grid">
          {connectors.filter(c => c.connectorType).map(renderCard)}
        </div>
      )}
      {connectors.filter(c => !c.connectorType).map(renderCapabilityCard)}
    </div>
  )

  return (
    <div className="agent-update">
      <BackButton onClick={onBack} />

      {/* GitHub's App install-target picker, owned by useIntegrationConnect and
          rendered while connect() waits on it. Null for every other connector. */}
      {installTargetModal}
      {picker && picker.objects.length > 0 && (
        <ObjectPicker
          objects={picker.objects}
          connectorId={picker.connectorId}
          connectorName={picker.connectorName}
          current={Object.fromEntries(
            picker.objects.map(o => [o.id, resolvedObjects[objectKey(picker.req, o)] ?? null]),
          )}
          onClose={() => setPicker(null)}
          onPick={(objectId, picked) => {
            const object = picker.objects.find(o => o.id === objectId)
            if (!object) return
            onResolveObject(objectKey(picker.req, object), {
              ...picked,
              connectorId: picker.connectorId,
            })
            track('team_explore_requirement_object_picked', {
              template_id: template.id,
              requirement_id: picker.req.id,
              object_kind: object.kind,
            })
          }}
          onUnsupported={(objectId) => {
            const object = picker.objects.find(o => o.id === objectId)
            if (object) onUnanswerableObject(objectKey(picker.req, object))
          }}
        />
      )}

      <div className="agent-update__header">
        <div className="agent-update__header-actions">
          <Button variant="primary" onClick={onContinue} disabled={!canContinue}>
            Continue
          </Button>
        </div>
      </div>

      <div className="agent-update__content">
        <div>
          <h1 className="explore-gallery__title">What they work with</h1>
          <p className="explore-gallery__subtitle">
            Your {roleLabel} needs these apps and services to work.
          </p>
        </div>

        {/* Above the connectors on purpose: these are facts about the work
            itself, which the tools below are only the means to. Driven entirely
            by what the template declared, so a template needing a target market
            or a price floor renders here with no change to this file, and a
            code reviewer that declares nothing shows no section at all. */}
        {templateInputs.length > 0 && (
          <section className="connections-section">
            <div className="connections-section__header">
              <h2 className="connections-section__title">What they need to know</h2>
            </div>
            <div className="template-inputs">
              {templateInputs.map(field => (
                <label className="template-inputs__field" key={field.id}>
                  <span className="template-inputs__label">
                    {field.label}
                    {!field.required && (
                      <span className="template-inputs__optional">Optional</span>
                    )}
                  </span>
                  {/* The app's own field, as on the update page. The label
                      stays outside it, since it carries the Optional chip. */}
                  <TextInput
                    type={field.type === 'url' ? 'url' : 'text'}
                    value={inputValues[field.id] ?? ''}
                    onChange={e => onInputChange(field.id, e.target.value)}
                    placeholder={field.placeholder}
                    autoComplete={field.type === 'url' ? 'url' : 'off'}
                    required={field.required}
                    hint={field.hint}
                  />
                </label>
              ))}
            </div>
          </section>
        )}

        {template.requiredConnectors.length > 0 && (
          <section className="connections-section">
            <div className="connections-section__header">
              <h2 className="connections-section__title">Required</h2>
            </div>
            {renderConnectorList(template.requiredConnectors)}
          </section>
        )}

        {template.optionalConnectors.length > 0 && (
          <section className="connections-section">
            <div className="connections-section__header">
              <h2 className="connections-section__title">Optional</h2>
            </div>
            {renderConnectorList(template.optionalConnectors)}
          </section>
        )}

      </div>
    </div>
  )
}


// ─────────────────────────────────────────────────────────────────────────────
// MAIN PAGE
// ─────────────────────────────────────────────────────────────────────────────

type WizardStep = 'gallery' | 'detail' | 'connectors' | 'loading' | 'completion'

// This page used to double as an onboarding sub-flow, mounted inside
// OnboardingPage with six extra props that mirrored its internal step machine
// into `tenants.onboarding_hire_input`. That mirror is what stranded users: the
// parent persisted a substep but was never told which template had been picked,
// so every resume dropped them back at the top of the gallery with their
// selections gone. The hire now happens here and only here, after payment, so
// the component owns all of its own state and there is nothing to keep in sync.
// See ADR-050.
interface TeamExplorePageProps {
  /** Seeds `searchQuery` state on mount so a role the person arrived with
   *  pre-populates the gallery search. Supplied by the `?role=`
   *  query param, which onboarding sets on completion for a Path-B tenant. */
  prefilledSearch?: string
}

export default function AgentExplorePage({
  prefilledSearch,
}: TeamExplorePageProps = {}) {
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  // The route is mounted bare (<Route path="teams/explore" element={<AgentExplorePage />} />),
  // so the hero role arrives on the URL rather than as a prop. The prop still
  // wins when both are present.
  const effectivePrefilledSearch = prefilledSearch ?? searchParams.get('role') ?? undefined
  const { showToast } = useToast()
  const { openIfPaymentRequired } = usePlanGate()
  const { currentTenant: tenant } = useTenant()
  const { data: connectorsData } = useConnectors()
  const createTeamMutation = useCreateInternalAgent()
  const { connectors: catalogConnectors } = useConnectorCatalog()
  const capabilityMap = useMemo(() => buildCapabilityConnectorTypes(catalogConnectors), [catalogConnectors])

  const [step, setStep] = useState<WizardStep>('gallery')
  // The gallery hands over a card, which no longer carries the template body:
  // the list endpoint stopped serving it. Everything past the detail step needs
  // the body (it is what gets distilled), so opening a template fetches it and
  // the fetched template — not the card — is what the rest of the flow uses.
  const [selectedCard, setSelectedCard] = useState<AgentTemplateCard | null>(null)
  const {
    data: selectedTemplate = null,
    isError: isTemplateError,
  } = useQuery({
    queryKey: ['agentTemplate', selectedCard?.id],
    queryFn: () => getAgentTemplate(selectedCard!.id),
    enabled: !!selectedCard,
    staleTime: 5 * 60 * 1000,
  })
  const [distillResult, setDistillResult] = useState<DistillOutput | null>(null)
  /** The summary, ahead of the rest of the artifact. See AgentBuilder for the
   *  reasoning; this screen shows the same single distilled field. */
  const [earlySummary, setEarlySummary] = useState<string | null>(null)
  /** The distillation is still running behind the confirmation screen. */
  const [finalizing, setFinalizing] = useState(false)
  /** A decision taken before the artifact was ready, fired when it lands. */
  const deferredActionRef = useRef<'launch' | 'notNow' | null>(null)

  /** The in-flight distillation, so it can be called off. */
  const distillAbortRef = useRef<AbortController | null>(null)

  // Navigating away is a cancel too. See AgentBuilder.
  useEffect(() => () => distillAbortRef.current?.abort(), [])
  const [distillStage, setDistillStage] = useState<DistillStage | null>(null)
  const [submitError, setSubmitError] = useState<string | null>(null)
  const [pendingAction, setPendingAction] = useState<'launch' | 'notNow' | null>(null)
  // Integrations assembled from the template, with any per-binding `config`
  // emitted by the distillation LLM merged in. Held in state so the
  // distill-result merge persists into buildCreatePayload — assembleIntegrations
  // alone is template-only and would otherwise discard the LLM's emission.
  const [assembledIntegrations, setAssembledIntegrations] = useState<SelectedIntegration[]>([])
  /** Destinations and inputs the person named on the connector step, keyed
   *  `<requirementId>:<objectId>`. Held here rather than in the step so it
   *  survives a step back and reaches the distill payload below. */
  const [resolvedObjects, setResolvedObjects] = useState<ResolvedObjects>({})
  /** Picks this workspace's connection cannot list at all, keyed the same way.
   *  Held beside the answers because "nothing to choose from" is an answer to
   *  the gate, even though it is not a destination. */
  const [unanswerableObjects, setUnanswerableObjects] = useState<Set<string>>(new Set())
  /** Connections the person took this team off, by connector id. Empty by
   *  default, so a workspace that never touches the control is hired with
   *  everything its templates match, as before. */
  const [excludedConnections, setExcludedConnections] = useState<Set<string>>(new Set())
  const [inputValues, setInputValues] = useState<TemplateInputValues>({})
  /** The person's own version of the template's two prose fields.
   *
   *  Null means untouched, which is the common case and the one that keeps
   *  everything downstream on the catalog's text. Held here, beside
   *  `resolvedObjects`, so it survives detail -> connectors -> loading ->
   *  completion and every step back; only returning to the gallery clears it. */
  const [drafts, setDrafts] = useState<TemplateDrafts>({
    responsibilities: null,
    additionalContext: null,
  })

  /** What they renamed this team to, or null while it is still the template's
   *  own name. Separate from `drafts` because a rename is a different kind of
   *  change: the provenance hash covers only the two prose fields, so renaming
   *  leaves a hire's link to its template intact and a later redistill still
   *  seeds from the catalog. They changed the label, not the job. */
  const [draftRole, setDraftRole] = useState<string | null>(null)

  /** The state of the line under the role name.
   *
   *  `template` is the catalog's own description and the common case.
   *  Everything else only happens once an edit has made that line untrue. */
  const [summary, setSummary] = useState<SummaryState>({ status: 'template' })
  const summaryAbortRef = useRef<AbortController | null>(null)
  /** Rewritten lines already described, keyed by the text they describe, so
   *  leaving this step and coming back does not pay for the same sentence
   *  twice. */
  const summaryCacheRef = useRef(new Map<string, string>())

  // Leaving mid-flight is not a failure; it just stops mattering.
  useEffect(() => () => summaryAbortRef.current?.abort(), [])

  const proseForked = draftIsEdited(drafts.responsibilities ?? []) || draftIsEdited(drafts.additionalContext ?? [])
  const forked = proseForked || draftRole !== null

  /** The name this team is being hired under. */
  function effectiveRole(template: AgentTemplate) {
    return draftRole ?? template.role
  }

  /** The text this hire should actually be built from: theirs where they wrote
   *  some, ours everywhere else. Every downstream call reads through here
   *  rather than off `selectedTemplate`, so a fork cannot be honoured in one
   *  place and silently dropped in another. */
  function effectiveProse(template: AgentTemplate) {
    return {
      responsibilities: drafts.responsibilities
        ? markdownFromDraft(drafts.responsibilities)
        : template.responsibilities,
      additionalContext: drafts.additionalContext
        ? markdownFromDraft(drafts.additionalContext)
        : template.additionalContext,
    }
  }

  function handleDraftChange(field: DraftField, next: ProseDraft) {
    if (drafts[field] === null) {
      track('team_explore_inline_edit_started', {
        template_id: selectedCard?.id ?? 'unknown',
        field,
      })
    }
    // Computed here rather than inside the updater below: a state updater has
    // to be pure, and React calls it more than once — which fired the rewrite
    // twice per edit and spent the old ceiling at double rate.
    const merged = { ...drafts, [field]: next }
    setDrafts(merged)
    refreshSummary(merged, draftRole)
    // A distillation of the previous wording no longer describes this team.
    // Unreachable today — connectors' only forward edge re-runs the distill —
    // but leaving a stale artifact in state is how that stops being true.
    setDistillResult(null)
    setEarlySummary(null)
  }

  function resetDrafts() {
    setDrafts({ responsibilities: null, additionalContext: null })
    setDraftRole(null)
    summaryAbortRef.current?.abort()
    summaryAbortRef.current = null
    setSummary({ status: 'template' })
  }

  /** Rewrite the line under the role name to match what they just changed.
   *
   *  Fires on a committed edit, never per keystroke: the block editor already
   *  has a commit boundary, so there is nothing to debounce and no tuning to
   *  get wrong. An edit landing while one is in flight abandons it, because
   *  only the latest text is worth describing.
   *
   *  Keyed on the text itself, so walking back to this step having changed
   *  nothing is a cache read rather than another call. */
  function refreshSummary(nextDrafts: TemplateDrafts, nextRole: string | null) {
    const template = selectedTemplate
    if (!template || !tenant?.id) return

    const body = {
      role: nextRole ?? template.role,
      responsibilities: nextDrafts.responsibilities
        ? markdownFromDraft(nextDrafts.responsibilities)
        : template.responsibilities,
      additionalContext: nextDrafts.additionalContext
        ? markdownFromDraft(nextDrafts.additionalContext)
        : template.additionalContext,
    }
    const key = `${body.role} ${body.responsibilities} ${body.additionalContext}`

    const cached = summaryCacheRef.current.get(key)
    if (cached !== undefined) {
      setSummary(
        cached === TEMPLATE_SUMMARY_UNSUPPORTED ? { status: 'template' }
        : cached ? { status: 'ready', text: cached }
        : { status: 'unavailable' },
      )
      return
    }

    summaryAbortRef.current?.abort()

    const run = new AbortController()
    summaryAbortRef.current = run
    // Kept so a rate-limited attempt can put the line back exactly as it was
    // rather than leaving the skeleton pulsing or blanking it.
    const previous = summary
    setSummary({ status: 'refreshing' })

    describeEditedTemplate(template.id, tenant.id, body, run.signal)
      .then((result) => {
        if (run.signal.aborted) return
        const text = result.description?.trim() ?? ''
        summaryCacheRef.current.set(key, text)
        setSummary(text ? { status: 'ready', text } : { status: 'unavailable' })
      })
      .catch((error: unknown) => {
        if (run.signal.aborted) return
        // A 404 means the route is not deployed yet, so this workspace simply
        // does not have the capability — behave as though the feature is not
        // there and leave the catalog's line alone, rather than stripping a
        // description from every edited template until the backend ships.
        if (error instanceof ApiError && error.status === 404) {
          summaryCacheRef.current.set(key, TEMPLATE_SUMMARY_UNSUPPORTED)
          setSummary({ status: 'template' })
          return
        }
        // Rate limited: a transient "ask again shortly", not a statement that
        // the description is wrong. Deliberately NOT cached, so the next commit
        // tries again, and the line stays as it was rather than being blanked
        // for the rest of the visit by a momentary limit.
        if (error instanceof ApiError && error.status === 429) {
          setSummary(previous)
          return
        }
        // Any other failure means the route IS there and did not answer.
        // Falling back to the template's own line would put a description of
        // the UNEDITED team under a team they have edited, which is the exact
        // thing this exists to prevent. Showing nothing is the honest failure.
        summaryCacheRef.current.set(key, '')
        setSummary({ status: 'unavailable' })
      })
  }

  function handleRoleChange(role: string) {
    if (draftRole === null) {
      track('team_explore_inline_edit_started', {
        template_id: selectedCard?.id ?? 'unknown',
        field: 'role',
      })
    }
    setDraftRole(role)
    refreshSummary(drafts, role)
    // A distilled artifact carries the old name in its summary and prompts.
    setDistillResult(null)
    setEarlySummary(null)
  }

  /** Leaving the detail step for the gallery throws the fork away.
   *
   *  That is the intended rule — a different template is a different job, and
   *  carrying someone's rewritten AP steps onto a recruiting template would be
   *  worse than losing them. But it is destructive and has no undo, so it asks
   *  first, and only when there is something to lose. */
  function leaveDetail() {
    if (forked && !window.confirm(
      'Going back will discard the lines you rewrote for this template. Continue?',
    )) return
    if (forked) {
      track('team_explore_inline_edit_discarded', {
        template_id: selectedCard?.id ?? 'unknown',
      })
    }
    resetDrafts()
    setStep('gallery')
  }

  // The resume-hydration and substep-reporting effects that used to sit here
  // are gone with the onboarding embed (ADR-050). They mirrored this
  // component's step machine into tenants.onboarding_hire_input so the parent
  // wizard could restore it — but the parent never learned WHICH template had
  // been selected, so `initialSelectedTemplateId` was always undefined, the
  // resume returned on its first line, and `!selectedTemplate` sent the user
  // back to the gallery with their work gone. Standalone, `step` and
  // `selectedTemplate` are owned here and never leave the component.

  // The destinations the person named, keyed by object id, in the shape both
  // the distill call and the create call send.
  //
  // One source for both on purpose: the backend resolves these into the prose
  // it PROMPTS with and the prose it STORES, and the two disagreeing is how the
  // saved instructions end up describing a different destination from the one
  // the team was built to use.
  function templatePicksForSend(): Record<string, { id: string; title: string; kind?: 'folder' | 'file' }> {
    return Object.fromEntries(
      Object.entries(resolvedObjects)
        // A destination on a connection this team is not hired with is not its
        // destination. Sending it would write a channel into the prose that the
        // team has no binding to post through.
        .filter(([, o]) => !excludedConnections.has(o.connectorId))
        // `kind` rides along for a destination, which accepts either a folder
        // or a file and means something different by each: a folder is a place
        // to work in, a file is the deliverable to keep up to date. The prose
        // reads differently for the two, so the answer has to say which it was.
        .map(([key, o]) => [
          key.split(':')[1] ?? key,
          { id: o.id, title: o.title, ...(o.kind ? { kind: o.kind } : {}) },
        ]),
    )
  }

  // Build the integrations list from connected connectors matching template
  // requirements, optional ones included. Reused in both startDistill (for the
  // distill input) and buildCreatePayload (for the POST body). Lives in utils
  // because it decides what a hired team can actually touch, and that deserves
  // tests of its own rather than a page render.
  function assembleIntegrations(template: AgentTemplate): SelectedIntegration[] {
    return assembleTemplateIntegrations({
      template,
      connectors: connectorsData ?? [],
      capabilityMap,
      resolvedObjects,
      label: typeToLabel,
      excludedConnectorIds: excludedConnections,
    })
  }

  // ── Gallery callbacks ──────────────────────────────────────────
  function handleSelectTemplate(template: AgentTemplateCard) {
    track('team_explore_template_selected', { template_id: template.id, role: template.role })
    setSelectedCard(template)
    setStep('detail')
  }

  // ── Detail callbacks ───────────────────────────────────────────
  function handleUseTemplate() {
    if (selectedTemplate) {
      track('team_explore_connector_step_entered', {
        template_id: selectedTemplate.id,
        required_count: selectedTemplate.requiredConnectors.length,
        optional_count: selectedTemplate.optionalConnectors.length,
      })
    }
    setStep('connectors')
  }

  // ── Connector step: kick off distillation ──────────────────────
  function startDistill() {
    if (!selectedTemplate || !tenant?.id) return

    // See AgentBuilder: one controller per attempt, closing the stream and
    // fencing this attempt's callbacks.
    distillAbortRef.current?.abort()
    const run = new AbortController()
    distillAbortRef.current = run

    setSubmitError(null)
    setDistillStage(null)
    setEarlySummary(null)
    setFinalizing(false)
    setPendingAction(null)
    deferredActionRef.current = null
    track('team_explore_distill_started', { template_id: selectedTemplate.id })
    setStep('loading')

    const assembled = assembleIntegrations(selectedTemplate)
    setAssembledIntegrations(assembled)

    distillInternalAgentStream(
      tenant.id,
      {
        role: effectiveRole(selectedTemplate),
        // Their wording where they supplied it. The draft is stored with every
        // {{connector:...}} and {{pick:...}} the template carried, so the
        // backend still resolves destinations against what they pick on the
        // connectors step rather than against a baked-in generic phrase.
        responsibilities: effectiveProse(selectedTemplate).responsibilities,
        // Answers to whatever the template declared it needs, as typed on the
        // connectors step. Only ids this template actually declared are sent,
        // and blanks are dropped, so an optional field left empty reaches the
        // distiller as absent rather than as an empty string it has to
        // interpret.
        ...(() => {
          const answered = Object.fromEntries(
            (selectedTemplate.inputs ?? [])
              .map(f => [f.id, (inputValues[f.id] ?? '').trim()] as const)
              .filter(([, v]) => v.length > 0),
          )
          return Object.keys(answered).length ? { templateInputs: answered } : {}
        })(),
        // The template's operator guidance (Rules, Constraints, Edge cases,
        // Anything to avoid) is shown on the detail page as "How they operate",
        // but it used to stop there: this call omitted it, so the distiller
        // never saw a word of it. The update page has always sent it, which is
        // why a hand-built team behaved to its rules and a template hire did
        // not. systemPrompt weaves it in as behavioral constraints, and
        // instructionsMd's `## Pitfalls and gotchas` keeps both halves of its
        // do/don't pairs.
        additionalContext: effectiveProse(selectedTemplate).additionalContext,
        integrations: assembled.map(i => ({
          id: i.id,
          name: i.name,
          type: i.integrationId ?? '',
          selectedObjects: i.selectedObjects,
        })),
        // What they named in the pickers, keyed by the object id the template
        // writes into its prose as `{{pick:<id>}}`. Keyed by object id alone,
        // not `<requirement>:<object>`, because the placeholder is the prose
        // and the prose has no requirement to name; the catalog validator
        // holds those ids unique across a template for exactly this reason.
        //
        // This is separate from the `config.destinations` the same picks write
        // onto the binding. That is where the runtime will read an id from
        // when it injects tool arguments; this is what reaches the team's
        // instructions today.
        ...(Object.keys(templatePicksForSend()).length
          ? { templatePicks: templatePicksForSend() }
          : {}),
        templateId: selectedTemplate.id,
      },
      {
        onProgress: (stage) => {
          if (run.signal.aborted) return
          setDistillStage(stage)
        },
        onSummaryReady: (summary) => {
          if (run.signal.aborted) return
          setEarlySummary(summary)
          setFinalizing(true)
          setStep('completion')
        },
        onComplete: (result) => {
          if (run.signal.aborted) return
          track('team_explore_distill_completed', { template_id: selectedTemplate.id })
          // Merge LLM-emitted per-binding config (e.g. Gmail gmailQuery /
          // sendAs) onto the assembled integrations so buildCreatePayload
          // serializes it on the create call.
          const merged = mergeDistillIntegrationConfigs(assembled, result.integrationConfigs)
          setAssembledIntegrations(merged)
          setDistillResult(result)
          setFinalizing(false)
          setStep('completion')
        },
        onError: (err) => {
          if (run.signal.aborted) return
          // A decision waiting on an artifact that failed must not fire later.
          deferredActionRef.current = null
          setFinalizing(false)
          setPendingAction(null)
          track('team_explore_distill_failed', {
            template_id: selectedTemplate.id,
            reason: err.message || 'unknown',
          })
          setSubmitError(err.message || 'Distillation failed. Please try again.')
        },
      },
      run.signal,
    )
  }

  /** Leave the loading screen and abandon the run behind it. */
  function cancelDistill() {
    track('team_explore_distill_canceled', {
      template_id: selectedTemplate?.id ?? 'unknown',
      stage: distillStage ?? 'none',
    })
    distillAbortRef.current?.abort()
    distillAbortRef.current = null
    setDistillStage(null)
    setSubmitError(null)
    setEarlySummary(null)
    setFinalizing(false)
    setStep('connectors')
  }

  // ── Completion step: create agent with chosen status ───────────
  function buildCreatePayload(status: 'active' | 'draft') {
    return {
      role: effectiveRole(selectedTemplate!),
      responsibilities: effectiveProse(selectedTemplate!).responsibilities,
      // Which template this came from, stored with a hash of the text above so
      // a later redistill can seed from it again — and stops doing so the
      // moment somebody edits the agent, since the edit is theirs.
      templateId: selectedTemplate!.id,
      // Declared, not inferred. The server fingerprints the text IT RECEIVES
      // and stores that as the baseline, so a hire created from rewritten prose
      // would hash equal to itself, `templateIdForRedistill` would hand the
      // template id back, and the first redistill would re-seed from our
      // catalog and pull their wording toward ours. Saying the text is already
      // theirs is what keeps that from happening; the template's declared
      // obligations still bind, because those run off `templateId` alone.
      ...(proseForked ? { templateTextEdited: true } : {}),
      // The same destinations sent to the distiller, because the backend
      // resolves them into the prose it STORES as well as the prose it prompts
      // with. Without them the saved responsibilities keep `{{pick:...}}`, the
      // edit screen shows a person our placeholder syntax, and a later
      // redistill — which has no other record of what was picked — silently
      // falls back to the generic phrase.
      ...(Object.keys(templatePicksForSend()).length
        ? { templatePicks: templatePicksForSend() }
        : {}),
      // Persisted, not just distilled from. A redistill reads the agent row,
      // so an agent created without this would silently lose its guidance the
      // first time anyone re-optimized it — the distilled prompts would be
      // rebuilt from responsibilities alone.
      additionalContext: effectiveProse(selectedTemplate!).additionalContext,
      integrations: assembledIntegrations.map(i => ({
        id: i.id,
        integrationId: i.integrationId,
        selectedObjects: i.selectedObjects,
        ...(i.config ? { config: i.config } : {}),
      })),
      summary: distillResult!.summary,
      // See AgentBuilder: the handle stands in for the compiled prompt, skills
      // and result rules, which the server reads from the stored artifact.
      distillId: distillResult!.distillId,
      status,
      agentType: distillResult!.agentType,
      // Template config fields override distillation output for trigger
      triggerConfig: distillResult!.triggerConfig ?? selectedTemplate!.defaultTriggerConfig,
      ...(distillResult!.workflowSteps && distillResult!.workflowSteps.length > 0
        ? { workflowSteps: distillResult!.workflowSteps }
        : {}),
    }
  }

  // Fires a decision taken before the artifact was ready.
  useEffect(() => {
    if (!distillResult) return
    const deferred = deferredActionRef.current
    if (!deferred) return
    deferredActionRef.current = null
    if (deferred === 'launch') handleLaunch()
    else handleNotNow()
    // The handlers are recreated every render; depending on them would re-fire
    // this on every render instead of when the artifact lands.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [distillResult])

  function handleLaunch() {
    if (!distillResult) {
      deferredActionRef.current = 'launch'
      setPendingAction('launch')
      return
    }
    setPendingAction('launch')
    createTeamMutation.mutate(buildCreatePayload('active'), {
      onSuccess: (created) => {
        track('agent_created', {
          agent_id: created.id,
          kind: 'internal',
          source: 'team_explore',
          status: 'active',
          integrations_count: assembledIntegrations.length,
        })
        navigate('/dashboard/agents')
      },
      // A 402 means the workspace has no plan, which is an expected state
      // here — building is free, launching is not. The gate collects payment
      // rather than reporting a failure the user cannot act on.
      onError: (err) => {
        if (openIfPaymentRequired(err)) return
        showToast('Failed to create team. Please try again.', 'error')
      },
      onSettled: () => setPendingAction(null),
    })
  }

  function handleNotNow() {
    if (!distillResult) {
      deferredActionRef.current = 'notNow'
      setPendingAction('notNow')
      return
    }
    setPendingAction('notNow')
    createTeamMutation.mutate(buildCreatePayload('draft'), {
      onSuccess: (created) => {
        track('agent_created', {
          agent_id: created.id,
          kind: 'internal',
          source: 'team_explore',
          status: 'draft',
          integrations_count: assembledIntegrations.length,
        })
        navigate('/dashboard/agents')
      },
      onError: () => showToast('Failed to save team. Please try again.', 'error'),
      onSettled: () => setPendingAction(null),
    })
  }

  // ── Render ─────────────────────────────────────────────────────
  // Gated on the card, not the fetched template. Gating on the template would
  // drop someone back to the gallery for the length of the detail request, and
  // strand them there for good if it failed.
  if (step === 'gallery' || !selectedCard) {
    return (
      <GalleryStep
        onSelect={handleSelectTemplate}
        onBack={() => navigate('/dashboard/agents')}
        prefilledSearch={effectivePrefilledSearch}
      />
    )
  }

  if (step === 'detail') {
    return (
      <DetailStep
        card={selectedCard}
        template={selectedTemplate}
        loadFailed={isTemplateError}
        onUse={handleUseTemplate}
        onBack={leaveDetail}
        drafts={drafts}
        onDraftChange={handleDraftChange}
        draftRole={draftRole}
        onRoleChange={handleRoleChange}
        summary={summary}
      />
    )
  }

  // Past the detail step everything operates on the body, so a failed or
  // in-flight fetch cannot be waved through. Continue is disabled until the
  // template lands, so reaching here without one means the request failed.
  if (!selectedTemplate) {
    return (
      <DetailStep
        card={selectedCard}
        template={null}
        loadFailed
        onUse={handleUseTemplate}
        onBack={leaveDetail}
        drafts={drafts}
        onDraftChange={handleDraftChange}
        draftRole={draftRole}
        onRoleChange={handleRoleChange}
        summary={summary}
      />
    )
  }

  if (step === 'connectors') {
    return (
      <ConnectorSetupStep
        template={selectedTemplate}
        roleLabel={effectiveRole(selectedTemplate)}
        // Runs the full distill directly. The onboarding intercept that used
        // to sit here existed because this ran before payment; it now runs
        // after, so there is nothing to defer (ADR-050).
        onContinue={startDistill}
        resolvedObjects={resolvedObjects}
        onResolveObject={(key, value) => setResolvedObjects(prev => ({ ...prev, [key]: value }))}
        unanswerableObjects={unanswerableObjects}
        onUnanswerableObject={(key) => setUnanswerableObjects(prev =>
          prev.has(key) ? prev : new Set(prev).add(key),
        )}
        excludedConnections={excludedConnections}
        onToggleConnection={(connectorId, use) => setExcludedConnections(prev => {
          const next = new Set(prev)
          if (use) next.delete(connectorId)
          else next.add(connectorId)
          return next
        })}
        inputValues={inputValues}
        onInputChange={(id, value) => setInputValues(prev => ({ ...prev, [id]: value }))}
        onBack={() => setStep('detail')}
      />
    )
  }

  if (step === 'loading') {
    return (
      <div className="agent-builder">
        {/* Backing out abandons the run. Every other step of this flow has
            had this button; the one with the longest wait did not. */}
        <BackButton onClick={cancelDistill} />
        <div className="agent-builder__content">
          <LoadingStep
            role={effectiveRole(selectedTemplate)}
            stage={distillStage}
            error={submitError}
            onRetry={startDistill}
          />
        </div>
      </div>
    )
  }

  // Gated on having something to SHOW, not on the whole artifact. Under the
  // waved strategy the step advances when the summary lands, with the prose
  // still in flight — and requiring distillResult here would drop the person
  // through to the gallery fallback below, losing the build entirely.
  if (step === 'completion' && (distillResult || earlySummary)) {
    return (
      <div className="agent-builder">
        {/* Back to the connectors step, not the loading one: loading exists
            only to cover a distill that has already finished, and nothing
            re-triggers it, so returning there would strand the person on a
            spinner. Mirrors the builder's own step 5 -> step 3 jump. The
            answers given on the connector step survive the trip: they live on
            the wizard, not the step. */}
        <BackButton onClick={() => setStep('connectors')} />
        <div className="agent-builder__content">
          <CompletionStep
            role={effectiveRole(selectedTemplate)}
            scopeSummary={distillResult?.summary || earlySummary || ''}
            integrations={assembledIntegrations}
            onLaunch={handleLaunch}
            onNotNow={handleNotNow}
            isLaunching={pendingAction === 'launch'}
            isSaving={pendingAction === 'notNow'}
            finalizing={finalizing}
            finalizingStage={distillStage}
            surface="explore"
            onRetryDistill={distillResult ? undefined : startDistill}
            error={submitError}
          />
        </div>
      </div>
    )
  }

  // Fallback: template data not loaded yet, show gallery
  return (
    <GalleryStep
      onSelect={handleSelectTemplate}
      onBack={() => navigate('/dashboard/agents')}
      prefilledSearch={effectivePrefilledSearch}
    />
  )
}
