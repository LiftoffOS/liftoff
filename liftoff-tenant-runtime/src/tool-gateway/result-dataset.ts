// Oversized connector results become workspace datasets, not context blobs.
//
// Without this, two protections collide on the Anthropic path: connector
// results are wrapped in the untrusted-content frame, and a result past the
// SDK's own cap is spilled BY THE SDK to a file labelled "Plain text". That
// file starts with the frame delimiter, so no parser can read it and nothing
// tells the model how to unwrap it — the full result becomes unreachable at
// exactly the size where the model most needs to query it.
//
// The contract here is the one that makes Claude Code-style tools robust: data
// lives on disk, context receives a bounded view plus a handle, and the agent
// queries the file with composable tools (jq / python3 are in the runtime
// image). So an oversized result is written to the workspace as CLEAN inner
// JSON, and the in-context text becomes a structural preview plus an explicit
// note naming the path and the format.
//
// Security posture — an explicit decision, not an accident:
//   - The framing boundary is CONTEXT ENTRY, not bytes-at-rest. The preview is
//     framed by the caller exactly as before, and `file_read` re-wraps file
//     content in the untrusted frame on the way back into context (see
//     readWorkspaceFile in mcp-server.ts). The dataset file itself holds clean
//     JSON so tools can parse it.
//   - A Bash `cat` of the file brings unframed untrusted bytes into context.
//     That exposure is not new: the SDK's own spill file was equally
//     Bash-readable, and in-sandbox code has always been able to fetch
//     untrusted data directly. The injection screen on model-bound content
//     remains the guard for that path.
//
// Fail-open in every direction: no writer (connector-only agent), a refused
// write, or a thrown write all return the serialized text unchanged — which is
// exactly today's behaviour, including the downstream bounds that already
// handle it (mcp-bridge's boundToolResult for the non-Anthropic engines).

import crypto from 'crypto';
import { truncateForPrompt } from '../agent-execution/engine/truncate-for-prompt';
import { maxChars } from '../agent-execution/adapter/tool-result-bound';
import { logger } from '../infrastructure/logging';

/** Workspace directory for connector-result datasets. Distinct from the
 *  tool-result spill dir (adapter/tool-result-bound.ts) and the step-output
 *  offload dir (engine/offload-large-value.ts) so the three mechanisms stay
 *  legible on disk. */
export const DATASET_DIR = 'tool-results';

/** How much of the result stays inline. Enough to see the shape and decide how
 *  to query the file, without re-creating the problem being solved. Matches the
 *  spill preview in tool-result-bound.ts. */
const DATASET_PREVIEW_CHARS = 2_000;

export type WorkspaceWriter = (path: string, content: string) => Promise<boolean>;

/** Where the whole result lives when only a view of it went into context. */
export interface ParkedResult {
  /** Workspace-relative path, readable with `file_read` and the code tools. */
  path: string;
  /** Size of the complete result, in characters. */
  bytes: number;
  /** Format at rest, so a reader does not have to guess — an unnamed format is
   *  the failure this module was written for. `json` is a clean inner document
   *  with no untrusted-content framing, parseable as-is. `text` is the tool's
   *  own output verbatim, which the spill path writes because a bounded block
   *  is whatever the tool produced and is frequently not JSON at all. */
  format: 'json' | 'text';
}

/**
 * A result plus whether it is all of the result.
 *
 * `complete: false` is the fact this module used to state only in English, in a
 * note addressed to the model, inside the text. Every consumer then had to
 * re-derive it: observe-result-size searched the text for a directory name, and
 * the model had to notice a sentence. A decision that is only correct over the
 * whole result — is this key already present, how many are there, what differs
 * between these two systems — cannot be made safely from a view, and could not
 * even tell it was looking at one.
 */
export interface ResultCompleteness {
  /** What the caller contributes to context. Unchanged from before. */
  text: string;
  /** False when `text` is a view and the whole result is at `full.path`. */
  complete: boolean;
  /** Present iff `complete` is false. */
  full?: ParkedResult;
}

/**
 * Return the text a connector result should contribute to context.
 *
 * Under the calibrated bound, or with no filesystem: the serialized JSON,
 * unchanged. Over it, with a writer: the full JSON is parked in the workspace
 * and a preview + handle comes back. The caller frames whatever is returned —
 * framing stays at the caller so this module cannot accidentally emit
 * unframed untrusted content into context.
 */
export async function datasetOrInlineWithCompleteness(
  toolLabel: string,
  serialized: string,
  writeFile: WorkspaceWriter | null,
  ids: { tenantId: string; agentId: string },
): Promise<ResultCompleteness> {
  if (serialized.length <= maxChars()) return { text: serialized, complete: true };

  // No filesystem: pass through unchanged. Whether an agent has a workspace is
  // decided at distillation — a workflow that needs one is armed with one at
  // build time — so this module does not degrade the result for a tier that
  // should not be handling it. Degrading here would paper over a provisioning
  // gap that belongs to the distiller.
  //
  // Completeness is reported as FALSE here even though the text is whole: the
  // result is over the bound, so a downstream bound (mcp-bridge's
  // boundToolResult on the non-Anthropic engines, or the SDK's own spill on the
  // Anthropic path) will cut it before the model sees all of it, and there is no
  // parked copy to recover. Claiming complete because this module passed the
  // bytes through would be the same lie in a new place.
  if (!writeFile) return { text: serialized, complete: false };

  // Label is ours (a tool function name); sanitised anyway, and suffixed so
  // two calls to the same tool in one run cannot overwrite each other.
  const safeLabel = toolLabel.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 60);
  const path = `${DATASET_DIR}/${safeLabel}-${crypto.randomUUID().slice(0, 8)}.json`;

  try {
    const written = await writeFile(path, serialized);
    if (!written) {
      logger.warn({ tool: toolLabel, path }, 'dataset spill refused — returning inline result');
      return { text: serialized, complete: false };
    }

    let preview: string;
    try {
      // Shape-preserving preview: keys and early records survive, so the model
      // sees the structure it will query for.
      preview = truncateForPrompt(JSON.parse(serialized), DATASET_PREVIEW_CHARS);
    } catch {
      preview = serialized.slice(0, DATASET_PREVIEW_CHARS);
    }

    logger.info(
      {
        metric: 'tool_result.dataset_spilled',
        tool: toolLabel,
        bytes: serialized.length,
        path,
        tenantId: ids.tenantId,
        agentId: ids.agentId,
      },
      'oversized connector result parked in the workspace as a dataset',
    );

    // The note names the format, the tools, AND which filesystem — because the
    // failure this module guards against is exactly an unnamed format, and
    // because there are two filesystems in play: this file lives in the SANDBOX
    // workspace, which
    // file_read and the code-execution tools see, while the built-in Bash shell
    // runs elsewhere and cannot reach it. Directing the model at the wrong one
    // would recreate the dead-path failure this module exists to fix.
    const text = (
      `${preview}\n` +
      `[Preview only — this is NOT the full result. The complete result ` +
      `(${serialized.length} characters of valid JSON) is saved in your sandbox ` +
      `workspace at ${path}. Read it with file_read, or process it with your ` +
      `code-execution tools (jq and python3 are available there). The built-in ` +
      `Bash shell runs outside your workspace and cannot see this file. Do not ` +
      `assume the preview contains every record.]`
    );

    return {
      text,
      complete: false,
      full: { path, bytes: serialized.length, format: 'json' },
    };
  } catch (err) {
    logger.warn(
      { tool: toolLabel, err: (err as Error).message },
      'dataset spill failed — returning inline result',
    );
    return { text: serialized, complete: false };
  }
}
