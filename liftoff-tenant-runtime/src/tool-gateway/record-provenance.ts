// Where did the id this write is about to act on come from?
//
// THE GAP. A write names a record — a pull request number, a channel, a
// spreadsheet id — and nothing establishes where that name came from. An id the
// run genuinely read a moment ago and an id the model composed out of context
// arrive at the vendor identical: same argument, same shape, same call. The
// second one is not a hallucination in the usual sense, because it is often
// plausible and occasionally right; it is a write against a record the run never
// looked at.
//
// WHAT MAKES IT ANSWERABLE. Two declarations on the catalog, which
// connector-service publishes and ListTools carries:
//
//   returnsIds — where a READ's result carries the identities it returned
//   idArgs     — which of a WRITE's arguments name the record it acts on
//
// So the run accumulates what it has legitimately seen, and a write is checked
// against that set. A tool that declares neither is not covered; this falls back
// to the same argument scan the action ledger uses, which is the relationship
// the name heuristic already has to `categories`.
//
// WHY IT LIVES HERE AND NOT IN AN ADAPTER. INV-TR-019: the Claude Agent SDK
// engine mounts the tool-gateway MCP server directly, so its calls never pass
// through the bridge. A gate in an adapter structurally misses an engine no
// matter what the vendor mix is on the day. Both `execute` and `executeBatch`
// call into this module, and an enumerating test asserts a new dispatch path
// cannot reach a vendor without passing through it.
//
// WHAT IT CANNOT ANSWER YET, stated so a quiet metric is not read as coverage.
// A run whose FIRST call is a write got its identifier from the trigger — a
// webhook naming the pull request, a cron carrying the row — and that is real
// provenance the platform handed it, not an id the model invented. Nothing
// seeds the set from the trigger payload today, so a run that has read nothing
// is not judged at all. Seeding it is the next increment; judging without it
// would flag the single most common legitimate shape on day one, which is the
// fastest way to make a shadow metric worthless.
//
// SHADOW BY DEFAULT. `PROVENANCE_GATE_MODE=off|shadow|enforce`, default shadow:
// the check runs, the metric fires, and nothing is refused. Enforce is a
// decision to be made on constructed per-engine evidence, not on organic
// traffic alone — and the shadow metric is also the
// false-positive alarm, because a legitimate pattern that lights it up is a
// pattern to declare rather than a write to block.

import { logger } from '../infrastructure/logging';
import { spotIdentifiers, unseenWriteIdentifiers } from './identifier-floor';
import { connectorTypeFromAlias } from '../action-ledger/target-ref';

/** How the gate behaves. Shadow observes; enforce holds; off does nothing. */
export type ProvenanceGateMode = 'off' | 'shadow' | 'enforce';

export function provenanceGateMode(): ProvenanceGateMode {
  const raw = (process.env.PROVENANCE_GATE_MODE ?? '').trim().toLowerCase();
  if (raw === 'off' || raw === 'enforce') return raw;
  // Anything else, including unset and a typo, is shadow. A misspelled mode
  // must not silently disable the observation this is here to collect, and it
  // must not silently start refusing writes either.
  return 'shadow';
}

/**
 * Whether this connector may be REFUSED, as opposed to merely observed.
 *
 * Enforcement is per connector because declaration coverage is: gmail has
 * thirteen response paths declared at the schema cache, github three
 * operations declared by hand (connectors/vendor-declarations.ts), and most of
 * the estate nothing. A single global flip would start refusing writes on the
 * connectors covered by nothing but the heuristic floor — which is the half of
 * this that guesses, and which can end up flagging every workspace file write.
 *
 * An allowlist rather than a per-connector mode. There is one question here
 * ("is this one ready?"), the answer is the same for every tenant, and a
 * config surface that could disagree per tenant would be a second source of
 * truth for a decision that has one.
 *
 * Empty means enforce nothing, so the global mode alone can never start
 * refusing: reaching enforce takes two deliberate settings, and the connector
 * list is the one that names what was actually checked.
 */
export function provenanceEnforcedConnectors(): ReadonlySet<string> {
  return new Set(
    (process.env.PROVENANCE_ENFORCE_CONNECTORS ?? '')
      .split(',')
      .map((c) => c.trim().toLowerCase())
      .filter((c) => c.length > 0),
  );
}

/** The one list value that is not a connector: enforce wherever there is a
 *  declaration to enforce on. */
