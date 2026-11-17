// Operations, from the provider's own specification — and the classification
// that stands between an agent and a destructive call.
//
// Connecting a custom API is connecting the API, not a hand-picked subset of
// it, so a connection can carry two hundred operations. What shapes behaviour
// is what already shapes it for every other connector: `/dashboard/oversight`
// decides what an AI team may do without a person, per category, and the
// distiller decides what this team does at all. Both of those read the
// per-operation classification, which is what makes this file load-bearing
// rather than decorative.
//
// `spec-codegen.ts` stays exactly where it is and is called here rather than
// only from `scripts/gen-connector-tools.ts`.

import { fromOpenApi, type GenOp } from '../catalog/spec-codegen.js';
import { MAX_CUSTOM_API_OPERATIONS } from './spec.js';
import type { CustomApiOperation, CustomApiRefusal } from './types.js';

/* eslint-disable @typescript-eslint/no-explicit-any */
type Json = Record<string, any>;

/** The effect tokens, most restrictive last. `outbound` is orthogonal — it
 *  says a call leaves the workspace, not how much it changes — so it is
 *  additive rather than ranked. */
const EFFECT_RANK: Record<string, number> = { read: 0, write: 1, destructive: 2 };

/** What the classifier is allowed to answer for an effect. */
const EFFECT_CLASSES = new Set(['read', 'write', 'destructive', 'outbound']);

/** The sensitivity vocabulary the oversight gate matches on literally
 *  (`sensitiveWorkMatch` in the tenant runtime reads these names out of a
 *  tool's categories). */
const SENSITIVITY_CATEGORIES = new Set([
  'customerCommunication',
  'financialActions',
  'dataChanges',
  'externalPublishing',
  'hiringDecisions',
]);

/** One classifier answer for one operation. */
export interface OperationClassifierAnswer {
  name: string;
  categories: string[];
  effectClass: string | null;
}

/**
 * Merge the conservative seed with the classifier's answer.
 *
 * Exactly four rules, and they are the whole of it:
 *
 *   1. The seed and the classifier's answer are UNIONED.
 *   2. The classifier may make an operation MORE restrictive, never less.
 *   3. Non-GET/HEAD stays a write; DELETE stays destructive, whatever the
 *      classifier says.
 *   4. No confident answer keeps the conservative seed.
 *
 * The seed is `spec-codegen`'s own: `categoriesFor` maps DELETE to
 * `destructive` and every other non-GET to `write`, and `classificationFor`
 * adds `dataChanges` to every non-GET plus `financialActions` /
 * `customerCommunication` by path regex.
 */
export function mergeClassification(
  seed: Pick<GenOp, 'method' | 'categories' | 'classification'>,
  answer: OperationClassifierAnswer | undefined,
): string[] {
  const method = seed.method.toUpperCase();
  const isSafe = method === 'GET' || method === 'HEAD';

  // Rule 1, the seed half: both of spec-codegen's lists travel on the one
  // `categories` array, the same way a seeded classification row carries the
  // sensitivity categories the gate matches on beside the effect tokens the
  // runtime reads.
  const out = new Set<string>([...seed.categories, ...seed.classification]);

  // Rule 1, the classifier half: sensitivity categories are additive. Rule 2
  // is why nothing is ever removed here — a category the seed asserted stays
  // asserted whatever the classifier thought.
  for (const c of answer?.categories ?? []) {
    if (SENSITIVITY_CATEGORIES.has(c)) out.add(c);
  }

  // Rule 2 for the EFFECT: the classifier's class is taken only when it ranks
  // above the seed's. `outbound` is added rather than ranked.
  const effectClass = answer?.effectClass ?? null;
  if (effectClass && EFFECT_CLASSES.has(effectClass)) {
    if (effectClass === 'outbound') {
      out.add('outbound');
    } else {
      const seedEffect = seed.categories
        .filter((c) => c in EFFECT_RANK)
        .reduce((best, c) => (EFFECT_RANK[c] > EFFECT_RANK[best] ? c : best), 'read');
      if (EFFECT_RANK[effectClass] > EFFECT_RANK[seedEffect]) {
        out.add(effectClass);
        // A promoted effect replaces the weaker reading of the SAME axis. It
        // never removes a sensitivity category, and it never demotes: only a
        // strictly higher rank reaches this branch.
        for (const weaker of Object.keys(EFFECT_RANK)) {
          if (EFFECT_RANK[weaker] < EFFECT_RANK[effectClass]) out.delete(weaker);
        }
      }
    }
  }

  // Rule 3, asserted after everything else so nothing above can have removed
  // it. A write the classifier read as a read is still a write: the HTTP
  // method is evidence, and a model's reading of a name is not.
  //
  // `write` is added only when nothing stronger is already there, so a DELETE
  // reads `destructive` rather than `destructive, write`. There is no mirror
  // for a safe method: a GET the classifier calls destructive BECOMES
  // destructive, because rule 2 lets the classifier tighten and only rule 3
  // stops it loosening.
  if (method === 'DELETE') out.add('destructive');
  if (!isSafe && !out.has('destructive')) out.add('write');
  if (out.has('write') || out.has('destructive')) out.delete('read');

  return [...out];
}

