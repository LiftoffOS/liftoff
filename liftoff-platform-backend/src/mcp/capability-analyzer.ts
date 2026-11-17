// Capability Analyzer
// Uses existing llmClient to analyze raw MCP tools and resources
// Follows same pattern as ai-teams/distill-service.ts

import { llmClient } from '../llm';
import { log } from '../infrastructure/logging';
import { withRetry } from '../infrastructure/llm-retry';
import type { MCPToolDefinition, MCPResourceDefinition, DetectedCapability, DetectedResource } from './types';
import type { JSONSchema } from '../llm/types';

const ANALYSIS_SYSTEM_PROMPT = `You are analyzing an external AI agent's MCP (Model Context Protocol) tool and resource definitions to help our platform's internal agents understand how to collaborate with it.

Your task is to synthesize the raw technical definitions into human-readable descriptions that help internal agents understand:

1. **What this agent can DO** (from MCP tools)
   - Group related tools into logical capabilities
   - Describe in terms of business outcomes, not technical operations
   - Be specific about what actions trigger external effects
   - Example: "Send pipeline reports" not "invoke_send_report_tool"

2. **Contextual resources this collaborator can access** (from MCP resources)
   - These are reference materials from the collaborator's own systems, NOT your data
   - Describe what information the collaborator can consult when working with your teams
   - Example: "Pipeline metrics from their analytics platform" not "metrics://pipeline/current"

3. **The agent's overall purpose**
   - Infer from the combination of tools and resources
   - Use business terminology, never "AI agent" or "bot"

4. **Collaboration guidance**
   - When should internal agents delegate to this agent?
   - What information should be passed vs requested?
   - Are there rate limits or sequencing requirements implied by the tools?
   - What capabilities complement vs overlap with internal team functions?

Guidelines:
- Never use words like "agent", "AI", "bot", or "automated" in descriptions
- Focus on what the external system enables, not how it works
- Group multiple related tools into single logical capabilities when appropriate
- Preserve rawToolName/rawUri to maintain the mapping to actual MCP calls`;

// JSON Schema for structured output (ensures valid response format)
// Follows pattern from distill-service.ts with detailed field descriptions
const DISCOVER_OUTPUT_SCHEMA: JSONSchema = {
  type: 'object',
  properties: {
    capabilities: {
      type: 'array',
      description: 'Logical groupings of what this agent can DO. Group related tools into business-level capabilities. Each capability may map to one or more MCP tools.',
      items: {
        type: 'object',
        properties: {
          id: {
            type: 'string',
            description: 'Unique identifier, lowercase with hyphens (e.g., "send-pipeline-reports")',
          },
          name: {
            type: 'string',
            description: 'Human-readable name, 2-4 words (e.g., "Send Pipeline Reports")',
          },
          description: {
            type: 'string',
            description: 'Clear description of the business outcome, 1-2 sentences. Explain what happens when this capability is invoked.',
          },
          rawToolName: {
            type: 'string',
            description: 'The primary MCP tool name this maps to (for runtime invocation). If multiple tools are grouped, use the main one.',
          },
        },
        required: ['id', 'name', 'description', 'rawToolName'],
      },
    },
    resources: {
      type: 'array',
      description: "Contextual resources from the collaborator's own systems. These are reference materials the collaborator can consult, NOT your data.",
      items: {
        type: 'object',
        properties: {
          id: {
            type: 'string',
            description: 'Unique identifier, lowercase with hyphens (e.g., "pipeline-metrics")',
          },
          name: {
            type: 'string',
            description: 'Human-readable name, 2-4 words (e.g., "Pipeline Metrics")',
          },
          description: {
            type: 'string',
            description: 'Clear description of what data is available and its typical use case.',
          },
          rawUri: {
            type: 'string',
            description: 'The MCP resource URI (for runtime access)',
          },
        },
        required: ['id', 'name', 'description', 'rawUri'],
      },
    },
    summary: {
      type: 'string',
      description: 'A concise 1-2 sentence overview of what this external system does and its primary value. Shown to users as a quick description. Never use "agent", "AI", or "bot".',
    },
    collaborationHints: {
      type: 'string',
      description: 'One concise sentence: "Delegate [what tasks]; provide [required context]." Example: "Delegate cryptocurrency price lookups; provide the coin symbol."',
    },
  },
  required: ['capabilities', 'resources', 'summary', 'collaborationHints'],
};

export interface AnalyzeInput {
  tools: MCPToolDefinition[];
  resources: MCPResourceDefinition[];
  agentName: string;
  description: string;
  tenantId?: string;      // For LLM usage attribution
  agentId?: string;       // For per-agent cost attribution
  correlationId?: string; // Written to llm_usage_log.thread_id so the save endpoint can back-attribute this call
}

export interface AnalyzeOutput {
  capabilities: DetectedCapability[];
  resources: DetectedResource[];
  summary: string;
  collaborationHints: string;
}

export async function analyzeCapabilities(input: AnalyzeInput): Promise<AnalyzeOutput> {
  const userMessage = `Analyze this external system's MCP definitions and produce structured output for our platform:

SYSTEM NAME: ${input.agentName}

USER-PROVIDED DESCRIPTION:
${input.description || '(No description provided)'}

MCP TOOLS (actions this collaborator can perform):
${JSON.stringify(input.tools, null, 2)}

MCP RESOURCES (contextual resources from the collaborator's own systems - reference material they can consult, NOT your data):
${JSON.stringify(input.resources, null, 2)}

Synthesize ALL of the above into capabilities, contextual resources, summary, and collaboration guidance. Group related tools into logical capabilities. Ensure rawToolName and rawUri fields preserve the exact MCP identifiers for runtime invocation.`;

  log.info(
    { agentName: input.agentName, toolCount: input.tools.length, resourceCount: input.resources.length },
    'Analyzing external agent capabilities'
  );

  // Use shared retry utility for transient failure handling
  const response = await withRetry(
    () =>
      llmClient.complete({
        messages: [
          { role: 'system', content: ANALYSIS_SYSTEM_PROMPT },
          { role: 'user', content: userMessage },
        ],
        maxTokens: 4096,
        temperature: 0.3, // Same as distill-service.ts for generation tasks
        responseSchema: {
          name: 'analyze_external_agent',
          description: 'Analyze external agent capabilities from MCP definitions',
          schema: DISCOVER_OUTPUT_SCHEMA,
        },
      }, undefined, {
        tenantId: input.tenantId || 'unknown',
        purpose: 'capability_analysis',
        ...(input.agentId && { agentId: input.agentId }),
        ...(input.correlationId && { threadId: input.correlationId }),
      }),
    { context: 'capability-analysis' }
  );

  log.info(
    { provider: response.provider, model: response.model, usage: response.usage },
    'External agent analysis completed'
  );

  // responseSchema guarantees valid JSON matching the schema
  return JSON.parse(response.content) as AnalyzeOutput;
}