export const ENFORCE_DECLARED = 'declared';

/** Does the gate refuse for this connector, or only record what it saw?
 *
 *  Matched on the connector TYPE, on both sides. The value that reaches this
 *  from a dispatch is the instance ALIAS — `github-dd4c4689`,
 *  `google-mail-0105297e` — because that is what names an instance and what the
 *  ledger stores. An operator names a connector by type: `github`,
 *  `google_mail`. Compared verbatim those never meet, and an allowlist that
 *  never matches enforces nothing while appearing switched on — the same silent
 *  shape as a missing declaration.
 *
 *  `declared` on the list means every connector with a declaration in hand:
 *  a hand-written one, a reviewed generated one, or one derived at runtime by
 *  the reviewed rule. A write nothing declares is never judged and so never
 *  held, whatever the list says — the floor reports, the floor does not
 *  refuse. Naming connectors one at a time was the register of what a
 *  constructed pair had proven; once the declarations themselves were the
 *  proof, the register was a flip ritual per connector. */
export function provenanceEnforcedFor(
  connector: string | undefined,
  declaration?: { idArgs?: string[]; returnsIds?: unknown[] } | undefined,
): boolean {
  if (provenanceGateMode() !== 'enforce') return false;
  if (!connector) return false;
  const wanted = connectorTypeFromAlias(connector);
  for (const listed of provenanceEnforcedConnectors()) {
    if (listed === ENFORCE_DECLARED) {
      if ((declaration?.idArgs ?? []).length > 0) return true;
      continue;
    }
    if (connectorTypeFromAlias(listed) === wanted) return true;
  }
  return false;
}

/**
 * What one invocation has legitimately seen, and where it is kept.
 */

// The store — a table in every deployment, a Map in tests — and the working
// shape the checks read. See `provenance-store.ts` for why it is not a Map here
// any more.
import {
  getProvenanceStore,
  type InvocationProvenance,
  type ProvenanceRow,
} from './provenance-store';
import { deriveTarget } from '../action-ledger/target-ref';
import { triggerTargetOf } from '../action-ledger/record-external-tool-call';

/** Below this, a substring match means nothing: a two-character "id" appears in
 *  any paragraph. Above it, the value is specific enough that finding it inside
 *  the request text says the person or the trigger named it. */
const MIN_TEXT_MATCH_LENGTH = 6;

/** Facts gathered by one record call, appended together. */
class Facts {
  readonly rows: ProvenanceRow[] = [];
  private readonly ids = new Set<string>();
  id(entityType: string | undefined, value: string): void {
    const key = `${entityType ?? ''}:${value}`;
    if (this.ids.has(key)) return;
    this.ids.add(key);
    this.rows.push(entityType ? { kind: 'id', entityType, value } : { kind: 'untyped', value });
  }
  given(text: string): void { this.rows.push({ kind: 'given', value: text }); }
  get idCount(): number { return this.ids.size; }
}

/**
 * Read a dot path out of a result, with `[]` meaning "every element".
 *
 * `messages[].ts`, `data.spreadsheetId`, `items[].id`. Returns every value the
 * path reaches, as strings, skipping anything that is not a scalar — an id is a
 * string or a number, and a nested object at the end of an id path means the
 * declaration is wrong rather than that the object is an identity.
 */
export function readIdPath(result: unknown, path: string): string[] {
  const segments = path.split('.').filter(Boolean);
  let current: unknown[] = [result];

  for (const segment of segments) {
    const isArray = segment.endsWith('[]');
    const key = isArray ? segment.slice(0, -2) : segment;
    const next: unknown[] = [];
    for (const node of current) {
      if (node === null || typeof node !== 'object') continue;
      const value = (node as Record<string, unknown>)[key];
      if (value === undefined) continue;
      if (isArray) {
        if (Array.isArray(value)) next.push(...value);
        // A path that says `[]` against a non-array is a wrong declaration.
        // Skipped rather than coerced: coercing would record the array itself
        // as an id and every later write would match it.
        continue;
      }
      next.push(value);
    }
    current = next;
  }

  return current
    .filter((v): v is string | number => typeof v === 'string' || typeof v === 'number')
    .map((v) => String(v))
    .filter((v) => v.length > 0);
}

/** The tool declaration this module reads. Structural, so a caller can pass a
 *  `ConnectorFunction` or anything that carries the same two fields. */
