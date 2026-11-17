// Re-export shim — the validator now lives at src/mcp/tool-validator.ts
// after the Phase 0 extraction. Kept here so the small number of legacy
// importers (mostly tests + the index re-export) continue to work without
// a bulk rename.

export {
  validateMcpTools,
  formatViolations,
  McpToolSchemaValidationError,
} from '../mcp/tool-validator';
export type { McpToolValidationViolation } from '../mcp/tool-validator';
