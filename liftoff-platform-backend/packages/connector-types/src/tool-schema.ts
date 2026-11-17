// JSON Schema shapes for connector tool definitions.
// Mirrors the subset of JSON Schema that OpenAI / Anthropic tool-calling
// APIs accept (draft-07 style, no $ref, no anyOf).
//
// WARNING: every `type: 'array'` MUST also set `items`. Callers that omit
// items on an array get rejected at request time with
// "Invalid schema ... array schema missing items".

export interface JsonSchemaProperty {
  type: string | string[];
  description?: string;
  required?: boolean;
  /** REQUIRED when type === 'array'. Empty object `{}` means "any". */
  items?: JsonSchemaProperty | Record<string, never>;
  /** Optional nested properties when type === 'object'. */
  properties?: Record<string, JsonSchemaProperty>;
  /** Optional enum constraint. */
  enum?: (string | number | boolean | null)[];
  /** Optional sub-required list when type === 'object'. */
  requiredFields?: string[];
}

/** What a function does to the world, as its author states it.
 *
 *  `internalCollaboration` marks a message into the workspace's OWN
 *  collaboration surface — a Slack channel, a Teams conversation the
 *  workspace installed the app into. It is how a team talks to its people
 *  and is never held for approval; a function carries it beside `write`, and
 *  every gate treats it as the more specific of the two. Deliberately not a
 *  key of any oversight setting, so no checkbox can turn it into a hold. */
export type ToolCategory = 'read' | 'write' | 'destructive' | 'outbound' | 'sensitive' | 'internalCollaboration';

export interface ConnectorFunction {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, JsonSchemaProperty>;
    required?: string[];
  };
  categories: ToolCategory[];
  /**
   * Alternative tool name for draft-first communication mode.
   * e.g. gmail_send_email → gmail_create_draft.
   */
  draftVariant?: string;
  entityType?: string;
  /**
   * W1 work_inbox/ack convention (see
   *
   *   'inbox' — tool surfaces a queue of pending work items, filtered by
   *             external-system state (e.g. is:unread, status:open).
   *   'ack'   — tool flips the external-system state so the same item
   *             does not appear in the paired inbox tool's next list.
   *
   * MUST be set in lockstep with paired_ack / acknowledges and workItemKind.
   * Boot-time validator in connector-service refuses to start on
   * inconsistent pairings.
   */
  workRole?: 'inbox' | 'ack';
  /**
   * On workRole='inbox': registry name of the paired ack tool (e.g.
   * 'mark_as_read', NOT the per-account aliased form). The runtime
   * composes the caller's alias at dispatch time so multi-account
   * agents bind to the right account's ack.
   */
  paired_ack?: string;
  /**
   * On workRole='ack': registry name of the inbox tool this ack closes
   * the loop on.
   */
  acknowledges?: string;
  /**
   * Stable cross-connector label for the kind of work item. Both halves
   * of a pair MUST agree. Examples: 'email_message', 'support_ticket',
   * 'issue', 'lead', 'task', 'card', 'deal'.
   */
  workItemKind?: string;
  /**
   * C2/Composio cutover-completion: origin of this function definition.
   *   'native'   — hand-authored in CONNECTOR_FUNCTIONS, dispatched via the
   *                connector's native REST executor.
   *   'composio' — sourced from @liftoffos/composio-overlays, dispatched
   *                via composio.tools.execute() in tenant-runtime.
   * Read by tenant-runtime's stable-name router to pick a dispatch path.
   * Absent on legacy entries; the router treats absent as 'native'.
   */
  definitionSource?: 'native' | 'composio';
  /**
   * Underlying vendor's tool name. For definitionSource='composio', this
   * is the Composio vendor slug (e.g. 'GMAIL_FETCH_EMAILS') passed to
   * composio.tools.execute(). The `name` field above is the stable Liftoff
   * name (e.g. 'list_messages') the agent calls. For native tools, MUST
   * be either omitted or equal to `name`.
   */
  vendorToolName?: string;

  // ── Record provenance ─────────────────────────────────────────────────
  //
  // A write names a record. Nothing today establishes where that name came
  // from, so an id the model composed out of context — a plausible-looking
  // ticket number, a channel it saw mentioned in a document — reaches the
  // vendor indistinguishable from one the run actually read.
  //
  // These two fields are the declaration that makes the question answerable.
  // They are SEPARATE because they are separate facts about different tools: a
  // write declares what its arguments MEAN, a read declares what its result
  // CONTAINS, and most tools have one or the other. A tool that declares
  // neither is not covered, and the runtime falls back to its own argument
  // heuristic — the same relationship the name heuristic has to `categories`.

  /**
   * Payload argument names that identify the record this call acts on, e.g.
   * `['pull_number']`, `['spreadsheet_id', 'range']`. Order is not
   * significant, and every listed argument is checked.
   *
   * Name the arguments that pick out WHICH record, never the ones that carry
   * WHAT to do to it: `body`, `text` and `comment` are content, and listing
   * them would ask the runtime to prove a sentence came from somewhere.
   */
  idArgs?: string[];

  /**
   * Where this tool's RESULT carries record identities, so the runtime can
   * remember what the run has legitimately seen.
   *
   * `entityType` is matched against the entity a later write names, so a
   * message id cannot vouch for a pull request. `path` is a dot path into the
   * result with `[]` meaning "every element": `messages[].id`,
   * `data.spreadsheetId`.
   */
  returnsIds?: Array<{ entityType: string; path: string }>;

  // ── Host-only result fields ───────────────────────────────────────────

  /**
   * Result paths whose values reach the SURFACE but never the model: signed
   * download URLs, payment links, one-time tokens, PII the surface may render
   * to its owner. The model-visible result carries a placeholder in their
   * place.
   *
   * Distinct from secret-scrubbing, which removes a value from everywhere
   * because nobody should have it. Here the person still needs it; the model
   * is the one that does not, and a URL in the model's context is a URL that
   * can be repeated into a reply, a tool argument or a web page.
   *
   * Same dot-path syntax as `returnsIds.path`.
   */
  egressOnly?: string[];

  // ── Staged writes ─────────────────────────────────────────────────────

  /**
   * Whether this call prepares a change, commits one, or takes effect on its
   * own.
   *
   *   'stage'  — prepares a change that a paired apply commits.
   *   'apply'  — commits what a paired stage prepared.
   *   'direct' — takes effect by itself. The default, and every tool that does
   *              not opt in.
   *
   * It exists to REDUCE interruptions, not to add a step. A job that is N
   * line-level writes — a price list, a mailing batch — currently pauses for
   * approval per line; declared as a pair, the person is asked once about the
   * staged batch and the single approval covers exactly what the apply
   * commits. Only opt-in families set it.
   */
  writeRole?: 'stage' | 'apply' | 'direct';

  /**
   * On writeRole='stage': registry name of the apply tool that commits it
   * (the bare registry name, not a per-account alias — the runtime composes
   * the alias at dispatch, exactly as it does for `paired_ack`).
   *
   * Validated at connector-service boot in lockstep with `writeRole`, the same
   * way the work-pair validator checks inbox/ack.
   */
  paired_apply?: string;
}
