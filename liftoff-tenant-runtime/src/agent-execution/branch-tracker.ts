import { memoryService } from '../memory/service';
import { log } from '../infrastructure/logging';

interface ToolCallRecord {
  name: string;
  input: Record<string, unknown>;
}

const BASH_TOOL_NAMES = ['bash', 'shell', 'run_terminal_cmd', 'computer'];

// Covers the common push forms:
//   git push origin branch-name
//   git push --set-upstream origin branch-name
//   git push -u origin branch-name
//   git checkout -b branch-name
//   git switch -c branch-name
const BRANCH_PATTERNS = [
  /git\s+push\s+(?:--set-upstream|-u)\s+\S+\s+(\S+)/,
  /git\s+push\s+(?!\s*-)\s*\S+\s+(\S+)/,
  /git\s+push\s+(\S+)(?:\s|$)/,
  /git\s+checkout\s+-b\s+(\S+)/,
  /git\s+switch\s+-c\s+(\S+)/,
  /gh\s+pr\s+create\b.*?--head\s+(\S+)/,
];

export function extractBranchFromToolCalls(toolCalls: ToolCallRecord[]): string | null {
  for (const tc of toolCalls) {
    if (/^(git_push|push_branch|create_branch)$/.test(tc.name)) {
      const branch = String(tc.input.branch ?? tc.input.branchName ?? tc.input.ref ?? '')
        .replace(/^refs\/heads\//, '');
      if (branch) return branch;
    }

    if (BASH_TOOL_NAMES.includes(tc.name)) {
      const cmd = typeof tc.input.command === 'string' ? tc.input.command
        : typeof tc.input.cmd === 'string' ? tc.input.cmd
        : '';
      if (!cmd) continue;
      for (const pattern of BRANCH_PATTERNS) {
        const match = cmd.match(pattern);
        if (match?.[1] && !match[1].startsWith('-')) return match[1];
      }
    }
  }
  return null;
}

export async function writeBranchCompletionMemory(
  tenantId: string,
  agentId: string,
  branchName: string,
  summary: string | null,
  invocationId?: string,
): Promise<void> {
  const content = [
    `Task completed on branch: ${branchName}`,
    summary ? `Summary: ${summary.slice(0, 400)}` : null,
    `Completed: ${new Date().toISOString().slice(0, 10)}`,
  ].filter(Boolean).join('\n');

  try {
    await memoryService.saveMemory({
      tenantId,
      layer: 'global',
      scopeKey: agentId,
      content,
      agentId,
      tags: ['task_completed', 'branch_tracking', `branch:${branchName}`],
      source: {
        nodeType: 'agent_action' as const,
        refId: `branch-completion-${branchName}-${invocationId ?? Date.now()}`,
        agentId,
        metadata: { branchName, invocationId: invocationId ?? null },
      },
    });
    log.info({ tenantId, agentId, branchName }, 'branch-tracker: wrote TASK_COMPLETED memory');
  } catch (err) {
    log.warn({ err: (err as Error).message }, 'Non-fatal: branch memory write failed');
  }
}
