'use strict';

/**
 * INV-TR-010 — runtime-keyed tables use the RUNTIME agent id.
 *
 * `agents.id` is a uuidv4 minted by this service; the Platform Backend
 * addresses the same agent by `internal_agents.id`. The two spaces are
 * disjoint, so filtering a runtime-keyed table by a control-plane id matches
 * ZERO rows — no error, no warning, just an empty result. That is how an agent
 * with learned memories can show "No learned context yet", and how
 * cost-attribution rows end up keyed to ids the control plane cannot resolve.
 *
 * WHAT THIS FLAGS — the shipped-bug shape specifically, not "any SQL mentioning
 * agent_id". An id only lands in the wrong space if it CAME FROM the control
 * plane, so the rule tracks that provenance: an agent-id-shaped identifier
 * that is
 *
 *   1. bound from an HTTP request (`req.params` / `req.body` / `req.query`,
 *      directly or by destructuring), or
 *   2. literally named `internalAgentId`, or
 *   3. handed either of those by a call within this file,
 *
 * reaching the parameter array of a `.query(sql, params)` call whose SQL both
 * touches a runtime-keyed table and mentions `agent_id`.
 *
 * Internal execution paths — where `agentId` is already a runtime id pulled
 * from execution context — carry no control-plane provenance and are therefore
 * not flagged. That is the difference between a rule people act on and 131
 * warnings people learn to scroll past.
 *
 * TAINT IS PER VALUE, NOT PER FUNCTION. Two earlier assumptions each let a
 * real bug ship (the chat-turn interrupt and stop lookups, which returned 409
 * "concurrent turn in progress" instead of steering or ending the run):
 *
 *   - "the function calls a resolver, so it is careful" — a long route handler
 *     resolves for one purpose and then queries with the raw id for another.
 *     Only the value that actually reaches the query matters, so a resolver
 *     call elsewhere in the function exempts nothing.
 *   - "the id came from `req`, so provenance is visible here" — handlers pass
 *     the id into a helper, and the helper is where the SQL lives. Taint
 *     therefore follows arguments into functions declared in the same file,
 *     including the properties of an options object.
 *
 * Only agent-id-shaped names carry taint (`agentId`, `internalAgentId`,
 * `agent_id`, …). `tenantId` and `threadId` arrive from the same request body
 * and belong in these queries; tainting them would flag every correctly
 * translated call site.
 *
 * Escape hatches:
 *   - `// RUNTIME_AGENT_ID_OK: <reason>` immediately above the SQL
 *   - the file listed in APPROVED_FILES below
 */
const path = require('path');

// Files that legitimately query both id spaces, or own the translation itself.
const APPROVED_FILES = new Set([
  'src/agent-lifecycle/resolve-runtime-agent-id.ts',
  'src/agent-lifecycle/sync-state-router.ts',
  'src/agent-lifecycle/canonical-reconciler.ts',
  'src/agent-lifecycle/drift-reconciler.ts',
  'src/events/subscriber.ts',
  'src/invocations/service.ts',
  'src/scheduling/event-trigger.ts',
]);

// Tables whose `agent_id` is the RUNTIME agents.id. Sourced from the live FK
// census (every table with a foreign key to agents(id)) plus chat_feedback_queue,
// whose FK was added in migration 330.
const RUNTIME_KEYED_TABLES = [
  'actions',
  'agent_audit_log',
  'agent_performance_snapshots',
  'agent_skills',
  'chat_feedback_queue',
  'child_tasks',
  'compiled_instructions',
  'connectors',
  'hitl_approval_requests',
  'human_feedback',
  'invocations',
  'memories',
  'policy_denials',
  'reflection_pattern_weights',
  'reflection_suggestions',
  'threads',
  'workflow_escalations',
  'workflow_handoffs',
  'workflow_tasks',
  'workflows',
];

const SQL_AGAINST_RUNTIME_TABLE_RE = new RegExp(
  `(?:FROM|UPDATE|INSERT\\s+INTO|DELETE\\s+FROM|JOIN)\\s+(?:${RUNTIME_KEYED_TABLES.join('|')})\\b`,
  'i',
);
const MENTIONS_AGENT_ID_RE = /\bagent_id\b/i;
// SQL that joins the mapping is translating in SQL — correct, never flag.
const JOINS_MAPPING_RE = /internal_agent_runtime_mapping/i;

