// What the runtime is allowed to assume about a hire's capabilities.
//
// A template can DECLARE a capability absent — "this business has no phone
// line" — and that is a fact about the customer no binding can contradict.
// Everything else is a fact about this hire, and only the bindings know it.
//
// Deriving it matters because the alternative is an empty map, and an empty
// map does not mean "all good": it means the gateway knows nothing and can
// gate nothing. Most templates declare no capabilities at all, so most hires
// shipped exactly that.

export type CapabilityState = 'live' | 'unwired' | 'absent';

interface Requirement {
  capability?: string;
  capabilities?: string[];
  connectorType?: string;
}

/**
 * A bound connector, named by whichever key the caller populated.
 *
 * `IntegrationPermission` declares `type` and `integrationId` both optional and
 * callers differ, so reading one key silently misses every binding that used
 * the other — and a missed binding here reads as `unwired`, which is the wrong
 * answer in the safe-looking direction.
 */
interface Binding {
  type?: string;
  integrationId?: string;
}

/**
 * Resolve each capability a template names to what this hire actually has.
 *
 * `live` — something bound provides it.
 * `unwired` — the platform supports it and this hire connected nothing.
 * `absent` — declared by the template; the capability is not part of the job.
 *
 * A declared `absent` wins over the bindings. Every other declared value
 * DEFERS to them, because a template cannot promise a connection a hire does
 * not have — a declared `live` over an empty binding set is the lie this is
 * meant to prevent, not one to preserve.
 */
export function deriveCapabilityStates(
  requirements: readonly Requirement[],
  bindings: readonly Binding[],
  declared: Readonly<Record<string, CapabilityState>>,
  // Passed in rather than imported. The connector capability table loads the
  // generated proto enums, and distill-service reaches it through a lazy
  // require for that reason; importing it here would drag that cost back to
  // module load and take five distiller suites down with it.
  connectorTypesFor: (req: { capability: string }) => string[],
): Record<string, CapabilityState> {
  const bound = new Set(
    bindings
      .flatMap((b) => [b.integrationId, b.type])
      .filter((id): id is string => typeof id === 'string' && id.length > 0),
  );

  const out: Record<string, CapabilityState> = {};
  for (const req of requirements) {
    // A requirement pinned to one connector type names no capability, so there
    // is no key to report it under and nothing downstream could read it.
    const names = req.capabilities ?? (req.capability ? [req.capability] : []);
    for (const capability of names) {
      const providers = connectorTypesFor({ capability });
      const live = providers.some((t) => bound.has(t));
      // Several requirements can name one capability. Live anywhere is live:
      // the agent can do the thing, whichever requirement asked for it.
      if (live || out[capability] === undefined) {
        out[capability] = live ? 'live' : 'unwired';
      }
    }
  }

  for (const [capability, state] of Object.entries(declared)) {
    if (state === 'absent' || out[capability] === undefined) {
      out[capability] = state;
    }
  }
  return out;
}
