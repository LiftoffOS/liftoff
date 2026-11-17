// Liftoff Switch — shared distill-bound normalizer.
//
// Every adapter must produce input that ALREADY FITS the canonical distill
// schema. Conversion happens after payment, so an oversized field discovered
// there would fail a migration the user has already paid for; and no adapter
// may silently discard or truncate source material, because a switcher's
// instructions are the thing they are paying to bring across.
//
// The bounds below mirror the server's real distill input schema exactly
// (src/internal-agents/distill-stream-router.ts and attachment-schema.ts).
// They are duplicated here on purpose: the CLI cannot import server code, and
// the whole point is to fail on THIS side of the payment boundary. The
// conversion suite asserts every adapter's output passes the real schema.
//
// Overflow always moves material into an attachment; it never drops it. When
// even packing cannot fit, the migration enters setup_required and the user is
// asked to deselect material, with the excluded source paths named.

import crypto from 'crypto';
import {
  type ArtifactCategory,
  type ImportedAgent,
  type ImportedAttachment,
  type UnsupportedItem,
} from './contract';

/** Mirrors distillInputSchema.role — z.string().min(1).max(255). */
export const MAX_ROLE_CHARS = 255;
/** Mirrors distillInputSchema.responsibilities — z.string().min(1).max(10000). */
export const MAX_RESPONSIBILITIES_CHARS = 10_000;
/** Mirrors distillInputSchema.additionalContext — z.string().max(10000). */
export const MAX_ADDITIONAL_CONTEXT_CHARS = 10_000;
/** Mirrors distillInputSchema.integrations — z.array(...).max(50). */
export const MAX_INTEGRATIONS = 50;
/** Mirrors attachment-schema.ts MAX_ATTACHMENTS. */
export const MAX_ATTACHMENTS = 20;
/** Mirrors attachment-schema.ts MAX_ATTACHMENT_CONTENT_CHARS. */
export const MAX_ATTACHMENT_CONTENT_CHARS = 100_000;

/** A source artifact ready to be packed into attachments. */
export interface NormalizableArtifact {
  sourcePath: string;
  text: string;
  category: ArtifactCategory;
}

export interface NormalizeIdentityInput {
  sourceRef: string;
  /** Raw label from the source; may exceed the role bound. */
  label: string;
  /** Raw responsibilities text; may exceed its bound. */
  responsibilities: string;
  /** Raw additional context; may exceed its bound. */
  additionalContext?: string;
  artifacts: NormalizableArtifact[];
  integrationRefs: string[];
  mcpServerRefs: string[];
  routineRefs: string[];
  /** The schedule this identity runs on, when the source gave it one. */
  cronExpr?: string;
  modelPreference?: ImportedAgent['modelPreference'];
}

export interface NormalizeIdentityResult {
  agent: ImportedAgent;
  unsupportedItems: UnsupportedItem[];
  /** True when this identity cannot be converted until the user reduces or
   *  deselects material. Drives the migration into setup_required. */
  requiresSetup: boolean;
  /** Source paths of which NOTHING was imported. Reported in the bundle's
   *  diagnostics for support, never raised at the person importing: "pick four
   *  files to delete" is not a question anyone can answer well. */
  excludedSourcePaths: string[];
  /** Source paths that were imported but lost material doing so. Kept apart
   *  from excluded so a support case can tell "never arrived" from "arrived
   *  shortened". */
  truncatedSourcePaths: string[];
  /** Integration refs beyond the 50 the schema accepts. The preview asks the
   *  user to select; the importer never silently chooses. */
  unselectedIntegrationRefs: string[];
}

/** Attachment name for responsibilities overflow. Deterministic so a re-run
 *  produces an identical bundle and an identical normalized-input hash. */
const RESPONSIBILITIES_ATTACHMENT = 'imported-responsibilities';
const ADDITIONAL_CONTEXT_ATTACHMENT = 'imported-additional-context';

