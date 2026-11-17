// The consumer of the observed-shape store: what a declaration is MISSING.
//
// `returnsIds` cannot be generated from an input schema, so the precision layer
// has to learn response shapes from traffic. observed-shapes.ts does the
// learning. This is where the learning goes — raw material nobody sees is not
// material, and a store that only ever accumulates is the same as no store.
//
// ONLY THE DIFFERENCE IS REPORTED. A tool whose declaration already covers the
// paths its traffic returns needs nothing from anybody, and listing it beside
// the ones that do teaches the reader to skim past both. Silence here means
// every read that passed the door is already declared.
//
// TWO KINDS OF GAP, kept apart because they have different answers:
//
//   declarable   The tool has a catalog row and its `returnsIds` does not
//                mention paths the traffic keeps returning. The paths are
//                written in `returnsIds` syntax already, so they go into the
//                registry beside it without translation.
//   floor_only   There is no catalog row to hang a declaration on. Every
//                vendor-hosted MCP tool is this shape — enumerated at runtime,
//                no registry entry — which is exactly the case the heuristic
//                floor exists to cover. Reporting it as a missing declaration
//                would be asking for something nobody can write, so it is
//                counted and named as what it is.
//
// Reported rather than written anywhere: the store is in-process and a restart
// loses nothing, because the next read observes the same shape again. A
// proposal is a thing a person decides on, and the decision is a registry edit.

import { observedShapes } from './observed-shapes';
import { getToolSchema } from '../connectors/tool-schema-cache';
import { scrubLogger } from '../observability/scrub-logger';

/** How often the report runs. The store only grows and the process it lives in
 *  is long-running (tool-gateway holds minScale=1), so this is about a person
 *  being able to see the answer within a session rather than about freshness. */
const REPORT_INTERVAL_MS = 15 * 60_000;

/** Paths listed per tool in one line. A tool returning more undeclared paths
 *  than this is not a declaration somebody is about to write by hand; the count
 *  is what matters at that point, and it is reported separately. */
const MAX_REPORTED_PATHS = 20;

export interface ShapeProposal {
  /** `<connectorType>.<actionType>`, the key the store observes under. */
  tool: string;
  connectorType: string;
  actionType: string;
  /** Observed id-bearing paths the declaration does not already name. */
  undeclaredPaths: string[];
  /** How many were observed in total, before the report cap. */
  undeclaredCount: number;
  /** Whether the catalog has a row this could be declared on. */
  declarable: boolean;
}

/**
 * Observed shapes minus what is already declared, per tool.
 *
 * Pure and exported so the join can be asserted directly: it is the whole
 * content of the report, and a report tested only through its log line is a
 * report whose logic is untested.
 */
export function shapeProposals(): ShapeProposal[] {
  const out: ShapeProposal[] = [];
  for (const [tool, paths] of Object.entries(observedShapes())) {
    // The store keys on `${catalogTypeFor(connector)}.${actionType}`. A
    // connector type is one token; an action name can carry dots of its own, so
    // the split is on the FIRST separator only.
    const sep = tool.indexOf('.');
    if (sep <= 0) continue;
    const connectorType = tool.slice(0, sep);
    const actionType = tool.slice(sep + 1);

    const schema = getToolSchema(connectorType, actionType);
    const declared = new Set((schema?.returnsIds ?? []).map((r) => r.path));
    const undeclared = paths.filter((p) => !declared.has(p));
    if (undeclared.length === 0) continue;

    out.push({
      tool,
      connectorType,
      actionType,
      undeclaredPaths: undeclared.slice(0, MAX_REPORTED_PATHS),
      undeclaredCount: undeclared.length,
      declarable: schema != null,
    });
  }
  // Most-undeclared first: the tools with the largest gap are the ones a
  // declaration buys the most from.
  return out.sort((a, b) => b.undeclaredCount - a.undeclaredCount || a.tool.localeCompare(b.tool));
}

/** One line per tool with a gap, and nothing at all when there is none. */
function reportShapeProposals(): void {
  const proposals = shapeProposals();
  if (proposals.length === 0) return;
  for (const p of proposals) {
    scrubLogger.info({
      event: 'provenance_shape_proposal',
      tool: p.tool,
      connectorType: p.connectorType,
      actionType: p.actionType,
      undeclaredPaths: p.undeclaredPaths,
      undeclaredCount: p.undeclaredCount,
      declarable: p.declarable,
    });
  }
}

/**
 * Start the periodic report. Called once at startup by the services that run
 * the gateway door, which are the only ones with anything to observe.
 *
 * `unref()` so it never holds the process open: a report is worth having while
 * something else keeps the runtime alive, and worth nothing at the cost of a
 * shutdown that hangs.
 */
export function startShapeProposalReport(
  intervalMs: number = REPORT_INTERVAL_MS,
): ReturnType<typeof setInterval> {
  return setInterval(() => {
    try {
      reportShapeProposals();
    } catch {
      // A proposal report must never be able to take down the process that is
      // doing the actual work.
    }
  }, intervalMs).unref();
}
