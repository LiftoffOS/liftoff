// Permission Validator
// Per Section 10: Tool gateway enforces action allowlist
// Uses action_allowlists table from migration 003
// Per Section 10: Also enforces connector allowlist from active instruction

// One accessor. `pool` is a Proxy onto `getPool()`, so importing both gave a
// test two surfaces to mock and one to forget. See duplicate-outward-action.ts.
import { getPool } from '../infrastructure/database';
import { logger } from '../infrastructure/logging';
import { listConnectorTypes } from '../connectors/tool-schema-cache';
import { normalizeIntegrationsField } from '../instruction-compiler/integration-shape';

// Phase 2c: the old getConnectorMode() check ran against a hard-coded MCP
// registry to decide whether a connector needed wildcard allowlist
// treatment. Every connector the connector-service knows about now gets
// wildcard allowlist treatment — the connector-service's ListTools response
// is the authoritative source of "is this a supported connector type".
// Mirror the old behaviour with a cache lookup: any connector type in the
// cache is wildcard-allowed, anything else falls through to the per-action
// allowlist rules.
function getConnectorMode(connectorTypeOrAlias: string): 'rest' | 'mcp' {
  return listConnectorTypes().includes(connectorTypeOrAlias) ? 'mcp' : 'rest';
}

export interface ActionAllowlistEntry {
  id: string;
  tenantId: string;
  agentId: string | null;
  instructionVersion: number | null;
  connector: string;
  actionType: string;
  entityTypes: string[] | null;
  fieldRestrictions: FieldRestriction[] | null;
  conditions: ConditionPredicate[] | null;
  enabled: boolean;
}

export interface FieldRestriction {
  field: string;
  access: 'read' | 'write' | 'deny';
  conditions?: ConditionPredicate[];
}

export interface ConditionPredicate {
  field: string;
  operator: 'equals' | 'not_equals' | 'contains' | 'not_contains' | 'matches' | 'greater_than' | 'less_than';
  value: any;
}

export interface ValidationInput {
  tenantId: string;
  agentId: string;
  instructionVersion: number;
  connector: string;
  actionType: string;
  entityType: string;
  payload: Record<string, any>;
}

export interface ValidationResult {
  allowed: boolean;
  reason?: string;
  allowedFields?: string[];
  deniedFields?: string[];
  appliedEntry?: ActionAllowlistEntry;
}

export class PermissionValidator {
  private cache: Map<string, { entries: ActionAllowlistEntry[]; expiresAt: Date }> = new Map();
  private readonly CACHE_TTL_MS = 60 * 1000; // 1 minute cache