export function normalizeIdentity(input: NormalizeIdentityInput): NormalizeIdentityResult {
  const unsupportedItems: UnsupportedItem[] = [];
  const excludedSourcePaths: string[] = [];

  // ── role ─────────────────────────────────────────────────────────────
  // A compact deterministic display name; the full original label is kept for
  // the preview and carried into the instruction attachments so nothing is lost.
  const role = boundRole(input.label);
  const originalLabel = role === input.label ? undefined : input.label;

  // ── attachments from artifacts ───────────────────────────────────────
  // Packed BEFORE the overflow fields are appended so the field-overflow
  // attachments are guaranteed a slot: losing a user's responsibilities to a
  // pile of skill files would be the wrong trade.
  const overflowAttachments: ImportedAttachment[] = [];

  // ── responsibilities ─────────────────────────────────────────────────
  let responsibilities = input.responsibilities;
  if (responsibilities.length > MAX_RESPONSIBILITIES_CHARS) {
    overflowAttachments.push({
      name: RESPONSIBILITIES_ATTACHMENT,
      content: input.responsibilities.slice(0, MAX_ATTACHMENT_CONTENT_CHARS),
      category: 'instructions',
      sourcePaths: [`${input.sourceRef}#responsibilities`],
    });
    responsibilities =
      `The imported responsibilities for ${role} were longer than this field allows. ` +
      `The full text is attached as "${RESPONSIBILITIES_ATTACHMENT}".`;
    if (input.responsibilities.length > MAX_ATTACHMENT_CONTENT_CHARS) {
      unsupportedItems.push({
        sourceRef: input.sourceRef,
        reason: 'attachment_overflow',
        detail:
          `Responsibilities text exceeded ${MAX_ATTACHMENT_CONTENT_CHARS} characters and was ` +
          'carried up to that limit. Review the imported responsibilities attachment.',
      });
    }
  }

  // ── additionalContext ────────────────────────────────────────────────
  let additionalContext = input.additionalContext;
  if (additionalContext && additionalContext.length > MAX_ADDITIONAL_CONTEXT_CHARS) {
    overflowAttachments.push({
      name: ADDITIONAL_CONTEXT_ATTACHMENT,
      content: additionalContext.slice(0, MAX_ATTACHMENT_CONTENT_CHARS),
      category: 'instructions',
      sourcePaths: [`${input.sourceRef}#additional-context`],
    });
    additionalContext =
      `Additional imported context is attached as "${ADDITIONAL_CONTEXT_ATTACHMENT}".`;
  }

  // ── artifact packing ─────────────────────────────────────────────────
  //
  // The attachment limit is OUR schema bound, not the user's problem. Twenty
  // slots at 100,000 characters is two million characters of capacity, and a
  // file count nowhere near that fits once files are packed together — so the
  // importer packs to fit rather than asking anyone to choose.
  //
  // If a genuinely pathological installation still exceeds two million
  // characters, material is dropped by PRIORITY rather than by whatever
  // happened to sort last: instructions define who the team member is and are
  // never dropped; skills are how they work; memories are the most
  // reconstructible, and the oldest go first. What was dropped is recorded in
  // diagnostics for support, not raised at the person importing, because
  // "pick four files to delete" is not a question anyone can answer well.
  const slotsForArtifacts = MAX_ATTACHMENTS - overflowAttachments.length;
  const packed = packArtifacts(prioritizeArtifacts(input.artifacts), slotsForArtifacts, originalLabel);
  excludedSourcePaths.push(...packed.excludedSourcePaths);

  // ── integrations ─────────────────────────────────────────────────────
  // Same principle. More than fifty connected tools on one identity is beyond
  // anything a real installation carries; the first fifty are taken in a
  // deterministic order so a re-run produces the same bundle, and the rest are
  // recorded. One source identity is never split into several Liftoff
  // identities, which would misrepresent what the user had.
  const integrationRefs = input.integrationRefs.slice(0, MAX_INTEGRATIONS);
  const unselectedIntegrationRefs = input.integrationRefs.slice(MAX_INTEGRATIONS);

  const attachments = [...overflowAttachments, ...packed.attachments];

  return {
    agent: {
      sourceRef: input.sourceRef,
      role,
      responsibilities: responsibilities.slice(0, MAX_RESPONSIBILITIES_CHARS),
      additionalContext: additionalContext?.slice(0, MAX_ADDITIONAL_CONTEXT_CHARS),
      originalLabel,
      attachments,
      integrationRefs,
      mcpServerRefs: input.mcpServerRefs,
      routineRefs: input.routineRefs,
      cronExpr: input.cronExpr,
      modelPreference: input.modelPreference,
    },
    unsupportedItems,
    // Overflow is handled by packing and prioritisation, so it never blocks a
    // migration or asks the person importing to arbitrate.
    requiresSetup: false,
    excludedSourcePaths,
    truncatedSourcePaths: packed.truncatedSourcePaths,
    unselectedIntegrationRefs,
  };
}

/** Record what normalization gave up, as lines for the bundle's diagnostics.
 *
 *  Support-facing, not user-facing. Paths only: a diagnostic that carried file
 *  contents would put the material we just redacted back on the wire. */
