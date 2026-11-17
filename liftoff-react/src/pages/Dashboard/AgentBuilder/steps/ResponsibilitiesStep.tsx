import Button from '../../../../components/Button'
import ResponsibilitiesInput from '../../../../components/ResponsibilitiesInput'
import { stripTemplateIfUntouched } from '../../../../components/guidanceTemplates'
import type { KnowledgeMentionItem } from '../../../../components/KnowledgeMentionList'
import type { AgentMentionItem } from '../../../../components/AgentMentionList'
import type { TeamAttachment } from '../../../../services/internalAgents'
import { useToast } from '../../../../contexts/ToastContext'
import { TOAST_MESSAGES } from '../../../../constants/toastMessages'
import { TEAM_LIMITS } from '../../../../constants/limits'

interface ResponsibilitiesStepProps {
  value: string
  onChange: (value: string) => void
  onContinue: () => void
  knowledgeItems?: KnowledgeMentionItem[]
  agentItems?: AgentMentionItem[]
  boundConnectorIds?: string[]
  attachments?: TeamAttachment[]
  onAttachmentsChange?: (attachments: TeamAttachment[]) => void
}

export default function ResponsibilitiesStep({
  value,
  onChange,
  onContinue,
  knowledgeItems,
  agentItems,
  boundConnectorIds,
  attachments = [],
  onAttachmentsChange,
}: ResponsibilitiesStepProps) {
  const { showToast } = useToast()

  const handleContinue = () => {
    const strippedValue = stripTemplateIfUntouched(value)
    if (strippedValue.length > TEAM_LIMITS.RESPONSIBILITIES_MAX) {
      showToast(TOAST_MESSAGES.VALIDATION_TOO_LONG, 'error')
      return
    }
    if (strippedValue.trim().length > 0 || attachments.length > 0) {
      onContinue()
    }
  }

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    handleContinue()
  }

  const isValid = stripTemplateIfUntouched(value).trim().length > 0 || attachments.length > 0

  return (
    <form className="agent-builder-step" onSubmit={handleSubmit}>
      <ResponsibilitiesInput
        value={value}
        onChange={onChange}
        titleAs="h1"
        titleClassName="agent-builder-step__header"
        knowledgeItems={knowledgeItems}
        agentItems={agentItems}
        boundConnectorIds={boundConnectorIds}
        attachments={attachments}
        onAttachmentsChange={onAttachmentsChange}
      />

      <div className="agent-builder-nav">
        <Button variant="primary" onClick={handleContinue} disabled={!isValid}>
          Continue
        </Button>
      </div>
    </form>
  )
}
