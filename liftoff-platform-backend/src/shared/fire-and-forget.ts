// Shared fire-and-forget helper.
//
// Previously duplicated in insights/chat-service.ts, workforce-plans/
// chat-service.ts, agent-chat/chat-service.ts, and agent-chat/
// multi-agent-service.ts. Extracted here so all fire-and-forget side
// effects log errors through a single, consistent pattern.
//
// The wrapper is for DETACHMENT only, not error handling — the callee
// should catch its own errors internally. The outer `.catch()` is a
// safety net that prevents unhandled rejections when a callee forgets.

import { log } from '../infrastructure/logging';

export function fireAndForget(promise: Promise<void>, label: string): void {
  promise.catch((err) => {
    log.error(
      { task: label, error: (err as Error).message },
      'Fire-and-forget task failed',
    );
  });
}
