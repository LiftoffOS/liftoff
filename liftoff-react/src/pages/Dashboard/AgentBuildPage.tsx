import { useNavigate } from 'react-router'
import AgentBuilder from './AgentBuilder/AgentBuilder'

/** Custom hire: a team described from scratch.
 *
 *  This page used to have a second job — editing an explore template in the
 *  builder, seeded from `state.templateId`. That route is gone with the Edit
 *  button on the template detail step, which now edits its own prose in place.
 *
 *  It was not only redundant, it quietly cost people things. The seed passed
 *  `proseForDisplay(...)`, so every `{{pick:...}}` arrived already flattened to
 *  its generic fallback and could never resolve to the channel or folder they
 *  went on to choose. And the builder carries none of the template machinery —
 *  no `templatePicks`, no declared `inputs`, no ObjectPicker — so a template
 *  hire that detoured through here was asked for none of it.
 */
export default function TeamBuilderPage() {
  const navigate = useNavigate()
  const toTeams = () => navigate('/dashboard/agents')

  return <AgentBuilder onComplete={toTeams} onCancel={toTeams} />
}
