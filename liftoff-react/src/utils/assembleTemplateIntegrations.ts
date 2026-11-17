import type { SelectedIntegration } from '../components/IntegrationsSelector'
import { typesForRequirement } from '../services/agentTemplates'
import type { AgentTemplate, ConnectorRequirement } from '../services/agentTemplates'

/** One live connection in the workspace, in the shape this needs. */
export interface AssemblableConnector {
  id: string
  type: string
  status: string
}

/** A destination the person named, as the connectors step holds it: keyed
 *  `<requirementId>:<objectId>` and carrying the connection it was named on. */
export interface ResolvedObject {
  id: string
  title: string
  connectorId: string
  /** What was chosen, when the question took either. See PickedObject.kind. */
  kind?: 'folder' | 'file'
}

interface AssembleArgs {
  template: Pick<AgentTemplate, 'requiredConnectors' | 'optionalConnectors'>
  connectors: AssemblableConnector[]
  /** capability → the connector types that satisfy it. */
  capabilityMap: Record<string, string[]>
  resolvedObjects: Record<string, ResolvedObject>
  /** Display name for a connector type. */
  label: (type: string) => string
  /** Connections the person took this team off, by connector id.
   *
   *  A workspace can hold two CRMs, and binding both is right for GitHub and
   *  GitLab and wrong for HubSpot and Zoho. It can also hold a Slack connected
   *  for something else entirely, which an optional requirement would otherwise
   *  hand to every team hired from a template that mentions a channel. The
   *  decision is per CONNECTION rather than per requirement, because a binding
   *  is: one connector reached through two capabilities is still one binding,
   *  and "use Drive as documents but not as storage" is not a thing the runtime
   *  could honour. */
  excludedConnectorIds?: ReadonlySet<string>
}

/** Which connections a hire binds to the team.
 *
 *  Optional requirements bind too. Optional describes whether the team can work
 *  without the tool, not whether a connection the person actually made reaches
 *  it: a template that offers to post alerts when team chat is present must be
 *  bound to team chat for that sentence to mean anything. An unconnected
 *  optional requirement still contributes nothing.
 *
 *  A capability requirement binds EVERY connected connector that satisfies it,
 *  so GitHub and GitLab both bind for version_control and the team works across
 *  each connected host with no manual binding step.
 */
export function assembleTemplateIntegrations({
  template,
  connectors,
  capabilityMap,
  resolvedObjects,
  label,
  excludedConnectorIds,
}: AssembleArgs): SelectedIntegration[] {
  const destinationsFor = (connectorId: string): Record<string, unknown> | undefined => {
    const entries = Object.entries(resolvedObjects)
      .filter(([, o]) => o.connectorId === connectorId)
      // `ref` says what kind of handle this is, because the write path is
      // provider-dependent: Google Drive and Slides take the folder ID (it
      // becomes the Drive `parents` value) while OneDrive and SharePoint take a
      // path. Browse gives ids, so that is what is recorded, and it says so
      // rather than leaving a bare string whose meaning has to be guessed.
      .map(([key, o]) => [key.split(':')[1] ?? key, { id: o.id, name: o.title, ref: 'id' }])
    return entries.length > 0 ? { destinations: Object.fromEntries(entries) } : undefined
  }

  const toSelected = (connector: AssemblableConnector): SelectedIntegration => {
    const config = destinationsFor(connector.id)
    return {
      id: connector.id,
      integrationId: connector.type,
      name: label(connector.type),
      type: 'integration' as const,
      // Left empty, meaning full access.
      selectedObjects: [],
      ...(config ? { config } : {}),
    }
  }

  const matches = (req: ConnectorRequirement): AssemblableConnector[] => {
    const active = connectors.filter(
      c => c.status === 'active' && !excludedConnectorIds?.has(c.id),
    )
    if (req.connectorType) {
      const hit = active.find(c => c.type === req.connectorType)
      return hit ? [hit] : []
    }
    const capTypes = typesForRequirement(req, capabilityMap)
    return active.filter(c => capTypes.includes(c.type))
  }

  // One connection, one binding. Two requirements can name the same connector
  // — a documents capability and a cloud_storage capability both reach Google
  // Drive — and binding it twice sends the runtime two entries for one
  // connection. Required requirements are walked first, so a connection that
  // satisfies both keeps the required one's place.
  const seen = new Set<string>()
  return [...template.requiredConnectors, ...(template.optionalConnectors ?? [])]
    .flatMap(matches)
    .filter(c => {
      if (seen.has(c.id)) return false
      seen.add(c.id)
      return true
    })
    .map(toSelected)
}
