// WS-2.4 — boot-time invariant: every entry in STANDARD_TOOLS must have a
// matching handler. Service refuses to start on a catalog/handler mismatch.

import { STANDARD_TOOLS } from './standard-tools';
import { executeStandardTool } from './standard-tool-handler';
import type { StandardToolContext } from './standard-tool-handler';
import { logger } from '../infrastructure/logging';

// Tools handled by paths other than executeStandardTool. Maintained explicitly
// so the invariant doesn't silently allow new escape hatches.
const EXTERNAL_DISPATCH_NAMES = new Set([
  'delegate_to_agent', // dispatched by agent-execution external-agent branch
  'search',            // dispatched by tool-gateway memory+connector dispatch
]);

export async function assertStandardToolHandlersComplete(): Promise<void> {
  const missing: string[] = [];
  for (const tool of STANDARD_TOOLS) {
    if (EXTERNAL_DISPATCH_NAMES.has(tool.name)) continue;
    // Probe with a minimal payload; we only care if handler returns null
    // (the unhandled-tool sentinel) or actually executes. We ignore handler
    // errors here — handler errors mean a handler exists.
    let result;
    try {
      const probeCtx: StandardToolContext = {
        tenantId: '00000000-0000-0000-0000-000000000000',
        agentId: '00000000-0000-0000-0000-000000000000',
        memoryScope: { readableLayers: [], writableLayers: [] },
        traceId: 'boot-invariant-probe',
      };
      result = await executeStandardTool(tool.name, {}, probeCtx);
    } catch {
      // Handler exists and threw — that's fine for this invariant.
      continue;
    }
    if (result === null) missing.push(tool.name);
  }
  if (missing.length > 0) {
    logger.error({ missing_handlers: missing }, 'Catalog/handler symmetry violated');
    throw new Error(
      `STANDARD_TOOLS catalog advertises tools with no handler: ${missing.join(', ')}. ` +
      `Either implement the case in standard-tool-handler.ts, dispatch via the external-agent ` +
      `branch and add to EXTERNAL_DISPATCH_NAMES, or remove from STANDARD_TOOLS.`,
    );
  }
  logger.info({ catalog_size: STANDARD_TOOLS.length }, 'Standard-tool catalog/handler symmetry verified');
}
