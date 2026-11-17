// Scan a remote-tool definition string (description / title) for prompt-
// injection patterns. A malicious customer-hosted or long-tail MCP server can
// smuggle instructions into an agent's tool catalog via tool metadata, so tool
// definitions are screened at discovery time with the same detector as user
// input. Reports under a distinct field label so audit consumers know where a
// hit came from.

import { enforcePromptInput, type InjectionVerdict, type InjectionReason } from './detector.js';

export interface ToolDefinitionScanHit {
  /** The field that was scanned (e.g. 'description' / 'title'). Audit-safe: a
   *  short label only, MUST NOT contain the scanned text. */
  field: string;
  /** Representative rule code from the detector (first fired reason). */
  code: string;
  /** Human-readable summary of the fired rule. */
  message: string;
  /** Aggregate score (same scale as the user-input detector). */
  score: number;
  /** Detector verdict — `review` or `block` (an `allow` returns null, not a hit). */
  verdict: InjectionVerdict;
  /** PII-safe hash of the scanned text. */
  hash: string;
}

/**
 * Scan a tool-definition field. Returns a hit for any non-`allow` verdict
 * (`review` or `block`) and `null` when the field is clean. The discovery
 * pipeline flags a tool on any hit; there is no review-and-approve UX for tool
 * metadata, so `review` and `block` are treated identically at the call site.
 *
 * `field` is a short label used only in the audit log; it MUST NOT contain the
 * input text.
 */
export function scanToolDefinition(field: string, text: string): ToolDefinitionScanHit | null {
  const decision = enforcePromptInput(text, { source: 'tool_definition' });
  if (decision.verdict === 'allow') return null;
  const top: InjectionReason = decision.reasons[0] ?? {
    code: 'tool_definition.flagged',
    message: 'Remote tool definition tripped the prompt-injection scan.',
  };
  return {
    field,
    code: top.code,
    message: top.message,
    score: decision.score,
    verdict: decision.verdict,
    hash: decision.hash,
  };
}
