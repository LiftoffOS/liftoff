// Server-side mirror of liftoff-react's mergeDistillIntegrationConfigs util.
//
// The frontend pre-merges distill output's `integrationConfigs` into each
// SelectedIntegration's `config` before POSTing to `/api/internal-agents`, so
// fresh creation already persists Gmail/Outlook per-binding scoping correctly.
// The redistill path bypasses the frontend; this module is the equivalent
// pre-merge applied server-side in `redistill-service.buildUpdatePayload`
// so that re-distilled agents land on the same persisted shape as freshly-
// created ones.
//
// Semantics MUST match the frontend (liftoff-react/src/utils/mergeDistillIntegrationConfigs.ts):
//   - Lookup by `id` first, fallback to `integrationId` (LLM may use either).
//   - Gmail-only fields (`gmailQuery`) only apply to Gmail bindings.
//   - Outlook-only fields (`outlookFilter`) only apply to Outlook bindings.
//   - Shared field (`sendAs`) applies to Gmail OR Outlook bindings; dropped
//     for anything else.
//   - GitHub-only field (`githubFilter`) only applies to GitHub bindings.
//   - Existing config keys NOT addressed by the new emission are preserved.
//   - Empty-string emission is treated as "leave existing alone."
//   - Mismatched-type emissions are dropped with a warn log so the LLM-
//     emission problem stays visible.

import type {
  DistillIntegrationConfigs,
  IntegrationPermission,
} from './types';
import { log } from '../infrastructure/logging';

const GMAIL_TYPE = 'google_mail';
const OUTLOOK_TYPE = 'microsoft_outlook_mail';
const GITHUB_TYPE = 'github';

function isGmail(p: IntegrationPermission): boolean {
  return p.integrationId === GMAIL_TYPE || p.type === GMAIL_TYPE;
}

function isOutlook(p: IntegrationPermission): boolean {
  return p.integrationId === OUTLOOK_TYPE || p.type === OUTLOOK_TYPE;
}

function isGithub(p: IntegrationPermission): boolean {
  return p.integrationId === GITHUB_TYPE || p.type === GITHUB_TYPE;
}

export function mergeDistillIntegrationConfigs(
  current: IntegrationPermission[],
  integrationConfigs: DistillIntegrationConfigs | undefined,
): IntegrationPermission[] {
  if (!integrationConfigs || Object.keys(integrationConfigs).length === 0) {
    return current;
  }
  let mutated = false;
  const next = current.map((p) => {
    const cfg = integrationConfigs[p.id] ?? (p.integrationId ? integrationConfigs[p.integrationId] : undefined);
    if (!cfg) return p;

    const merged: Record<string, unknown> = { ...(p.config ?? {}) };

    if (cfg.gmailQuery) {
      if (isGmail(p)) {
        merged.gmailQuery = cfg.gmailQuery;
      } else {
        log.warn(
          { integrationId: p.integrationId, type: p.type, id: p.id },
          'mergeDistillIntegrationConfigs: LLM emitted gmailQuery for a non-Gmail integration; dropping',
        );
      }
    }

    if (cfg.outlookFilter) {
      if (isOutlook(p)) {
        merged.outlookFilter = cfg.outlookFilter;
      } else {
        log.warn(
          { integrationId: p.integrationId, type: p.type, id: p.id },
          'mergeDistillIntegrationConfigs: LLM emitted outlookFilter for a non-Outlook integration; dropping',
        );
      }
    }

    // Without this branch the derived filter is computed and then dropped here
    // — the value reaches the distill result and never reaches the binding, so
    // the runtime keeps applying its own default. Every field this function does
    // not name is silently discarded, which is why a new one has to be added in
    // the same change as its producer.
    if (cfg.githubFilter && Object.keys(cfg.githubFilter).length > 0) {
      if (isGithub(p)) {
        // Merged key-wise, not replaced: `allowedActions` is derived from the
        // declared topics while `repos` / `branches` / `authors` may have been
        // set by an operator on the connections page, and replacing the object
        // would silently drop their narrowing.
        merged.githubFilter = {
          ...(merged.githubFilter as Record<string, unknown> | undefined ?? {}),
          ...cfg.githubFilter,
        };
      } else {
        log.warn(
          { integrationId: p.integrationId, type: p.type, id: p.id },
          'mergeDistillIntegrationConfigs: githubFilter emitted for a non-GitHub integration; dropping',
        );
      }
    }

    if (cfg.sendAs) {
      if (isGmail(p) || isOutlook(p)) {
        merged.sendAs = cfg.sendAs;
      } else {
        log.warn(
          { integrationId: p.integrationId, type: p.type, id: p.id },
          'mergeDistillIntegrationConfigs: LLM emitted sendAs for an integration that is neither Gmail nor Outlook; dropping',
        );
      }
    }

    if (Object.keys(merged).length === 0) return p;
    // Compared by VALUE, not by reference. Every config field was a string until
    // `githubFilter`, and `===` on a freshly-built object is always false — so a
    // redistill that changed nothing would mark the binding mutated and show up
    // in the operator's dry-run diff on every run, which is how a diff stops
    // being read.
    if (p.config && Object.keys(merged).every(
      (k) => JSON.stringify(merged[k]) === JSON.stringify((p.config as Record<string, unknown>)[k]),
    )) {
      return p;
    }
    mutated = true;
    return { ...p, config: merged };
  });
  return mutated ? next : current;
}
