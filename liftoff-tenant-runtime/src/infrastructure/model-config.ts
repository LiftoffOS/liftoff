// Model Configuration Service
// Per Section 17: Tenant runtime owns enforcement that only approved configs are used

import { pool } from './database';
import { logger } from './logging';

// Per Section 17: Model configuration that can be approved by control plane
export interface ModelConfig {
  modelId: string;
  provider: 'anthropic' | 'google' | 'openai';
  maxTokens: number;
  temperature: number;
  topP?: number;
  topK?: number;
}

// Approved model configs cached from control plane.
// Schema was simplified in migration 035 — provider/useCases/isDefault/
// settings/approved_at/approved_by columns were removed because the Platform
// Backend never populated them. The type now mirrors the live schema.
export interface ApprovedModelConfig {
  tenantId: string;
  configId: string;
  modelId: string;
  routingPolicy: Record<string, unknown>;
  entityVersion: number;
}

export class ModelConfigService {
  // Validate that a model config is present for the tenant. `useCase` is kept
  // in the signature for callers but is no longer used for filtering — migration
  // 035 removed use-case scoping from the cached_model_configs table; every
  // config is now applicable to all use cases.
  async validateModelConfig(
    tenantId: string,
    modelId: string,
    useCase: string
  ): Promise<{ valid: boolean; reason?: string; config?: ApprovedModelConfig }> {
    const approvedConfig = await this.getApprovedConfig(tenantId, modelId, useCase);

    if (!approvedConfig) {
      logger.warn({
        tenant_id: tenantId,
        model_id: modelId,
        use_case: useCase,
      }, 'Model config validation failed: no approved config found');

      return {
        valid: false,
        reason: `Model ${modelId} is not approved`,
      };
    }

    logger.debug({
      tenant_id: tenantId,
      model_id: modelId,
      use_case: useCase,
      config_id: approvedConfig.configId,
    }, 'Model config validated');

    return { valid: true, config: approvedConfig };
  }

  // Return the most recent config for the tenant. `useCase` is ignored; see
  // the comment on validateModelConfig for why.
  async getDefaultConfig(tenantId: string, _useCase: string): Promise<ApprovedModelConfig | null> {
    const result = await pool.query(
      `SELECT * FROM cached_model_configs
       WHERE tenant_id = $1
       ORDER BY entity_version DESC
       LIMIT 1`,
      [tenantId]
    );

    if (result.rows.length === 0) {
      return null;
    }

    return this.mapRowToConfig(result.rows[0]);
  }

  // Get a specific approved config by model_id. `useCase` ignored (see above).
  async getApprovedConfig(
    tenantId: string,
    modelId: string,
    useCase: string
  ): Promise<ApprovedModelConfig | null> {
    const result = await pool.query(
      `SELECT * FROM cached_model_configs
       WHERE tenant_id = $1
       AND model_id = $2
       ORDER BY entity_version DESC
       LIMIT 1`,
      [tenantId, modelId]
    );

    if (result.rows.length === 0) {
      return this.getDefaultConfig(tenantId, useCase);
    }

    return this.mapRowToConfig(result.rows[0]);
  }

  // List all approved configs for a tenant
  async listApprovedConfigs(tenantId: string): Promise<ApprovedModelConfig[]> {
    const result = await pool.query(
      `SELECT * FROM cached_model_configs
       WHERE tenant_id = $1
       ORDER BY model_id ASC`,
      [tenantId]
    );

    return result.rows.map(this.mapRowToConfig);
  }

  private mapRowToConfig(row: Record<string, unknown>): ApprovedModelConfig {
    return {
      tenantId: row.tenant_id as string,
      configId: row.id as string,
      modelId: row.model_id as string,
      routingPolicy: (row.routing_policy as Record<string, unknown>) ?? {},
      entityVersion: (row.entity_version as number) ?? 1,
    };
  }
}