const RESOLVER_NAMES = new Set([
  'resolveRuntimeAgentId',
  'resolveRuntimeAgentIdStrict',
  'resolveInternalAgentId',
  'resolveGovernanceAgentId',
  'lookupRuntimeAgentId',
]);

const REQUEST_ROOTS = new Set(['req', 'request']);
const REQUEST_PROPS = new Set(['params', 'body', 'query']);
const CONTROL_PLANE_NAMES = new Set(['internalAgentId', 'internal_agent_id']);

// Only agent-id-shaped names can land in the wrong id space. `agentId`,
// `internalAgentId`, `agent_id`, `p.agentId` — but not `tenantId`/`threadId`,
// which come from the same request body and belong in these queries.
const AGENT_ID_NAME_RE = /agent_?id$/i;

function calleeName(node) {
  const callee = node.callee;
  if (!callee) return null;
  if (callee.type === 'Identifier') return callee.name;
  if (callee.type === 'MemberExpression' && callee.property && callee.property.type === 'Identifier') {
    return callee.property.name;
  }
  return null;
}

function walk(node, visit, seen = new Set()) {
  if (!node || typeof node !== 'object' || seen.has(node)) return;
  seen.add(node);
  if (typeof node.type === 'string') visit(node);
  for (const key of Object.keys(node)) {
    if (key === 'parent') continue;
    const child = node[key];
    if (Array.isArray(child)) child.forEach((c) => walk(c, visit, seen));
    else if (child && typeof child.type === 'string') walk(child, visit, seen);
  }
}

/** `req.params.agentId` / `req.body` / `req.query.x` — an HTTP-sourced value. */
function isRequestSourced(node) {
  let cursor = node;
  while (cursor && cursor.type === 'MemberExpression') {
    const obj = cursor.object;
    if (
      obj && obj.type === 'Identifier' && REQUEST_ROOTS.has(obj.name) &&
      cursor.property && cursor.property.type === 'Identifier' &&
      REQUEST_PROPS.has(cursor.property.name)
    ) {
      return true;
    }
    cursor = cursor.object;
  }
  return false;
}

/** Strip `await`, `?? x`, and `.catch(...)` to reach the expression underneath. */
function unwrap(node) {
  let cursor = node;
  for (let i = 0; i < 8 && cursor; i += 1) {
    if (cursor.type === 'AwaitExpression') cursor = cursor.argument;
    else if (cursor.type === 'TSNonNullExpression' || cursor.type === 'TSAsExpression') cursor = cursor.expression;
    else if (cursor.type === 'LogicalExpression') cursor = cursor.left;
    else if (
      cursor.type === 'CallExpression' && cursor.callee.type === 'MemberExpression' &&
      cursor.callee.property.type === 'Identifier' && cursor.callee.property.name === 'catch'
    ) {
      cursor = cursor.callee.object;
    } else return cursor;
  }
  return cursor;
}

/**
 * Control-plane provenance of an expression:
 *
 *   'id'        — this value IS an agent id from the control plane
 *   'container' — this value HOLDS control-plane data; reading an
 *                 agent-id-shaped property off it yields an 'id'
 *   null        — no control-plane provenance
 *
 * The container level is what makes the rule work on real routes. Handlers do
 * not touch `req.body.agentId` directly; they validate first
 * (`Schema.safeParse(req.body)` → `.data` → destructure), and every hop in
 * that chain is a plain call or member access. Without carrying provenance
 * through them, taint dies at the validator and every zod-guarded route — which
 * is nearly all of them — reads as clean.
 */