export interface GeneratedOperations {
  operations: CustomApiOperation[];
  /** The raw seed beside each operation, in the same order. The merge needs
   *  the seed as well as the classifier's answer, and re-deriving it from the
   *  stored operation would mean reading a classification back out of the
   *  thing it was merged into. */
  seeds: GenOp[];
}

/**
 * Generate the operations for a connection, from the provider's own OpenAPI
 * document.
 *
 * The caller has already checked the supported subset (`checkSupportedSubset`)
 * — this only refuses on the two things that are properties of the RESULT
 * rather than of the document: a specification that yields nothing at all, and
 * one that yields more operations than a connection may carry.
 */
/**
 * The path prefix an operation's own path hangs off, expressed relative to the
 * connection's base address.
 *
 * OpenAPI appends a path to the SERVER url, and a server url very often
 * carries one of its own (`/v1`, `/planetary`). `spec-codegen` reads the
 * `paths` object alone, so without this the prefix is simply dropped and every
 * operation resolves one level too high. Nothing catches it: the verification
 * call has its own path written out in full, so the connection verifies, says
 * `active`, and every tool on it 404s.
 *
 * Relative to the base address because that is what dispatch joins the path
 * to. When the base already carries the prefix the path keeps none of it, and
 * when it does not the path carries all of it. A base and a server that
 * disagree outright are left alone: there is no join that satisfies both, and
 * the description is what a person approved.
 */
export function operationPathPrefix(document: Json, baseUrl: string): string {
  const servers = (document as { servers?: Array<{ url?: unknown }> }).servers;
  const raw = Array.isArray(servers) ? servers.find((s) => typeof s?.url === 'string')?.url : undefined;
  if (typeof raw !== 'string' || raw === '') return '';

  let serverPath: string;
  let basePath: string;
  try {
    // A server url may be relative to the document it came from, which is what
    // the second argument resolves.
    serverPath = new URL(raw, baseUrl).pathname.replace(/\/+$/, '');
    basePath = new URL(baseUrl).pathname.replace(/\/+$/, '');
  } catch {
    return '';
  }
  if (serverPath === '' || serverPath === basePath) return '';
  if (basePath === '') return serverPath;
  return serverPath.startsWith(`${basePath}/`) ? serverPath.slice(basePath.length) : '';
}

/**
 * Re-express every operation path against a new base address, so the absolute
 * endpoint an operation names does not move when the base is edited.
 *
 * A path here is relative to the connection's base, which means editing the
 * base silently re-homes every operation: a base that gains `/v1` turns
 * `https://api.acme.example/things` into `https://api.acme.example/v1/things`
 * and every tool 404s, which is the same failure as dropping the
 * specification's own server prefix, arriving through the edit instead.
 *
 * Only the PATH component of the base takes part, so the edit people actually
 * make — a different host for a region or a tenant — leaves every path exactly
 * as it was.
 */
