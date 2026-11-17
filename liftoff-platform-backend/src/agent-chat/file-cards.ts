// Shared helpers for surfacing agent-generated files in chat channels
// (Slack, Microsoft Teams).
//
// Generated files are persisted as separate `file_output` assistant messages
// (see generated-files/router.ts), NOT in the chat event stream. After a turn
// finishes, a channel worker calls collectTurnFileCards() to gather the files
// produced during that turn and render them as file cards.
//
// MEDIA rides the same collection. A screenshot the person asked to be shown is
// stored as its own `media` row (see media/attach.ts) rather than as a
// `file_output` attachment, and a channel that only looked for `file_output`
// would let a team agent take the screenshot somebody asked for in Teams and
// deliver it to nobody — the tool would report success and the thread would say
// nothing. The link is the same login-gated one a document gets.
//
// Link strategy: a synced cloud file has a stable `webViewUrl` — link straight
// to it. Otherwise link to the login-gated /files/open page, which re-checks
// tenant membership and mints a fresh download (the raw signed URL on the
// attachment expires after ~1h, so it must never go into a persisted message).

import * as chatRepo from './chat-repository';
import { MEDIA_MESSAGE_TYPE } from '../media/message-type';
import type { MediaRef } from '../media/attach';

const FRONTEND_URL = process.env.FRONTEND_URL || 'https://example.com';

export interface FileCardItem {
  filename: string;
  url: string;
}

interface FileOutputAttachment {
  generatedFileId?: string;
  filename?: string;
  outputType?: string;
  webViewUrl?: string | null;
}

function chatFileLink(p: {
  tenantId: string;
  threadId: string;
  agentId: string | null;
  fileId: string;
  filename: string;
}): string {
  // Opaque token → the agent chat session page, which verifies membership,
  // switches tenant if needed, and auto-downloads. Non-members are routed to
  // /dashboard/agents with a toast. (See AgentChatPage.)
  const token = Buffer.from(
    JSON.stringify({ t: p.tenantId, f: p.fileId, a: p.agentId, th: p.threadId, n: p.filename }),
  ).toString('base64url');
  return `${FRONTEND_URL}/dashboard/agents/chat?f=${token}`;
}

/**
 * Collect artifacts produced during this turn — `file_output` and `media`
 * messages created at or after `since` (a small skew buffer is applied).
 * Best-effort: returns [] on any error so a lookup failure never breaks the
 * reply.
 */
export async function collectTurnFileCards(
  tenantId: string,
  threadId: string,
  since: Date,
): Promise<FileCardItem[]> {
  try {
    const { messages } = await chatRepo.listMessages(threadId, tenantId, { limit: 50 });
    const cutoff = since.getTime() - 5_000; // tolerate minor app/DB clock skew
    const items: FileCardItem[] = [];
    for (const m of messages) {
      if (new Date(m.createdAt).getTime() < cutoff) continue;
      if (m.messageType === 'file_output') {
        for (const raw of m.attachments ?? []) {
          const a = raw as FileOutputAttachment;
          if (!a.generatedFileId || !a.filename) continue;
          const url = a.webViewUrl
            ? a.webViewUrl
            : chatFileLink({
                tenantId,
                threadId,
                agentId: m.agentId,
                fileId: a.generatedFileId,
                filename: a.filename,
              });
          items.push({ filename: a.filename, url });
        }
        continue;
      }
      if (m.messageType === MEDIA_MESSAGE_TYPE) {
        // No webViewUrl branch: media never syncs to a connector, so the
        // login-gated link is the only one there is. The signed URL on the
        // stored ref is deliberately not used — it expires in an hour and this
        // link is going into a message somebody may open tomorrow.
        for (const ref of (m.media ?? []) as MediaRef[]) {
          if (!ref?.mediaId || !ref.filename) continue;
          items.push({
            filename: ref.filename,
            url: chatFileLink({
              tenantId,
              threadId,
              agentId: m.agentId,
              fileId: ref.mediaId,
              filename: ref.filename,
            }),
          });
        }
      }
    }
    return items;
  } catch {
    return [];
  }
}