function provenance(expr, scope) {
  const node = unwrap(expr);
  if (!node) return null;

  if (node.type === 'Identifier') {
    if (CONTROL_PLANE_NAMES.has(node.name) || scope.ids.has(node.name)) return 'id';
    if (scope.containers.has(node.name)) return 'container';
    return null;
  }

  if (node.type === 'MemberExpression') {
    const name = node.property.type === 'Identifier' ? node.property.name : null;
    const base = isRequestSourced(node) ? 'container' : provenance(node.object, scope);
    if (!base) return null;
    return name && AGENT_ID_NAME_RE.test(name) ? 'id' : 'container';
  }

  if (node.type === 'CallExpression') {
    // A resolver call is the translation itself — its result is runtime-space.
    if (RESOLVER_NAMES.has(calleeName(node))) return null;
    // Validators and wrappers (`safeParse(req.body)`, `normalize(body)`) hand
    // the same data back under a new name.
    for (const arg of node.arguments) {
      if (provenance(arg, scope)) return 'container';
    }
    return null;
  }

  if (node.type === 'ObjectExpression') {
    for (const prop of node.properties) {
      if (prop.type === 'Property' && provenance(prop.value, scope)) return 'container';
    }
    return null;
  }

  return null;
}

/** Names bound from a resolver call — translated, therefore never tainted. */
function collectResolvedNames(fnNode) {
  const resolved = new Set();
  walk(fnNode, (node) => {
    if (node.type !== 'VariableDeclarator' || !node.init || node.id.type !== 'Identifier') return;
    const init = unwrap(node.init);
    if (init && init.type === 'CallExpression' && RESOLVER_NAMES.has(calleeName(init))) {
      resolved.add(node.id.name);
    }
  });
  return resolved;
}

/**
 * Control-plane values inside `fnNode`: agent ids (`ids`) and the objects that
 * carry them (`containers`). `seed` holds what arrived as a call argument from
 * elsewhere in the file.
 *
 * A name bound from a resolver is never an id here — that binding is the
 * translated, runtime-space value, which is the whole point of the fix.
 */
function collectScope(fnNode, seed) {
  const resolved = collectResolvedNames(fnNode);
  const scope = {
    ids: new Set(seed ? seed.ids : []),
    containers: new Set([...REQUEST_ROOTS, ...(seed ? seed.containers : [])]),
  };
  const addId = (name) => {
    if (AGENT_ID_NAME_RE.test(name) && !resolved.has(name)) scope.ids.add(name);
  };

  const bind = (pattern, kind) => {
    if (pattern.type === 'Identifier') {
      if (kind === 'id') addId(pattern.name);
      else scope.containers.add(pattern.name);
      return;
    }
    if (pattern.type === 'ObjectPattern') {
      // Destructuring a container splits it: agent-id-shaped keys become ids,
      // everything else stays a container to be read further down.
      for (const prop of pattern.properties) {
        if (prop.type !== 'Property' || prop.value.type !== 'Identifier') continue;
        if (AGENT_ID_NAME_RE.test(prop.value.name)) addId(prop.value.name);
        else scope.containers.add(prop.value.name);
      }
    }
  };

  // Bindings chain (`safeParse(req.body)` → `.data` → destructure → helper), and
  // a chain can read backwards in source order, so run to a fixpoint.
  for (let pass = 0; pass < 6; pass += 1) {
    const before = scope.ids.size + scope.containers.size;
    walk(fnNode, (node) => {
      if (node.type === 'Identifier' && CONTROL_PLANE_NAMES.has(node.name)) addId(node.name);
      if (node.type === 'VariableDeclarator' && node.init) {
        const kind = provenance(node.init, scope);
        if (kind) bind(node.id, kind);
        return;
      }
      // `body.agentId` used inline, with no intermediate binding.
      if (node.type === 'MemberExpression' && provenance(node, scope) === 'id') {
        if (node.property.type === 'Identifier') addId(node.property.name);
      }
    });
    if (scope.ids.size + scope.containers.size === before) break;
  }
  return scope;
}

/** Functions declared in this file, by the name they are called through. */
function collectLocalFunctions(programNode) {
  const byName = new Map();
  walk(programNode, (node) => {
    if (node.type === 'FunctionDeclaration' && node.id) byName.set(node.id.name, node);
    if (
      node.type === 'VariableDeclarator' && node.id.type === 'Identifier' && node.init &&
      (node.init.type === 'ArrowFunctionExpression' || node.init.type === 'FunctionExpression')
    ) {
      byName.set(node.id.name, node.init);
    }
  });
  return byName;
}

