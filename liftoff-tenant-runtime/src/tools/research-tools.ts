// Research Tools for Autonomous Learning
// Per implementation plan Phase 5.2: Research-specific tools

import { LLMTool } from '../llm/types';

// Research-specific tools for autonomous research agents
export const RESEARCH_TOOLS: LLMTool[] = [
  // web_search moved to STANDARD_TOOLS. It sat here as a definition with no
  // handler and no exposure — a catalog entry the platform routed nothing to —
  // while the same name is what every engine's basic search is called.
  // research_save_finding - Save finding to role memory
  {
    name: 'research_save_finding',
    description: 'Save a research finding to role memory. Use this to persist important discoveries, trends, or insights for future reference by all agents of this role.',
    input_schema: {
      type: 'object',
      properties: {
        title: {
          type: 'string',
          description: 'A concise title for the finding',
        },
        summary: {
          type: 'string',
          description: 'A brief summary of the finding (2-3 sentences)',
        },
        details: {
          type: 'string',
          description: 'Detailed content of the finding',
        },
        source_url: {
          type: 'string',
          description: 'URL of the source (if applicable)',
        },
        source_name: {
          type: 'string',
          description: 'Name of the source publication or website',
        },
        category: {
          type: 'string',
          description: 'Category of the finding: "regulation", "trend", "best_practice", "tool", "benchmark", or "other"',
        },
        relevance_score: {
          type: 'number',
          description: 'How relevant this finding is to the organization (0 to 1)',
        },
        action_items: {
          type: 'array',
          items: { type: 'string' },
          description: 'List of potential action items based on this finding',
        },
        effective_date: {
          type: 'string',
          description: 'When this finding becomes effective or relevant (ISO date string)',
        },
        expiration_date: {
          type: 'string',
          description: 'When this finding may become outdated (ISO date string)',
        },
      },
      required: ['title', 'summary', 'details', 'category'],
    },
  },

  // research_get_previous_findings - Retrieve previous research
  {
    name: 'research_get_previous_findings',
    description: 'Retrieve previous research findings to avoid duplicating effort and build on past research.',
    input_schema: {
      type: 'object',
      properties: {
        category: {
          type: 'string',
          description: 'Filter by category: "regulation", "trend", "best_practice", "tool", "benchmark", or "other"',
        },
        time_range_days: {
          type: 'number',
          description: 'Only return findings from the last N days (default: 90)',
        },
        query: {
          type: 'string',
          description: 'Optional semantic search query to find relevant findings',
        },
        limit: {
          type: 'number',
          description: 'Maximum number of findings to return (default: 10)',
        },
      },
      required: [],
    },
  },

  // research_summarize_trends - Summarize trends from findings
  {
    name: 'research_summarize_trends',
    description: 'Generate a summary of trends based on accumulated research findings. Use this to create reports or identify patterns.',
    input_schema: {
      type: 'object',
      properties: {
        time_range_days: {
          type: 'number',
          description: 'Analyze findings from the last N days (default: 90)',
        },
        categories: {
          type: 'array',
          items: { type: 'string' },
          description: 'Categories to include in the analysis',
        },
        format: {
          type: 'string',
          description: 'Output format: "executive_summary", "detailed_report", or "action_items" (default: "executive_summary")',
        },
      },
      required: [],
    },
  },
];

// Get research tool by name
export function getResearchTool(name: string): LLMTool | undefined {
  return RESEARCH_TOOLS.find(t => t.name === name);
}

// Get all research tool names
export function getResearchToolNames(): string[] {
  return RESEARCH_TOOLS.map(t => t.name);
}

// Check if a tool name is a research tool
export function isResearchTool(name: string): boolean {
  return RESEARCH_TOOLS.some(t => t.name === name);
}
