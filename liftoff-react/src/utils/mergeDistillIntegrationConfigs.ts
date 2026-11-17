import type { SelectedIntegration } from '../components/IntegrationsSelector'
import type { DistillIntegrationConfigs } from '../services/internalAgents'

const GMAIL_TYPE = 'google_mail'
const OUTLOOK_TYPE = 'microsoft_outlook_mail'

/** True iff the selected integration is a Gmail binding. Per-binding config
 *  keys gmailQuery + sendAs only make sense on this integration type. */
function isGmail(s: SelectedIntegration): boolean {
  return s.integrationId === GMAIL_TYPE || s.type === GMAIL_TYPE
}

/** True iff the selected integration is an Outlook Mail binding.
 *  Per-binding config keys outlookFilter + sendAs only make sense here. */
function isOutlook(s: SelectedIntegration): boolean {
  return s.integrationId === OUTLOOK_TYPE || s.type === OUTLOOK_TYPE
}

/**
 * Merge per-integration config emitted by the distillation LLM onto the
 * current SelectedIntegration[]. Keyed by integration id; missing entries
 * pass through unchanged. The LLM may reference an integration by either
 * the catalog id (SelectedIntegration.integrationId, e.g. "google_mail")
 * or the connector instance UUID (SelectedIntegration.id) — we accept
 * both so distillation works regardless of which identifier the LLM picked.
 *
 * Type-guard contract: the LLM occasionally emits gmailQuery/sendAs against a
 * NON-Gmail integration id (e.g. the custom_mcp_server's UUID). Blindly
 * applying it would persist Gmail-only fields onto an MCP binding, where they
 * serve no purpose. We now gate each provider-specific key to its matching
 * connector type and drop the rest with a console.warn so the LLM-emission
 * problem stays visible.
 *
 * Existing config keys NOT addressed by the new emission are preserved
 * (e.g. a user-typed sendAs stays even if the LLM only re-emits gmailQuery).
 * Only non-empty values overwrite — the LLM may emit an empty string for
 * a field it considered and rejected, and we treat that as "leave the
 * existing value alone".
 */
export function mergeDistillIntegrationConfigs(
  current: SelectedIntegration[],
  integrationConfigs: DistillIntegrationConfigs | undefined,
): SelectedIntegration[] {
  if (!integrationConfigs || Object.keys(integrationConfigs).length === 0) return current
  let mutated = false
  const next = current.map((s) => {
    const cfg = integrationConfigs[s.id] ?? (s.integrationId ? integrationConfigs[s.integrationId] : undefined)
    if (!cfg) return s

    const merged: Record<string, unknown> = { ...(s.config ?? {}) }

    // Gmail-only fields. Only apply when the binding is actually Gmail.
    if (cfg.gmailQuery) {
      if (isGmail(s)) {
        merged.gmailQuery = cfg.gmailQuery
      } else {
        console.warn(
          '[mergeDistillIntegrationConfigs] LLM emitted gmailQuery for a non-Gmail integration; dropping',
          { integrationId: s.integrationId, type: s.type, name: s.name },
        )
      }
    }

    // Outlook-only field. Same gating.
    if (cfg.outlookFilter) {
      if (isOutlook(s)) {
        merged.outlookFilter = cfg.outlookFilter
      } else {
        console.warn(
          '[mergeDistillIntegrationConfigs] LLM emitted outlookFilter for a non-Outlook integration; dropping',
          { integrationId: s.integrationId, type: s.type, name: s.name },
        )
      }
    }

    // sendAs is shared by Gmail + Outlook; reject for anything else.
    if (cfg.sendAs) {
      if (isGmail(s) || isOutlook(s)) {
        merged.sendAs = cfg.sendAs
      } else {
        console.warn(
          '[mergeDistillIntegrationConfigs] LLM emitted sendAs for an integration that is neither Gmail nor Outlook; dropping',
          { integrationId: s.integrationId, type: s.type, name: s.name },
        )
      }
    }

    if (Object.keys(merged).length === 0) return s
    if (s.config && Object.keys(merged).every((k) => merged[k] === (s.config as Record<string, unknown>)[k])) {
      // No change.
      return s
    }
    mutated = true
    return { ...s, config: merged }
  })
  return mutated ? next : current
}
