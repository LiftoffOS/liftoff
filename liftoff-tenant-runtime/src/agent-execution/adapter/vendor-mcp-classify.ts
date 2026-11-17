// Risk-classification of vendor-hosted MCP tools (GitHub/Notion/Stripe, custom
// MCP) for HITL gating.
//
// WHY: catalog-based HITL gating (`hitlEnforcementService.checkHitlGate`) is
// category-driven — the sensitive-work path matches a tool's `categories`
// against the enabled `oversight.sensitiveWork` keys (SensitivityCategory), and
// the level-2 destructive path keys on the `⚠️ DESTRUCTIVE` description marker.
// In-process connector tools carry registry categories; external-agent tools
// carry `toolClassifications`. Vendor-hosted MCP tools carry NEITHER — their
// tool list is discovered live from the vendor server with no category labels.
// Without classification, routing them through the bridge makes the gate RUN
// but it returns shouldGate:false for the default category posture, so
// `delete_repo` / `create_refund` pass UNGATED (only the name-based
// super_destructive / merge_to_main gates apply).
//
// This module supplies the missing classification so destructive / sensitive
// vendor MCP actions gate under the category posture too. It maps the VERB
// tokens of a tool name to the exact SensitivityCategory strings the gate
// matches on. The category strings MUST stay in sync with
// `@liftoffos/governance-types` SensitivityCategory:
//   'customerCommunication' | 'financialActions' | 'dataChanges'
//   | 'externalPublishing' | 'hiringDecisions'
//
// MATCHING: vendor MCP tool names are overwhelmingly `verb_object`
// (`create_issue`, `delete_repo`, `send_message`). We tokenize the name
// (snake/kebab/camelCase → tokens) and match WHOLE tokens against the verb
// sets. This is deliberately NOT substring matching — substring matching
// mis-fires (`list_assets` → "assets".includes("set")). Exact-token matching is
// precise and conservative: a name with no risk verb classifies to [] and never
// spuriously gates a read.
//
// ⚠️ This is a heuristic, not a per-vendor-calibrated map. The verb sets are a
// reasonable default for CRUD-shaped APIs but will not capture every vendor's
// naming (e.g. a vendor that names a destructive op `expire` or `sunset`).
// Before relying on CATEGORY gating for a specific high-risk vendor, calibrate
// against that vendor's real `tools/list` output, or specialize via the
// `serverId` argument (kept for exactly that). The name-based
// super_destructive / merge_to_main gates do NOT depend on this and remain the
// hard safety net regardless.
//
// The `serverId` specialization is now USED, by CODE_COLLABORATION_HOSTS below:
// on a code host a "comment" is a write to the repository, not contact with a
// customer. Verb tokens alone cannot make that distinction, because the verb is
// identical in both worlds — only the vendor separates them.

/** Result of classifying one vendor MCP tool. `categories` feed the
 *  sensitive-work gate; `destructive` adds the `⚠️ DESTRUCTIVE` description
 *  marker that the level-2 gate (and isLowRiskTool) keys on. */
export interface VendorMcpClassification {
  categories: string[];
  destructive: boolean;
}

// Irreversible mutate/remove ops → destructive marker + dataChanges.
const DESTRUCTIVE_VERBS = new Set([
  'delete', 'remove', 'destroy', 'drop', 'purge', 'wipe', 'erase',
  'revoke', 'cancel', 'terminate', 'uninstall', 'archive', 'close', 'void',
]);
// Non-destructive writes → dataChanges.
const WRITE_VERBS = new Set([
  'create', 'update', 'edit', 'write', 'set', 'add', 'modify', 'patch',
  'put', 'upsert', 'merge', 'push', 'move', 'rename', 'assign', 'transfer',
]);
// Outbound 1:1 communication → customerCommunication.
const COMMUNICATION_VERBS = new Set([
  'send', 'reply', 'comment', 'message', 'email', 'notify', 'dm', 'mention',
]);

