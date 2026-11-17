// Agent Templates — schema / interface layer
// Re-exports shared types and adds backend-only request/response interfaces.

export {
  AGENT_TEMPLATE_SCHEMA_VERSION,
  type AgentTemplate,
  type ConnectorRequirement,
  type DepartmentCategory,
} from '@liftoffos/shared-types';

// ConnectorMapping disambiguates multi-account tenants (BE-011).
// requirementId maps to ConnectorRequirement.id in the template.
export interface ConnectorMapping {
  requirementId: string;   // from template.requiredConnectors[].id
  connectorId: string;     // tenant's connector instance UUID
  accountRef?: string;     // disambiguates multiple accounts (e.g., Gmail mailbox, Salesforce org)
}

// Request body for POST /api/agents/from-template
export interface FromTemplateRequest {
  templateId: string;
  variables: Record<string, string>;
  connectorMapping: ConnectorMapping[];
  name: string;            // customer-facing agent name
  workforcePlan?: string;  // optional workforce plan to attach the new agent to
}

// Request body for POST /api/agents/from-template:preview
export interface FromTemplatePreviewRequest {
  templateId: string;
  variables: Record<string, string>;
  connectorMapping: ConnectorMapping[];
}
