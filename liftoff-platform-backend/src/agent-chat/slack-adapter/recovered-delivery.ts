// Post a recovered reply to Slack (C1).
//
// Used only by the delivery sweep, for a turn whose reply was generated but
// whose delivery never completed. Deliberately a single plain post rather than
// the streaming path: the reply is finished, there is nothing to stream, and
// re-entering the streamer would mean minting a new placeholder message.
//
// The bot token is resolved here, at send time, from the workspace install —
// the same rule the worker follows, because a token must never be stored in a
// row that outlives the request that made it.

import { log } from '../../infrastructure/logging';
import { slackApiFetch } from './slack-api';
import { getThread } from '../chat-repository';

export async function postRecoveredSlackReply(input: {
  tenantId: string;
  agentId: string;
  channelId: string;
  threadId: string;
  text: string;
}): Promise<void> {
  const { getInstalledWorkspaceInstall } = await import('./workspace-repository');
  const { resolveWorkspaceBotToken } = await import('./bot-token-service');

  const install = await getInstalledWorkspaceInstall(input.tenantId);
  const botToken = install ? await resolveWorkspaceBotToken(install) : null;
  if (!botToken) {
    // The workspace was uninstalled, or the token was revoked. There is no way
    // to deliver this and no point retrying — surfaced as a throw so the sweep
    // records it against the obligation and stops.
    throw new Error('no usable Slack bot token for this workspace');
  }

  // Prefer the thread the conversation actually lives in, so a recovered reply
  // lands where the person is looking rather than at the bottom of the channel.
  // `external_thread_ref` is the Slack thread ts for a Slack-channel thread.
  const thread = await getThread(input.threadId, input.tenantId).catch(() => null);
  const threadTs = thread?.channel === 'slack' ? thread.externalThreadRef ?? undefined : undefined;

  const result = await slackApiFetch('chat.postMessage', {
    authToken: botToken,
    body: {
      kind: 'json',
      value: {
        channel: input.channelId,
        text: input.text,
        ...(threadTs ? { thread_ts: threadTs } : {}),
      },
    },
  });

  if (!result?.ok) {
    throw new Error(`Slack rejected the recovered reply: ${result?.error ?? 'unknown error'}`);
  }

  log.info(
    { tenantId: input.tenantId, channelId: input.channelId },
    'recovered-delivery: reply posted to Slack',
  );
}