  // Per Section 10: Validate action against allowlist and instruction connector allowlist
  async validate(input: ValidationInput): Promise<ValidationResult> {
    // Standard tools (no connector) bypass all permission checks
    if (!input.connector) {
      return { allowed: true };
    }

    // WS-A: TR-first-class builtins (`__builtin:*` sentinel — `__builtin:search`
    // today, future builtins likewise) bypass all permission checks. They are
    // semantically standard tools that carry a synthetic connector tag purely
    // so the agent-execution dispatch table can route them. Without this
    // bypass, the agent gets rejected first at verifyConnectorAllowlist
    // ("Connector '__builtin:search' is not in instruction's allowed
    // connectors: [<real uuids>]"), and even past that fails at
    // getApplicableEntries because no `action_allowlists` row exists for the
    // synthetic sentinel. They are owned by the runtime, not by tenant
    // connector/action policy.
    if (input.connector.startsWith('__builtin:')) {
      return { allowed: true };
    }

    // Per Section 12: Check if connector is disabled at tenant level (kill switch)
    const connectorDisabled = await this.checkConnectorDisabled(input.tenantId, input.connector);
    if (connectorDisabled.disabled) {
      logger.warn('Connector disabled by kill switch', {
        tenantId: input.tenantId,
        agentId: input.agentId,
        connector: input.connector,
        reason: connectorDisabled.reason,
      });

      return {
        allowed: false,
        reason: connectorDisabled.reason || `Connector ${input.connector} is disabled`,
      };
    }

    // Per Section 10: First verify connector is in instruction's allowedConnectors
    const connectorAllowed = await this.verifyConnectorAllowlist(input);
    if (!connectorAllowed.allowed) {
      logger.warn('Connector not in instruction allowlist', {
        tenantId: input.tenantId,
        agentId: input.agentId,
        connector: input.connector,
        instructionVersion: input.instructionVersion,
        reason: connectorAllowed.reason,
      });

      return {
        allowed: false,
        reason: connectorAllowed.reason,
      };
    }

    // Phase 0.4: Wildcard allowlist for MCP connectors
    // When a connector is MCP-mode, all discovered tools are implicitly allowed
    // (HITL enforcement handles gating, not the allowlist)
    if (getConnectorMode(input.connector) === 'mcp' || input.entityType === 'mcp_passthrough') {
      logger.info('MCP connector wildcard allowlist applied', {
        tenantId: input.tenantId,
        connector: input.connector,
        actionType: input.actionType,
        entityType: input.entityType,
      });
      return { allowed: true };
    }

    // Get applicable allowlist entries
    const entries = await this.getApplicableEntries(input);

    if (entries.length === 0) {
      // Per Section 10: No allowlist = deny by default
      logger.warn('No allowlist entry found', {
        tenantId: input.tenantId,
        connector: input.connector,
        actionType: input.actionType,
        entityType: input.entityType,
      });

      return {
        allowed: false,
        reason: `Action ${input.actionType} on ${input.connector}/${input.entityType} is not in allowlist`,
      };
    }

    // Find the most specific matching entry
    const entry = this.findBestMatch(entries, input);

    if (!entry) {
      return {
        allowed: false,
        reason: 'No matching allowlist entry found',
      };
    }

    if (!entry.enabled) {
      return {
        allowed: false,
        reason: 'Matching allowlist entry is disabled',
      };
    }

    // Validate entity type
    if (entry.entityTypes && entry.entityTypes.length > 0) {
      if (!entry.entityTypes.includes(input.entityType) && !entry.entityTypes.includes('*')) {
        return {
          allowed: false,
          reason: `Entity type ${input.entityType} is not allowed for ${input.connector}/${input.actionType}`,
        };
      }
    }

    // Validate conditions
    if (entry.conditions && entry.conditions.length > 0) {
      const conditionResult = this.evaluateConditions(entry.conditions, input.payload);
      if (!conditionResult.passed) {
        return {
          allowed: false,
          reason: `Condition not met: ${conditionResult.failedCondition}`,
        };
      }
    }

    // Validate field restrictions
    const fieldResult = this.validateFieldRestrictions(
      entry.fieldRestrictions,
      input.actionType,
      input.payload
    );

    if (!fieldResult.allowed) {
      return {
        allowed: false,
        reason: fieldResult.reason,
        deniedFields: fieldResult.deniedFields,
      };
    }

    logger.info('Action allowed by policy', {
      tenantId: input.tenantId,
      connector: input.connector,
      actionType: input.actionType,
      entityType: input.entityType,
      policyId: entry.id,
    });

    return {
      allowed: true,
      allowedFields: fieldResult.allowedFields,
      appliedEntry: entry,
    };
  }

  // Get all applicable allowlist entries for this tenant/agent
  private async getApplicableEntries(input: ValidationInput): Promise<ActionAllowlistEntry[]> {
    const cacheKey = `${input.tenantId}:${input.agentId}`;
    const now = new Date();

    // Check cache
    const cached = this.cache.get(cacheKey);
    if (cached && cached.expiresAt > now) {
      return this.filterEntries(cached.entries, input);
    }

    // Query database for all entries for this tenant/agent
    const result = await getPool().query(
      `SELECT * FROM action_allowlists
       WHERE tenant_id = $1
       AND (agent_id IS NULL OR agent_id = $2)
       AND enabled = true
       ORDER BY
         CASE WHEN agent_id IS NOT NULL THEN 0 ELSE 1 END,
         CASE WHEN instruction_version IS NOT NULL THEN 0 ELSE 1 END`,
      [input.tenantId, input.agentId]
    );

    const entries = result.rows.map(this.mapRowToEntry);

    // Cache the entries
    this.cache.set(cacheKey, {
      entries,
      expiresAt: new Date(now.getTime() + this.CACHE_TTL_MS),
    });

    return this.filterEntries(entries, input);
  }

