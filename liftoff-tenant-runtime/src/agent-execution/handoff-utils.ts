import type { AgentRunItem } from './run-state/types';

export interface HandoffHistoryOptions {
  wrapperTag?: string;
  maxItems?: number;
  includeToolResults?: boolean;
}

const MAX_CONTENT_LENGTH = 500;

/** Bound a fragment for injection into a prompt. Shared so every place that
 *  folds recalled context into a message uses the same ceiling and the same
 *  visible ellipsis. */
export function truncate(s: string): string {
  return s.length > MAX_CONTENT_LENGTH ? s.slice(0, MAX_CONTENT_LENGTH) + '…' : s;
}

export async function collapseHistory(
  items: AgentRunItem[],
  opts: HandoffHistoryOptions = {},
): Promise<string> {
  const tag = opts.wrapperTag ?? 'CONVERSATION HISTORY';
  const max = opts.maxItems ?? 50;
  const includeToolResults = opts.includeToolResults ?? true;

  const filtered = items
    .filter(item => item.type !== 'hitl_approval' && item.type !== 'handoff')
    .filter(item => includeToolResults || item.type !== 'tool_result')
    .slice(-max);

  const lines = filtered.map(item => {
    switch (item.type) {
      case 'message_output':
        return `[${item.role}]: ${truncate(item.content)}`;
      case 'tool_call':
        return `[tool_call: ${item.toolName}] ${truncate(JSON.stringify(item.input))}`;
      case 'tool_result':
        return `[tool_result for ${item.callId}] ${truncate(JSON.stringify(item.output))}${item.error ? ` (error: ${truncate(item.error)})` : ''}`;
      default:
        return '';
    }
  }).filter(Boolean);

  if (lines.length === 0) return '';
  return `<${tag}>\n${lines.join('\n')}\n</${tag}>`;
}

export function buildInputFromItems(items: AgentRunItem[]): string {
  return items.map(item => {
    if (item.type === 'message_output') return `${item.role}: ${item.content}`;
    if (item.type === 'tool_call') return `[tool_call: ${item.toolName}]`;
    if (item.type === 'tool_result') return `[tool_result: ${JSON.stringify(item.output).slice(0, 200)}]`;
    return '';
  }).filter(Boolean).join('\n');
}
