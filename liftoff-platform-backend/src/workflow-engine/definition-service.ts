// Workflow Definition Service — CRUD for workflow_definitions
// Validates DAG structure (no cycles, valid entry node) before insert/update.
//
// RLS scope: workflow_definitions is RLS-on (migration 200). All public
// functions accept tenantId — use withTenantScope.

import { withTenantScope } from '../infrastructure/database';
import type { WorkflowDefinitionBody, WorkflowDefinitionRow } from './types';

function validateDefinition(def: WorkflowDefinitionBody): string | null {
  if (!def.entry_node_id) return 'entry_node_id is required';
  if (!Array.isArray(def.nodes) || def.nodes.length === 0) return 'nodes array is required';
  if (!Array.isArray(def.edges)) return 'edges array is required';

  const nodeIds = new Set(def.nodes.map(n => n.id));
  if (!nodeIds.has(def.entry_node_id)) return `entry_node_id "${def.entry_node_id}" not found in nodes`;

  for (const edge of def.edges) {
    if (!nodeIds.has(edge.from)) return `edge references unknown node "${edge.from}"`;
    if (!nodeIds.has(edge.to)) return `edge references unknown node "${edge.to}"`;
  }

  // Cycle detection via DFS
  const adj = new Map<string, string[]>();
  for (const n of def.nodes) adj.set(n.id, []);
  for (const e of def.edges) adj.get(e.from)!.push(e.to);

  const visited = new Set<string>();
  const inStack = new Set<string>();

  function hasCycle(node: string): boolean {
    visited.add(node);
    inStack.add(node);
    for (const neighbor of (adj.get(node) ?? [])) {
      if (!visited.has(neighbor)) {
        if (hasCycle(neighbor)) return true;
      } else if (inStack.has(neighbor)) {
        return true;
      }
    }
    inStack.delete(node);
    return false;
  }

  for (const node of def.nodes) {
    if (!visited.has(node.id) && hasCycle(node.id)) {
      return `workflow definition contains a cycle`;
    }
  }

  return null;
}

export async function createDefinition(
  tenantId: string,
  input: { name: string; description?: string; definition: WorkflowDefinitionBody },
  userId: string,
): Promise<WorkflowDefinitionRow> {
  const validationError = validateDefinition(input.definition);
  if (validationError) throw new Error(`Invalid definition: ${validationError}`);

  const result = await withTenantScope(tenantId, (client) =>
    client.query<WorkflowDefinitionRow>(
      `INSERT INTO workflow_definitions (tenant_id, name, description, definition, created_by)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING *`,
      [tenantId, input.name, input.description ?? null, JSON.stringify(input.definition), userId],
    ),
  );
  return result.rows[0];
}

export async function updateDefinition(
  tenantId: string,
  id: string,
  input: { name?: string; description?: string; definition?: WorkflowDefinitionBody },
  _userId: string,
): Promise<WorkflowDefinitionRow | null> {
  return withTenantScope(tenantId, async (client) => {
    const existing = await client.query<WorkflowDefinitionRow>(
      `SELECT * FROM workflow_definitions WHERE id = $1 AND tenant_id = $2`,
      [id, tenantId],
    );
    if (existing.rows.length === 0) return null;

    const current = existing.rows[0];
    const newDef = input.definition ?? current.definition;

    if (input.definition) {
      const validationError = validateDefinition(input.definition);
      if (validationError) throw new Error(`Invalid definition: ${validationError}`);
    }

    const result = await client.query<WorkflowDefinitionRow>(
      `UPDATE workflow_definitions
       SET name = $3, description = $4, definition = $5,
           version = version + 1, updated_at = NOW()
       WHERE id = $1 AND tenant_id = $2
       RETURNING *`,
      [id, tenantId, input.name ?? current.name, input.description ?? current.description,
       JSON.stringify(newDef)],
    );
    return result.rows[0];
  });
}

export async function activateDefinition(tenantId: string, id: string): Promise<WorkflowDefinitionRow | null> {
  const result = await withTenantScope(tenantId, (client) =>
    client.query<WorkflowDefinitionRow>(
      `UPDATE workflow_definitions SET status = 'active', updated_at = NOW()
       WHERE id = $1 AND tenant_id = $2 AND status = 'draft'
       RETURNING *`,
      [id, tenantId],
    ),
  );
  return result.rows[0] ?? null;
}

export async function archiveDefinition(tenantId: string, id: string): Promise<WorkflowDefinitionRow | null> {
  const result = await withTenantScope(tenantId, (client) =>
    client.query<WorkflowDefinitionRow>(
      `UPDATE workflow_definitions SET status = 'archived', updated_at = NOW()
       WHERE id = $1 AND tenant_id = $2 AND status != 'archived'
       RETURNING *`,
      [id, tenantId],
    ),
  );
  return result.rows[0] ?? null;
}

export async function getDefinition(tenantId: string, id: string): Promise<WorkflowDefinitionRow | null> {
  const result = await withTenantScope(tenantId, (client) =>
    client.query<WorkflowDefinitionRow>(
      `SELECT * FROM workflow_definitions WHERE id = $1 AND tenant_id = $2`,
      [id, tenantId],
    ),
  );
  return result.rows[0] ?? null;
}

export async function listDefinitions(
  tenantId: string,
  opts: { status?: 'draft' | 'active' | 'archived'; limit?: number; offset?: number } = {},
): Promise<WorkflowDefinitionRow[]> {
  const conditions = ['tenant_id = $1'];
  const params: unknown[] = [tenantId];

  if (opts.status) {
    params.push(opts.status);
    conditions.push(`status = $${params.length}`);
  }

  params.push(opts.limit ?? 50);
  params.push(opts.offset ?? 0);

  const result = await withTenantScope(tenantId, (client) =>
    client.query<WorkflowDefinitionRow>(
      `SELECT * FROM workflow_definitions
       WHERE ${conditions.join(' AND ')}
       ORDER BY created_at DESC
       LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params,
    ),
  );
  return result.rows;
}
