// Sandbox Command Audit Repository
// Append-only audit trail for all sandbox tool calls.
// Resolved: SE-012 — no audit trail for individual shell commands.

import { getPoolForService } from '../infrastructure/database';
import { SandboxCommandAudit } from './types';
import { log } from '../infrastructure/logging';

const pool = getPoolForService('default');

const PREVIEW_MAX_BYTES = 4096; // First 4KB of stdout/stderr

function inferComponent(toolName: string): 'shell' | 'file' | 'browser' | 'vscode' | null {
  if (toolName.startsWith('shell_') || toolName.startsWith('bash_') || toolName.startsWith('nodejs_') || toolName.startsWith('code_')) return 'shell';
  if (toolName.startsWith('file_') || toolName.startsWith('git_')) return 'file';
  if (toolName.startsWith('browser_')) return 'browser';
  if (toolName.startsWith('vscode_')) return 'vscode';
  return null;
}

export class SandboxAuditRepository {
  /**
   * Log a sandbox tool call to the immutable audit table.
   */
  async logToolCall(record: SandboxCommandAudit): Promise<void> {
    try {
      const component = record.component ?? inferComponent(record.toolName);
      await pool.query(
        `INSERT INTO sandbox_command_audit
          (tenant_id, agent_id, invocation_id, sandbox_id, tool_name,
           command_args, work_dir, exit_code, stdout_preview, stderr_preview, wall_clock_ms, component)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
        [
          record.tenantId,
          record.agentId,
          record.invocationId,
          record.sandboxId,
          record.toolName,
          record.commandArgs,
          record.workDir,
          record.exitCode,
          record.stdoutPreview ? record.stdoutPreview.slice(0, PREVIEW_MAX_BYTES) : null,
          record.stderrPreview ? record.stderrPreview.slice(0, PREVIEW_MAX_BYTES) : null,
          record.wallClockMs,
          component,
        ],
      );
    } catch (err) {
      // Audit logging should never block execution — log and continue
      log.error({
        message: 'Failed to write sandbox audit log',
        sandboxId: record.sandboxId,
        toolName: record.toolName,
        error: (err as Error).message,
      });
    }
  }
}
