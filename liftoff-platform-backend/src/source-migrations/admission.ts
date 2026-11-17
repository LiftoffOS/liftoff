// Liftoff Switch — payment and conversion admission.
//
// Scanning, normalization, upload, inventory review, connection setup and
// collaborator invitations may all happen before payment. LLM distillation and
// agent creation may not. That boundary is the whole reason this file exists:
// without it, an unpaid account could ask Liftoff to fund an arbitrary
// multi-agent conversion, and 25 distills is a real bill.
//
// Two independent gates:
//
//   1. Entitlement — a paid subscription with enough team capacity for the
//      selected import, read from the EXISTING billing authority. INV-PB-010:
//      billing_controls plus the OU buckets decide spend and nothing else does,
//      so this module reads that decision and never computes or caches its own.
//
//   2. Rate limit — every distill attempt reserves capacity through the SAME
//      ledger the interactive builder uses (`distill_rate_limit_events`). A
//      migration worker must not call distillInternalAgentWithProgress
//      directly: that would let a bulk import walk straight past the limits a
//      single user is held to.

import { checkAndIncrementChatRateLimit, type ChatRateLimitCaps } from '../common/chat-rate-limiter';
import { log } from '../infrastructure/logging';

/** Identical to the interactive builder's caps (distill-stream-router.ts).
 *  Duplicated as a named constant so the migration path is visibly held to the
 *  same ceiling rather than quietly given its own. */
export const DISTILL_RATE_LIMITS: ChatRateLimitCaps = {
  tenant: { maxPerMinute: 10, maxPerHour: 60, maxPerDay: 200 },
  user: { maxPerMinute: 5, maxPerHour: 30, maxPerDay: 100 },
};

// There is deliberately NO cap on how many team members one import may carry.
//
// There was: 25, chosen to fit inside a person's hourly distillation allowance
// so a conversion could never run out of it mid-way. That protected the wrong
// thing. Conversion already handles running out — an item that cannot reserve a
// slot is left pending with the reason — so the allowance was never the danger.
// The danger was that nothing came back to finish those items, which made a
// half-converted import look like a finished one. That is fixed by the resume
// sweep (jobs/source-migration-resume-sweep.ts), and with it fixed the cap only
// refused imports the system can now complete.

/** At most three newly created migration records per account in a rolling
 *  24-hour period. Resuming an existing migration does not consume a slot. */
export const MAX_MIGRATIONS_PER_24H = 3;
export const MIGRATION_CREATION_WINDOW_HOURS = 24;


/** At most four item distills run concurrently. */
export const MAX_CONCURRENT_ITEM_DISTILLS = 4;

/** A failed item may retry at most three times. Each retry consumes rate-limit
 *  and billing capacity, so this is a real ceiling, not a formality. */
export const MAX_ITEM_ATTEMPTS = 3;

export interface AdmissionDenial {
  allowed: false;
  code:
    | 'payment_required'
    | 'too_many_migrations'
    | 'rate_limited'
    | 'attempts_exhausted';
  detail: string;
  retryAfter?: number;
}

export type AdmissionResult = { allowed: true } | AdmissionDenial;

/** Entitlement snapshot as this module needs it. Deliberately narrow: the
 *  migration module consumes a decision, it does not reconstruct one. */
export interface EntitlementSnapshot {
  /** Whether the tenant currently holds a paid subscription. */
  paid: boolean;
  /** Operational status from the one money authority. An explicit suspension
   *  stops conversion exactly as it stops execution. */
  operationalStatus?: string;
}

/** Gate LLM distillation and agent creation on a paid, active subscription.
 *
 *  This mirrors the existing post-payment full-distill precedent in onboarding,
 *  where the provisioning step runs after the payment step rather than before.
 *
 *  It takes no count. Size stopped being a reason to refuse when conversion
 *  learned to resume itself: a large import takes more waves, not a rejection. */
export function checkConversionAdmission(params: {
  entitlement: EntitlementSnapshot;
}): AdmissionResult {
  const { entitlement } = params;

  if (!entitlement.paid) {
    return {
      allowed: false,
      code: 'payment_required',
      detail: 'A paid subscription is required before the imported team can be built.',
    };
  }

  if (entitlement.operationalStatus && entitlement.operationalStatus !== 'active') {
    return {
      allowed: false,
      code: 'payment_required',
      detail: `This workspace is currently ${entitlement.operationalStatus}. Conversion is paused.`,
    };
  }

  // No seat cap and no size cap, deliberately. Pricing is consumption of
  // Operating Units, so a workspace may run as many teams as it wants and an
  // import is never refused for being too big — it is metered like everything
  // else. A team limit here would be a second money authority beside the OU
  // buckets, which is exactly what INV-PB-010 forbids.
  return { allowed: true };
}

/** Gate creating a NEW migration record. Resuming does not pass through here. */
/** Gate creating a NEW migration record. Resuming does not pass through here.
 *
 *  There is deliberately no "one open import at a time" rule. One live import
 *  per INSTALLATION is already guaranteed by the partial unique index on
 *  (tenant, account, source, fingerprint), and `createOrResume` resumes that row
 *  rather than duplicating it — so a count could only ever refuse a DIFFERENT
 *  installation. That is the case that must be allowed: a person may have
 *  OpenClaw on a laptop and on a desktop, and both are theirs to import.
 *
 *  What remains is a genuine rate limit on new records, plus the per-distill
 *  reservation that meters the only expensive part. */
export function checkMigrationCreationAdmission(params: {
  recentMigrationCount: number;
}): AdmissionResult {
  if (params.recentMigrationCount >= MAX_MIGRATIONS_PER_24H) {
    return {
      allowed: false,
      code: 'too_many_migrations',
      // Per person, not per workspace: a ten-person workspace shared three
      // imports a day between them, which is not a rate limit, it is a queue.
      detail:
        `You can start up to ${MAX_MIGRATIONS_PER_24H} imports a day. Re-running the same ` +
        'import to resume it does not count towards this.',
    };
  }
  return { allowed: true };
}

/** Reserve rate-limit capacity for ONE distill attempt.
 *
 *  Every distill in this module goes through here. There is no path that calls
 *  the distiller without first taking a slot, which is what stops a 25-item
 *  import from outrunning the limits an interactive user is held to. */
export async function reserveDistillSlot(params: {
  tenantId: string;
  accountId: string;
}): Promise<AdmissionResult> {
  const result = await checkAndIncrementChatRateLimit({
    tableName: 'distill_rate_limit_events',
    tenantId: params.tenantId,
    accountId: params.accountId,
    limits: DISTILL_RATE_LIMITS,
  });

  if (!result.allowed) {
    log.info(
      {
        metric: 'source_migration.distill_rate_limited',
        tenantId: params.tenantId,
        retryAfter: result.retryAfter,
      },
      'Source migration distill rate limited',
    );
    return {
      allowed: false,
      code: 'rate_limited',
      detail: 'Too many builds in a short window. The import will continue shortly.',
      retryAfter: result.retryAfter,
    };
  }

  return { allowed: true };
}

/** Whether a failed item may be retried. */
export function mayRetryItem(attemptCount: number): AdmissionResult {
  if (attemptCount >= MAX_ITEM_ATTEMPTS) {
    return {
      allowed: false,
      code: 'attempts_exhausted',
      detail: `This team member failed to build ${MAX_ITEM_ATTEMPTS} times and will not retry automatically.`,
    };
  }
  return { allowed: true };
}
