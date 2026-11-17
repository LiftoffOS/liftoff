// The templates that predate the distillation input contract.
//
// A ratchet baseline, in the shape of `known-unguarded-routes.ts`: the entries
// here are frozen debt, and anything ADDED or EDITED has to satisfy the rules.
// It only tightens — a template that gains its flows, evals and boundaries must
// come off the list, and the test fails if it does not.
//
// This is not a permission list and it has not been triaged. A template on it
// simply has not been enriched yet, and enrichment is the catalog's cost to
// bear, never a user's: a two-field template stays valid forever, and the point
// of the contract is that a well-understood role is pre-typed, not that every
// role must be.

/** Templates with no `flows`, exempt from the flow-boundary rules. */
export const KNOWN_TEMPLATES_WITHOUT_FLOWS: readonly string[] = [
];

/** Templates with no `evals`, exempt from the counterpart rule. */
export const KNOWN_TEMPLATES_WITHOUT_EVALS: readonly string[] = [
];

/** Templates whose prose still carries headings outside the section
 *  vocabulary. Each one has to be classified — into `toolNotes` where it is
 *  material read while writing a call's arguments, into `flows` where it is a
 *  named sub-workflow, or into the vocabulary where it is neither. */
export const KNOWN_TEMPLATES_WITH_OFF_VOCABULARY_HEADINGS: readonly string[] = [
];

/** Templates with no `toolNotes`. A note is material read while ONE call's
 *  arguments are written, keyed by capability so it survives a rebinding; a
 *  template whose tools genuinely need none records that in the
 *  applicability ledger (`reviewed-field-applicability.ts`) with a reason,
 *  which is a different thing from having not been enriched yet. */
export const KNOWN_TEMPLATES_WITHOUT_TOOL_NOTES: readonly string[] = [
];

/** Templates with no `domainAliases`. On none of the 65 today, the pilot
 *  included: the count of enriched templates undercounted this field for as
 *  long as nothing ratcheted it. A template with no vendor-specific vocabulary
 *  may carry none — as a reviewed ledger entry with a reason, not an absence. */
export const KNOWN_TEMPLATES_WITHOUT_DOMAIN_ALIASES: readonly string[] = [
];

/** Templates with no `capabilities` map. The tri-state is required wherever
 *  a template names a connector requirement — the validator derives that set
 *  from requiredConnectors + optionalConnectors and refuses a DECLARED map that
 *  leaves one of them out — and conditional only for a template that names
 *  none, which then records a ledger entry. What this baseline holds is the
 *  same thing the other five hold: whether the field is there at all. */
export const KNOWN_TEMPLATES_WITHOUT_CAPABILITIES: readonly string[] = [
];