/**
 * Taint that flows into local functions as call arguments. A route handler
 * reads `req.params.agentId` and hands it to the helper that owns the SQL —
 * without this, the helper looks clean because nothing inside it touches
 * `req`. Both a bare argument and an options-object property propagate; for an
 * object the KEY name is tainted, since that is what the callee reads back
 * (`p.agentId`, or `{ agentId }` destructured).
 */
function propagateIntoLocalFunctions(fnNode, scopeHere, localFns, seeds) {
  walk(fnNode, (node) => {
    if (node.type !== 'CallExpression') return;
    const target = localFns.get(calleeName(node));
    if (!target || target === fnNode) return;
    const seed = seeds.get(target) || { ids: new Set(), containers: new Set() };

    node.arguments.forEach((arg, index) => {
      const param = target.params[index];
      if (arg.type === 'ObjectExpression') {
        // `helper({ tenantId, agentId: req.params.agentId })` — the callee reads
        // the value back by key, so the KEY is what carries the taint.
        for (const prop of arg.properties) {
          if (prop.type !== 'Property' || prop.key.type !== 'Identifier') continue;
          if (!AGENT_ID_NAME_RE.test(prop.key.name)) continue;
          if (provenance(prop.value, scopeHere) === 'id') seed.ids.add(prop.key.name);
        }
        if (param && param.type === 'Identifier') seed.containers.add(param.name);
        return;
      }
      const kind = provenance(arg, scopeHere);
      if (!kind || !param) return;
      if (param.type === 'Identifier') {
        if (kind === 'id' && AGENT_ID_NAME_RE.test(param.name)) seed.ids.add(param.name);
        else seed.containers.add(param.name);
      } else if (param.type === 'ObjectPattern') {
        for (const prop of param.properties) {
          if (prop.type !== 'Property' || prop.value.type !== 'Identifier') continue;
          if (AGENT_ID_NAME_RE.test(prop.value.name)) seed.ids.add(prop.value.name);
          else seed.containers.add(prop.value.name);
        }
      }
    });

    seeds.set(target, seed);
  });
}

function findEnclosingFunction(node) {
  let cursor = node.parent;
  while (cursor) {
    if (
      cursor.type === 'FunctionDeclaration' ||
      cursor.type === 'FunctionExpression' ||
      cursor.type === 'ArrowFunctionExpression'
    ) {
      return cursor;
    }
    cursor = cursor.parent;
  }
  return null;
}

/**
 * The statement the SQL literal sits in. The escape-hatch comment belongs
 * above the statement — nobody writes a comment wedged between `query(` and
 * its first argument, and a hatch people cannot use is one they route around
 * with a blanket eslint-disable.
 */
function findEnclosingStatement(node) {
  let cursor = node.parent;
  while (cursor) {
    if (/Statement$|Declaration$/.test(cursor.type)) return cursor;
    cursor = cursor.parent;
  }
  return null;
}

/** The `.query(sql, params)` CallExpression this SQL literal is an argument of. */
function findQueryCall(node) {
  let cursor = node.parent;
  while (cursor) {
    if (cursor.type === 'CallExpression' && cursor.arguments.includes(node)) return cursor;
    if (
      cursor.type === 'FunctionDeclaration' ||
      cursor.type === 'FunctionExpression' ||
      cursor.type === 'ArrowFunctionExpression'
    ) {
      return null;
    }
    cursor = cursor.parent;
  }
  return null;
}

/** Identifier names appearing in the query's parameter array argument. */
function paramIdentifiers(queryCall, sqlNode) {
  const names = new Set();
  for (const arg of queryCall.arguments) {
    if (arg === sqlNode) continue;
    walk(arg, (n) => {
      if (n.type === 'Identifier') names.add(n.name);
    });
  }
  return names;
}