export interface ProvenanceDeclaration {
  idArgs?: string[];
  returnsIds?: Array<{ entityType: string; path: string }>;
  entityType?: string;
  /** Composite identity, for a connector whose records are not named by one
   *  scalar. A pull request is `owner/repo#number`: checked as independent
   *  values, a read of #123 in one repository grounds a write to #123 in
   *  another. `connector` names the ledger's own `deriveTarget` rule, so the
   *  read and the write derive exactly the same value — the ref the ledger
   *  already stores. For a READ, `from` maps the payload keys that rule reads
   *  to the RESPONSE paths that carry them: the read establishes the ref only
   *  when its response yields every component, never from its own arguments.
   *  A WRITE derives the ref from the arguments it is about to send. */
  canonicalRef?: { connector: string; from?: Record<string, string> };
}

/** The entity type under which a canonical ref is remembered. A ref carries
 *  its connector in its own text, so one type serves every connector. */
const REF_ENTITY = 'ref';

/** The ref a declaration's `canonicalRef` derives from a payload — the write's
 *  arguments, or the read's response projected through `from`. Undefined when
 *  the ledger's rule finds nothing to name. */
function canonicalRefOf(
  decl: ProvenanceDeclaration,
  actionType: string,
  source: unknown,
  projectResponse: boolean,
): string | undefined {
  const spec = decl.canonicalRef;
  if (!spec) return undefined;
  let payload: Record<string, unknown>;
  if (projectResponse) {
    if (!spec.from) return undefined;
    payload = {};
    for (const [key, path] of Object.entries(spec.from)) {
      const [first] = readIdPath(source, path);
      if (first === undefined) return undefined;
      payload[key] = first;
    }
  } else {
    if (!source || typeof source !== 'object') return undefined;
    payload = source as Record<string, unknown>;
  }
  const target = deriveTarget({ connector: spec.connector, actionType, payload });
  return target.ref || undefined;
}

/**
 * Record what a successful call returned.
 *
 * Called on BOTH dispatch paths after the result exists. Reads contribute the
 * identities they returned; writes contribute the record they just created or
 * touched, so a create-then-update inside one run is provenanced by its own
 * create rather than looking like a write out of nowhere.
 */
/** The row that says "this run has read something", when a read returned no
 *  identifier to record. Empty given text: it matches nothing, since a value
 *  shorter than MIN_TEXT_MATCH_LENGTH never matches given text and an empty
 *  string is included in nothing. */
const HAS_READ: ProvenanceRow = { kind: 'given', value: '' };

/**
 * Identifiers the PLATFORM itself handed the agent when it woke it.
 *
 * The seen-set is fed by tool RESULTS and by nothing else, so an id that
 * arrived in the triggering event was never seen — and a triggered agent doing
 * the most ordinary thing it can do, replying to the thread the event named,
 * writes to an identifier this run "has not read". Under shadow that is a
 * warning. Under enforce it is a refusal, and it would land on the legitimate
 * majority rather than on the fabrications the gate is for.
 *
 * That is the false-positive class this module's own header warns about: "a
 * legitimate pattern that lights it up is a pattern to declare rather than a
 * write to block". Here the declaration is structural — the platform read the
 * thing, and handed it over. An event payload IS a read result; the read was
 * simply performed by the delivery path instead of by the agent.
 *
 * Recorded through the floor rather than as a typed entity because an event
 * payload carries no declaration to type it by, and an untyped id is the
 * weaker, correct claim: it vouches for the value without asserting what kind
 * of thing it names.
 */
export async function seedProvenanceFromEvent(args: {
  tenantId?: string;
  invocationId: string | undefined;
  /** The run's `inputData` — the normalized envelope, whose `eventData` is the
   *  vendor's own payload. */
  inputData: Record<string, unknown> | undefined;
}): Promise<number> {
  if (!args.invocationId || !args.inputData) return 0;
  const eventData = args.inputData.eventData;
  if (!eventData || typeof eventData !== 'object') return 0;
  const facts = new Facts();
  for (const id of spotIdentifiers(eventData)) facts.id(undefined, id);
  // And the composite identity of what the event was ABOUT, derived the way
  // the ledger derives it: a run woken by a pull request's own event acts on
  // that pull request without reading it first, and that is what the event
  // is for.
  const target = triggerTargetOf(args.inputData);
  if (target) facts.id(REF_ENTITY, target.ref);
  if (facts.rows.length === 0) facts.rows.push(HAS_READ);
  const ok = await getProvenanceStore().append(args.tenantId, args.invocationId, facts.rows);
  return ok ? facts.idCount : 0;
}