  // Filter entries to those matching the connector/action
  private filterEntries(
    entries: ActionAllowlistEntry[],
    input: ValidationInput
  ): ActionAllowlistEntry[] {
    return entries.filter((entry) => {
      // Must match connector (or wildcard)
      if (entry.connector !== input.connector && entry.connector !== '*') {
        return false;
      }

      // Must match action type (or wildcard)
      if (entry.actionType !== input.actionType && entry.actionType !== '*') {
        return false;
      }

      // If instruction version is specified, must match
      if (entry.instructionVersion !== null && entry.instructionVersion !== input.instructionVersion) {
        return false;
      }

      return true;
    });
  }

  // Find the most specific matching entry
  private findBestMatch(
    entries: ActionAllowlistEntry[],
    _input: ValidationInput
  ): ActionAllowlistEntry | null {
    if (entries.length === 0) return null;

    // Sort by specificity (more specific first)
    const sorted = [...entries].sort((a, b) => {
      // Agent-specific > agent-wildcard
      if (a.agentId && !b.agentId) return -1;
      if (!a.agentId && b.agentId) return 1;

      // Version-specific > version-wildcard
      if (a.instructionVersion !== null && b.instructionVersion === null) return -1;
      if (a.instructionVersion === null && b.instructionVersion !== null) return 1;

      // Exact connector > wildcard
      if (a.connector !== '*' && b.connector === '*') return -1;
      if (a.connector === '*' && b.connector !== '*') return 1;

      // Exact action > wildcard
      if (a.actionType !== '*' && b.actionType === '*') return -1;
      if (a.actionType === '*' && b.actionType !== '*') return 1;

      // Entity type restriction > no restriction
      const aHasEntity = a.entityTypes && a.entityTypes.length > 0;
      const bHasEntity = b.entityTypes && b.entityTypes.length > 0;
      if (aHasEntity && !bHasEntity) return -1;
      if (!aHasEntity && bHasEntity) return 1;

      return 0;
    });

    return sorted[0];
  }

  // Evaluate condition predicates
  private evaluateConditions(
    conditions: ConditionPredicate[],
    payload: Record<string, any>
  ): { passed: boolean; failedCondition?: string } {
    for (const condition of conditions) {
      const fieldValue = payload[condition.field];
      let passed = false;

      switch (condition.operator) {
        case 'equals':
          passed = fieldValue === condition.value;
          break;
        case 'not_equals':
          passed = fieldValue !== condition.value;
          break;
        case 'contains':
          passed = typeof fieldValue === 'string' && fieldValue.includes(condition.value);
          break;
        case 'not_contains':
          passed = typeof fieldValue === 'string' && !fieldValue.includes(condition.value);
          break;
        case 'matches':
          passed = typeof fieldValue === 'string' && new RegExp(condition.value).test(fieldValue);
          break;
        case 'greater_than':
          passed = typeof fieldValue === 'number' && fieldValue > condition.value;
          break;
        case 'less_than':
          passed = typeof fieldValue === 'number' && fieldValue < condition.value;
          break;
        default:
          passed = false;
      }

      if (!passed) {
        return {
          passed: false,
          failedCondition: `${condition.field} ${condition.operator} ${condition.value}`,
        };
      }
    }

    return { passed: true };
  }

