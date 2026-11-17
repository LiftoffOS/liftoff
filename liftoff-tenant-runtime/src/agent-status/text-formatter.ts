import type { AgentStatusResponse } from './types';

const COLORS = {
  reset: '\x1b[0m',
  dim: '\x1b[2m',
  cyan: '\x1b[36m',
  yellow: '\x1b[33m',
  red: '\x1b[31m',
  green: '\x1b[32m',
};

export function formatAsText(status: AgentStatusResponse, useColor: boolean = false): string {
  const c = (color: keyof typeof COLORS, s: string) => useColor ? `${COLORS[color]}${s}${COLORS.reset}` : s;
  const statusColor: keyof typeof COLORS =
    status.status === 'complete' ? 'green' :
    status.status === 'failed' ? 'red' :
    status.status === 'interrupted' ? 'yellow' : 'cyan';

  const lines: string[] = [];
  lines.push(`inv      ${status.invocationId}`);
  lines.push(`agent    ${status.agentName ?? status.agentId} (${c(statusColor, status.status)})`);
  lines.push(`turn     ${status.currentTurn}${status.maxTurns ? `/${status.maxTurns}` : ''}`);
  lines.push(`phase    ${status.phase}`);
  if (status.elapsedMs != null) lines.push(`elapsed  ${(status.elapsedMs / 1000).toFixed(1)}s`);
  if (status.currentTool) lines.push(`tool     ${status.currentTool}`);
  if (status.pendingApprovalId) lines.push(c('yellow', `awaiting ${status.pendingApprovalId}`));
  if (status.lastError) lines.push(c('red', `error    ${status.lastError.slice(0, 200)}`));

  if (status.recentEvents.length > 0) {
    lines.push('recent');
    for (const ev of status.recentEvents) {
      const ago = msAgo(ev.at);
      const desc = describeEvent(ev);
      lines.push(`         ${desc} ${c('dim', `(${ago})`)}`);
    }
  }
  return lines.join('\n');
}

function describeEvent(ev: AgentStatusResponse['recentEvents'][number]): string {
  switch (ev.type) {
    case 'tool_call': return `tool_call    ${ev.toolName}`;
    case 'tool_result': return ev.errorPreview ? `tool_error   ${ev.errorPreview}` : `tool_result  ${ev.callId ?? ''}`;
    case 'message_output': return `message      ${ev.contentPreview ?? ''}`;
    case 'hitl_approval': return `hitl         ${ev.toolName ?? ''}`;
    case 'handoff': return `handoff`;
  }
}

function msAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  if (diff < 1000) return `${diff}ms ago`;
  if (diff < 60_000) return `${(diff / 1000).toFixed(1)}s ago`;
  return `${Math.floor(diff / 60_000)}m ago`;
}
