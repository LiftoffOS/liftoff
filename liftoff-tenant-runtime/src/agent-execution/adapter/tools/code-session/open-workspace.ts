// Which workspace a code_session gets, and the one switch that decides.
//
// `CODE_SESSION_EXECUTION`:
//   inprocess (default)  a temp directory in the tenant runtime's own container
//   sandbox              an isolated Cloud Run sandbox under a zero-role SA
//
// The default is the old behaviour, deliberately, for one release. The sandbox
// path cannot be proven from a test suite: it needs a real sandbox, a real
// image with the vendor CLIs on PATH, and a real repository to clone. Until it
// has run in dev, defaulting to it would be shipping an unverified substrate
// under the one tool that hands an agent a shell.
//
// FALLING BACK IS A DECISION, NOT AN ERROR PATH. When `sandbox` is asked for
// and no executor is wired, this returns the in-process workspace and says so
// loudly. That is right for a connector-only deployment, where there is no
// sandbox to have; it would be wrong to fail a tool the agent can otherwise
// use. What must never happen is falling back SILENTLY, because the whole
// value of the flag is knowing which substrate a given session ran on — so the
// choice is logged and carried on the workspace itself.

import { logger } from '../../../../infrastructure/logging';
import { LocalCodeSessionWorkspace, type CodeSessionWorkspace } from './workspace';
import { SandboxCodeSessionWorkspace } from './sandbox-workspace';
import type { CodeSessionContext } from './types';

export type CodeSessionExecutionMode = 'inprocess' | 'sandbox';

/** The configured mode, defaulting to the behaviour that predates the flag. */
export function codeSessionExecutionMode(): CodeSessionExecutionMode {
  return process.env.CODE_SESSION_EXECUTION === 'sandbox' ? 'sandbox' : 'inprocess';
}

export interface OpenWorkspaceOpts {
  context: CodeSessionContext;
  /** Variables the coding CLI needs: the BYOK gateway base URL and its per-run
   *  token, or a managed provider key. Never this process's environment. */
  env?: Record<string, string | undefined>;
}

export async function openCodeSessionWorkspace(
  opts: OpenWorkspaceOpts,
): Promise<CodeSessionWorkspace> {
  const mode = codeSessionExecutionMode();
  if (mode === 'sandbox') {
    // Imported here rather than at module load: `tool-gateway/router` builds the
    // gateway singleton, and importing it from a tool handler at load time
    // closes a cycle through the handler registry.
    const { toolGatewayService } = await import('../../../../tool-gateway/router');
    const executor = toolGatewayService.sandboxExecutorForCodeSession();
    if (executor) {
      const workspace = await SandboxCodeSessionWorkspace.create({
        executor,
        tenantId: opts.context.tenantId,
        agentId: opts.context.agentId,
        invocationId: opts.context.invocationId,
        env: opts.env,
      });
      logger.info(
        {
          invocationId: opts.context.invocationId,
          sandboxSessionId: workspace.sandboxSessionId,
        },
        'code_session_workspace_sandboxed',
      );
      return workspace;
    }
    logger.warn(
      { invocationId: opts.context.invocationId },
      'code_session_sandbox_requested_but_unavailable: running in-process, '
        + 'where the coding agent shares this container and this service account',
    );
  }

  return LocalCodeSessionWorkspace.create(`code-session-${opts.context.invocationId}-`);
}
