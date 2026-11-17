// Promote a template's bold sub-workflow headers into `flows[]` stubs, its
// clock lines into `companionCrons`, and its edge-case bullets into eval
// skeletons.
//
// MECHANICAL, and refused until reviewed. Around thirty templates already
// write their decomposition as bold headers inside `## Workflows` ("Payment
// runs (weekly, every Thursday):", "Whenever a new document arrives:"), and
// lifting one costs nothing but moving the text. What it does NOT do is author
// the retrieval keys: `useWhen` and `notNeededFor` are left EMPTY on every stub,
// so the validator refuses the template until a person has written the
// boundary. A stub that passed validation would be a flow with no exclusion,
// competing with every sibling for the same top-K slot — the exact defect the
// keys exist to prevent. Same for an eval skeleton: `turns` is empty and
// `expected` asserts nothing, and the validator refuses both.
//
// FAILS ON A COLLISION rather than de-duplicating. A flow's id is its identity
// — the skill id it becomes, the key its metrics accrue under, what survives a
// redistill — and heading-derived slugs collide. Two headers that slug to one
// id are reported and nothing is written.
//
// CLOCKS. A header carrying a clock ("weekly, every Monday") is resolved
// against the template's own triggers: the primary cron, then the declared
// `companionCrons` (the flow's `companionCron` then names that label). A clock
// the script CAN decide (a weekday, daily, weekdays, first weekday of the
// month) with no declared companion becomes a companion stub; one it cannot
// ("quarterly", "weekly" with no day) is written onto the flow as the raw
// phrase, which names no declared label and so the validator refuses it —
// what the script cannot decide, a person decides.
//
//   npx ts-node scripts/promote-template-flows.ts nda-analyst spa-analyst --dry-run
//   npx ts-node scripts/promote-template-flows.ts nda-analyst spa-analyst --write
//
// Run once per family; author the stubs; commit the family.

import { readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import * as yaml from 'js-yaml';

export const CATALOG_DIR = join(__dirname, '..', 'agent-templates', 'catalog');

// ── What the lifter reads ─────────────────────────────────────────────────

export interface LiftableTemplate {
  id: string;
  responsibilities: string;
  additionalContext: string;
  sections?: Record<string, string | undefined>;
  flows?: Array<{ id: string }>;
  evals?: Array<{ id: string }>;
  defaultTriggerConfig: {
    type: string;
    cronExpr?: string;
    timezone?: string;
    companionCrons?: Array<{ label: string; cronExpr: string; timezone?: string; objective?: string }>;
  };
}

export interface FlowStub {
  id: string;
  name: string;
  /** Empty on purpose. The validator refuses it until a person writes it. */
  useWhen: string;
  /** Empty on purpose, for the same reason. */
  notNeededFor: string;
  body: string;
  /** The label of the declared companion this flow's clock resolved to, or the
   *  raw clock phrase when the script could not decide — which the validator
   *  refuses, because it names no declared label. */
  companionCron?: string;
  /** Where the clock resolved, for the report. */
  clock?: ClockResolution;
}

export interface CompanionStub {
  label: string;
  cronExpr: string;
  objective: string;
}

export interface EvalStub {
  id: string;
  /** The edge-case bullet this case is for, carried as a YAML comment. */
  source: string;
}

export type ClockResolution =
  | { kind: 'primary'; cronExpr: string }
  | { kind: 'companion'; label: string }
  | { kind: 'stub'; label: string; cronExpr: string }
  | { kind: 'undecidable'; phrase: string };

export interface Lift {
  templateId: string;
  flows: FlowStub[];
  companionStubs: CompanionStub[];
  evals: EvalStub[];
  /** Headers found but not lifted, with why. */
  skipped: string[];
}

export class FlowIdCollisionError extends Error {
  constructor(public readonly templateId: string, public readonly id: string, public readonly headers: string[]) {
    super(
      `${templateId}: flow id "${id}" is produced by more than one header — ${headers.map((h) => JSON.stringify(h)).join(' and ')}. `
      + 'A flow id is its stable identity; nothing here is written until one of them is renamed.',
    );
  }
}

// ── Prose ─────────────────────────────────────────────────────────────────

/** One `## Heading` section's body out of the prose. Split on headings at the
 *  start of a line, the way `split-template-sections.ts` does, so the two read
 *  the same section boundaries. */
function sectionOf(markdown: string, heading: string): string {
  const parts = markdown.split(/^(## .+)$/m);
  for (let i = 1; i < parts.length; i += 2) {
    if (parts[i].trim() === heading) return (parts[i + 1] ?? '').trim();
  }
  return '';
}

/** The `## Workflows` body: from `sections` when split, else from the prose. */
export function workflowsBody(t: LiftableTemplate): string {
  return t.sections?.['## Workflows'] ?? sectionOf(t.responsibilities, '## Workflows');
}

/** The `## Edge cases` body, the same way. */
export function edgeCasesBody(t: LiftableTemplate): string {
  return t.sections?.['## Edge cases'] ?? sectionOf(t.additionalContext, '## Edge cases');
}

/** A sub-workflow header is a whole bold line ending in a colon. An emphasised
 *  sentence ("**Your first run sends nothing. Report only.**") is not a header
 *  and stays in the body it sits in. */
const HEADER = /^\s*\*\*(.+?):\*\*\s*$/;

interface HeaderBlock { header: string; body: string }

export function splitHeaders(workflows: string): { preamble: string; blocks: HeaderBlock[] } {
  const lines = workflows.split('\n');
  const blocks: HeaderBlock[] = [];
  const preamble: string[] = [];
  let current: { header: string; lines: string[] } | null = null;
  for (const line of lines) {
    const m = HEADER.exec(line);
    if (m) {
      if (current) blocks.push({ header: current.header, body: current.lines.join('\n').trim() });
      current = { header: m[1].trim(), lines: [] };
      continue;
    }
    if (current) current.lines.push(line);
    else preamble.push(line);
  }
  if (current) blocks.push({ header: current.header, body: current.lines.join('\n').trim() });
  return { preamble: preamble.join('\n').trim(), blocks };
}

/** A kebab id from a header: placeholders, parentheticals and code spans out,
 *  the first eight words in. Deterministic, so the same header always names
 *  the same flow. */
export function slugFor(text: string, maxWords = 8): string {
  const cleaned = text
    .replace(/\{\{[^}]*\}\}/g, ' ')
    .replace(/\([^)]*\)/g, ' ')
    .replace(/`[^`]*`/g, ' ')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return cleaned.split('-').filter(Boolean).slice(0, maxWords).join('-');
}

// ── Clocks ────────────────────────────────────────────────────────────────

export type ClockShape =
  | { kind: 'weekly'; dow: number }
  | { kind: 'daily' }
  | { kind: 'weekdays' }
  | { kind: 'monthly_first_dow'; dow: number }
  | { kind: 'undecidable'; phrase: string };

const DAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

/** The clock a header carries, if any. Only the shapes cron can state without
 *  a guess are decided; a cadence with no day is not. */
export function clockIn(header: string): ClockShape | null {
  const h = header.toLowerCase();
  const first = /first (sunday|monday|tuesday|wednesday|thursday|friday|saturday) of (each|every|the) month/.exec(h);
  if (first) return { kind: 'monthly_first_dow', dow: DAYS.indexOf(first[1]) };
  const day = /\b(?:every|each|on) (sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b/.exec(h);
  if (day) return { kind: 'weekly', dow: DAYS.indexOf(day[1]) };
  if (/\bevery weekday\b/.test(h)) return { kind: 'weekdays' };
  if (/\bdaily\b|\bevery day\b|\beach day\b|\bend of each day\b|\bevery morning\b|\beach morning\b/.test(h)) return { kind: 'daily' };
  const cadence = /\b(weekly|monthly|quarterly|every week|each week|every month|each month|every quarter|each quarter|every hour|hourly)\b/.exec(h);
  if (cadence) return { kind: 'undecidable', phrase: cadence[1] };
  return null;
}

export function cronFor(shape: ClockShape): string | null {
  switch (shape.kind) {
    case 'weekly': return `0 9 * * ${shape.dow}`;
    case 'daily': return '0 9 * * *';
    case 'weekdays': return '0 9 * * 1-5';
    case 'monthly_first_dow': return `0 9 1-7 * ${shape.dow}`;
    case 'undecidable': return null;
  }
}

/** The shape of a declared cron, read back so a header's clock can be matched
 *  against it on what matters (the day), not the hour. */
export function shapeOf(cronExpr: string): ClockShape | null {
  const f = cronExpr.trim().split(/\s+/);
  if (f.length !== 5) return null;
  const [, , dom, , dow] = f;
  if (dom === '1-7' && /^[0-6]$/.test(dow)) return { kind: 'monthly_first_dow', dow: Number(dow) };
  if (dom === '*' && /^[0-6]$/.test(dow)) return { kind: 'weekly', dow: Number(dow) };
  if (dom === '*' && dow === '1-5') return { kind: 'weekdays' };
  if (dom === '*' && dow === '*') return { kind: 'daily' };
  return null;
}

function sameShape(a: ClockShape | null, b: ClockShape | null): boolean {
  if (!a || !b || a.kind !== b.kind) return false;
  if (a.kind === 'weekly' && b.kind === 'weekly') return a.dow === b.dow;
  if (a.kind === 'monthly_first_dow' && b.kind === 'monthly_first_dow') return a.dow === b.dow;
  return true;
}

/** Companion labels are ≤32 chars of lower kebab (validator). */
function labelFor(flowId: string, taken: Set<string>): string {
  let base = flowId.slice(0, 32).replace(/-+$/, '');
  if (!/^[a-z]/.test(base)) base = `flow-${base}`.slice(0, 32).replace(/-+$/, '');
  let label = base;
  let n = 2;
  while (taken.has(label)) {
    const suffix = `-${n++}`;
    label = `${base.slice(0, 32 - suffix.length)}${suffix}`;
  }
  taken.add(label);
  return label;
}

// ── The lift ──────────────────────────────────────────────────────────────

export function liftTemplate(t: LiftableTemplate): Lift {
  const { blocks } = splitHeaders(workflowsBody(t));
  const skipped: string[] = [];
  const flows: FlowStub[] = [];
  const byId = new Map<string, string[]>();

  for (const b of blocks) {
    if (!b.body) {
      skipped.push(`"${b.header}": header with no steps under it`);
      continue;
    }
    const id = slugFor(b.header);
    if (!id) {
      skipped.push(`"${b.header}": header slugs to nothing`);
      continue;
    }
    byId.set(id, [...(byId.get(id) ?? []), b.header]);
    flows.push({ id, name: b.header, useWhen: '', notNeededFor: '', body: b.body });
  }
  for (const [id, headers] of byId) {
    if (headers.length > 1) throw new FlowIdCollisionError(t.id, id, headers);
  }
  // A flow the template already authored under this id is not re-lifted.
  const existing = new Set((t.flows ?? []).map((f) => f.id));
  const fresh = flows.filter((f) => !existing.has(f.id));

  // Clocks.
  const trigger = t.defaultTriggerConfig;
  const declared = trigger.companionCrons ?? [];
  const taken = new Set(declared.map((c) => c.label));
  const companionStubs: CompanionStub[] = [];
  const primaryShape = trigger.type === 'cron' && trigger.cronExpr ? shapeOf(trigger.cronExpr) : null;
  for (const flow of fresh) {
    const clock = clockIn(flow.name);
    if (!clock) continue;
    if (clock.kind === 'undecidable') {
      flow.companionCron = clock.phrase;
      flow.clock = { kind: 'undecidable', phrase: clock.phrase };
      continue;
    }
    if (primaryShape && sameShape(primaryShape, clock)) {
      // The clock IS the primary trigger; nothing to promote, and a companion
      // for it would fire the same work twice.
      flow.clock = { kind: 'primary', cronExpr: trigger.cronExpr! };
      continue;
    }
    const match = declared.find((c) => sameShape(shapeOf(c.cronExpr), clock));
    if (match) {
      flow.companionCron = match.label;
      flow.clock = { kind: 'companion', label: match.label };
      continue;
    }
    const cronExpr = cronFor(clock)!;
    const label = labelFor(flow.id, taken);
    companionStubs.push({
      label,
      cronExpr,
      // What the run does, as the header and its steps say it — reviewed with
      // the rest of the stub.
      objective: `${flow.name.replace(/\s*\([^)]*\)\s*/g, ' ').trim()}: ${flow.body.replace(/\s+/g, ' ')}`.slice(0, 2000),
    });
    flow.companionCron = label;
    flow.clock = { kind: 'stub', label, cronExpr };
  }

  // Eval skeletons, one per edge-case bullet.
  const existingEvals = new Set((t.evals ?? []).map((e) => e.id));
  const evals: EvalStub[] = [];
  const evalIds = new Map<string, string[]>();
  for (const line of edgeCasesBody(t).split('\n')) {
    const m = /^\s*[-*]\s+(.+?)\s*$/.exec(line);
    if (!m) continue;
    const bullet = m[1];
    // The first eight words of the WHOLE bullet, not its head: two edge cases
    // regularly share a head ("No enrichment connector connected: ...") and
    // differ in what follows, and a head-only id would collide where the cases
    // genuinely differ.
    const id = slugFor(bullet);
    if (!id || existingEvals.has(id)) continue;
    evalIds.set(id, [...(evalIds.get(id) ?? []), bullet]);
    evals.push({ id, source: bullet });
  }
  for (const [id, sources] of evalIds) {
    if (sources.length > 1) throw new FlowIdCollisionError(t.id, `(eval) ${id}`, sources);
  }

  return { templateId: t.id, flows: fresh, companionStubs, evals, skipped };
}

/** Whether the promoter has anything to lift from a template: at least one
 *  sub-workflow header with steps under it. What the flows ratchet reads. */
export function canLiftFlows(t: LiftableTemplate): boolean {
  return splitHeaders(workflowsBody(t)).blocks.some((b) => b.body.length > 0);
}

// ── Writing the YAML ──────────────────────────────────────────────────────

/** Written by insertion, never by re-serialising the whole document: a full
 *  round-trip reflows every block scalar and the diff becomes unreadable, which
 *  for a hand-maintained catalog is the difference between a review and a
 *  rubber stamp. Same rule `split-template-sections.ts` follows. */
export function applyLift(raw: string, lift: Lift): string {
  let out = raw;

  if (lift.flows.length > 0) {
    const block = yaml.dump({
      flows: lift.flows.map((f) => ({
        id: f.id, name: f.name, useWhen: f.useWhen, notNeededFor: f.notNeededFor, body: f.body,
        ...(f.companionCron ? { companionCron: f.companionCron } : {}),
      })),
    }, { lineWidth: -1, noRefs: true, indent: 2 });
    out = insertBeforeSections(out, `${block}`, lift.templateId);
  }

  if (lift.evals.length > 0) {
    const lines = ['evals:'];
    for (const e of lift.evals) {
      lines.push(`  # Edge case: ${e.source.replace(/\n/g, ' ')}`);
      lines.push(`  - id: ${e.id}`);
      lines.push('    turns: []');
      lines.push('    expected: {}');
    }
    out = insertBeforeSections(out, `${lines.join('\n')}\n`, lift.templateId);
  }

  if (lift.companionStubs.length > 0) {
    const entries = lift.companionStubs.map((c) =>
      `    - label: ${c.label}\n      cronExpr: ${JSON.stringify(c.cronExpr)}\n      objective: ${JSON.stringify(c.objective)}`).join('\n');
    if (/^ {2}companionCrons:\s*$/m.test(out)) {
      out = out.replace(/^( {2}companionCrons:\s*)$/m, `$1\n${entries}`);
    } else {
      // At the end of the defaultTriggerConfig block: before the next
      // top-level key, or the end of the file.
      const start = out.search(/^defaultTriggerConfig:/m);
      if (start === -1) throw new Error(`${lift.templateId}: no defaultTriggerConfig to add companionCrons to`);
      const rest = out.slice(start);
      // The block ends where the next top-level key begins: a line starting
      // with a letter, after this one.
      const nextTop = rest.search(/\n(?=[a-zA-Z])/);
      const end = nextTop === -1 ? out.length : start + nextTop;
      const blockText = out.slice(start, end).replace(/\s+$/, '');
      const after = out.slice(end);
      out = `${out.slice(0, start)}${blockText}\n  companionCrons:\n${entries}${after.startsWith('\n') ? after : `\n${after}`}`;
    }
  }
  return out;
}

