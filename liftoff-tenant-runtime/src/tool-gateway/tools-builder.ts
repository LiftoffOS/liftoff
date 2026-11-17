// Sandbox-facing helper: enumerate an agent's bound MCP tools so a script
// running inside the sandbox can call `from liftoff_agent import tools` and
// reflect on what's available before dispatching. Mirrors the discovery the
// LLM loop performs at every turn, but doesn't actually wire any MCP
// transports — the dispatch hop goes through the gateway as usual.

import { getPoolForService } from '../infrastructure/database';
import { log } from '../infrastructure/logging';
import { normalizeIntegrationsField } from '../instruction-compiler/integration-shape';
import { getToolSchemas, getCustomApiToolSchemas, CUSTOM_API_CONNECTOR_TYPE } from '../connectors/tool-schema-cache';
import { describeWith } from './tool-description-overrides';
import { connectorManifestRepository } from '../connectors/manifest-repository';
import { deriveAllowedConnectors } from '../interactive-chat/connector-utils';

const pool = getPoolForService('default');

export interface SandboxToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  connectorAlias: string;
  connectorType: string | null;
  /** Governance categories (read/write/destructive/outbound/sensitive). Sourced
   *  from the SAME place the LLM catalog uses — the registry for sandbox-native
   *  tools, getToolSchema(connectorType,name) for vendor tools — so the workspace
   *  /oversight sensitive-work gate sees the tool. Empty = unclassified. */
  categories: string[];
  /** Prefixed name of the draft alternative (e.g. `gmail__create_draft`) when the
   *  connector publishes one; consumed by the communication-mode gate. */
  draftVariant?: string;
}

/**
 * Returns the tool catalog for the given agent at the given instructionVersion.
 * Includes:
 *   - sandbox tools always available (shell/file/browser/vscode/etc.) via the registry
 *   - each integration's per-connector tool definitions, joined from connector_manifests
 *
 * Per-tool input schema is what the LLM tool catalog would surface, so the
 * sandbox SDK can validate args before calling /v1/mcp/dispatch.
 */
export async function buildToolsForAgent(
  tenantId: string,
  agentId: string,
  instructionVersion: number,
  toolDescriptionOverrides?: Record<string, string>,
): Promise<SandboxToolDef[]> {
  const out: SandboxToolDef[] = [];

  // (1) Sandbox-native tools — always present.
  try {
    const { getSandboxFunctions } = await import('../execution-environments/function-registry');
    for (const fn of getSandboxFunctions()) {
      out.push({
        name: fn.name,
        description: fn.description,
        inputSchema: fn.inputSchema as Record<string, unknown>,
        connectorAlias: 'sandbox',
        connectorType: 'sandbox',
        categories: (fn.categories as string[] | undefined) ?? [],
      });
    }
  } catch (err) {
    log.warn({ message: 'failed to load sandbox functions', err: (err as Error).message });
  }

  // (2) Agent connector tools — resolved EXACTLY like the LLM catalog
  //     (mcp-server.ts): manifests via connectorManifestRepository
  //     .getManifestsForAgent (matches by connector_type / alias / id and the
  //     connectors-table join — robust to the PB integrationId↔type drift), and
  //     the per-connector tool list + governance metadata from the tool-schema
  //     cache (getToolSchemas), NOT from connector_manifests — that table has no
  //     tool_definitions column; tool schemas are baked into the runtime image.
  try {
    const inst = await pool.query(
      `SELECT integrations FROM compiled_instructions
        WHERE tenant_id = $1 AND agent_id = $2 AND version = $3
        LIMIT 1`,
      [tenantId, agentId, instructionVersion],
    );
    const integrations = normalizeIntegrationsField(inst.rows[0]?.integrations) as Array<{ id: string; type?: string }>;
    if (integrations.length === 0) return out;

    const allowedConnectors = deriveAllowedConnectors(integrations);
    const manifests = await connectorManifestRepository.getManifestsForAgent(tenantId, allowedConnectors);

    for (const manifest of manifests) {
      const alias = manifest.alias ?? 'unknown';
      const connectorType = manifest.connectorType ?? null;
      if (!connectorType) continue;
      // A custom API connection's operations are PER INSTANCE, so the
      // type-keyed catalog holds nothing under `custom_api_connector`. Read by
      // connector id — which is the manifest's own primary key — or a hire
      // reflecting on its tools from inside the sandbox would be shown every
      // bound connector EXCEPT the one its workspace described itself.
      const functions = (connectorType as string) === CUSTOM_API_CONNECTOR_TYPE
        ? getCustomApiToolSchemas(manifest.id)
        : getToolSchemas(connectorType);
      for (const fn of functions) {
        const cats = (fn.categories as string[] | undefined) ?? [];
        const rawDesc = fn.description ?? '';
        const toolName = `${alias}__${fn.name}`;
        out.push({
          name: toolName,
          // Match the LLM catalog (mcp-server.ts): destructive vendor tools carry
          // the ⚠️ DESTRUCTIVE marker so the level-2 destructive gate reads it
          // identically whether a tool came from the catalog or this builder.
          //
          // The per-tool rule is appended for the same reason: this surface
          // describes the same tools to the same model, and a rule present on
          // two surfaces and absent on the third is a rule the agent follows or
          // not depending on where it happens to be working.
          description: describeWith(
            cats.includes('destructive') ? `⚠️ DESTRUCTIVE: ${rawDesc}` : rawDesc,
            toolDescriptionOverrides?.[toolName],
          ),
          inputSchema: (fn.inputSchema ?? { type: 'object', properties: {} }) as Record<string, unknown>,
          connectorAlias: alias,
          connectorType,
          categories: cats,
          draftVariant: fn.draftVariant ? `${alias}__${fn.draftVariant}` : undefined,
        });
      }
    }
  } catch (err) {
    log.warn({ message: 'failed to enumerate agent integration tools', err: (err as Error).message });
  }

  return out;
}
