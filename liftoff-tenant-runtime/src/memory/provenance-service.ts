import { Pool, PoolClient } from 'pg';
import { pool } from '../infrastructure/database';
import { SourceEventInput } from './types';

type DbClient = Pool | PoolClient;

async function upsertNode(
  client: DbClient,
  tenantId: string,
  nodeType: string,
  refId: string,
  fields: {
    connectorId?: string | null;
    agentId?: string | null;
    confidence?: number | null;
    metadata?: Record<string, unknown>;
  },
): Promise<string> {
  const result = await client.query(
    `WITH ins AS (
      INSERT INTO provenance_nodes (id, tenant_id, node_type, ref_id, connector_id, agent_id, confidence, metadata)
      VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6, $7)
      ON CONFLICT (tenant_id, node_type, ref_id) DO NOTHING
      RETURNING id
    )
    SELECT id FROM ins
    UNION ALL
    SELECT id FROM provenance_nodes WHERE tenant_id = $1 AND node_type = $2 AND ref_id = $3
    LIMIT 1`,
    [
      tenantId,
      nodeType,
      refId,
      fields.connectorId ?? null,
      fields.agentId ?? null,
      fields.confidence ?? null,
      JSON.stringify(fields.metadata ?? {}),
    ],
  );
  return result.rows[0].id as string;
}

async function upsertEdge(
  client: DbClient,
  tenantId: string,
  fromNodeId: string,
  toNodeId: string,
  edgeType: string,
): Promise<void> {
  await client.query(
    `INSERT INTO provenance_edges (id, tenant_id, from_node_id, to_node_id, edge_type)
     VALUES (gen_random_uuid(), $1, $2, $3, $4)
     ON CONFLICT (from_node_id, to_node_id, edge_type) DO NOTHING`,
    [tenantId, fromNodeId, toNodeId, edgeType],
  );
}

export async function recordMemoryOrigin(
  client: DbClient,
  tenantId: string,
  memoryId: string,
  source: SourceEventInput,
): Promise<void> {
  const sourceNodeId = await upsertNode(client, tenantId, source.nodeType, source.refId, {
    connectorId: source.connectorId,
    agentId: source.agentId,
    confidence: source.confidence,
    metadata: source.metadata,
  });
  const memoryNodeId = await upsertNode(client, tenantId, 'memory', memoryId, {});
  await upsertEdge(client, tenantId, sourceNodeId, memoryNodeId, 'produced');
}

export async function recordSynthesis(
  client: DbClient,
  tenantId: string,
  sourceMemoryIds: string[],
  derivedMemoryId: string,
): Promise<void> {
  if (sourceMemoryIds.length === 0) return;
  const derivedNodeId = await upsertNode(client, tenantId, 'memory', derivedMemoryId, {});
  for (const sourceId of sourceMemoryIds) {
    const sourceNodeId = await upsertNode(client, tenantId, 'memory', sourceId, {});
    await upsertEdge(client, tenantId, sourceNodeId, derivedNodeId, 'synthesized_into');
  }
}

export async function recordAmendment(
  client: DbClient,
  tenantId: string,
  sourceMemoryIds: string[],
  amendmentId: string,
): Promise<void> {
  const amendmentNodeId = await upsertNode(client, tenantId, 'instruction_amendment', amendmentId, {});
  for (const sourceId of sourceMemoryIds) {
    const sourceNodeId = await upsertNode(client, tenantId, 'memory', sourceId, {});
    await upsertEdge(client, tenantId, sourceNodeId, amendmentNodeId, 'contributed_to');
  }
}

