// Pricing as of 2026-04 (Anthropic list prices, USD per 1k tokens).
// IMPORTANT: verify against https://www.anthropic.com/pricing before
// trusting these numbers for billing or reconciliation. They drive only
// the harvest_cost_events.cost_usd column (workspace-level reporting),
// NOT the canonical cost_attribution ledger.
//
// When updating: bump the date in this comment and add the new model
// entries. Keep the legacy entries so historical events still reconcile.
export const MODEL_PRICING: Record<string, { inputPer1k: number; outputPer1k: number }> = {
  // Claude Haiku 4.5 — primary classifier model for harvest (small tier).
  'claude-haiku-4-5-20251001': { inputPer1k: 0.0008, outputPer1k: 0.004 },
  'claude-haiku-4-5': { inputPer1k: 0.0008, outputPer1k: 0.004 },
  // Claude Haiku 3.5 — legacy fallback.
  'claude-haiku-3-5': { inputPer1k: 0.0008, outputPer1k: 0.004 },
  // Claude Sonnet 4.x — medium tier; included for reconciler completeness.
  'claude-sonnet-4-5': { inputPer1k: 0.003, outputPer1k: 0.015 },
  'claude-sonnet-4-5-20250929': { inputPer1k: 0.003, outputPer1k: 0.015 },
  // Fallback for unknown / future models. Conservative midrange.
  default: { inputPer1k: 0.001, outputPer1k: 0.005 },
};

export function computeCostUsd(model: string, inputTokens: number, outputTokens: number): number {
  const pricing = MODEL_PRICING[model] ?? MODEL_PRICING.default;
  return (inputTokens / 1000) * pricing.inputPer1k + (outputTokens / 1000) * pricing.outputPer1k;
}
