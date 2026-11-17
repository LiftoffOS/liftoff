// connectors__list_available Tool
//
// Returns the connector catalog the platform actually serves, plus this tenant's
// connection status for each entry. The CAIO uses it to ground recommendations:
// if a team needs HubSpot and HubSpot is not connected, say so upfront rather
// than letting someone build a plan whose teams cannot run.
//
// The catalog is fetched live (connector-catalog.ts). A list maintained by hand
// falls behind the real catalog, and a connector missing from it is not "listed
// as not connected" — it is absent, which reads to a model as "the platform has
// never heard of this", so the CAIO would tell a person "We do not have a
// webclaw connector" about an entry that is available and connectable.
//
// The same snapshot also has a CONNECTED side: a connected app missing from it
// would be dropped from the count. Both sides are read from the live catalog.
//
// There is no hardcoded list here any more, not even as a fallback. When the
// catalog cannot be reached, connector-catalog.ts serves the last copy it read
// successfully, which grows with the product instead of drifting behind it.
//
// Two independent lookups back this tool, and each can degrade on its own:
//   - the catalog  (what the platform supports)
//   - the tenant's connections  (what this workspace has connected)
// Neither may be reported as an absence. "I could not read the catalog" is not
// "we do not support that", and "I could not read your connections" is not
// "nothing is connected". Both states are stated explicitly in `message`, and
// when connections are unknown the per-entry `connected` field is omitted rather
// than guessed at.

import { workforcePlansConnectorClient as connectorService } from '../tenant-connectors.js';
import { fetchConnectorCatalog } from '../connector-catalog.js';
import type { WorkforcePlanTool, WorkforcePlanToolContext } from './types.js';

/** Label for a connected connector type the catalog did not describe — a type
 *  retired from the catalog while a tenant still holds a live credential for it.
 *  The tenant's own row usually carries a display name; this is the last resort.
 *
 *  There is deliberately no brand-name override table. One used to live here,
 *  mapping google_mail to Gmail and so on, duplicating the displayName the
 *  catalog already returns. Every type it covered now arrives labelled. */
