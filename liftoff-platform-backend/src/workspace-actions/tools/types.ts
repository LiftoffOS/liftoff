// The tool shape every assistant shares.
//
// One registry of workspace-action tools serves Liftoff, the Insights Manager
// and (over the internal route) the Chief AI Officer. Each tool names the
// permission it needs — null for a read any member may make — and whether it
// mutates. A mutating tool follows the preview → confirm shape the dispatcher
// implements: called without `confirmationId` it answers with a preview and a
// handle; with one, it applies, exactly the previewed payload, once.

import type { LLMToolDefinition } from '../../llm/types';
import type { Actor } from '../actor';
import type { Permission } from '../permissions';

export interface WorkspaceActionTool {
  definition: LLMToolDefinition;
  /** null = any member (reads). */
  permission: Permission | null;
  /** A write. The dispatcher runs the preview → confirm protocol, consumes
   *  the confirmation on first use, and re-resolves the actor at execution so
   *  a person demoted mid-turn cannot complete the write with the role the
   *  turn started with. */
  mutating?: boolean;
  /** Re-read membership and role at execution even though there is no
   *  preview step (review decisions and clarification answers). Implied by
   *  `mutating`. */
  reResolveActor?: boolean;
  /** The longest string value this tool's result may carry, when the
   *  sanitizer's default (500 characters, written for a tenant-controlled
   *  name) would ruin it: a result whose value IS a document, or one the model
   *  must quote back exactly. Each bound is its own field's cap with headroom,
   *  never one number for every tool, because the point of the default is that
   *  unbounded third-party content stays bounded. */
  maxResultStringLength?: number;
  /** Whose change this is. A change to an agent is the Chief AI Officer's
   *  to make, whoever asks: Liftoff and the Insights Manager hold the same
   *  registry but are neither offered nor allowed a steward tool, and hand
   *  the ask to the Chief AI Officer. Reads of a team carry no steward. */
  steward?: 'caio';
  /** For a mutating tool: what the person is shown before they confirm.
   *  Absent means the payload itself is the preview. Throwing here refuses
   *  the preview with the error's message. */
  preview?(input: Record<string, unknown>, actor: Actor): Promise<unknown>;
  execute(input: Record<string, unknown>, actor: Actor): Promise<unknown>;
}

/** What a refusal looks like to the model: one shape for permission, actor,
 *  confirmation and idempotency refusals alike. */
export interface WorkspaceActionRefusal {
  refused: true;
  reason: string;
  message: string;
}

/** A preview that cannot be shown, with the reason the model reads. Thrown
 *  by a tool's preview; the dispatcher relays it as a typed refusal rather
 *  than a generic failure. `from` relays a function's own refusal object. */
export class PreviewRefused extends Error {
  readonly reason: string;
  readonly context?: unknown;
  constructor(reason: string, message: string, context?: unknown) {
    super(message);
    this.name = 'PreviewRefused';
    this.reason = reason;
    this.context = context;
  }
  static from(r: { refused: string; message: string; context?: unknown; page?: string }): PreviewRefused {
    return new PreviewRefused(r.refused, r.page ? `${r.message} (${r.page})` : r.message, r.context);
  }
}
