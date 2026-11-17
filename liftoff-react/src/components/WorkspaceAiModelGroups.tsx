import type { WorkspaceAiVendor, WorkspaceAiVendorCatalog } from '../services/tenants'
import './WorkspaceAiModelGroups.css'

// What an AI provider brings, under its dropdown wherever one is chosen: the
// Workspace AI card on Settings and the AI Provider Override card on a team.
// Models (the Frontier model first) and the coding tool, with the model it
// codes with where Liftoff picks it. Liftoff Managed shows nothing: what it
// routes to is not shown. One model can hold two places (GPT-6 Astra is both
// Frontier and the large tier); the backend lists it once, and this holds to
// that itself.

interface WorkspaceAiModelGroupsProps {
  /** The provider the dropdown currently shows, saved or not. */
  vendor: WorkspaceAiVendor | undefined
  catalog: WorkspaceAiVendorCatalog | undefined
}

export default function WorkspaceAiModelGroups({ vendor, catalog }: WorkspaceAiModelGroupsProps) {
  if (!vendor || vendor === 'default' || !catalog) return null
  const models = [...new Set(catalog.models[vendor] ?? [])]
  const coding = catalog.coding[vendor]
  const codingChips = coding ? [...new Set([coding.tool, ...(coding.model ? [coding.model] : [])])] : []
  if (models.length === 0 && codingChips.length === 0) return null

  return (
    <dl className="ai-model-groups">
      {models.length > 0 && <Group label="Models" chips={models} />}
      {codingChips.length > 0 && <Group label="Coding" chips={codingChips} />}
    </dl>
  )
}

function Group({ label, chips }: { label: string; chips: string[] }) {
  return (
    <div className="ai-model-groups__row">
      <dt className="ai-model-groups__label">{label}</dt>
      <dd className="ai-model-groups__chips">
        <ul className="ai-model-chips" aria-label={label}>
          {chips.map(chip => (
            <li key={chip} className="ai-model-chips__chip">{chip}</li>
          ))}
        </ul>
      </dd>
    </div>
  )
}