/**
 * Everything else the run was legitimately given.
 *
 * The event was the first of these and the same argument covers the rest. An
 * agent knows an identifier for exactly five reasons: it read one with a tool,
 * the event that woke it named one, its own configuration names one, the person
 * asked about one, or it is continuing work where one already appeared. Only the
 * first two were recorded, so the other three read as fabrication — and under
 * enforcement they would be refusals, landing on ordinary work.
 *
 * NONE OF THIS IS PER-CONNECTOR, which is the point. The gap is on the side
 * that records what a run knows, and that side never mentions which app the
 * write is going to. A connector added tomorrow at a customer's request — one
 * nobody here has an account on, whose traffic nobody can watch — inherits every
 * one of these the day it is connected.
 *
 * Structured sources are scanned for id-shaped keys. TEXT sources are kept as
 * text: prose has no keys to scan, and the exact question is answerable the
 * other way round at verdict time.
 */
export async function seedProvenanceFromContext(args: {
  tenantId?: string;
  invocationId: string | undefined;
  /** Agent configuration, integration bindings — anything with field names. */
  structured?: unknown;
  /** The person's request, the compiled instruction, the conversation being
   *  continued. Empty and undefined entries are dropped. */
  texts?: Array<string | undefined | null>;
}): Promise<void> {
  if (!args.invocationId) return;
  const facts = new Facts();
  if (args.structured !== undefined && args.structured !== null) {
    for (const id of spotIdentifiers(args.structured)) facts.id(undefined, id);
  }
  for (const text of args.texts ?? []) {
    if (typeof text === 'string' && text.length > 0) facts.given(text);
  }
  if (facts.rows.length === 0) return;
  await getProvenanceStore().append(args.tenantId, args.invocationId, facts.rows);
}

/** Was this value present in what the run was handed? */
function appearsInGivenText(entry: InvocationProvenance, value: string): boolean {
  if (value.length < MIN_TEXT_MATCH_LENGTH) return false;
  return entry.givenText.some((t) => t.includes(value));
}

/**
 * What the FLOOR would flag about a write, for connectors with no declaration.
 *
 * Reported under its own metric, never merged into `provenance.would_block`. A
 * shadow metric that mixes a precise signal with a heuristic one is worse than
 * either: the precise number stops being trustworthy and the heuristic number
 * stops being actionable.
 */
/**
 * Connectors whose writes are not record mutations, so the floor does not
 * apply to them.
 *
 * The floor asks whether a write names a record this run has not read. A file
 * in the run's own sandbox is not a customer record: its name is generated, it
 * is nobody's identifier, and there is no read that could have vouched for it.
 * Asking is a category error, and answering flags every file the run creates.
 */
const NOT_RECORD_WRITES: ReadonlySet<string> = new Set(['execution_environment']);

export async function checkFloorProvenance(args: {
  tenantId?: string;
  invocationId: string | undefined;
  payload: unknown;
  /** The connector this write goes to. A sandbox write is out of scope. */
  connector?: string;
  /** Identifiers the PLATFORM gave this run — its own invocation, agent and
   *  tenant. Never flagged: the run did not read them because it was handed
   *  them, and a floor that demands provenance for a run's own name is asking
   *  where it heard of itself. */
  runContext?: ReadonlyArray<string | undefined>;
}): Promise<string[]> {
  if (!args.invocationId) return [];
  if (args.connector && NOT_RECORD_WRITES.has(args.connector)) return [];
  const entry = await getProvenanceStore().load(args.tenantId, args.invocationId);
  if (!entry) return [];
  const ownContext = new Set(
    [args.invocationId, ...(args.runContext ?? [])].filter(
      (v): v is string => typeof v === 'string' && v.length > 0,
    ),
  );
  return unseenWriteIdentifiers(args.payload, entry.seenUntyped)
    .filter((id) => !ownContext.has(id));
}

/**
 * A declaration that never matches anything says so.
 *
 * The failure this catches is the one hand-written declarations are most prone
 * to and the one nothing else can see: `idArgs: ['pull_number']` against a tool
 * whose argument is `pullNumber` is not an error anywhere. The runtime looks the
 * key up, finds nothing, and reads the write as "declares no id arguments" —
 * which is indistinguishable from a tool nobody ever covered. The declaration
 * looks like protection, reads like protection in review, and protects nothing.
 *
 * So a declared write whose payload contains NONE of its declared arguments
 * reports itself. Once per tool per process, because the point is to be noticed
 * once and fixed, not to fill a log.
 */
