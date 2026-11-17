// Deterministic argument-validity critic — scores each tool call's arguments
// against the tool's captured input_schema. These are Arcade's critic primitives
// (Binary type/enum, Numeric range, Datetime/format) validating against the
// SCHEMA rather than authored literals — the reference-free way to grade args
// for arbitrary user agents. Part of the Trajectory & efficiency (deterministic)
// tier: emits a numeric score + advisory warn/info findings, never gates.
//
// PII boundary ("only evaluated results leave the tenant"): findings carry field
// NAMES and check outcomes only — never raw argument values.

import type { Finding, ReconstructedRun } from '../../reconstruct/trace-model';
import { collectToolUses, type ToolUse } from '../trajectory-util';
import { designedInputSchemas } from '../../toolset';

/** Below this per-call validity score, a warn finding is emitted. SINGLE
 *  threshold (no separate warn band → no unreachable state, unlike Arcade's
 *  shipped default). Env-tunable; default 0.7 matches the efficiency alert. */
export const ARG_FAIL_THRESHOLD = Number(process.env.DIAGNOSTICS_ARG_FAIL_THRESHOLD ?? '0.7');

type JsonSchema = Record<string, unknown>;

export type CheckKind = 'required' | 'type' | 'enum' | 'range' | 'format' | 'pattern' | 'additional';

export interface CallCheck {
  field: string;
  check: CheckKind;
  score: number; // 0..1
  pass: boolean;
}

export interface PerCallValidity {
  tool: string;
  order: number;
  hasSchema: boolean;
  /** null when the tool has no schema (not scoreable). */
  score: number | null;
  checks: CallCheck[];
}

export interface ArgValidityResult {
  /** Mean per-call score over scoreable calls; null when unreliable / no schema
   *  / zero scoreable calls. Never a fabricated 0. */
  score: number | null;
  perCall: PerCallValidity[];
  /** Notes for calls skipped (tool schema unavailable, or inputs unreliable). */
  coverageNotes: string[];
}

/** Strip a genuine MCP server prefix (`mcp__srv__name` → `name`); leave designed
 *  names that merely contain `__` intact. Mirrors tool-conformance.ts. */
function bare(name: string): string {
  if (!name.startsWith('mcp__')) return name;
  return name.slice(name.lastIndexOf('__') + 2);
}

function lookupSchema(map: Map<string, JsonSchema>, name: string): JsonSchema | undefined {
  return map.get(name) ?? map.get(bare(name));
}

function typeMatches(schemaType: unknown, value: unknown): boolean {
  const types = Array.isArray(schemaType) ? schemaType : [schemaType];
  return types.some((t) => {
    switch (t) {
      case 'string': return typeof value === 'string';
      case 'number': return typeof value === 'number' && !Number.isNaN(value);
      case 'integer': return typeof value === 'number' && Number.isInteger(value);
      case 'boolean': return typeof value === 'boolean';
      case 'array': return Array.isArray(value);
      case 'object': return typeof value === 'object' && value !== null && !Array.isArray(value);
      case 'null': return value === null;
      default: return true; // unknown/absent type → don't penalize
    }
  });
}

function formatScore(format: string, value: string): number {
  switch (format) {
    case 'date-time':
    case 'date':
      return Number.isNaN(Date.parse(value)) ? 0 : 1;
    case 'email':
      return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(value) ? 1 : 0;
    case 'uri':
    case 'url':
      try { new URL(value); return 1; } catch { return 0; }
    default:
      return 1; // unhandled format → don't penalize
  }
}

/** Numeric partial credit: full inside [min,max]; linear decay outside relative
 *  to the range span. One-sided bounds are binary (satisfied → 1 else 0). */
function rangeScore(prop: JsonSchema, value: number): number {
  const min = typeof prop.minimum === 'number' ? prop.minimum : undefined;
  const max = typeof prop.maximum === 'number' ? prop.maximum : undefined;
  if (min !== undefined && max !== undefined) {
    if (value >= min && value <= max) return 1;
    const span = max - min || 1;
    const overflow = value < min ? min - value : value - max;
    return Math.max(0, 1 - overflow / span);
  }
  if (min !== undefined) return value >= min ? 1 : 0;
  if (max !== undefined) return value <= max ? 1 : 0;
  return 1;
}