function humaniseConnectorType(type: string): string {
  return type
    .split('_')
    .map(part => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

interface ConnectorEntry {
  type: string;
  name: string;
  category: string;
  /** Omitted entirely when the tenant's connections could not be read, so an
   *  unknown state is never rendered as a confident `false`. */
  connected?: boolean;
  connectionStatus?: 'active' | 'error' | 'pending';
}

interface ConnectorsOutput {
  connectors: ConnectorEntry[];
  connectedCount: number;
  availableCount: number;
  /** Where the catalog came from. Only 'live' supports concluding that an app
   *  absent from the list is genuinely unsupported. */
  catalogSource: 'live' | 'last_known_good' | 'unavailable';
  /** True only for a live read. Kept as the simple signal the prompt refers to. */
  catalogComplete: boolean;
  /** False when the tenant's connections could not be read. */
  connectionsKnown: boolean;
  message: string;
}

// Active > pending > error, higher is better. Used to pick the headline
// status when a tenant has multiple rows for the same connector type.
function rankStatus(status: 'active' | 'error' | 'pending'): number {
  if (status === 'active') return 3;
  if (status === 'pending') return 2;
  return 1;
}

/** "12 minutes" / "3 hours" / "2 days" — the message has to say how old a stale
 *  catalog is, because that is what decides whether it can be leaned on. */
function describeAge(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  if (minutes < 60) return `${Math.max(minutes, 1)} minute${minutes === 1 ? '' : 's'}`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} hour${hours === 1 ? '' : 's'}`;
  return `${Math.round(hours / 24)} days`;
}

export const connectorsListAvailableTool: WorkforcePlanTool = {
  definition: {
    name: 'connectors__list_available',
    description:
      'List the connectors the platform supports and their connection status for this tenant. This is the live catalog and it is the ONLY authority on whether an app is supported: it holds well over a hundred connectors and gains more every week, so never answer "we do not have that" from memory, and never conclude an app is unsupported because you have not heard of it. Always call this early in a planning conversation so you can ground your recommendations in reality. Check `catalogSource` and `connectionsKnown` before making a negative statement: only `catalogSource: "live"` supports saying we lack an app, and otherwise say you could not check rather than that the thing does not exist. Each entry carries two identifiers and they are not interchangeable: `type` is the internal slug for tool arguments and plan specs, and `name` is the brand name to use whenever you write to the user. If a role requires a connector that is not yet connected, tell the user its `name` so they can set it up on the Connections page, and never put a `type` in a sentence or in parentheses beside the name. Does not return individual data objects; object-level access defaults to full and can be fine-tuned per agent after provisioning.',
    input_schema: {
      type: 'object',
      properties: {},
    },
  },

  async execute(
    _input: Record<string, unknown>,
    ctx: WorkforcePlanToolContext,
  ): Promise<ConnectorsOutput> {
    // Independent lookups, so they run together and are judged separately.
    const [catalogResult, tenantResult] = await Promise.all([
      fetchConnectorCatalog(),
      connectorService.listByTenant(ctx.tenantId),
    ]);

    const catalogSource = catalogResult.source;
    const catalogComplete = catalogResult.source === 'live';
    const connectionsKnown = tenantResult.ok;

    // The tenant adapter filters 'disconnected' rows, so any row it returns is
    // pending, active, error or disabled — all count as "connected" for planning
    // purposes, because a credential exists.
    const tenantConnectors = tenantResult.ok ? tenantResult.connectors : [];

    const statusByType = new Map<string, 'active' | 'error' | 'pending'>();
    const displayByType = new Map<string, string>();

    for (const c of tenantConnectors) {
      const incoming = c.status === 'disabled' ? 'error' : c.status;
      if (incoming === 'error' || incoming === 'pending' || incoming === 'active') {
        const current = statusByType.get(c.type);
        if (!current || rankStatus(incoming) > rankStatus(current)) {
          statusByType.set(c.type, incoming);
        }
      }
      if (c.displayName && !displayByType.has(c.type)) {
        displayByType.set(c.type, c.displayName);
      }
    }

    const catalogConnectors =
      catalogResult.source === 'unavailable' ? [] : catalogResult.connectors;

    const entries: ConnectorEntry[] = catalogConnectors.map(base => {
      const connectionStatus = statusByType.get(base.type);
      return {
        type: base.type,
        name: base.displayName,
        category: base.category,
        ...(connectionsKnown ? { connected: connectionStatus !== undefined } : {}),
        ...(connectionStatus ? { connectionStatus } : {}),
      };
    });

    // Anything the tenant has connected that the catalog did not describe is
    // still reported. This is what commit 11a2a8c added, and it still earns its
    // place: it covers a connector retired from the catalog while a tenant holds
    // a live credential for it, and it is the only list the CAIO has at all when
    // the catalog is unavailable.
    for (const [type, connectionStatus] of statusByType) {
      if (entries.some(e => e.type === type)) continue;
      entries.push({
        type,
        name: displayByType.get(type) ?? humaniseConnectorType(type),
        category: 'unknown',
        ...(connectionsKnown ? { connected: true } : {}),
        connectionStatus,
      });
    }

    const connectedCount = connectionsKnown
      ? entries.filter(e => e.connected).length
      : 0;
    const availableCount = entries.length - connectedCount;

    const message = buildMessage({
      catalogResult,
      connectionsKnown,
      connectedCount,
      availableCount,
      total: entries.length,
    });

    return {
      connectors: entries,
      connectedCount,
      availableCount,
      catalogSource,
      catalogComplete,
      connectionsKnown,
      message,
    };
  },
};

/** The message is where a partial answer says it is partial. Each degradation is
 *  named on its own, because the two lookups fail for different reasons and the
 *  CAIO has to know which half of its answer it can stand behind. */
function buildMessage(input: {
  catalogResult: Awaited<ReturnType<typeof fetchConnectorCatalog>>;
  connectionsKnown: boolean;
  connectedCount: number;
  availableCount: number;
  total: number;
}): string {
  const parts: string[] = [];
  const { catalogResult } = input;

  if (catalogResult.source === 'last_known_good') {
    parts.push(
      `The live connector catalog could not be read just now, so this list is the catalog as it stood ${describeAge(catalogResult.ageMs)} ago. It is complete as of then and fine to plan against, but a connector added since will be missing: if the user asks about an app that is not in this list, say you could not confirm it rather than that we do not have it.`,
    );
  }

  if (catalogResult.source === 'unavailable') {
    parts.push(
      'The connector catalog could not be read and there is no recent copy, so this list does NOT describe what the platform supports and is only what this workspace has connected. Do not tell the user we lack a connector on the strength of it: say you could not check which integrations are available and offer to look again.',
    );
  }

  if (!input.connectionsKnown) {
    parts.push(
      'This workspace\'s connections could not be read, so this is NOT a statement that nothing is connected. Tell the user you could not check their connections, and ask which apps they use rather than assuming their workspace is empty.',
    );
  }

  if (catalogResult.source === 'live' && input.connectionsKnown) {
    if (input.connectedCount === 0) {
      parts.push(
        `No connectors are connected yet, out of ${input.total} the platform supports. This is a new tenant: the user will need to set up app connections on the Connections page before any teams can work with external data. Help them prioritise based on the specs you are proposing.`,
      );
    } else {
      parts.push(
        `${input.connectedCount} of ${input.total} supported connectors are connected. ${input.availableCount} more are available but not yet set up.`,
      );
    }
  }

  return parts.join(' ');
}