function insertBeforeSections(raw: string, block: string, templateId: string): string {
  const anchor = /^sections:/m.exec(raw);
  if (!anchor) throw new Error(`${templateId}: no sections: anchor to insert before — split the template first`);
  return `${raw.slice(0, anchor.index)}${block}\n${raw.slice(anchor.index)}`;
}

// ── The run ───────────────────────────────────────────────────────────────

export function loadCatalogTemplate(id: string): { raw: string; template: LiftableTemplate; path: string } {
  const path = join(CATALOG_DIR, `${id}.yaml`);
  const raw = readFileSync(path, 'utf8');
  return { raw, template: yaml.load(raw) as LiftableTemplate, path };
}

export function describe(lift: Lift): string {
  const lines = [`${lift.templateId}: ${lift.flows.length} flow stub(s), ${lift.evals.length} eval skeleton(s), ${lift.companionStubs.length} companion stub(s)`];
  for (const f of lift.flows) {
    const clock = f.clock
      ? f.clock.kind === 'primary' ? ' [clock = primary trigger]'
        : f.clock.kind === 'companion' ? ` [clock → companion ${f.clock.label}]`
          : f.clock.kind === 'stub' ? ` [clock → NEW companion ${f.clock.label} ${f.clock.cronExpr}]`
            : ` [clock "${f.clock.phrase}" UNDECIDABLE — the validator will refuse until a person decides]`
      : '';
    lines.push(`  flow ${f.id}${clock}`);
  }
  for (const e of lift.evals) lines.push(`  eval ${e.id}`);
  for (const s of lift.skipped) lines.push(`  skipped ${s}`);
  return lines.join('\n');
}

export function run(ids: string[], write: boolean): void {
  if (ids.length === 0) throw new Error('Name at least one template id.');
  const lifts = ids.map((id) => {
    const { raw, template, path } = loadCatalogTemplate(id);
    return { raw, path, lift: liftTemplate(template) };
  });
  for (const { raw, path, lift } of lifts) {
    console.log(describe(lift));
    if (!write) continue;
    if (lift.flows.length === 0 && lift.evals.length === 0 && lift.companionStubs.length === 0) continue;
    writeFileSync(path, applyLift(raw, lift), 'utf8');
  }
  if (!write) {
    console.log('\nDry run. Re-run with --write to apply, then author useWhen / notNeededFor and the eval cases before the template loads again.');
  }
}
