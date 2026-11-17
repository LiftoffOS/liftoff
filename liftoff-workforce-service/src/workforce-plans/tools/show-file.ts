// Showing a file the workspace already holds, from a Chief AI Officer turn.
//
// The same act the tenant runtime offers an agent and the control plane
// offers the other two assistants, under the same name: one word for one act,
// whoever performs it. Writing a file and publishing it are separate
// decisions, so a file that exists is not a file anybody has seen — and until
// this there was no way for this conversation to ask for one.
//
// The control plane owns the store, the tenancy check and the lifetime; this
// is the caller. The conversation comes from THIS turn's context and never
// from the file, which carries none: which conversation shows a file is
// decided by where the reply is going.
//
// Auth is the pattern every other call from here uses — X-Service-Auth with
// WORKFORCE_SERVICE_TOKEN — and the surface is named explicitly, so the
// control plane writes the card back into this service's own table rather than
// somewhere a person here would never look.

import type { WorkforcePlanTool, WorkforcePlanToolContext } from './types.js';
import { loadConfig } from '../../infrastructure/config.js';
import { log } from '../../infrastructure/logging.js';

export const SHOW_FILE_TOOL = 'show_file';

async function execute(
  input: Record<string, unknown>,
  ctx: WorkforcePlanToolContext,
): Promise<unknown> {
  const fileId = typeof input.file_id === 'string' ? input.file_id.trim() : '';
  if (!fileId) {
    return { shown: false, message: 'That needs the id of a file in this workspace.' };
  }
  if (!ctx.threadId) {
    // A card with no conversation is a card nobody sees.
    return { shown: false, message: 'A file can only be shown inside a conversation.' };
  }

  const baseUrl = loadConfig().PLATFORM_BACKEND_URL.replace(/\/$/, '');
  const secret = loadConfig().WORKFORCE_SERVICE_TOKEN;

  let resp: Response;
  try {
    resp = await fetch(`${baseUrl}/api/generated-files/${encodeURIComponent(fileId)}/present`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Service-Auth': secret },
      body: JSON.stringify({
        tenantId: ctx.tenantId,
        conversationId: ctx.threadId,
        surface: 'team_plan',
      }),
    });
  } catch (err) {
    log.error({ error: (err as Error).message, fileId }, 'show_file: fetch to platform-backend failed');
    return { shown: false, message: 'That file could not be shown just now.' };
  }

  if (resp.status === 404) {
    return { shown: false, message: 'No file in this workspace has that id.' };
  }
  if (!resp.ok) {
    log.warn({ status: resp.status, fileId }, 'show_file: platform-backend did not answer 200');
    // No fabricated success: a card that was not appended must never read as
    // one, or the reply says "here it is" over nothing.
    return { shown: false, message: 'That file could not be shown just now.' };
  }

  const body = await resp.json().catch(() => ({})) as { filename?: string };
  return {
    shown: true,
    message: `${body.filename ?? 'The file'} is in the conversation now, and the person can see it.`,
  };
}

export const showFileTool: WorkforcePlanTool = {
  definition: {
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
  },
  execute,
};
