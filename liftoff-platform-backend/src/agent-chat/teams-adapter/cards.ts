// Adaptive Card builders for the Teams adapter.
//
// - Agent picker: filtered Input.ChoiceSet (type-to-search over the loaded
//   agents). The selection arrives as a message activity with
//   data.action='pick_agent'.
// - Final message card: agent name header + body. internal_agents has no
//   avatar column, so we use the name/initials only (no avatar URL).
// - Review card: HITL approve/reject Action.Submit carrying the reviewId.

import { CardFactory, type Attachment } from 'botbuilder';
import type { PickerAgent } from './repository';
import type { FileCardItem } from '../file-cards';

const SCHEMA = 'http://adaptivecards.io/schemas/adaptive-card.json';
const VERSION = '1.5';

/** Filtered (type-to-search) picker over the provided agent choices. */
export function buildAgentPickerCard(initialChoices: PickerAgent[]): Attachment {
  return CardFactory.adaptiveCard({
    $schema: SCHEMA,
    type: 'AdaptiveCard',
    version: VERSION,
    body: [
      { type: 'TextBlock', text: 'Who would you like to talk to?', weight: 'Bolder', size: 'Medium', wrap: true },
      {
        type: 'Input.ChoiceSet',
        id: 'agentId',
        style: 'compact',
        choices: initialChoices.map((a) => ({ title: a.label, value: a.agentId })),
      },
    ],
    actions: [
      { type: 'Action.Submit', title: 'Start chat', data: { action: 'pick_agent' } },
    ],
  });
}

/** Final, formatted agent response (cards/attachments only allowed at finalize). */
export function buildAgentMessageCard(input: { agentName: string; markdown: string }): Attachment {
  return CardFactory.adaptiveCard({
    $schema: SCHEMA,
    type: 'AdaptiveCard',
    version: VERSION,
    body: [
      { type: 'TextBlock', text: input.agentName, weight: 'Bolder', size: 'Medium', wrap: true },
      { type: 'TextBlock', text: input.markdown, wrap: true },
    ],
    actions: [
      { type: 'Action.Submit', title: 'Change agent', data: { action: 'switch' } },
    ],
  });
}

/** Card listing files the agent produced this turn, each an Open-in-browser action. */
export function buildFilesCard(files: FileCardItem[]): Attachment {
  return CardFactory.adaptiveCard({
    $schema: SCHEMA,
    type: 'AdaptiveCard',
    version: VERSION,
    body: [
      { type: 'TextBlock', text: files.length === 1 ? 'File' : 'Files', weight: 'Bolder', wrap: true },
    ],
    actions: files.slice(0, 10).map((f) => ({ type: 'Action.OpenUrl', title: f.filename, url: f.url })),
  });
}

/** HITL review card with approve/reject actions. */
export function buildReviewCard(input: {
  agentName: string;
  reviewId: string;
  draftText?: string;
  // Generic gated-tool card content (hitl-card-content.ts). Present instead of draftText.
  action?: string;
  why?: string | null;
  detail?: string | null;
  /** Escalation notice: informational, no Approve/Reject. Resolution happens in
   *  the dashboard review queue, so the card carries the reason and a link
   *  instead of Submit actions that would post decisions against an id the
   *  approval store does not hold. */
  /** `linkKind` says what the url IS, so this card can word its own button.
   *  A terminal escalation now links to the chat thread it opened, and calling
   *  that "Open review queue" would send the reader looking for an item that
   *  page will never list. The router decides the destination; the wording for
   *  it belongs here. */
  notice?: { reason: string; linkUrl: string; linkKind?: 'review' | 'chat' };
}): Attachment {
  if (input.notice) {
    return CardFactory.adaptiveCard({
      $schema: SCHEMA,
      type: 'AdaptiveCard',
      version: VERSION,
      body: [
        { type: 'TextBlock', text: 'Needs your attention', weight: 'Bolder', size: 'Medium', wrap: true },
        { type: 'TextBlock', text: `Agent: ${input.agentName}`, wrap: true, isSubtle: true },
        { type: 'TextBlock', text: input.notice.reason, wrap: true },
      ],
      actions: [
        // Only when there is somewhere real to go, and labelled for where that
        // is. A parked run has a row in the queue. A terminal escalation has no
        // queue row but does open a chat thread, so it points there instead —
        // under the "Open review queue" label that would be a page without the
        // item on it.
        ...(input.notice.linkUrl
          ? [{
            type: 'Action.OpenUrl',
            title: input.notice.linkKind === 'chat' ? 'Open the conversation' : 'Open review queue',
            url: input.notice.linkUrl,
          }]
          : []),
      ],
    });
  }

  // Generic gated-tool card: Agent / Action / Why / Details. Messaging card unchanged.
  const body = input.action
    ? [
        { type: 'TextBlock', text: 'Approval needed', weight: 'Bolder', size: 'Medium', wrap: true },
        { type: 'TextBlock', text: `Agent: ${input.agentName}`, wrap: true, isSubtle: true },
        { type: 'TextBlock', text: `Action: ${input.action}`, wrap: true },
        ...(input.why ? [{ type: 'TextBlock', text: `Why: ${input.why}`, wrap: true }] : []),
        ...(input.detail ? [{ type: 'TextBlock', text: input.detail, wrap: true, isSubtle: true, size: 'Small' }] : []),
      ]
    : [
        { type: 'TextBlock', text: `${input.agentName} needs your approval`, weight: 'Bolder', wrap: true },
        { type: 'TextBlock', text: input.draftText ?? '', wrap: true },
      ];
  return CardFactory.adaptiveCard({
    $schema: SCHEMA,
    type: 'AdaptiveCard',
    version: VERSION,
    body,
    actions: [
      { type: 'Action.Submit', title: 'Approve', data: { action: 'review_approve', reviewId: input.reviewId } },
      { type: 'Action.Submit', title: 'Reject', data: { action: 'review_reject', reviewId: input.reviewId } },
    ],
  });
}

/** A resolved review card (no actions) — replaces a review card after a decision. */
export function buildResolvedReviewCard(input: { agentName: string; footer: string }): Attachment {
  return CardFactory.adaptiveCard({
    $schema: SCHEMA,
    type: 'AdaptiveCard',
    version: VERSION,
    body: [
      { type: 'TextBlock', text: `${input.agentName}: approval request`, weight: 'Bolder', wrap: true },
      { type: 'TextBlock', text: input.footer, wrap: true, isSubtle: true },
    ],
  });
}

/** Build the application/search typeahead response payload (dataset 'agents'). */
export function buildSearchResponse(results: PickerAgent[]): {
  status: number;
  body: { type: string; value: { results: Array<{ title: string; value: string }> } };
} {
  return {
    status: 200,
    body: {
      type: 'application/vnd.microsoft.search.searchResponse',
      value: { results: results.map((a) => ({ title: a.label, value: a.agentId })) },
    },
  };
}