  // Validate field-level restrictions
  private validateFieldRestrictions(
    restrictions: FieldRestriction[] | null,
    actionType: string,
    payload: Record<string, any>
  ): { allowed: boolean; reason?: string; allowedFields?: string[]; deniedFields?: string[] } {
    // If no restrictions, all fields are allowed
    if (!restrictions || restrictions.length === 0) {
      return { allowed: true, allowedFields: Object.keys(payload) };
    }

    // Use prefix matching so compound action names like `create_values`,
    // `update_row`, `write_cell`, `delete_sheet` etc. are correctly
    // classified as writes. Exact-match was wrong because the connector
    // function registry uses verb_noun naming (e.g. `create_values`,
    // `update_values`), and a compound name slipping through to the
    // !isWriteAction branch silently allows write payloads against a
    // read-only field restriction.
    const isWriteAction =
      actionType.startsWith('create') ||
      actionType.startsWith('update') ||
      actionType.startsWith('write') ||
      actionType.startsWith('insert') ||
      actionType.startsWith('append') ||
      actionType.startsWith('patch') ||
      actionType.startsWith('delete') ||
      actionType.startsWith('remove') ||
      actionType.startsWith('post') ||
      actionType.startsWith('send');
    const payloadFields = Object.keys(payload);
    const allowedFields: string[] = [];
    const deniedFields: string[] = [];

    // Build a map of field restrictions
    const restrictionMap = new Map<string, FieldRestriction>();
    let _hasWildcard = false;
    let wildcardRestriction: FieldRestriction | null = null;

    for (const r of restrictions) {
      if (r.field === '*') {
        _hasWildcard = true;
        wildcardRestriction = r;
      } else {
        restrictionMap.set(r.field, r);
      }
    }

    // Check each field in the payload
    for (const field of payloadFields) {
      const restriction = restrictionMap.get(field) || wildcardRestriction;

      if (!restriction) {
        // No restriction for this field and no wildcard - deny by default for writes
        if (isWriteAction) {
          deniedFields.push(field);
        } else {
          allowedFields.push(field);
        }
        continue;
      }

      // Check access level
      if (restriction.access === 'deny') {
        deniedFields.push(field);
        continue;
      }

      if (isWriteAction && restriction.access === 'read') {
        deniedFields.push(field);
        continue;
      }

      // Check field-level conditions if present
      if (restriction.conditions && restriction.conditions.length > 0) {
        const condResult = this.evaluateConditions(restriction.conditions, { [field]: payload[field] });
        if (!condResult.passed) {
          deniedFields.push(field);
          continue;
        }
      }

      allowedFields.push(field);
    }

    if (deniedFields.length > 0) {
      return {
        allowed: false,
        reason: `Access denied to fields: ${deniedFields.join(', ')}`,
        allowedFields,
        deniedFields,
      };
    }

    return { allowed: true, allowedFields };
  }

  // Map database row to ActionAllowlistEntry
  private mapRowToEntry(row: any): ActionAllowlistEntry {
    return {
      id: row.id,
      tenantId: row.tenant_id,
      agentId: row.agent_id,
      instructionVersion: row.instruction_version,
      connector: row.connector,
      actionType: row.action_type,
      entityTypes: row.entity_types,
      fieldRestrictions: row.field_restrictions,
      conditions: row.conditions,
      enabled: row.enabled,
    };
  }

  // Clear cache (for testing or policy updates)
  clearCache(): void {
    this.cache.clear();
    this.instructionCache.clear();
  }

  // Invalidate cache for a specific tenant
  invalidateTenant(tenantId: string): void {
    for (const key of this.cache.keys()) {
      if (key.startsWith(`${tenantId}:`)) {
        this.cache.delete(key);
      }
    }
    for (const key of this.instructionCache.keys()) {
      if (key.startsWith(`${tenantId}:`)) {
        this.instructionCache.delete(key);
      }
    }
  }

  // Per Section 10: Verify connector is in instruction's allowedConnectors list
  private instructionCache: Map<string, { connectors: string[]; expiresAt: Date }> = new Map();