/** Validate one call's args against its schema → list of graded checks. */
function checkCall(schema: JsonSchema, args: Record<string, unknown>): CallCheck[] {
  const checks: CallCheck[] = [];
  const properties = (schema.properties as Record<string, JsonSchema> | undefined) ?? {};
  const required = Array.isArray(schema.required) ? (schema.required as string[]) : [];

  // required present
  for (const r of required) {
    const present = Object.prototype.hasOwnProperty.call(args, r) && args[r] !== undefined;
    checks.push({ field: r, check: 'required', score: present ? 1 : 0, pass: present });
  }

  // per provided field
  for (const [k, value] of Object.entries(args)) {
    const prop = properties[k];
    if (!prop) {
      // unknown key — penalize only under additionalProperties:false
      if (schema.additionalProperties === false) {
        checks.push({ field: k, check: 'additional', score: 0, pass: false });
      }
      continue;
    }
    if (value === undefined || value === null) continue; // optional-absent / null → nothing to type-check
    if ('type' in prop) {
      const ok = typeMatches(prop.type, value);
      checks.push({ field: k, check: 'type', score: ok ? 1 : 0, pass: ok });
    }
    if (Array.isArray(prop.enum)) {
      const ok = (prop.enum as unknown[]).includes(value);
      checks.push({ field: k, check: 'enum', score: ok ? 1 : 0, pass: ok });
    }
    if (typeof value === 'number' && (typeof prop.minimum === 'number' || typeof prop.maximum === 'number')) {
      const s = rangeScore(prop, value);
      checks.push({ field: k, check: 'range', score: s, pass: s >= 1 });
    }
    if (typeof value === 'string' && typeof prop.format === 'string') {
      const s = formatScore(prop.format, value);
      checks.push({ field: k, check: 'format', score: s, pass: s >= 1 });
    }
    if (typeof value === 'string' && typeof prop.pattern === 'string') {
      let ok = true;
      try { ok = new RegExp(prop.pattern).test(value); } catch { ok = true; }
      checks.push({ field: k, check: 'pattern', score: ok ? 1 : 0, pass: ok });
    }
  }
  return checks;
}

/**
 * Score every tool call's arguments against its captured/replicated input_schema.
 * Reliability-gated: returns `score: null` (never a fabricated 0) when the run's
 * inputs are unreliable or no call was scoreable.
 */
export function scoreArgValidity(run: ReconstructedRun): ArgValidityResult {
  const perCall: PerCallValidity[] = [];
  const coverageNotes: string[] = [];

  // Inputs not reliably captured → cannot judge args. Null, never 0.
  if (run.trajectory.trajectory_meta.inputs_reliable === false) {
    return { score: null, perCall, coverageNotes: ['inputs not reliably captured — arg validity skipped'] };
  }

  // Schema map: replicated system-agent schemas, then overlay the
  // trajectory-captured schemas (authoritative for user-created).
  const schemaMap = designedInputSchemas(run.ref.agentKind);
  for (const t of run.trajectory.tools ?? []) {
    if (t?.name && t.input_schema) schemaMap.set(t.name, t.input_schema as JsonSchema);
  }

  const uses: ToolUse[] = collectToolUses(run.trajectory);
  const scores: number[] = [];
  for (const u of uses) {
    const schema = lookupSchema(schemaMap, u.name);
    if (!schema) {
      perCall.push({ tool: u.name, order: u.order, hasSchema: false, score: null, checks: [] });
      if (!coverageNotes.includes(u.name)) coverageNotes.push(u.name);
      continue;
    }
    const checks = checkCall(schema, u.input);
    // No applicable checks (e.g. a no-arg tool called with no args) → trivially valid.
    const callScore = checks.length === 0 ? 1 : checks.reduce((s, c) => s + c.score, 0) / checks.length;
    perCall.push({ tool: u.name, order: u.order, hasSchema: true, score: callScore, checks });
    scores.push(callScore);
  }

  const score = scores.length === 0 ? null : scores.reduce((a, b) => a + b, 0) / scores.length;
  return { score, perCall, coverageNotes };
}

/**
 * Advisory findings from an arg-validity result. Warn for calls below the fail
 * threshold (field + failed check NAMES only — no raw values); info for tools
 * whose schema was unavailable. Never error/critical → never gates.
 */
export function argValidityFindings(result: ArgValidityResult, threshold = ARG_FAIL_THRESHOLD): Finding[] {
  const findings: Finding[] = [];
  for (const call of result.perCall) {
    if (call.score === null || call.score >= threshold) continue;
    const failed = call.checks.filter((c) => !c.pass).map((c) => ({ field: c.field, check: c.check }));
    findings.push({
      invariant: 'critic.arg_validity',
      severity: 'warn',
      component: 'tool-selection',
      message: `tool ${call.tool} called with low-validity arguments (score ${call.score.toFixed(2)})`,
      evidence: { tool: call.tool, order: call.order, score: call.score, failedChecks: failed },
      failureMode: 'TRAIL.invalid_tool_args',
    });
  }
  if (result.coverageNotes.length > 0) {
    findings.push({
      invariant: 'critic.arg_schema_unavailable',
      severity: 'info',
      component: 'tool-selection',
      message: `arg validity skipped for ${result.coverageNotes.length} tool(s)/run without a captured schema`,
      evidence: { notes: result.coverageNotes },
    });
  }
  return findings;
}
