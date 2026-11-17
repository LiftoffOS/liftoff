import Button from '../../../../components/Button'
import IntegrationsSelector, { type SelectedIntegration } from '../../../../components/IntegrationsSelector'
// Route-scoped CSS for the shared IntegrationsSelector/ConnectIntegrationModal.
// Imported here (a route module) rather than in the components themselves —
// those are re-exported by the components barrel that App.tsx pulls, so a CSS
// side-effect import there leaks into the entry chunk (loads on every route).
import '../../../../components/integrationsSelector.css'
import '../../../../components/connectionModals.css'

interface IntegrationsStepProps {
  selected: SelectedIntegration[]
  onChange: (selected: SelectedIntegration[]) => void
  onContinue: () => void
}

export default function IntegrationsStep({
  selected,
  onChange,
  onContinue
}: IntegrationsStepProps) {
  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    onContinue()
  }

  return (
    <form className="agent-builder-step" onSubmit={handleSubmit}>
      <IntegrationsSelector
        selected={selected}
        onChange={onChange}
        titleAs="h1"
        titleClassName="agent-builder-step__header"
        chipsLimit={8}
      />

      <div className="agent-builder-nav">
        {/* Deliberately ungated. Binding nothing is a legitimate configuration:
            the team still gets the platform-level toolset (workspace filesystem
            plus code execution, web tools), and every layer downstream already
            treats an empty selection as normal — the distiller renders "None
            specified", the runtime early-returns on empty bindings, and the
            completion screen hides its "Working with" block. The template flow
            gates on the template's own declared requirements and the update
            page lets you unbind everything, so requiring one here only blocked
            creation of a state the product otherwise supports. */}
        <Button variant="primary" onClick={onContinue}>
          Continue
        </Button>
      </div>
    </form>
  )
}