const INERT_REPORTED = new Set<string>();

export function reportInertDeclaration(args: {
  connector: string;
  actionType: string;
  declaration: ProvenanceDeclaration | undefined;
  payload: unknown;
}): void {
  const declared = args.declaration?.idArgs ?? [];
  if (declared.length === 0) return;
  const payload = (args.payload ?? {}) as Record<string, unknown>;
  const anyPresent = declared.some((k) => payload[k] !== undefined && payload[k] !== null && payload[k] !== '');
  if (anyPresent) return;

  // A create legitimately supplies none of them, so a single call proves
  // nothing — but a tool that NEVER supplies one, across a process's lifetime,
  // is a declaration naming arguments this tool does not take.
  const key = `${args.connector}:${args.actionType}`;
  if (INERT_REPORTED.has(key)) return;
  INERT_REPORTED.add(key);
  logger.info({
    event: 'provenance_declaration_inert',
    metric: 'provenance.declaration_inert',
    connector: args.connector,
    actionType: args.actionType,
    declaredArgs: declared,
    payloadKeys: Object.keys(payload).slice(0, 20),
  }, 'a declared write supplied none of its declared id arguments — the declaration may name arguments this tool does not take');
}

/** Test seam. */
export function _resetInertReportingForTesting(): void {
  INERT_REPORTED.clear();
}

export async function recordProvenance(args: {
  tenantId?: string;
  invocationId: string | undefined;
  declaration: ProvenanceDeclaration | undefined;
  /** Needed only to derive a composite ref, whose rule may read it. */
  actionType?: string;
  payload: unknown;
  result: unknown;
  /** True when this call CHANGED something. A read's arguments are not
   *  provenance; see the note on the payload branch below. */
  isWrite: boolean;
  /** Also record every identifier-shaped value a READ returned, whatever the
   *  connector — the floor's half of the memory. It runs beside the
   *  declaration-driven recording rather than instead of it: a declared
   *  `returnsIds` path is a precise statement about where an identity lives,
   *  and this is a guess that covers the ~144 connectors nobody has made that
   *  statement about. Recording generously is free in the direction that
   *  matters: an extra identifier can only ever PREVENT a flag.
   *
   *  In the SAME append as the declared facts, so the answer below is about
   *  all of them. Two appends answered for the first alone, and for a
   *  long-tail read the first held nothing but HAS_READ while the second
   *  held every identifier — a "recorded" that recorded nothing. */
  floor?: boolean;
}): Promise<boolean> {
  // Resolves to whether the store holds what this call established. A caller
  // that marks the call remembered may do so only on true.
  if (!args.invocationId) return true;
  const facts = new Facts();
  if (args.floor && !args.isWrite) {
    for (const id of spotIdentifiers(args.result)) facts.id(undefined, id);
  }

  for (const { entityType, path } of args.declaration?.returnsIds ?? []) {
    for (const id of readIdPath(args.result, path)) facts.id(entityType, id);
  }
  // The composite identity, when the tool declares one: a read establishes it
  // only from its RESPONSE (projected through `from`), a write from the
  // arguments it sent — the same rule the ledger's target_ref follows.
  if (args.declaration?.canonicalRef) {
    const ref = canonicalRefOf(args.declaration, args.actionType ?? '', args.isWrite ? args.payload : args.result, !args.isWrite);
    if (ref) facts.id(REF_ENTITY, ref);
  }

  // A WRITE's own arguments become provenance for the writes after it. Without
  // this, a run that creates a row and then updates it reports the update as
  // unprovenanced — the id never came from a read because the record did not
  // exist until this run made it.
  //
  // A READ's arguments deliberately do NOT. Recording them would let the model
  // launder an identifier through a lookup: invent an id, call a read with it,
  // and the id is now "seen" for every write that follows. A successful read
  // does prove the record exists, which is worth something — but "this record
  // exists somewhere" is not "this is the record my task is about", and the
  // whole point of the gate is the difference between them.
  //
  // So a read contributes through `returnsIds` instead, grounded in what the
  // vendor sent BACK rather than what the model sent in. A read that declares
  // no returnsIds contributes nothing, which is the honest answer: it is a read
  // nobody has told us the shape of.
  if (args.isWrite) {
    for (const arg of args.declaration?.idArgs ?? []) {
      const value = (args.payload as Record<string, unknown> | null | undefined)?.[arg];
      if (typeof value === 'string' || typeof value === 'number') {
        facts.id(args.declaration?.entityType, String(value));
      }
    }
  }

  // Emitted so a run's provenance can be TRACED rather than inferred. Without
  // it the only observable state is a write being flagged, and a run with no
  // flags is indistinguishable from a run where nothing was ever recorded —
  // which is the reading that turns a quiet metric into false confidence.
  // A call that established nothing still means the run has been judged
  // against something — see HAS_READ.
  if (facts.rows.length === 0) facts.rows.push(HAS_READ);
  const ok = await getProvenanceStore().append(args.tenantId, args.invocationId, facts.rows);
  if (ok && facts.idCount > 0) {
    logger.debug({
      event: 'provenance_recorded',
      metric: 'provenance.recorded',
      invocationId: args.invocationId,
      added: facts.idCount,
      isWrite: args.isWrite,
    }, 'recorded identifiers this run has now seen');
  }
  return ok;
}