  private async verifyConnectorAllowlist(
    input: ValidationInput
  ): Promise<{ allowed: boolean; reason?: string }> {
    // Standard tools (no connector) always pass — they're not connector-scoped
    if (!input.connector) {
      return { allowed: true };
    }

    const cacheKey = `${input.tenantId}:${input.agentId}:${input.instructionVersion}`;
    const now = new Date();

    // Check cache
    const cached = this.instructionCache.get(cacheKey);
    if (cached && cached.expiresAt > now) {
      return this.checkConnectorInList(input.connector, cached.connectors);
    }

    // Query the active instruction for this agent
    const result = await getPool().query(
      `SELECT instruction, integrations FROM compiled_instructions
       WHERE tenant_id = $1
       AND agent_id = $2
       AND status = 'active'
       ORDER BY version DESC
       LIMIT 1`,
      [input.tenantId, input.agentId]
    );

    if (!result.rows[0]) {
      return {
        allowed: false,
        reason: 'No active instruction found for agent',
      };
    }

    const instruction = result.rows[0].instruction;
    let allowedConnectors: string[];
    if (instruction && instruction.allowedConnectors) {
      allowedConnectors = instruction.allowedConnectors;
    } else {
      // Internal agents: derive from integrations, then resolve to manifest aliases.
      //
      // ROOT CAUSE OF PRIOR BUG: integration records store the connector_id UUID
      // captured at distillation time. After a connector is reconnected, the OLD
      // UUID is soft-deleted in `connectors` and a NEW row is inserted with a new
      // UUID. The old code did `SELECT alias FROM connector_manifests WHERE id::text
      // = ANY($ids)` which fails because the manifest's `id` now holds the NEW UUID
      // (per the Bug 4 fix that added `id = EXCLUDED.id` to the upsert). The query
      // returned 0 aliases, allowedConnectors contained only stale UUIDs, and every
      // tool call by alias was denied.
      //
      // PERMANENT FIX — multi-strategy resolution to current manifest aliases:
      //   Strategy 1 — by `type`: the platform backend now enriches each integration
      //                with `type` (connector_type) before publishing the event. Look
      //                up the alias by type. This is the principled fix because type
      //                never changes for the lifetime of an integration.
      //   Strategy 2 — by id via current manifest: covers the case where an
      //                integration record has only the id and the manifest's id
      //                still happens to match (no reconnect since distillation).
      //   Strategy 3 — by id via the connectors table: the OLD UUID still exists in
      //                `connectors` (status='disconnected' after reconnect, never
      //                hard-deleted). JOIN connectors -> connectors.type ->
      //                connector_manifests.alias by type. This is the safety net
      //                that works for legacy instructions without `type`.
      //
      // The integration ids themselves are also kept in the allowlist (some tool
      // call paths historically pass the id rather than the alias).
      // Shared normalizer covers the PB integrationId↔type drift — see
      // instruction-compiler/integration-shape.ts. Without it, allowedConnectors
      // here would miss the type alias for any agent whose row was written
      // via PB's older path, falling back to the UUID-only resolution branch
      // and blocking legitimately-bound tools at permission time.
      const parsed = normalizeIntegrationsField(result.rows[0].integrations);
      const integrationIds: string[] = parsed.map(i => i.id).filter(Boolean);
      const integrationTypes: string[] = parsed
        .map(i => i.type)
        .filter((t): t is string => typeof t === 'string' && t.length > 0);

      if (integrationIds.length > 0 || integrationTypes.length > 0) {
        // Single query unioning all three resolution strategies. UNION DISTINCT
        // collapses duplicates. Empty arrays for $ids/$types are handled by the
        // `= ANY` clause matching nothing.
        const manifestResult = await getPool().query(
          `SELECT DISTINCT alias FROM connector_manifests cm
           WHERE cm.tenant_id = $1 AND (
             cm.connector_type = ANY($2::text[])
             OR cm.id::text = ANY($3::text[])
             OR cm.connector_type IN (
               SELECT type FROM connectors
               WHERE tenant_id = $1 AND id::text = ANY($3::text[])
             )
           )`,
          [input.tenantId, integrationTypes, integrationIds]
        );
        // Deduplicated: the alias derivation below mints
        // `${type}-${id.slice(0,8)}` for EVERY integration, and
        // `connector_manifests` supplies the same spelling for any connector
        // that happens to have a row — so a connector with a manifest lands
        // twice. Harmless to the check (it is a membership test) and not
        // harmless to read: the denial message prints the whole list, and a
        // repeated entry reads as two connectors where there is one. That
        // message is the primary diagnostic for this class of failure and it
        // has already been misread once.
        allowedConnectors = [...new Set([
          ...integrationIds,
          ...manifestResult.rows.map((r: { alias: string }) => r.alias),
          // Custom MCP servers, whose alias no manifest can supply.
          //
          // Every alias above comes from `connector_manifests`, and a BYOC
          // server has no manifest — the runtime says so in as many words
          // (connectors/binding-probe.ts). So the allowlist carried the
          // server's UUID and never the name its tools are actually called by,
          // and every call was denied at the gate:
          //
          //   Connector 'custom-mcp-d144a7ea' is not in instruction's allowed
          //   connectors: [0105297e-…, d144a7ea-…, google-mail-0105297e, …]
          //
          // The UUID is right there in the same list. Only the spelling the
          // dispatch uses was missing.
          //
          // A support agent's Help Center search is then refused here on every
          // run — even with its credential and its catalog entry correct — so
          // the agent escalates questions the Help Center has articles for. The
          // alias is
          // minted the same way tool-gateway/mcp-server.ts keys the SDK server,
          // because that is what produced the name being checked.
          ...parsed
            .filter(i => i.type === 'custom_mcp_server')
            .map(i => `custom-mcp-${String(i.id ?? '').replace(/-/g, '').slice(0, 8)}`)
            .filter(a => a.length === 'custom-mcp-'.length + 8),
          // The same spelling problem, for ORDINARY connectors.
          //
          // The custom-MCP case above was treated as special because a BYOC
          // server has no manifest. It is not special. A manifest is not
          // guaranteed for anything: `connector_manifests` is a separate table
          // that a connector may simply have no row in, and when it does not,
          // the only spelling in the allowlist is the raw UUID — which is never
          // what the dispatch is called by.
          //
          // A code-review agent's very first step is then refused here on a
          // live pull_request event —
          //
          //   Connector 'github-dd4c4689' is not in instruction's allowed
          //   connectors: [dd4c4689-e1d6-4464-8592-f8fdac0edf0d, github-7d07a896]
          //
          // — and note the shape of that list. The connector being called is in
          // it, as a UUID. Beside it sits a sibling GitHub connector's alias,
          // supplied by the manifest THAT one happens to have. So two GitHub
          // connectors can be exact mirror images where neither can work: an
          // App connector dispatches but has no manifest, so it is denied here;
          // an OAuth connector has a manifest but no installation, so it is
          // dropped from the catalog as undispatchable. Every GitHub connector
          // call then fails, and the agent quietly falls back to running `gh`
          // in the sandbox — where the action ledger and the duplicate guard
          // cannot see it.
          //
          // Minted exactly as tool-gateway/mcp-server.ts keys the SDK server
          // (`${type}-${id, dashes stripped, first 8}`, or `connector-${…}`
          // when the integration carries no type), because that is what
          // produces the name being checked. This widens nothing: it adds a
          // second spelling of a connector whose id is already in the list.
          ...parsed
            .filter(i => i.type !== 'custom_mcp_server')
            .flatMap((i) => {
              const shortId = String(i.id ?? '').replace(/-/g, '').slice(0, 8);
              // A short id is only a real alias at the full 8 characters. A
              // truncated one is a PREFIX of other connectors' aliases, and
              // the check below treats a trailing '*' as a wildcard — so a
              // malformed entry could WIDEN the allowlist rather than correct
              // a spelling. Drop it instead.
              if (shortId.length !== 8) return [];
              if (!i.type) return [`connector-${shortId}`];
              // BOTH spellings of a multi-word type.
              //
              // The manifest's alias replaces underscores with dashes
              // (`events/subscriber.ts`: `connectorType.replace(/_/g, '-')`),
              // and that is the name the dispatch is called by — so for a
              // single-word type like `github` the two forms coincide and for
              // every multi-word one they do not. `custom_api_connector` is
              // the widest case: its dispatch name is
              // `custom-api-connector-<8>`, which the underscored form does
              // not match at all.
              //
              // Additive, exactly as the underscored form is: it adds a second
              // SPELLING of a connector whose id is already in this list, and
              // widens nothing.
              const dashed = `${i.type.replace(/_/g, '-')}-${shortId}`;
              const underscored = `${i.type}-${shortId}`;
              return dashed === underscored ? [underscored] : [underscored, dashed];
            }),
        ])];
      } else {
        allowedConnectors = [];
      }
    }

    // Cache the resolved connectors
    this.instructionCache.set(cacheKey, {
      connectors: allowedConnectors,
      expiresAt: new Date(now.getTime() + this.CACHE_TTL_MS),
    });

    return this.checkConnectorInList(input.connector, allowedConnectors);
  }

