// Showing a file, for the three platform assistants.
//
// The same act the tenant runtime offers an agent as `show_file`, under the
// same name: one word for one act, whoever performs it. What differs is only
// the wiring. An agent's tool reaches the store over HTTP; these three run
// inside this process and call the helper directly.
//
// Deliberately NOT a workspace action. That registry carries no conversation —
// `dispatchWorkspaceAction` passes none, the Insights adapter drops the thread
// when it builds an Actor, and the Chief AI Officer's internal route has none
// at all — and a file is shown INTO a conversation. The precedent followed
// here is the dataset and browser tools, which are dispatched before that
// registry and handed the thread explicitly.

import type { LLMToolDefinition } from '../llm/types';
import { presentFile, PresentFileError, type PresentSurface } from './present';
import { log } from '../infrastructure/logging';

export const SHOW_FILE_TOOL = 'show_file';

/** What the caller must know to show a file: which conversation, and where it
 *  lives. There is no agent — these three have no `internal_agents` row, and
 *  the file is owned by the conversation instead. */
export interface ShowFileToolContext {
  tenantId: string;
  surface: PresentSurface;
  /** The conversation the reply is going to. Absent on a turn with no thread,
   *  which this tool refuses rather than guessing at. */
  threadId?: string;
}

export const showFileTool: LLMToolDefinition = {
  name: SHOW_FILE_TOOL,
  description:
    'Show a file that is already in this workspace to the person you are talking to: it appears as a '
    + 'card they can open or download. Use it for a file that was stored but never shown. Storing a '
    + 'file and showing it are separate, so a file that exists is not a file anyone has seen. Showing '
    + 'one also keeps it, since a file nobody was shown is discarded on its own. Harmless to call twice.',
  input_schema: {
    type: 'object',
    properties: {
      file_id: {
        type: 'string',
        description: 'The file id a tool gave you for a file in this workspace.',
      },
    },
    required: ['file_id'],
  },
};

export const generatedFileTools: LLMToolDefinition[] = [showFileTool];

export function isGeneratedFileTool(name: string): boolean {
  return name === SHOW_FILE_TOOL;
}

/**
 * Run it, and answer in the words the model will relay.
 *
 * A string rather than a structure, like the dataset tools beside it: what
 * comes back is read by a model and then paraphrased to a person, so it says
 * what happened and never how.
 */
export async function runGeneratedFileTool(
  input: Record<string, unknown>,
  ctx: ShowFileToolContext,
): Promise<string> {
  const fileId = typeof input.file_id === 'string' ? input.file_id.trim() : '';
  if (!fileId) {
    return 'That needs the id of a file in this workspace.';
  }
  if (!ctx.threadId) {
    // A card with no conversation is a card nobody sees.
    return 'A file can only be shown inside a conversation.';
  }

  try {
    const shown = await presentFile({
      tenantId: ctx.tenantId,
      fileId,
      surface: ctx.surface,
      conversationId: ctx.threadId,
      // These three have no row in internal_agents; the conversation owns it.
      agentId: null,
    });
    return `${shown.filename} is in the conversation now, and the person can see it.`;
  } catch (err) {
    if (err instanceof PresentFileError && err.reason === 'not_found') {
      return 'No file in this workspace has that id.';
    }
    // No fabricated success: a card that was not appended must never read as
    // one, or the reply says "here it is" over nothing.
    log.warn(
      { error: (err as Error).message, tenantId: ctx.tenantId, fileId },
      'generated-files: assistant could not show a file',
    );
    return 'That file could not be shown just now.';
  }
}
