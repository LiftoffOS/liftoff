// Agent Templates module — public exports

export { agentTemplatesRouter } from './router';
export { initTemplateLoader, getAllTemplates, getActiveTemplates, getTemplate, isTemplateDisabled, getDisabledReason } from './loader';
export type { AgentTemplate, ConnectorRequirement, DepartmentCategory, ConnectorMapping } from './schema';