  private checkConnectorInList(
    connector: string,
    allowedConnectors: string[]
  ): { allowed: boolean; reason?: string } {
    // Empty allowedConnectors list means all connectors are allowed
    // (backwards compatibility)
    if (allowedConnectors.length === 0) {
      return { allowed: true };
    }

    // Check if connector is in the allowlist (supports wildcards)
    const isAllowed = allowedConnectors.some((allowed) => {
      if (allowed === '*') return true;
      if (allowed === connector) return true;
      // Support prefix wildcards like 'salesforce-*'
      if (allowed.endsWith('*') && connector.startsWith(allowed.slice(0, -1))) {
        return true;
      }
      return false;
    });

    if (!isAllowed) {
      return {
        allowed: false,
        reason: `Connector '${connector}' is not in instruction's allowed connectors: [${allowedConnectors.join(', ')}]`,
      };
    }

    return { allowed: true };
  }

  // Per Section 12: Cache for disabled connectors
  private disabledConnectorCache: Map<string, { connectors: Set<string>; expiresAt: Date }> = new Map();
  private readonly DISABLED_CACHE_TTL_MS = 30 * 1000; // 30 second cache for kill switch status

  // Per Section 12: Check if connector is disabled at tenant level
  private async checkConnectorDisabled(
    tenantId: string,
    connector: string
  ): Promise<{ disabled: boolean; reason?: string }> {
    const now = new Date();

    // Check cache
    const cached = this.disabledConnectorCache.get(tenantId);
    if (cached && cached.expiresAt > now) {
      if (cached.connectors.has(connector) || cached.connectors.has('*')) {
        return {
          disabled: true,
          reason: `Connector ${connector} is disabled for this tenant`,
        };
      }
      return { disabled: false };
    }

    // Query database for disabled connectors
    const result = await getPool().query(
      `SELECT connector, reason FROM connector_kill_switches
       WHERE tenant_id = $1
       AND enabled = true
       AND (expires_at IS NULL OR expires_at > NOW())`,
      [tenantId]
    );

    const disabledConnectors = new Set<string>();
    let reason: string | undefined;

    for (const row of result.rows) {
      disabledConnectors.add(row.connector);
      if (row.connector === connector || row.connector === '*') {
        reason = row.reason;
      }
    }

    // Cache the result
    this.disabledConnectorCache.set(tenantId, {
      connectors: disabledConnectors,
      expiresAt: new Date(now.getTime() + this.DISABLED_CACHE_TTL_MS),
    });

    if (disabledConnectors.has(connector) || disabledConnectors.has('*')) {
      return {
        disabled: true,
        reason: reason || `Connector ${connector} is disabled for this tenant`,
      };
    }

    return { disabled: false };
  }

  // Clear disabled connector cache (called when kill switch status changes)
  clearDisabledConnectorCache(tenantId?: string): void {
    if (tenantId) {
      this.disabledConnectorCache.delete(tenantId);
    } else {
      this.disabledConnectorCache.clear();
    }
  }
}

// Export singleton
export const permissionValidator = new PermissionValidator();
