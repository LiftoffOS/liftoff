// Provenance declarations for vendor-hosted MCP servers, by hand.
//
// The catalog's declarations are derived at the schema-cache mappers and
// learned from traffic; a vendor-hosted server — GitHub's MCP, Stripe's — is
// enumerated in the agent service for the model's tool list and never reaches
// that cache, so its writes have always been judged `no_declaration`: the
// guard ran, the floor ran, the precise check could not say anything.
//
// Derivation cannot fill this in. The id-name rule recognises `pull_number`
// and `issue_id`; GitHub's server spells them `pullNumber` and `commitID`, and
// widening the rule to every `*Number` would take limits, pages and positions
// as identifiers. And `returnsIds` cannot be derived from an input schema at
// all. So the operations a pilot depends on are declared here, in full, and
// the long tail stays with derivation and the learning path.
//
// Keyed by the connector TYPE and the vendor's own tool name — the two things
// a tool call carries whichever tenant and whichever server instance it is on.

import type { ProvenanceDeclaration } from '../tool-gateway/record-provenance';

/** The composite identity GitHub records carry: `owner/repo#number`, derived
 *  by the ledger's own `deriveTarget` rule. A read establishes it from its
 *  response — the PR object's `base.repo.full_name` and `number` — never from
 *  what it was asked for; a write derives it from `owner`, `repo` and the
 *  number it names. */
const GITHUB_PR_REF = { connector: 'github', from: { full_name: 'base.repo.full_name', number: 'number' } } as const;

const GITHUB: Record<string, ProvenanceDeclaration> = {
  /** `method: get` returns the pull request; the other methods (diff, commits,
   *  review comments) return no object that names the PR, and establish
   *  nothing beyond what the floor records. */
  pull_request_read: {
    entityType: 'pull_request',
    returnsIds: [
      { entityType: 'pull_request', path: 'number' },
      { entityType: 'pull_request', path: 'head.sha' },
    ],
    canonicalRef: GITHUB_PR_REF,
  },
  pull_request_review_write: {
    idArgs: ['owner', 'repo', 'pullNumber'],
    entityType: 'pull_request',
    canonicalRef: { connector: 'github' },
  },
  add_issue_comment: {
    idArgs: ['owner', 'repo', 'issue_number'],
    entityType: 'issue',
    canonicalRef: { connector: 'github' },
  },
};

const BY_CONNECTOR_TYPE: Record<string, Record<string, ProvenanceDeclaration>> = {
  github: GITHUB,
};

/** The declaration for a vendor-hosted tool, or undefined when nobody has
 *  written one — in which case the caller falls back to whatever derivation
 *  and learning have produced, as before. */
export function vendorDeclarationFor(
  connectorType: string,
  remoteToolName: string,
): ProvenanceDeclaration | undefined {
  return BY_CONNECTOR_TYPE[connectorType]?.[remoteToolName];
}

/** The declared read on this connector that returns records of this entity
 *  type, so a hold can name the call to make rather than leaving the model
 *  to search for one. Undefined when nothing declared returns it. */
export function vendorReadReturning(connectorType: string, entityType: string | undefined): string | undefined {
  if (!entityType) return undefined;
  const ops = BY_CONNECTOR_TYPE[connectorType];
  if (!ops) return undefined;
  return Object.entries(ops).find(([, decl]) =>
    (decl.returnsIds ?? []).some((r) => r.entityType === entityType))?.[0];
}

/** For the tests that hold every declared operation to the same shape. */
export function _declaredVendorOperationsForTesting(): Array<[string, string, ProvenanceDeclaration]> {
  return Object.entries(BY_CONNECTOR_TYPE).flatMap(([type, ops]) =>
    Object.entries(ops).map(([op, decl]): [string, string, ProvenanceDeclaration] => [type, op, decl]));
}