/** Why a write was flagged, for the metric. */
export type ProvenanceBasis =
  | 'canonical_ref'      // the tool declared a composite identity and the ref was never seen
  | 'declared_id_args'   // the tool declared idArgs and one was never seen
  | 'no_declaration';    // nothing declared; not checked

export interface ProvenanceVerdict {
  /** True when every declared id argument traces to something this run saw. */
  provenanced: boolean;
  basis: ProvenanceBasis;
  /** The argument values that could not be traced. Empty when provenanced. */
  unseen: string[];
}

/**
 * Check a write against what the run has seen.
 *
 * Returns `provenanced: true` for anything it cannot judge — a tool with no
 * declaration, a payload with none of the declared arguments present. This gate
 * reports what it KNOWS is unprovenanced, never what it merely cannot vouch
 * for, because the second reading would flag most of the estate on day one and
 * the metric would be unreadable.
 */
export async function checkWriteProvenance(args: {
  tenantId?: string;
  invocationId: string | undefined;
  declaration: ProvenanceDeclaration | undefined;
  /** Needed only to derive a composite ref, whose rule may read it. */
  actionType?: string;
  payload: unknown;
}): Promise<ProvenanceVerdict> {
  // A composite identity is judged as one value — the ref — never as the
  // scalars it is made of, which is what let #123 in one repository ground
  // #123 in another. A write whose arguments yield no ref is not judged: the
  // ledger's rule found nothing to name, which is the honest answer.
  if (args.declaration?.canonicalRef) {
    const ref = canonicalRefOf(args.declaration, args.actionType ?? '', args.payload, false);
    if (!ref) return { provenanced: true, basis: 'no_declaration', unseen: [] };
    const entry = args.invocationId ? await getProvenanceStore().load(args.tenantId, args.invocationId) : undefined;
    if (!entry) return { provenanced: true, basis: 'no_declaration', unseen: [] };
    const seen = entry.seen.has(`${REF_ENTITY}:${ref}`);
    return { provenanced: seen, basis: 'canonical_ref', unseen: seen ? [] : [ref] };
  }

  const declared = args.declaration?.idArgs ?? [];
  if (declared.length === 0) {
    return { provenanced: true, basis: 'no_declaration', unseen: [] };
  }

  const payload = (args.payload ?? {}) as Record<string, unknown>;
  const present = declared
    .map((arg) => payload[arg])
    .filter((v): v is string | number => typeof v === 'string' || typeof v === 'number')
    .map(String)
    .filter((v) => v.length > 0);

  if (present.length === 0) {
    // The tool declares id arguments and this call supplied none of them, so
    // it is not acting on a named record — a create, most often.
    return { provenanced: true, basis: 'no_declaration', unseen: [] };
  }

  const entry = args.invocationId ? await getProvenanceStore().load(args.tenantId, args.invocationId) : undefined;
  if (!entry) {
    // No invocation to remember against. Chat turns and inbound dispatch reach
    // the gateway without one, and a run whose reads happened in an earlier
    // process has none either. Not judged: the alternative is flagging every
    // call that arrives without a session, which says nothing about the id.
    return { provenanced: true, basis: 'no_declaration', unseen: [] };
  }

  const entityType = args.declaration?.entityType;
  const unseen = present.filter((value) => {
    if (entityType && entry.seen.has(`${entityType}:${value}`)) return false;
    if (entry.seenUntyped.has(value)) return false;
    // Last, and deliberately last: a value the run READ is the strong claim,
    // and this is the weaker one — the identifier appears in what the agent was
    // handed. It is still a claim about provenance rather than a shrug, because
    // the value is matched exactly and only when it is long enough for a match
    // to mean something.
    return !appearsInGivenText(entry, value);
  });

  return {
    provenanced: unseen.length === 0,
    basis: 'declared_id_args',
    unseen,
  };
}