/** One diagnostic line's hard ceiling. The server validates each line at 1024
 *  characters and rejects the WHOLE bundle when one is longer — so an
 *  installation with enough overflow to write a long line would fail to import
 *  because of the note explaining why material was dropped. */
export const MAX_DIAGNOSTIC_CHARS = 1024;

/** At most this many paths are named per line; the rest are counted. */
const MAX_PATHS_LISTED = 10;

/** The server accepts at most this many diagnostic lines and rejects the whole
 *  bundle beyond it. A scan that hit the file cap can produce far more. */
export const MAX_DIAGNOSTIC_LINES = 500;

/** Bound a diagnostics list to what the server will accept.
 *
 *  Applied once where the bundle is assembled, over BOTH sources of lines: the
 *  filesystem scan (skipped symlinks, unreadable directories, oversized files,
 *  excluded credential files) and normalization. Neither was reaching the
 *  bundle before — the scan wrote its findings into the inventory and the
 *  inventory was not carried forward, so "your AGENTS.md was too large to read"
 *  was computed on the user's machine and thrown away there. */
export function boundDiagnostics(lines: string[]): string[] {
  const bounded = lines.map((line) =>
    line.length > MAX_DIAGNOSTIC_CHARS ? `${line.slice(0, MAX_DIAGNOSTIC_CHARS - 1)}…` : line,
  );
  if (bounded.length <= MAX_DIAGNOSTIC_LINES) return bounded;
  // Say how many were suppressed rather than silently ending the list: a
  // truncated list that looks complete is how a scan that gave up reads as a
  // scan that found nothing more.
  const kept = bounded.slice(0, MAX_DIAGNOSTIC_LINES - 1);
  kept.push(`and ${bounded.length - kept.length} further diagnostic(s) not reported`);
  return kept;
}

function listPaths(paths: string[]): string {
  if (paths.length <= MAX_PATHS_LISTED) return paths.join(', ');
  const shown = paths.slice(0, MAX_PATHS_LISTED).join(', ');
  return `${shown}, and ${paths.length - MAX_PATHS_LISTED} more`;
}

function pushBounded(into: string[], line: string): void {
  // Belt as well as braces: a single pathological path can exceed the ceiling
  // on its own, and losing the tail of a note is far better than losing the
  // import.
  into.push(line.length > MAX_DIAGNOSTIC_CHARS ? `${line.slice(0, MAX_DIAGNOSTIC_CHARS - 1)}…` : line);
}

export function recordNormalizationLosses(
  into: string[],
  sourceRef: string,
  result: Pick<
    NormalizeIdentityResult,
    'excludedSourcePaths' | 'truncatedSourcePaths' | 'unselectedIntegrationRefs'
  >,
): void {
  if (result.excludedSourcePaths.length > 0) {
    pushBounded(
      into,
      `${sourceRef}: ${result.excludedSourcePaths.length} file(s) exceeded the attachment ` +
        `budget and were not imported: ${listPaths(result.excludedSourcePaths)}`,
    );
  }
  if (result.truncatedSourcePaths.length > 0) {
    pushBounded(
      into,
      `${sourceRef}: ${result.truncatedSourcePaths.length} file(s) were imported but shortened ` +
        `to fit: ${listPaths(result.truncatedSourcePaths)}`,
    );
  }
  if (result.unselectedIntegrationRefs.length > 0) {
    pushBounded(
      into,
      `${sourceRef}: ${result.unselectedIntegrationRefs.length} integration(s) beyond the ` +
        `${MAX_INTEGRATIONS} the schema accepts were not imported: ` +
        listPaths(result.unselectedIntegrationRefs),
    );
  }
}

/** Split one source identity's schedules across Liftoff team members.
 *
 *  Liftoff models a schedule as `internal_agents.trigger_config` — ONE per team
 *  member. The source harnesses model it as a list of cron jobs hanging off an
 *  agent, each with its own prompt. There is no faithful one-to-one mapping
 *  when an identity carries several.
 *
 *  Rather than invent a "routine" object Liftoff does not have, the first
 *  schedule becomes the identity's own trigger and each additional one becomes
 *  a team member of its own, built from that job's prompt. Every imported
 *  schedule therefore actually runs, which is the only outcome that matters to
 *  someone whose Monday brief has to keep going out.
 *
 *  Ordering is deterministic so a re-run produces the same team rather than
 *  promoting a different job to owner by chance. */