export async function findMemoriesByConnector(
  tenantId: string,
  connectorId: string,
): Promise<string[]> {
  const result = await pool.query(
    `WITH RECURSIVE affected(node_id, depth) AS (
      SELECT pe.to_node_id, 0
      FROM provenance_edges pe
      JOIN provenance_nodes pn ON pe.from_node_id = pn.id
      WHERE pn.connector_id = $1
        AND pn.tenant_id = $2
        AND pn.node_type = 'connector_event'
        AND pe.edge_type = 'produced'
      UNION ALL
      SELECT pe.to_node_id, a.depth + 1
      FROM provenance_edges pe
      JOIN affected a ON pe.from_node_id = a.node_id
      WHERE pe.edge_type = 'synthesized_into'
        AND pe.tenant_id = $2
        AND a.depth < 50
    )
    SELECT DISTINCT pn.ref_id AS memory_id
    FROM provenance_nodes pn
    JOIN affected a ON pn.id = a.node_id
    WHERE pn.node_type = 'memory'
      AND pn.tenant_id = $2`,
    [connectorId, tenantId],
  );
  return result.rows.map((r: { memory_id: string }) => r.memory_id);
}

export async function getProvenanceChain(
  tenantId: string,
  memoryId: string,
  depth: number,
): Promise<{
  upstream: Array<{
    nodeType: string;
    refId: string;
    connectorId?: string;
    agentId?: string;
    confidence?: number;
    edgeType: string;
    depth: number;
    metadata: Record<string, unknown>;
  }>;
  downstream: Array<{
    nodeType: string;
    refId: string;
    edgeType: string;
    depth: number;
  }>;
}> {
  const [upstreamResult, downstreamResult] = await Promise.all([
    pool.query(
      `WITH RECURSIVE upstream(node_id, edge_type, depth) AS (
        SELECT pn.id, NULL::text, 0
        FROM provenance_nodes pn
        WHERE pn.tenant_id = $1 AND pn.ref_id = $2 AND pn.node_type = 'memory'
        UNION ALL
        SELECT pe.from_node_id, pe.edge_type, u.depth + 1
        FROM provenance_edges pe
        JOIN upstream u ON pe.to_node_id = u.node_id
        WHERE pe.tenant_id = $1
          AND u.depth < $3
      )
      SELECT pn.node_type, pn.ref_id, pn.connector_id, pn.agent_id, pn.confidence, u.edge_type, u.depth, pn.metadata
      FROM provenance_nodes pn
      JOIN upstream u ON pn.id = u.node_id
      WHERE u.depth > 0
        AND pn.tenant_id = $1
      ORDER BY u.depth`,
      [tenantId, memoryId, depth],
    ),
    pool.query(
      `WITH RECURSIVE downstream(node_id, edge_type, depth) AS (
        SELECT pn.id, NULL::text, 0
        FROM provenance_nodes pn
        WHERE pn.tenant_id = $1 AND pn.ref_id = $2 AND pn.node_type = 'memory'
        UNION ALL
        SELECT pe.to_node_id, pe.edge_type, d.depth + 1
        FROM provenance_edges pe
        JOIN downstream d ON pe.from_node_id = d.node_id
        WHERE pe.tenant_id = $1
          AND d.depth < $3
      )
      SELECT pn.node_type, pn.ref_id, d.edge_type, d.depth
      FROM provenance_nodes pn
      JOIN downstream d ON pn.id = d.node_id
      WHERE d.depth > 0
        AND pn.tenant_id = $1
      ORDER BY d.depth`,
      [tenantId, memoryId, depth],
    ),
  ]);

  return {
    upstream: upstreamResult.rows.map((r: Record<string, unknown>) => ({
      nodeType: r.node_type as string,
      refId: r.ref_id as string,
      ...(r.connector_id != null ? { connectorId: r.connector_id as string } : {}),
      ...(r.agent_id != null ? { agentId: r.agent_id as string } : {}),
      ...(r.confidence != null ? { confidence: r.confidence as number } : {}),
      edgeType: r.edge_type as string,
      depth: r.depth as number,
      metadata: (r.metadata as Record<string, unknown>) ?? {},
    })),
    downstream: downstreamResult.rows.map((r: Record<string, unknown>) => ({
      nodeType: r.node_type as string,
      refId: r.ref_id as string,
      edgeType: r.edge_type as string,
      depth: r.depth as number,
    })),
  };
}