export function rebaseOperationPaths<T extends { path: string }>(
  ops: readonly T[],
  fromBaseUrl: string,
  toBaseUrl: string,
): T[] {
  let fromPath: string;
  let toPath: string;
  try {
    fromPath = new URL(fromBaseUrl).pathname.replace(/\/+$/, '');
    toPath = new URL(toBaseUrl).pathname.replace(/\/+$/, '');
  } catch {
    return [...ops];
  }
  if (fromPath === toPath) return [...ops];
  return ops.map((op) => {
    const absolute = `${fromPath}${op.path}`;
    if (toPath === '') return { ...op, path: absolute };
    if (absolute === toPath) return { ...op, path: '/' };
    if (absolute.startsWith(`${toPath}/`)) return { ...op, path: absolute.slice(toPath.length) };
    // The new base is not above this operation, so no path keeps the absolute
    // url AND hangs off the new base. The operation moves with the base, which
    // is what an edit that points somewhere else is asking for.
    return { ...op };
  });
}

export function generateOperations(
  document: Json,
  baseUrl: string,
  skip: readonly string[] = [],
): GeneratedOperations | CustomApiRefusal {
  // A custom API is generated fresh on every connection, so it takes the
  // fuller schema: an array parameter that says what it holds.
  const skipped = new Set(skip);
  const generated = fromOpenApi(document, undefined, undefined, false, {
    describeArrayItems: true,
    includeHeaderParams: true,
    describeBodyEncoding: true,
  });
  const prefix = operationPathPrefix(document, baseUrl);
  // A provider is not its worst endpoint. One that cannot be dispatched is
  // left out and named; the rest of the API is connected, which is what a
  // person asking for that API meant.
  const usable = skipped.size ? generated.filter((op) => !skipped.has(op.entityType)) : generated;
  if (usable.length === 0) {
    return {
      refused: 'no_operations',
      message: 'That specification describes no operations we could generate, so there is nothing to connect.',
    };
  }
  // The cap counts what would be CONNECTED. An operation that was left out is
  // not one this connection carries, so it should not be one that pushes the
  // connection over the limit.
  if (usable.length > MAX_CUSTOM_API_OPERATIONS) {
    return {
      refused: 'too_many_operations',
      message:
        `That specification describes ${usable.length} operations and a connection carries at most `
        + `${MAX_CUSTOM_API_OPERATIONS}. Connect the part of the API this work needs.`,
      operations: usable.slice(0, 20).map((op) => op.entityType),
    };
  }
  // A duplicate name is a tool the model cannot address unambiguously. The
  // slug is derived from the operationId or the verb and path, so a collision
  // is rare and a suffix keeps both operations reachable rather than dropping
  // one silently.
  // Suffixed until the name is free rather than by a per-base counter: a
  // document that really does contain `x` twice AND an `x_1` would otherwise
  // produce two tools called `x_1`, which is the collision this exists to
  // prevent arriving by the fix for it.
  const taken = new Set<string>();
  const operations = usable.map((op) => {
    let name = op.name;
    for (let n = 1; taken.has(name); n++) name = `${op.name}_${n}`;
    taken.add(name);
    return {
      name,
      description: op.description,
      entityType: op.entityType,
      method: op.method,
      path: `${prefix}${op.path}`,
      inputSchema: op.inputSchema as Record<string, unknown>,
      ...(op.headerParams?.length ? { headerParams: op.headerParams } : {}),
      ...(op.bodyMediaType ? { bodyMediaType: op.bodyMediaType } : {}),
      ...(op.deepObjectParams?.length ? { deepObjectParams: op.deepObjectParams } : {}),
      ...(op.joinedArrayParams?.length ? { joinedArrayParams: op.joinedArrayParams } : {}),
      ...(op.fileParams?.length ? { fileParams: op.fileParams } : {}),
      // Replaced by the merged answer once the classifier has run; the seed is
      // what stands until then, and what stands FOREVER for an operation the
      // classifier had no confident answer for.
      categories: mergeClassification(op, undefined),
    };
  });
  return { operations, seeds: usable };
}

/** Apply the classifier's answers to already-generated operations. */
export function applyClassifierAnswers(
  generated: GeneratedOperations,
  answers: readonly OperationClassifierAnswer[],
): CustomApiOperation[] {
  const byName = new Map(answers.map((a) => [a.name, a]));
  return generated.operations.map((op, i) => {
    const seed = generated.seeds[i];
    if (!seed) return op;
    return { ...op, categories: mergeClassification(seed, byName.get(op.name)) };
  });
}

/** Is this a refusal rather than a generated set? */
export function isRefusal(
  result: GeneratedOperations | CustomApiRefusal,
): result is CustomApiRefusal {
  return 'refused' in result;
}
