// Manual Capability Analyzer
// Uses existing llmClient to analyze user-provided capabilities
// Follows same pattern as capability-analyzer.ts but for manual entries

import { llmClient } from '../llm';
import { log } from '../infrastructure/logging';
import { withRetry } from '../infrastructure/llm-retry';
import type { SensitivityCategory } from '../mcp/tool-classifier';
import type { ManualCapability, DetectedCapability, AnalyzeManualOutput } from './types';
import type { JSONSchema } from '../llm/types';

const MANUAL_ANALYSIS_SYSTEM_PROMPT = `You are analyzing capabilities for an external AI collaborator that a user has manually defined. Unlike MCP-discovered tools, you only have the user's descriptions to work with.

Your task is to:

1. **Validate and enhance capability descriptions**
   - Check if the descriptions make sense
   - Infer additional context if the user was brief
   - Ensure descriptions are actionable and clear

2. **Validate sensitivity classifications**
   - Review the user-provided sensitivity categories
   - Suggest additional categories if the capability clearly involves sensitive operations
   - Be conservative - if a capability could send emails, modify data, or affect hiring, flag it

3. **Generate collaboration guidance**
   - Synthesize a summary of what this collaborator does overall
   - Provide hints for how internal teams should work with it

Sensitivity Categories:
- customerCommunication: Sends messages to customers (emails, SMS, chat)
- financialActions: Processes payments, refunds, or financial transactions
- dataChanges: Modifies records, databases, or important data
- externalPublishing: Posts to social media, websites, or public channels
- hiringDecisions: Affects hiring, termination, or performance reviews

Guidelines:
- Never use words like "agent", "AI", "bot", or "automated" in descriptions
- Focus on what the external system enables, not how it works
- Be conservative with classifications - if unsure, include the category`;

// JSON Schema for structured output
const MANUAL_ANALYSIS_SCHEMA: JSONSchema = {
  type: 'object',
  properties: {
    capabilities: {
      type: 'array',
      description: 'Enhanced capability definitions with validated descriptions',
      items: {
        type: 'object',
        properties: {
          id: {
            type: 'string',
            description: 'Original capability ID from user input',
          },
          name: {
            type: 'string',
            description: 'Enhanced capability name (2-4 words)',
          },
          description: {
            type: 'string',
            description: 'Enhanced description explaining the business outcome',
          },
          rawToolName: {
            type: 'string',
            description: 'Tool name for runtime invocation (from user input)',
          },
        },
        required: ['id', 'name', 'description', 'rawToolName'],
      },
    },
    toolClassifications: {
      type: 'object',
      description: 'Map of tool name to array of sensitivity category strings. Valid categories: customerCommunication, financialActions, dataChanges, externalPublishing, hiringDecisions. Format: {"toolName": ["category1", "category2"]}',
    },
    summary: {
      type: 'string',
      description: 'A concise 1-2 sentence overview of what this external system does. Never use "agent", "AI", or "bot".',
    },
    collaborationHints: {
      type: 'string',
      description: 'Practical guidance for how internal team members should work with this system. 2-4 sentences.',
    },
  },
  required: ['capabilities', 'toolClassifications', 'summary', 'collaborationHints'],
};

export interface ManualAnalyzeInput {
  capabilities: ManualCapability[];
  agentName: string;
  agentDescription: string;
  tenantId?: string;      // For LLM usage attribution
  agentId?: string;       // For per-agent cost attribution
  correlationId?: string; // Written to llm_usage_log.thread_id so the save endpoint can back-attribute this call
}

export async function analyzeManualCapabilities(input: ManualAnalyzeInput): Promise<AnalyzeManualOutput> {
  const userMessage = `Analyze these manually-defined capabilities for an external agent:

COLLABORATOR NAME: ${input.agentName}
COLLABORATOR DESCRIPTION: ${input.agentDescription || '(No description provided)'}

USER-DEFINED CAPABILITIES:
${JSON.stringify(input.capabilities.map(c => ({
  id: c.id,
  name: c.name,
  description: c.description,
  toolName: c.toolName,
  userProvidedSensitivity: c.sensitivityCategories,
})), null, 2)}

For each capability:
1. Enhance the description if it's too brief
2. Validate the sensitivity classifications (keep user-provided ones, add any obviously missing ones)
3. Map toolName to rawToolName in the output

Then synthesize:
- A summary of what this collaborator does overall
- Collaboration hints for how internal teams should work with it

Be conservative with classifications - if a capability description is vague, ask yourself "could this send emails? modify data? affect hiring?" and classify accordingly.`;

  log.info(
    { agentName: input.agentName, capabilityCount: input.capabilities.length },
    'Analyzing manual capabilities'
  );

  // Use shared retry utility for transient failure handling
  const response = await withRetry(
    () =>
      llmClient.complete({
        messages: [
          { role: 'system', content: MANUAL_ANALYSIS_SYSTEM_PROMPT },
          { role: 'user', content: userMessage },
        ],
        maxTokens: 4096,
        temperature: 0.3,
        responseSchema: {
          name: 'analyze_manual_capabilities',
          description: 'Analyze user-provided manual capabilities',
          schema: MANUAL_ANALYSIS_SCHEMA,
        },
      }, undefined, {
        tenantId: input.tenantId || 'unknown',
        purpose: 'manual_capability_analysis',
        ...(input.agentId && { agentId: input.agentId }),
        ...(input.correlationId && { threadId: input.correlationId }),
      }),
    { context: 'manual-capability-analysis' }
  );

  log.info(
    { provider: response.provider, model: response.model, usage: response.usage },
    'Manual capability analysis completed'
  );

  // responseSchema guarantees valid JSON matching the schema
  const result = JSON.parse(response.content) as {
    capabilities: DetectedCapability[];
    toolClassifications: Record<string, SensitivityCategory[]>;
    summary: string;
    collaborationHints: string;
  };

  // Merge user-provided classifications with LLM-suggested ones
  const mergedClassifications: Record<string, SensitivityCategory[]> = {};
  for (const cap of input.capabilities) {
    const llmClassifications = result.toolClassifications[cap.toolName] || [];
    const userClassifications = cap.sensitivityCategories || [];
    // Combine unique categories
    const combined = [...new Set([...userClassifications, ...llmClassifications])];
    mergedClassifications[cap.toolName] = combined;
  }

  return {
    capabilities: result.capabilities,
    toolClassifications: mergedClassifications,
    summary: result.summary,
    collaborationHints: result.collaborationHints,
  };
}
