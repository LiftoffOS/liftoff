// Re-export of the canonical activity labels from @liftoffos/shared-types.
//
// The map itself lives in packages/shared-types/src/tool-activity-label.ts
// because two services have to agree on it exactly, and that package is this
// estate's mechanism for a contract that crosses a repo boundary. The Chief AI
// Officer's own page streams from workforce-service through a transparent proxy
// (src/workforce-plans/workforce-proxy.ts pipes the response), so this service
// cannot attach a label on the way past: workforce-service has to attach its
// own, from the same map. Redeclaring it here would recreate the drift that
// change exists to remove — the same tool reading two ways on two pages.
//
// This file exists so callers inside src/ import from a path that matches every
// other shared helper, and so there is one place to look when tracing where the
// labels come from.
//
// Consumers: src/liftoff/stream-router.ts, src/insights/stream-router.ts,
// src/agent-chat/stream-router.ts, src/agent-chat/turn-event-recorder.ts and
// src/internal-api/assistant-handover-router.ts.

export {
  toolActivityLabel,
  NEUTRAL_ACTIVITY_LABEL,
  _authoredActivityLabels,
} from '@liftoffos/shared-types';
