// A required connector has to actually be bound.
//
// `requiredConnectors` reads as a guarantee and was never one. The validator
// says so in its own words — "A required connector is always bound, so it has
// no second version to choose between" — and used that premise to allow a
// destination on such a connector to be named bare in prose. Nothing upheld
// it. An agent can require team chat, have only GitHub bound, and be told to
// notify a channel it has no tool to reach — and then report notifying one.
//
// Where a capability has a platform floor, the answer was to make the sentence
// true unbound (see platform-destinations.ts). Documents have no floor: a role
// whose deliverable is a saved file, or which reads back what an earlier run
// wrote, cannot degrade. For those the honest answer is to ask at hire rather
// than to discover it a week later in a report that was never written.
//
// Draft agents are exempt. Someone building a team should be able to save
// progress before they have connected anything; the gate belongs where the
// agent starts running.


export class RequiredConnectorMissingError extends Error {
  constructor(
    message: string,
    public readonly context: { templateId: string; requirementId: string; capabilities: string[] },
  ) {
    super(message);
    this.name = 'RequiredConnectorMissingError';
  }
}

interface Requirement {
  id: string;
  connectorType?: string;
  capability?: string;
  capabilities?: string[];
}

interface Binding {
  type?: string;
  integrationId?: string;
}

/**
 * Throw when a template's required connector has nothing bound to satisfy it.
 *
 * `connectorTypesFor` is injected for the same reason as in
 * capability-state-derivation: the capability table loads the generated proto
 * enums, and the callers here reach it through a lazy require.
 */
export function assertRequiredConnectorsBound(args: {
  template: { id: string; requiredConnectors?: readonly Requirement[] };
  bindings: readonly Binding[];
  status?: string;
  connectorTypesFor: (req: { capability: string }) => string[];
}): void {
  if (args.status === 'draft') return;

  const bound = new Set(
    args.bindings
      .flatMap((b) => [b.integrationId, b.type])
      .filter((t): t is string => typeof t === 'string' && t.length > 0),
  );

  for (const req of args.template.requiredConnectors ?? []) {
    // A requirement pinned to one type names that type; otherwise any connector
    // carrying any of its capabilities will do, which is what lets a team stand
    // up on Drive or on Notion.
    const acceptable = req.connectorType
      ? [req.connectorType]
      : (req.capabilities ?? (req.capability ? [req.capability] : []))
          .flatMap((capability) => args.connectorTypesFor({ capability }));

    // A requirement naming neither is not a requirement anything can check.
    if (acceptable.length === 0) continue;
    if (acceptable.some((t) => bound.has(t))) continue;

    const names = req.capabilities ?? (req.capability ? [req.capability] : [req.connectorType!]);
    throw new RequiredConnectorMissingError(
      `This team needs ${names.join(' or ')} connected before it can start. `
      + 'Connect it on the tools step, then try again.',
      { templateId: args.template.id, requirementId: req.id, capabilities: names },
    );
  }
}
