// Re-export shim — the old combined `hitlRouter` was split into
// `approvalsRouter` (mounted at /api/governance/approvals) and
// `lateFeedbackRouter` (mounted at /api/governance/late-feedback) to match
// the Phase 3 plan's URL layout. This file is kept so any residual
// `import { hitlRouter } from './router'` calls continue to compile; the
// re-exported `hitlRouter` combines both sub-routers the same way the old
// combined router did so test stacks that walk `hitlRouter.stack` still
// find both `/late-feedback` and `/approvals/*` routes.
//
// Prefer importing `approvalsRouter` and `lateFeedbackRouter` directly in
// new code. See server.ts for the authoritative mount points.

import { Router } from 'express';
import { approvalsRouter } from './approvals-router';
import { lateFeedbackRouter } from './late-feedback-router';

export { approvalsRouter } from './approvals-router';
export { lateFeedbackRouter } from './late-feedback-router';

const router = Router();
router.use('/late-feedback', lateFeedbackRouter);
router.use('/approvals', approvalsRouter);

/**
 * @deprecated Use approvalsRouter + lateFeedbackRouter directly.
 */
export const hitlRouter = router;
