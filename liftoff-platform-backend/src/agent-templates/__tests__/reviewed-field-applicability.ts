// The applicability ledger: the fields a template has REVIEWED and found it
// does not need, with the reason, one line each.
//
// The five baselines beside this (`known-uncontracted-templates.ts`) freeze
// debt: a template on one of them has not been enriched yet. This file is the
// other answer a field can have. Some of the contract's fields are genuinely
// conditional — a template with no vendor-specific vocabulary carries no
// `domainAliases`; a template whose tools need no per-call rule carries no
// `toolNotes`; a template naming no connector requirement has no capability
// set to declare a tri-state over. Left as an absence, those are
// indistinguishable from debt, and a lane that counts enriched templates
// counts them wrong in both directions.
//
// So an absence that was looked at is written down here, and the ratchet reads
// both: a template's conditional field is present, OR frozen as debt, OR
// reviewed here with a reason. An entry names a template that exists, carries a
// reason, and is not ALSO on the debt baseline — the review replaces the debt
// entry, it does not sit beside it — and a template that later gains the field
// comes off this ledger, or the test fails: a reason for not having something
// you now have is stale.
//
// `capabilities` is conditional ONLY for a template that names no connector
// requirement. Wherever requirements name capabilities, the tri-state is
// required over that set and an entry here is refused.

export type ConditionalField = 'domainAliases' | 'toolNotes' | 'capabilities';

/** template id → one-line reason the field does not apply. */
export const REVIEWED_NOT_APPLICABLE: Readonly<Record<ConditionalField, Readonly<Record<string, string>>>> = {
  domainAliases: {},
  toolNotes: {},
  capabilities: {},
};