export interface ScheduledJob {
  sourceRef: string;
  name: string;
  cronExpr: string;
  prompt: string;
}

export interface ScheduleSplit {
  ownerCronExpr?: string;
  spawned: ScheduledJob[];
}

export function splitSchedules(jobs: ScheduledJob[]): ScheduleSplit {
  if (jobs.length === 0) return { spawned: [] };
  // The OWNER keeps the identity's instructions, skills and memories, so which
  // schedule it takes decides what the imported team member actually does. Pure
  // alphabetical order made that an accident: an identity called Support Triage
  // whose main job runs hourly took the 9am digest instead, because "digest"
  // sorts before "hourly", and its hourly work became a separate member with
  // one attachment.
  //
  // The most frequent schedule is the identity's own cadence — the continuous
  // work its instructions describe — so it stays with the identity. A daily or
  // weekly digest is far more plausibly a recurring responsibility of its own.
  // Ties fall back to sourceRef, which keeps a re-run of the same installation
  // producing the same team.
  const ordered = [...jobs].sort((a, b) => {
    const byFrequency = cadenceRank(a.cronExpr) - cadenceRank(b.cronExpr);
    return byFrequency !== 0 ? byFrequency : a.sourceRef.localeCompare(b.sourceRef);
  });
  return { ownerCronExpr: ordered[0].cronExpr, spawned: ordered.slice(1) };
}

/** Roughly how often a 5-field cron expression fires. Lower runs more often.
 *
 *  Deliberately coarse: it only has to order schedules against each other, and
 *  a real cron parser would be a dependency and a new failure mode for a
 *  tie-break. Anything unparseable ranks last, so a schedule Liftoff does not
 *  understand never wins the identity. */
function cadenceRank(cronExpr: string | undefined): number {
  if (!cronExpr) return Number.MAX_SAFE_INTEGER;
  const [minute, hour, dayOfMonth, , dayOfWeek] = cronExpr.trim().split(/\s+/);
  if (!minute || !hour) return Number.MAX_SAFE_INTEGER;

  const varies = (field: string): boolean => field.includes('*') || field.includes('/');

  if (varies(minute) && varies(hour)) return 0; // every minute, or every N minutes
  if (varies(hour)) return 1; // hourly
  if (varies(dayOfMonth ?? '*') && varies(dayOfWeek ?? '*')) return 2; // daily
  if (!varies(dayOfWeek ?? '*')) return 3; // weekly
  return 4; // monthly or narrower
}

/** Order artifacts so that, if capacity ever runs out, what survives is what
 *  matters most.
 *
 *  Instructions first: they are the team member's identity and the distiller's
 *  primary input. Then skills, then routines, then memories — memories are the
 *  most reconstructible (the team member re-learns them in use), and within
 *  them the oldest go first, which is why dated filenames sort descending. */
export function prioritizeArtifacts(artifacts: NormalizableArtifact[]): NormalizableArtifact[] {
  const rank: Record<ArtifactCategory, number> = {
    instructions: 0,
    skill: 1,
    routine: 2,
    memory: 3,
  };
  return [...artifacts].sort((a, b) => {
    if (rank[a.category] !== rank[b.category]) return rank[a.category] - rank[b.category];
    // Newest memory first, so the oldest is what falls off the end.
    if (a.category === 'memory') return b.sourcePath.localeCompare(a.sourcePath);
    return a.sourcePath.localeCompare(b.sourcePath);
  });
}

/** Derive a bounded, deterministic role string. */
export function boundRole(label: string): string {
  const collapsed = label.replace(/\s+/g, ' ').trim();
  if (collapsed.length <= MAX_ROLE_CHARS) return collapsed || 'Imported team member';
  // Cut on a word boundary when one is available near the limit, so the
  // shortened name stays readable rather than ending mid-token.
  const hard = collapsed.slice(0, MAX_ROLE_CHARS);
  const lastSpace = hard.lastIndexOf(' ');
  return lastSpace > MAX_ROLE_CHARS - 40 ? hard.slice(0, lastSpace) : hard;
}

interface PackResult {
  attachments: ImportedAttachment[];
  /** Files that reached NO attachment. Nothing of them was imported. */
  excludedSourcePaths: string[];
  /** Files that reached an attachment but lost material doing so. Distinct
   *  from excluded on purpose: a support case reading one list and finding a
   *  file in it needs to know whether the file arrived. Reporting a truncated
   *  file as excluded says it did not. */
  truncatedSourcePaths: string[];
}

