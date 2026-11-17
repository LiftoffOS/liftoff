// Re-export shim for backwards compatibility with callers that import
// analyzeCapabilities from external-agents. The real module lives in
// src/mcp/capability-analyzer.ts after the Phase 0 extraction.

export { analyzeCapabilities } from '../mcp/capability-analyzer';
export type { AnalyzeInput, AnalyzeOutput } from '../mcp/capability-analyzer';
