// Stable-name routing decision for a tool invocation.
//
// Reads the ConnectorFunction's definitionSource marker (set at boot by
// connector-service's @liftoffos/composio-overlays merge in
// connector-functions-registry.ts) and returns the dispatch target.
//
// For composio-sourced tools: returns the vendor tool name + the
// translation functions sourced from @liftoffos/composio-overlays.
// For native tools (definitionSource='native' or absent): routes through
// the existing native executor (toolGateway.execute) unchanged.
//
// Composio cutover-completion (C5).

import type { ConnectorFunction } from '@liftoffos/connector-types';
import {
  resolveTranslations,
  type NormalizedToolError,
  type ComposioToolOverlay,
} from '@liftoffos/composio-overlays';

export interface NativeRoute {
  source: 'native';
  vendorToolName: string;       // == stable name for native
}

export interface ComposioRoute {
  source: 'composio';
  vendorToolName: string;       // e.g. 'GMAIL_FETCH_EMAILS'
  toolkitSlug: string;          // 'gmail'
  canonicalKey: string;         // '<toolkit>.<stableName>' — for shape validation
  translateInput?: (canonical: Record<string, unknown>) => Record<string, unknown>;
  translateOutput?: (vendorRespData: unknown) => unknown;
  translateError: (err: { code: number; message: string; data?: unknown }) => NormalizedToolError;
  polling?: ComposioToolOverlay['polling'];
  enrichBeforeExecute?: ComposioToolOverlay['enrichBeforeExecute'];
}

export type RouteResolution = NativeRoute | ComposioRoute;

export function resolveStableName(args: {
  connectorType: string;        // 'google_mail'
  toolkitSlug?: string;         // 'gmail' (from CONNECTORS map mcp.toolkitSlug)
  stableName: string;           // 'list_messages'
  fn: ConnectorFunction;        // resolved from tool-schema cache
}): RouteResolution {
  if (args.fn.definitionSource === 'composio') {
    if (!args.toolkitSlug) {
      throw new Error(
        `stable_name_router: composio tool missing toolkit slug ` +
        `(connectorType=${args.connectorType}, stable=${args.stableName})`,
      );
    }
    const vendorName = args.fn.vendorToolName;
    if (!vendorName) {
      throw new Error(
        `stable_name_router: composio tool missing vendorToolName ` +
        `(connectorType=${args.connectorType}, stable=${args.stableName})`,
      );
    }
    const t = resolveTranslations(args.toolkitSlug, vendorName);
    return {
      source: 'composio',
      vendorToolName: vendorName,
      toolkitSlug: args.toolkitSlug,
      canonicalKey: `${args.toolkitSlug}.${args.stableName}`,
      translateInput: t.translateInput,
      translateOutput: t.translateOutput,
      translateError: t.translateError,
      polling: t.polling,
      enrichBeforeExecute: t.enrichBeforeExecute,
    };
  }
  // native (or absent) — passthrough
  return { source: 'native', vendorToolName: args.stableName };
}