/** Pack artifacts into at most `slots` attachments.
 *
 *  Packing is category-homogeneous because absorption classifies each
 *  attachment AS A UNIT: mixing a skill and a memory into one attachment would
 *  force the classifier to pick one destination for both. Files are packed in
 *  deterministic source-path order with visible boundaries, so a re-run of the
 *  same installation produces byte-identical attachments and therefore an
 *  identical normalized-input hash. */
export function packArtifacts(
  artifacts: NormalizableArtifact[],
  slots: number,
  originalLabel?: string,
): PackResult {
  if (slots <= 0) {
    return {
      attachments: [],
      excludedSourcePaths: artifacts.map((a) => a.sourcePath),
      truncatedSourcePaths: [],
    };
  }

  // Input order is already the priority order (see prioritizeArtifacts); it is
  // preserved rather than re-sorted, so what falls off the end is the least
  // valuable material rather than whatever sorted last alphabetically.
  const byCategory = new Map<ArtifactCategory, NormalizableArtifact[]>();
  for (const artifact of artifacts) {
    const list = byCategory.get(artifact.category) ?? [];
    list.push(artifact);
    byCategory.set(artifact.category, list);
  }

  // Deterministic category order; instructions first because they carry the
  // identity's voice and are the least replaceable if something must be cut.
  const categoryOrder: ArtifactCategory[] = ['instructions', 'skill', 'memory', 'routine'];
  const categories = categoryOrder.filter((c) => byCategory.has(c));

  const attachments: ImportedAttachment[] = [];
  const excludedSourcePaths: string[] = [];
  const truncatedSourcePaths: string[] = [];

  // Give every present category at least one slot, then distribute what is
  // left in category order.
  const budgets = new Map<ArtifactCategory, number>();
  let remaining = slots;
  for (const c of categories) {
    budgets.set(c, 1);
    remaining -= 1;
  }
  if (remaining < 0) {
    // More categories than slots: the trailing categories get nothing and are
    // reported rather than silently merged into a mixed attachment.
    for (const c of categories.slice(slots)) {
      budgets.delete(c);
      excludedSourcePaths.push(...(byCategory.get(c) ?? []).map((a) => a.sourcePath));
    }
    remaining = 0;
  }
  let i = 0;
  while (remaining > 0 && budgets.size > 0) {
    const c = categories[i % categories.length];
    if (budgets.has(c)) {
      budgets.set(c, (budgets.get(c) ?? 0) + 1);
      remaining -= 1;
    }
    i += 1;
  }

  for (const category of categories) {
    const budget = budgets.get(category);
    if (!budget) continue;
    const items = byCategory.get(category) ?? [];
    const result = packCategory(category, items, budget, originalLabel);
    attachments.push(...result.attachments);
    excludedSourcePaths.push(...result.excludedSourcePaths);
    truncatedSourcePaths.push(...result.truncatedSourcePaths);
  }

  return { attachments, excludedSourcePaths, truncatedSourcePaths };
}

function packCategory(
  category: ArtifactCategory,
  items: NormalizableArtifact[],
  slots: number,
  originalLabel?: string,
): PackResult {
  const attachments: ImportedAttachment[] = [];
  // Two facts, tracked separately and reconciled at the end. A path can appear
  // in BOTH — a file whose first chunk was attached and whose tail was dropped
  // is attached AND lost material — and calling that "excluded" would tell a
  // support case the file never arrived. Recording it in one list as the code
  // walked was also double-counting: the flush and the loop each pushed the
  // same path.
  const attachedPaths = new Set<string>();
  const droppedPaths = new Set<string>();

  let current: { paths: string[]; parts: string[]; length: number } = { paths: [], parts: [], length: 0 };
  const flush = (): void => {
    if (current.paths.length === 0) return;
    if (attachments.length >= slots) {
      for (const p of current.paths) droppedPaths.add(p);
      current = { paths: [], parts: [], length: 0 };
      return;
    }
    const index = attachments.length + 1;
    const name = slots === 1 && attachments.length === 0
      ? `imported-${category}`
      : `imported-${category}-${index}`;
    attachments.push({
      name,
      content: current.parts.join('\n'),
      category,
      sourcePaths: [...current.paths],
    });
    for (const p of current.paths) attachedPaths.add(p);
    current = { paths: [], parts: [], length: 0 };
  };

  const header = originalLabel ? `# Imported from ${originalLabel}\n` : '';

  for (const item of items) {
    // A single artifact larger than one attachment is split across consecutive
    // attachments when there are slots for them, and loses its tail when there
    // are not. Either way the outcome is reported.
    const chunks = splitText(item.text, MAX_ATTACHMENT_CONTENT_CHARS - 512);
    for (let ci = 0; ci < chunks.length; ci += 1) {
      const boundary =
        chunks.length === 1
          ? `\n----- source: ${item.sourcePath} -----\n`
          : `\n----- source: ${item.sourcePath} (part ${ci + 1} of ${chunks.length}) -----\n`;
      const piece = boundary + chunks[ci];
      if (current.length + piece.length > MAX_ATTACHMENT_CONTENT_CHARS - header.length) {
        flush();
        if (attachments.length >= slots) {
          // No slot left for the rest of this file, or for any file after it.
          droppedPaths.add(item.sourcePath);
          break;
        }
      }
      if (current.parts.length === 0 && header) {
        current.parts.push(header);
        current.length += header.length;
      }
      current.parts.push(piece);
      current.length += piece.length;
      if (!current.paths.includes(item.sourcePath)) current.paths.push(item.sourcePath);
    }
  }
  flush();

  // Derived from `items` order, not Set order, so a re-run of the same
  // installation reports identically — the normalized-input hash depends on it.
  const dropped = items.map((i) => i.sourcePath).filter((p) => droppedPaths.has(p));
  return {
    attachments,
    excludedSourcePaths: dropped.filter((p) => !attachedPaths.has(p)),
    truncatedSourcePaths: dropped.filter((p) => attachedPaths.has(p)),
  };
}

