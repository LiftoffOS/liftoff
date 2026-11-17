#!/usr/bin/env npx ts-node
/**
 * Backfill script: Create agent records for existing AI teams
 *
 * This script handles AI teams created before the event-driven agent creation
 * was implemented. It queries all AI teams from Platform Backend and creates
 * corresponding agent records and mappings in Tenant Runtime.
 *
 * Usage:
 *   npx ts-node scripts/backfill-ai-team-agents.ts
 *
 * Environment variables required:
 *   - PLATFORM_BACKEND_DB_URL: Connection string for Platform Backend database
 *   - DATABASE_URL: Connection string for Tenant Runtime database
 *
 * Or run via Cloud Run Job for production.
 */

import { Pool } from 'pg';
import { v4 as uuidv4 } from 'uuid';

// Platform Backend connection (read-only)
const platformPool = new Pool({
  connectionString: process.env.PLATFORM_BACKEND_DB_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
});

// Tenant Runtime connection
const tenantPool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
});

interface AITeam {
  id: string;
  tenant_id: string;
  role: string;
  status: string;
  agent_type: string;
  hitl_level: number | null;
  model_config: object;
  exec_config: object;
  memory_scope: object;
  trigger_config: object | null;
  system_prompt: string | null;
  user_instructions: string | null;
  current_version: number;
}

async function backfillAgents(): Promise<void> {
  console.log('Starting AI team agent backfill...');

  // Get all AI teams from Platform Backend
  const aiTeamsResult = await platformPool.query<AITeam>(`
    SELECT
      id, tenant_id, role, status,
      COALESCE(agent_type, 'B') as agent_type,
      hitl_level,
      COALESCE(model_config, '{}') as model_config,
      COALESCE(exec_config, '{}') as exec_config,
      COALESCE(memory_scope, '{}') as memory_scope,
      trigger_config,
      system_prompt,
      user_instructions,
      current_version
    FROM ai_teams
    WHERE deleted_at IS NULL
    ORDER BY created_at
  `);

  console.log(`Found ${aiTeamsResult.rows.length} AI teams to process`);

  let created = 0;
  let skipped = 0;
  let errors = 0;

  for (const aiTeam of aiTeamsResult.rows) {
    try {
      // Check if mapping already exists
      const existingMapping = await tenantPool.query(
        `SELECT agent_id FROM ai_team_agent_mapping WHERE ai_team_id = $1`,
        [aiTeam.id]
      );

      if (existingMapping.rows.length > 0) {
        console.log(`  Skipping ${aiTeam.id} (${aiTeam.role}) - mapping exists`);
        skipped++;
        continue;
      }

      // Create agent and mapping in a transaction
      const client = await tenantPool.connect();
      try {
        await client.query('BEGIN');

        const agentId = uuidv4();

        // Create agent record
        await client.query(
          `INSERT INTO agents
           (id, tenant_id, name, lifecycle, runtime_status, agent_type, hitl_level,
            model_config, exec_config, memory_scope, trigger_config, system_prompt,
            user_instructions, entity_version, created_at, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, NOW(), NOW())`,
          [
            agentId,
            aiTeam.tenant_id,
            aiTeam.role,
            aiTeam.status === 'active' ? 'ACTIVE' : 'DRAFT',
            'IDLE',
            aiTeam.agent_type,
            aiTeam.hitl_level ?? 3,
            JSON.stringify(aiTeam.model_config),
            JSON.stringify(aiTeam.exec_config),
            JSON.stringify(aiTeam.memory_scope),
            aiTeam.trigger_config ? JSON.stringify(aiTeam.trigger_config) : null,
            aiTeam.system_prompt || '',
            aiTeam.user_instructions || '',
            aiTeam.current_version,
          ]
        );

        // Create mapping
        await client.query(
          `INSERT INTO ai_team_agent_mapping (ai_team_id, agent_id, tenant_id)
           VALUES ($1, $2, $3)`,
          [aiTeam.id, agentId, aiTeam.tenant_id]
        );

        await client.query('COMMIT');

        console.log(`  Created agent ${agentId} for AI team ${aiTeam.id} (${aiTeam.role})`);
        created++;
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      } finally {
        client.release();
      }
    } catch (error) {
      console.error(`  Error processing AI team ${aiTeam.id}:`, (error as Error).message);
      errors++;
    }
  }

  console.log('\nBackfill complete:');
  console.log(`  Created: ${created}`);
  console.log(`  Skipped: ${skipped}`);
  console.log(`  Errors: ${errors}`);
}

async function main(): Promise<void> {
  try {
    await backfillAgents();
  } catch (error) {
    console.error('Backfill failed:', error);
    process.exit(1);
  } finally {
    await platformPool.end();
    await tenantPool.end();
  }
}

main();
