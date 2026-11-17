'use strict';

/**
 * INV-PB-009 — agent-id columns in this repo hold `internal_agents.id`.
 *
 * `internal_agents.id` (here) and the Tenant Runtime's `agents.id` are disjoint
 * uuid spaces linked only by `internal_agent_runtime_mapping`, which lives in
 * the RUNTIME's database. `cost_attribution_events.agent_id` and
 * `cost_attribution_snapshots.agent_id` are TEXT, so a runtime-space id stores
 * without a type error and then matches nothing — `getAllAgentsCosts` /
 * `getAgentCostSummary` key on the control-plane id, so those rows vanish from
 * every per-agent surface, and the cost goes missing from /teams.
 *
 * WHAT THIS FLAGS — an attribution write whose `agentId` comes straight off a
 * value that arrived from the tenant runtime, with no translation. Concretely:
 * a call to `ingestEventWithBuckets(...)` / `insertEvents(...)` whose template
 * sets `agentId:` from a bare member expression rooted at a runtime-sourced
 * identifier (`row.agentId`, `payload.agentId`, `e.agent_id`, …) rather than
 * from `toInternalAgentId(...)`, an `internalAgentId` preference, or a local
 * variable that already resolved one of those.
 *
 * Deliberately NOT flagged: `agentId: null`, a literal, or anything whose
 * initializer mentions `internalAgentId` / `toInternalAgentId` — those are the
 * correct shapes. This mirrors the tenant-runtime rule
 * `r5/runtime-agent-id-must-be-resolved`, which guards the producing side; this
 * one guards the consuming side, closing the asymmetry that let the mixed-space
 * column go unnoticed.
 *
 * Escape hatch: `// ATTRIBUTION_AGENT_ID_OK: <reason>` immediately above the
 * property (for producers that are internal-space by construction, e.g.
 * platform-llm-ingester reading this repo's own llm_usage_log).
 */
const path = require('path');

/** Attribution write chokepoints — every agent-id row goes through one of these. */
const WRITE_FNS = new Set(['ingestEventWithBuckets', 'insertEvents', 'upsertSnapshot']);

/**
 * Structural signature of a CostAttributionEvent template. Anchoring on the
 * write CALL alone is not enough: `usage-ledger-ingester` builds its template in
 * `mapEvent()` and passes `mapped.template` to `ingestEventWithBuckets` from a
 * different function, so a call-scoped check silently misses it — which is
 * exactly the seam that motivated this rule. Recognising the object SHAPE
 * catches the extracted-template form too. `eventType` + `source` are both
 * required on CostAttributionEvent and this pairing appears nowhere else.
 */
const TEMPLATE_MARKER_KEYS = ['eventType', 'source'];

function propertyKeyName(prop) {
  if (!prop || prop.type !== 'Property' || !prop.key) return null;
  return prop.key.name ?? prop.key.value ?? null;
}

/** True when the object literal is shaped like an attribution-event template. */
function looksLikeAttributionTemplate(objectExpr) {
  if (!objectExpr || objectExpr.type !== 'ObjectExpression') return false;
  const keys = new Set(objectExpr.properties.map(propertyKeyName).filter(Boolean));
  return TEMPLATE_MARKER_KEYS.every((k) => keys.has(k));
}

/** Identifiers whose properties carry a tenant-runtime-sourced value. */
const RUNTIME_SOURCED_ROOTS = new Set(['row', 'payload', 'e', 'event', 'feedRow', 'ev']);

/** Anything mentioning these is already translated / already internal-space. */
const SAFE_TOKENS = /internalAgentId|toInternalAgentId|attributionAgentId|internal_agent_id/;

function rootIdentifier(node) {
  let cur = node;
  while (cur && cur.type === 'MemberExpression') cur = cur.object;
  return cur && cur.type === 'Identifier' ? cur.name : null;
}

module.exports = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Attribution writes must key agent_id by internal_agents.id, not the Tenant Runtime agents.id (INV-PB-009).',
    },
    messages: {
      untranslated:
        'This attribution write sets `agentId` from `{{expr}}`, a value that arrived from the Tenant Runtime, without translating it. Runtime and control-plane agent ids are disjoint, and this column is TEXT — the wrong space stores silently and then matches nothing on /teams (INV-PB-009). Use `toInternalAgentId(await getRuntimeToInternalMap(tenantId), …)`, prefer an `internalAgentId` field if the producer sends one, or add // ATTRIBUTION_AGENT_ID_OK: <reason> if this producer is internal-space by construction.',
    },
    schema: [],
  },

  create(context) {
    const sourceCode = context.getSourceCode ? context.getSourceCode() : context.sourceCode;
    const filename = context.getFilename ? context.getFilename() : context.filename;
    const relative = path.relative(process.cwd(), filename).replace(/\\/g, '/');

    if (/(^|\/)__tests__\//.test(relative) || /\.test\.ts$/.test(relative)) return {};

    /** Local variables whose initializer already resolved an internal id. */
    const safeLocals = new Set();

    return {
      VariableDeclarator(node) {
        if (node.id.type !== 'Identifier' || !node.init) return;
        if (SAFE_TOKENS.test(sourceCode.getText(node.init))) safeLocals.add(node.id.name);
      },

      Property(node) {
        const key = node.key;
        const keyName = key && (key.name || key.value);
        if (keyName !== 'agentId') return;

        // In scope when EITHER the property sits inside a call to a write
        // chokepoint (inline template) OR its enclosing object literal is shaped
        // like an attribution template (extracted template, built in a helper and
        // passed to the write later). The second arm is what covers
        // usage-ledger-ingester's mapEvent().
        let cursor = node.parent;
        let inWrite = false;
        while (cursor) {
          if (cursor.type === 'CallExpression') {
            const callee = cursor.callee;
            const name =
              callee && callee.type === 'Identifier' ? callee.name
                : callee && callee.type === 'MemberExpression' && callee.property
                  ? callee.property.name
                  : null;
            if (WRITE_FNS.has(name)) { inWrite = true; break; }
          }
          cursor = cursor.parent;
        }
        const isTemplateShaped = looksLikeAttributionTemplate(node.parent);
        if (!inWrite && !isTemplateShaped) return;

        const valueText = sourceCode.getText(node.value);
        if (SAFE_TOKENS.test(valueText)) return;

        const before = sourceCode.getCommentsBefore(node);
        if (before.some((c) => /ATTRIBUTION_AGENT_ID_OK/.test(c.value))) return;

        // Walk the value for a runtime-sourced member expression or a local
        // that was NOT initialised from a translation.
        let offending = null;
        (function walk(n) {
          if (offending || !n || typeof n !== 'object') return;
          if (n.type === 'MemberExpression') {
            const root = rootIdentifier(n);
            if (root && RUNTIME_SOURCED_ROOTS.has(root)) { offending = sourceCode.getText(n); return; }
          }
          if (n.type === 'Identifier' && safeLocals.has(n.name)) return;
          for (const k of Object.keys(n)) {
            if (k === 'parent') continue;
            const c = n[k];
            if (Array.isArray(c)) c.forEach(walk);
            else if (c && typeof c.type === 'string') walk(c);
          }
        })(node.value);

        if (offending) {
          context.report({ node, messageId: 'untranslated', data: { expr: offending } });
        }
      },
    };
  },
};
