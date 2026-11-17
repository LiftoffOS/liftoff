// Common Components
export { Toast, type ToastType } from './common'

// UI Primitives
export { default as ActionMenu } from './ActionMenu/ActionMenu'
export { default as BackButton } from './BackButton'
export { default as Button } from './Button'
export { default as Card } from './Card'
export { default as Checkbox } from './Checkbox/Checkbox'
export { default as DateInput } from './DateInput/DateInput'
export { DateRangeInput } from './DateRangeInput'
export { Dropdown } from './Dropdown'
export { default as Markdown } from './Markdown'
export { default as ModalActions } from './ModalActions/ModalActions'
export { default as ModalOverlay } from './ModalOverlay'
export { default as StatusBadge } from './StatusBadge'
export { default as StatusDot } from './StatusDot'
export { default as TextInput } from './TextInput/TextInput'
export { default as Toggle } from './Toggle'
export { default as Tooltip } from './Tooltip'
export { UserAvatar, type AvatarPerson } from './UserAvatar'
export { GuestAvatar } from './GuestAvatar'

// UI Utilities
export { AutonomyControl } from './AutonomyControl/AutonomyControl'
export { default as Collapsible } from './ui/Collapsible'
export { default as CollapsibleSection } from './CollapsibleSection/CollapsibleSection'
export { default as Pagination } from './ui/Pagination'
export { default as SegmentedControl } from './SegmentedControl/SegmentedControl'

// Form Components
export { stripGuidanceTemplateIfUntouched, stripTemplateIfUntouched } from './guidanceTemplates'
export { default as ConnectIntegrationModal } from './ConnectIntegrationModal'
export { default as ConnectApiKeyModal } from './ConnectApiKeyModal'
export { default as RollbackModal } from './RollbackModal'
// The FileAttach folder (FileUploadButton + FileUploadPopover) and FilePicker
// are deliberately NOT re-exported here. Import them from their own folder
// instead: components/FileAttach and components/FilePicker/FilePicker.
//
// Being in this barrel is what forced them to be styled from the outside: the
// entry chunk pulls the barrel in, so a CSS side-effect import on either one
// leaked their stylesheets into every route including marketing. The workaround
// was to make each route page import the CSS by hand, which is a rule nobody
// can see and everybody eventually forgets. The dashboard home composer forgot,
// and shipped the picker with no styling at all.
//
// Out of the barrel they are only reachable from lazy route code, so they can
// own their stylesheets and arrive styled wherever they are rendered.
export { default as IntegrationIconsDisplay } from './IntegrationIconsDisplay'
export { default as IntegrationsSelector } from './IntegrationsSelector'
export { default as ExternalAgentChip } from './ExternalAgentChip'
export { default as ExternalAgentSelector } from './ExternalAgentSelector'
export { default as RoleInput } from './RoleInput'

// Icons
export { default as EmptyState } from './EmptyState/EmptyState'
export { default as PageHeader } from './PageHeader/PageHeader'
export { default as GridIcon } from '../assets/icons/grid.svg?react'
export { default as InsightsIcon } from '../assets/icons/insights.svg?react'
export { default as PersonIcon } from '../assets/icons/person.svg?react'
export { default as PlugIcon } from '../assets/icons/plug.svg?react'
export { default as RocketIcon } from '../assets/icons/rocket.svg?react'
export { default as TeamIcon } from '../assets/icons/team.svg?react'
export { getIntegrationIcon } from './icons/integrationIconRegistry'

// Layout Components
export { default as Footer } from './Footer'
export { default as Navbar } from './Navbar'

// Dashboard Components
export { default as ActivityFeed } from './Dashboard/ActivityFeed'
export { RecentItemCard, type ItemStatus } from './RecentItemCard'
export { SelectableAgentCard } from './SelectableAgentCard'
export { default as MetricCard } from './Dashboard/MetricCard'
export { default as NeedsAttentionPanel } from './Dashboard/NeedsAttentionPanel'
export { default as OperatingHealth } from './Dashboard/OperatingHealth'
export { default as Sidebar } from './Dashboard/Sidebar'
export { default as StreamingSparkline } from './Dashboard/StreamingSparkline'
export { default as WorkflowCard } from './Dashboard/WorkflowCard'

// Dashboard Onboarding Components
export { default as OnboardingNav } from './Dashboard/Onboarding/OnboardingNav'
export { default as OnboardingProgress } from './Dashboard/Onboarding/OnboardingProgress'
export { steps as onboardingSteps } from './Dashboard/Onboarding/onboardingSteps'

// Feature Sections

// Auth
export { default as ProtectedRoute } from './ProtectedRoute'
export { PermissionGate } from './PermissionGate'