/**
 * The text an enforced hold returns.
 *
 * A hold, not an error. The run has done nothing wrong that a read would not
 * fix, so the outcome names the read to run rather than reporting a failure the
 * model has to guess its way out of — the same reasoning the no-stub-success
 * rule applies to a tool that cannot dispatch.
 */
export function holdMessage(args: {
  connector: string;
  actionType: string;
  unseen: string[];
  readToRun: string | undefined;
}): string {
  const ids = args.unseen.join(', ');
  const read = args.readToRun
    ? `Call \`${args.readToRun}\` first and act on what it returns.`
    : `Read the record from ${args.connector} first and act on what that returns.`;
  return (
    `Held: ${args.connector}.${args.actionType} names ${ids}, which nothing in this run has read. `
    + `${read} `
    + 'This is not a refusal of the action — it is a refusal to act on an identifier whose origin is unknown.'
  );
}

/** Emit the shadow observation. Separate from the check so the check stays pure
 *  and testable, and so both dispatch paths report identically. */
export function reportProvenance(args: {
  mode: ProvenanceGateMode;
  verdict: ProvenanceVerdict;
  connector: string;
  actionType: string;
  tenantId: string;
  agentId: string;
  invocationId?: string;
  /** How the call was dispatched. `gateway` is our own dispatcher; `direct` is
   *  the vendor SDK (or the bridge's client pool) talking to a vendor-hosted
   *  server itself. Both are judged BEFORE dispatch and both can refuse — the
   *  gateway inside `execute()`, direct at the adapter gate every engine calls
   *  first. Kept because the two have different declaration coverage (a
   *  vendor-hosted server has no catalog row) and a report should be able to
   *  read them apart. Defaults to `gateway`. */
  dispatch?: 'gateway' | 'direct';
}): void {
  const dispatch = args.dispatch ?? 'gateway';
  // A write nobody declared id arguments for was not judged. Reporting it as a
  // pass would be the same lie in the other direction.
  if (args.verdict.basis === 'no_declaration') {
    logger.info({
      event: 'provenance_not_judged',
      dispatch,
      metric: 'provenance.not_judged',
      connector: args.connector,
      actionType: args.actionType,
      tenantId: args.tenantId,
      agentId: args.agentId,
      invocationId: args.invocationId,
    }, 'write was not judged: nothing declares which arguments name a record');
    return;
  }

  if (args.verdict.provenanced) {
    // Emitted so the shadow metric can be READ. Without it the only signal is
    // would_block, and would_block == 0 means either "every write was
    // provenanced" or "the gate never evaluated anything" — opposite
    // conclusions from identical telemetry, which is the exact shape of defect
    // this gate was built to catch. `checked` is the denominator that tells
    // them apart, and `checked == 0` says plainly that nothing was judged.
    //
    // AT INFO, and that is the whole point of it. At `debug`, below a deployed
    // default of `info`, the denominator is never collected — and a readiness
    // report built on it reads every connector as "no evidence, do not flip",
    // permanently and identically to a connector that has genuinely never been
    // exercised. The one signal that exists to tell those two apart
    // cannot be logged below the level its consumers run at.
    logger.info({
      event: 'provenance_pass',
      dispatch,
      metric: 'provenance.checked',
      connector: args.connector,
      actionType: args.actionType,
      basis: args.verdict.basis,
      tenantId: args.tenantId,
      agentId: args.agentId,
      invocationId: args.invocationId,
    }, 'write names identifiers this run has read');
    return;
  }

  logger.warn({
    event: 'provenance_would_block',
    metric: 'provenance.would_block',
    dispatch,
    connector: args.connector,
    actionType: args.actionType,
    basis: args.verdict.basis,
    unseenCount: args.verdict.unseen.length,
    // The identifiers themselves, not just how many. A count says a write was
    // unprovenanced; the values say WHICH record it was about, which is the
    // difference between a metric somebody can act on and one they can only
    // watch. They are record ids the run already put on the wire, not secrets.
    unseen: args.verdict.unseen.slice(0, 10),
    mode: args.mode,
    tenantId: args.tenantId,
    agentId: args.agentId,
    invocationId: args.invocationId,
  }, 'write names an identifier this run has not read');
}