module.exports = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'A control-plane agent id must be translated through internal_agent_runtime_mapping before it reaches a runtime-keyed table (INV-TR-010).',
    },
    messages: {
      untranslated:
        'This query filters a runtime-keyed table by `agent_id` using `{{name}}`, which holds a control-plane id (it came from an HTTP request, an internalAgentId binding, or a caller in this file that passed one). Control-plane and runtime agent ids are disjoint, so this matches zero rows with no error (INV-TR-010). Pass the result of resolveRuntimeAgentId/resolveRuntimeAgentIdStrict instead, JOIN internal_agent_runtime_mapping, or add // RUNTIME_AGENT_ID_OK: <reason> above the SQL.',
    },
    schema: [],
  },

  create(context) {
    const sourceCode = context.getSourceCode ? context.getSourceCode() : context.sourceCode;
    const filename = context.getFilename ? context.getFilename() : context.filename;
    const relative = path.relative(process.cwd(), filename).replace(/\\/g, '/');

    for (const allowed of APPROVED_FILES) {
      if (relative.endsWith(allowed)) return {};
    }
    if (/(^|\/)__tests__\//.test(relative) || /\.test\.ts$/.test(relative)) return {};

    // SQL sites are collected during traversal and judged at Program:exit,
    // once taint from every call site in the file is known. Judging each site
    // as it is visited would miss a helper declared above its caller.
    const sqlSites = [];

    function collect(node, raw) {
      if (typeof raw !== 'string') return;
      if (!SQL_AGAINST_RUNTIME_TABLE_RE.test(raw)) return;
      if (!MENTIONS_AGENT_ID_RE.test(raw)) return;
      if (JOINS_MAPPING_RE.test(raw)) return;

      const statement = findEnclosingStatement(node);
      const before = [
        ...sourceCode.getCommentsBefore(node),
        ...(statement ? sourceCode.getCommentsBefore(statement) : []),
      ];
      if (before.some((c) => /RUNTIME_AGENT_ID_OK/.test(c.value))) return;

      const fn = findEnclosingFunction(node);
      if (!fn) return;
      sqlSites.push({ node, fn });
    }

    return {
      TemplateLiteral(node) {
        const raw = node.quasis.map((q) => q.value && q.value.raw).join(' ');
        collect(node, raw);
      },
      Literal(node) {
        if (typeof node.value !== 'string') return;
        collect(node, node.value);
      },
      'Program:exit'(program) {
        if (sqlSites.length === 0) return;

        const localFns = collectLocalFunctions(program);
        // Taint arriving as a call argument, keyed by callee. A chain of
        // helpers needs more than one pass; the file's call graph is shallow,
        // so a bounded fixpoint is enough and cannot loop on recursion.
        const seeds = new Map();
        const functions = new Set([program, ...localFns.values()]);
        walk(program, (n) => {
          if (
            n.type === 'FunctionDeclaration' || n.type === 'FunctionExpression' ||
            n.type === 'ArrowFunctionExpression'
          ) {
            functions.add(n);
          }
        });

        const seedSize = () =>
          [...seeds.values()].reduce((n, s) => n + s.ids.size + s.containers.size, 0);

        let scopeByFn = new Map();
        for (let pass = 0; pass < 4; pass += 1) {
          scopeByFn = new Map();
          for (const fn of functions) {
            scopeByFn.set(fn, collectScope(fn, seeds.get(fn)));
          }
          const sizeBefore = seedSize();
          for (const fn of functions) {
            propagateIntoLocalFunctions(fn, scopeByFn.get(fn), localFns, seeds);
          }
          if (seedSize() === sizeBefore) break;
        }

        for (const { node, fn } of sqlSites) {
          const scope = scopeByFn.get(fn) || collectScope(fn, seeds.get(fn));
          const tainted = scope.ids;
          if (tainted.size === 0) continue;

          const queryCall = findQueryCall(node);
          // No recognisable (sql, params) shape — fall back to "is a tainted
          // name even in scope", still far narrower than flagging every query.
          const candidates = queryCall ? paramIdentifiers(queryCall, node) : tainted;

          for (const name of tainted) {
            if (candidates.has(name)) {
              context.report({ node, messageId: 'untranslated', data: { name } });
              break;
            }
          }
        }
      },
    };
  },
};
