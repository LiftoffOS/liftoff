// Showing a file that is already in the workspace.
//
// Storing bytes and putting them in front of a person are separate acts, and
// until this tool existed only the first had a way to happen for a file that
// arrived without a conversation. A custom API answers with a PDF, the bytes go
// to the workspace store attributed to the agent that fetched them, and then
// nothing could ever show them to anybody: the card was only ever written by
// the same request that created the file.
//
// The conversation comes from the CALL, never from the file. A file carries no
// thread and the execute contract has no field for one; which conversation
// shows it is decided by where the reply is going, which is exactly what this
// context knows and the fetch did not.

import type { StandardToolContext, StandardToolResult } from './standard-tool-handler';

export interface ShowFileInput {
  file_id?: string;
}

export async function handleShowFile(
  input: ShowFileInput,
  ctx: StandardToolContext,
): Promise<StandardToolResult> {
  const fileId = (input.file_id ?? '').trim();
  if (!fileId) {
    return {
      success: false,
      error: 'show_file requires "file_id": the id a tool gave you for a file in this workspace',
    };
  }

  // A file is shown INTO a conversation. An autonomous run has none, and there
  // is no sensible substitute: a card with no thread is a card nobody sees.
  if (!ctx.threadId) {
    return {
      success: false,
      error: 'show_file: there is no conversation here to show a file in. This works in a chat, not in a run nobody is watching.',
    };
  }

  // The control plane attributes the card to a CONTROL-PLANE internal_agents.id;
  // the runtime's own agent id addresses nothing there (ADR-039 / INV-TR-010).
  const { resolveInternalAgentId } = await import('../agent-lifecycle/resolve-runtime-agent-id');
  const internalAgentId = ctx.agentId
    ? await resolveInternalAgentId(ctx.tenantId, ctx.agentId, 'show-file')
    : null;
  if (!internalAgentId) {
    return {
      success: false,
      error: 'show_file: this agent has no control-plane id, so the file could not be attributed to anyone',
    };
  }

  try {
    const { presentGeneratedFile } = await import('../clients/generated-files-client');
    const shown = await presentGeneratedFile({
      tenantId: ctx.tenantId,
      internalAgentId,
      generatedFileId: fileId,
      conversationId: ctx.threadId,
      turnId: ctx.turnId ?? null,
    });
    return { success: true, result: shown };
  } catch (err) {
    // No fabricated success: a card that was not appended must not read as one,
    // or a reply says "attached below" over nothing.
    return {
      success: false,
      error: `show_file: the file could not be shown (${(err as Error).message})`,
    };
  }
}