/** Test seam: the sets are process-global, so a test that seeds one would
 *  otherwise leak into the next. */
export function _resetProvenanceForTesting(): void {
  (getProvenanceStore() as { _reset?: () => void })._reset?.();
}

/** Test seam: how many ids one invocation is holding. */
export function _provenanceSizeForTesting(invocationId: string): number {
  return (getProvenanceStore() as { _size?: (id: string) => number })._size?.(invocationId) ?? 0;
}

/** A trigger payload contributes at most this many identifiers.
 *
 *  The seed goes in before the run's first read, and eviction is oldest-first,
 *  so an unbounded seed would be pushed out again by the reads that follow —
 *  harmless but pointless. The cap keeps a fat webhook envelope from consuming
 *  the invocation's whole budget before it has done anything. */
const MAX_SEED_IDS = 200;

/** How far into a trigger payload to walk, and how much of it to look at. */
const MAX_SEED_DEPTH = 8;
const MAX_SEED_NODES = 2_000;

/** Longer than this is prose, not an identity. */
const MAX_SEED_VALUE_LENGTH = 256;

/**
 * Seed an invocation from the payload its trigger handed it.
 *
 * The gate's premise is that a run should act only on records it has seen. A
 * run whose FIRST call is a write has usually seen the record perfectly well —
 * the platform put it in the trigger. A webhook naming the merge request, a
 * cron carrying the row, a poll event carrying the message: the identifier came
 * from the platform, which is stronger provenance than a read, not weaker.
 *
 * Without this the single most common legitimate shape is flagged on day one,
 * and a shadow metric that fires constantly on correct behaviour teaches
 * everyone to ignore it. That is the failure this exists to prevent, and it is
 * why seeding is a prerequisite for enforcing rather than a refinement of it.
 *
 * Seeded ids are UNTYPED. A trigger envelope carries no entity types and
 * guessing them from key names would be a fiction the check then relies on;
 * untyped is the honest strength and is what the untyped fallback is for.
 *
 * The walk takes every short scalar rather than trying to recognise ids by key
 * name. Key names vary per connector (`iid`, `ts`, `resourceName`, `number`),
 * a miss is silent, and the values here are trusted-origin by construction —
 * so the conservative direction is to take too many, not too few.
 */
export async function seedProvenanceFromTrigger(args: {
  tenantId?: string;
  invocationId: string | undefined;
  payload: unknown;
}): Promise<number> {
  if (!args.invocationId || args.payload == null) return 0;
  if (provenanceGateMode() === 'off') return 0;

  const facts = new Facts();
  let seeded = 0;
  let nodes = 0;

  const walk = (node: unknown, depth: number): void => {
    if (seeded >= MAX_SEED_IDS || nodes >= MAX_SEED_NODES || depth > MAX_SEED_DEPTH) return;
    nodes++;

    if (typeof node === 'number' && Number.isFinite(node)) {
      facts.id(undefined, String(node));
      seeded++;
      return;
    }
    if (typeof node === 'string') {
      if (node.length > 0 && node.length <= MAX_SEED_VALUE_LENGTH) {
        facts.id(undefined, node);
        seeded++;
      }
      return;
    }
    if (Array.isArray(node)) {
      for (const item of node) walk(item, depth + 1);
      return;
    }
    if (node && typeof node === 'object') {
      for (const value of Object.values(node as Record<string, unknown>)) {
        walk(value, depth + 1);
      }
    }
  };

  walk(args.payload, 0);
  if (seeded > 0) {
    const ok = await getProvenanceStore().append(args.tenantId, args.invocationId, facts.rows);
    if (!ok) return 0;
    logger.debug({
      event: 'provenance_seeded',
      metric: 'provenance.seeded',
      invocationId: args.invocationId,
      seeded,
    }, 'seeded write-provenance from the trigger payload');
  }
  return seeded;
}