/**
 * Vendors where a "comment" or "reply" is code collaboration, not contact with
 * a customer.
 *
 * The verb sets above read a tool's NAME and nothing else, so
 * `add_comment_to_pending_review` classified as `customerCommunication` for the
 * single reason that it contains the word "comment". Nothing about the vendor,
 * the agent, or what was being written to was consulted. A pull-request review
 * annotation is not a message to a customer, and `in-place-reply.ts` already
 * says so in as many words while working around it:
 *
 *   "`add_issue_comment` is tagged customerCommunication — which a pull-request
 *    comment plainly is not. So category tags can neither be trusted to catch
 *    the dangerous case nor to permit the safe one."
 *
 * The consequence was not cosmetic. `customerCommunication` sits in
 * OUTBOUND_CATEGORIES, so every code-review comment was routed through the
 * Communication oversight policy — the one meant for messages that leave the
 * workspace toward a customer.
 *
 * On these hosts a comment is a WRITE TO THE REPOSITORY, so it classifies as
 * `dataChanges`: still a real category, still governable through
 * `sensitiveWork.dataChanges`, but governed as what it is. A workspace that
 * wants review comments held for approval sets the lever that names them.
 *
 * Explicit rather than pattern-matched. Adding a host here is a policy decision
 * about that vendor, not a naming convenience — and getting it wrong in the
 * other direction (a vendor that really does reach customers) would silence a
 * gate that should fire.
 *
 * SCOPED BY VENDOR, NOT BY VERB, AND ZENDESK IS WHY. Zendesk calls a ticket
 * reply a COMMENT — the runtime carries a `formatZendeskComments` helper for
 * that vocabulary — as do Freshdesk, Intercom and Zoho Desk, the whole
 * `customer_support` category of the connector catalog. So the identical verb
 * means "annotate a diff" on GitHub and "write to the customer" there.
 *
 * Fixing this by dropping `comment` from COMMUNICATION_VERBS, or by keying on
 * the verb rather than the host, would silently stop governing replies to
 * customers as customer communication. That is a strictly worse defect than the
 * one this fixes, and it would stay invisible until someone audited a support
 * agent's oversight settings.
 */
const CODE_COLLABORATION_HOSTS = new Set([
  'github', 'gitlab', 'bitbucket', 'gitea',
]);

/**
 * Vendor type from an MCP server id.
 *
 * `mcp-server.ts` keys a vendor server as `${type}-${id, dashes stripped,
 * first 8}`, so `github-dd4c4689` is the github connector and
 * `google-mail-0105297e` is google-mail — the type itself may contain dashes,
 * which is why the SUFFIX is stripped rather than the first segment taken.
 * A bare type with no suffix is returned unchanged, so a caller that passes one
 * still resolves.
 */
export function vendorTypeFromServerId(serverId: string): string {
  return String(serverId ?? '').toLowerCase().replace(/-[0-9a-f]{8}$/, '');
}
// Public / external publishing → externalPublishing.
const PUBLISHING_VERBS = new Set([
  'publish', 'post', 'tweet', 'share', 'broadcast', 'release', 'deploy',
]);
// Money movement → financialActions.
const FINANCIAL_VERBS = new Set([
  'refund', 'charge', 'payment', 'pay', 'payout', 'invoice', 'subscription',
  'checkout', 'capture', 'price',
]);
// People / hiring → hiringDecisions.
const HIRING_VERBS = new Set([
  'hire', 'offer', 'candidate', 'applicant', 'interview', 'onboard', 'employee',
]);

/** Split a tool name into lowercase word tokens (snake/kebab/camelCase aware). */
export function tokenizeToolName(name: string): string[] {
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2') // camelCase → camel_Case
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

function anyTokenIn(toks: string[], set: Set<string>): boolean {
  return toks.some((t) => set.has(t));
}

/**
 * Classify a vendor MCP tool from its bare name. Conservative: a name with no
 * recognized risk verb returns no categories (read-only assumption) so reads
 * never spuriously gate. `serverId` is accepted so a future per-vendor static
 * map can specialize without changing call sites.
 */
export function classifyVendorMcpTool(serverId: string, bareName: string): VendorMcpClassification {
  const toks = tokenizeToolName(bareName);
  const categories = new Set<string>();
  let destructive = false;

  // The per-vendor specialization this signature has always been shaped for.
  const isCodeCollaboration = CODE_COLLABORATION_HOSTS.has(vendorTypeFromServerId(serverId));

  if (anyTokenIn(toks, DESTRUCTIVE_VERBS)) {
    destructive = true;
    categories.add('destructive');
    categories.add('dataChanges');
  }
  if (anyTokenIn(toks, WRITE_VERBS)) categories.add('dataChanges');
  if (anyTokenIn(toks, COMMUNICATION_VERBS)) {
    // Narrowed, never dropped: a comment on a code host is still an effectful
    // write and still carries a category. Emitting nothing here would leave the
    // tool unclassified, which the gate reads as an unknown effectful write and
    // gates anyway — trading a wrong label for no label.
    categories.add(isCodeCollaboration ? 'dataChanges' : 'customerCommunication');
  }
  if (anyTokenIn(toks, PUBLISHING_VERBS)) categories.add('externalPublishing');
  if (anyTokenIn(toks, FINANCIAL_VERBS)) categories.add('financialActions');
  if (anyTokenIn(toks, HIRING_VERBS)) categories.add('hiringDecisions');

  return { categories: [...categories], destructive };
}