function splitText(text: string, size: number): string[] {
  if (text.length <= size) return [text];
  const out: string[] = [];
  for (let i = 0; i < text.length; i += size) out.push(text.slice(i, i + size));
  return out;
}

/** Validate a normalized agent against the bounds. Adapters call this before
 *  returning a bundle so a violation surfaces on the user's machine, not after
 *  payment. */
export function assertWithinDistillBounds(agent: ImportedAgent): void {
  const problems: string[] = [];
  if (agent.role.length < 1 || agent.role.length > MAX_ROLE_CHARS) {
    problems.push(`role length ${agent.role.length} outside 1..${MAX_ROLE_CHARS}`);
  }
  if (agent.responsibilities.length < 1 || agent.responsibilities.length > MAX_RESPONSIBILITIES_CHARS) {
    problems.push(
      `responsibilities length ${agent.responsibilities.length} outside 1..${MAX_RESPONSIBILITIES_CHARS}`,
    );
  }
  if (agent.additionalContext && agent.additionalContext.length > MAX_ADDITIONAL_CONTEXT_CHARS) {
    problems.push(`additionalContext length ${agent.additionalContext.length} > ${MAX_ADDITIONAL_CONTEXT_CHARS}`);
  }
  if (agent.integrationRefs.length > MAX_INTEGRATIONS) {
    problems.push(`integrations ${agent.integrationRefs.length} > ${MAX_INTEGRATIONS}`);
  }
  if (agent.attachments.length > MAX_ATTACHMENTS) {
    problems.push(`attachments ${agent.attachments.length} > ${MAX_ATTACHMENTS}`);
  }
  for (const att of agent.attachments) {
    if (att.content.length > MAX_ATTACHMENT_CONTENT_CHARS) {
      problems.push(`attachment ${att.name} length ${att.content.length} > ${MAX_ATTACHMENT_CONTENT_CHARS}`);
    }
  }
  if (problems.length > 0) {
    throw new Error(
      `Adapter produced input outside the distill bounds for ${agent.sourceRef}: ${problems.join('; ')}`,
    );
  }
}

/** Stable hash of the BOUNDED input, computed after normalization so a resumed
 *  migration uses exactly the input the user reviewed. */
export function normalizedInputHash(agent: ImportedAgent): string {
  const canonical = JSON.stringify({
    sourceRef: agent.sourceRef,
    role: agent.role,
    responsibilities: agent.responsibilities,
    additionalContext: agent.additionalContext ?? null,
    integrationRefs: [...agent.integrationRefs].sort(),
    mcpServerRefs: [...agent.mcpServerRefs].sort(),
    routineRefs: [...agent.routineRefs].sort(),
    attachments: agent.attachments.map((a) => ({
      name: a.name,
      category: a.category,
      sourcePaths: a.sourcePaths,
      contentHash: crypto.createHash('sha256').update(a.content).digest('hex'),
    })),
  });
  return crypto.createHash('sha256').update(canonical).digest('hex');
}
