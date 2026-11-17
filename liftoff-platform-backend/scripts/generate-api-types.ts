#!/usr/bin/env npx ts-node

/**
 * API Types Generator Script
 * Per Phase G3: Generate OpenAPI spec from Zod schemas and TypeScript types
 *
 * This script generates TypeScript types for the frontend from the backend's
 * Zod schemas and type definitions.
 *
 * Usage:
 *   npx ts-node scripts/generate-api-types.ts
 *
 * Output:
 *   - generated/openapi.json - OpenAPI 3.0 specification
 *   - generated/api-types.ts - TypeScript types for frontend
 */

import * as fs from 'fs';
import * as path from 'path';

// OpenAPI 3.0 specification generator
interface OpenAPISpec {
  openapi: string;
  info: {
    title: string;
    version: string;
    description: string;
  };
  paths: Record<string, unknown>;
  components: {
    schemas: Record<string, unknown>;
    securitySchemes: Record<string, unknown>;
  };
}

// Generate OpenAPI spec from our type definitions
function generateOpenAPISpec(): OpenAPISpec {
  return {
    openapi: '3.0.3',
    info: {
      title: 'Liftoff Platform API',
      version: '1.0.0',
      description: 'Control plane API for LiftoffOS platform',
    },
    paths: {
      // Paths would be generated from router definitions
      // For now, we focus on schema types
    },
    components: {
      schemas: {
        // Error types
        ApiError: {
          type: 'object',
          required: ['error'],
          properties: {
            error: { type: 'string' },
            code: { type: 'string' },
            details: { type: 'object', additionalProperties: true },
          },
        },

        // Pagination types
        PaginatedResponse: {
          type: 'object',
          required: ['items', 'total', 'page', 'limit', 'hasMore'],
          properties: {
            items: { type: 'array', items: {} },
            total: { type: 'integer' },
            page: { type: 'integer' },
            limit: { type: 'integer' },
            hasMore: { type: 'boolean' },
          },
        },

        // HITL types
        HitlLevel: {
          type: 'integer',
          enum: [0, 1, 2, 3, 4],
          description: 'Human-in-the-loop level (0=none, 4=maximum oversight)',
        },

        SensitiveWorkConfig: {
          type: 'object',
          required: ['customerCommunication', 'financialActions', 'dataChanges', 'externalPublishing', 'hiringDecisions'],
          properties: {
            customerCommunication: { type: 'boolean' },
            financialActions: { type: 'boolean' },
            dataChanges: { type: 'boolean' },
            externalPublishing: { type: 'boolean' },
            hiringDecisions: { type: 'boolean' },
          },
        },

        OversightSettings: {
          type: 'object',
          required: ['tenantId', 'hitlLevel', 'sensitiveWork', 'communicationMode', 'escalationTimeoutMinutes', 'autoApproveReadOnly', 'requireMfaForLevel1'],
          properties: {
            tenantId: { type: 'string', format: 'uuid' },
            hitlLevel: { $ref: '#/components/schemas/HitlLevel' },
            sensitiveWork: { $ref: '#/components/schemas/SensitiveWorkConfig' },
            communicationMode: { type: 'string', enum: ['review', 'draft'] },
            escalationTimeoutMinutes: { type: 'integer' },
            autoApproveReadOnly: { type: 'boolean' },
            requireMfaForLevel1: { type: 'boolean' },
            updatedAt: { type: 'string', format: 'date-time' },
          },
        },

        // Feedback types
        FeedbackStatus: {
          type: 'string',
          enum: ['pending', 'assigned', 'in_progress', 'resolved', 'canceled', 'escalated', 'expired'],
        },

        FeedbackType: {
          type: 'string',
          enum: ['clarification', 'approval', 'escalation', 'review'],
        },

        FeedbackPriority: {
          type: 'string',
          enum: ['low', 'normal', 'high', 'critical'],
        },

        FeedbackOption: {
          type: 'object',
          required: ['id', 'label', 'action'],
          properties: {
            id: { type: 'string' },
            label: { type: 'string' },
            description: { type: 'string' },
            action: { type: 'string', enum: ['approve', 'reject', 'modify', 'escalate'] },
          },
        },

        FeedbackRequest: {
          type: 'object',
          required: ['id', 'tenantId', 'type', 'priority', 'status', 'title', 'description', 'options', 'createdAt', 'updatedAt'],
          properties: {
            id: { type: 'string', format: 'uuid' },
            tenantId: { type: 'string', format: 'uuid' },
            agentId: { type: 'string', format: 'uuid' },
            workflowId: { type: 'string', format: 'uuid' },
            taskId: { type: 'string', format: 'uuid' },
            type: { $ref: '#/components/schemas/FeedbackType' },
            priority: { $ref: '#/components/schemas/FeedbackPriority' },
            status: { $ref: '#/components/schemas/FeedbackStatus' },
            title: { type: 'string' },
            description: { type: 'string' },
            context: { type: 'object', additionalProperties: true },
            options: { type: 'array', items: { $ref: '#/components/schemas/FeedbackOption' } },
            assignedTo: { type: 'string', format: 'uuid' },
            resolvedBy: { type: 'string', format: 'uuid' },
            resolvedAt: { type: 'string', format: 'date-time' },
            expiresAt: { type: 'string', format: 'date-time' },
            createdAt: { type: 'string', format: 'date-time' },
            updatedAt: { type: 'string', format: 'date-time' },
          },
        },

        // Entitlements types (team count based, not tier-based per Phase H3)
        TeamTier: {
          type: 'integer',
          enum: [5, 10, 25, 50, 75, 100, 200],
          description: 'Standard team count tiers available for purchase',
        },

        Entitlement: {
          type: 'object',
          required: ['id', 'tenantId', 'teamCount', 'isCustomPricing', 'tenantOperationalStatus', 'agentExecutionAllowed'],
          properties: {
            id: { type: 'string', format: 'uuid' },
            tenantId: { type: 'string', format: 'uuid' },
            version: { type: 'integer' },

            // Capacity
            teamCount: { type: 'integer', description: 'Number of autonomous teams purchased' },
            isCustomPricing: { type: 'boolean', description: 'Enterprise customers with custom contracts' },

            // Operational status
            tenantOperationalStatus: { type: 'string', enum: ['active', 'suspended', 'terminated'] },
            agentExecutionAllowed: { type: 'boolean' },

            // Credit/usage tracking
            remainingIncludedCredits: { type: 'integer' },
            overageAllowed: { type: 'boolean' },
            includedMonthlyCredits: { type: 'integer' },
            overageCeiling: { type: 'integer' },

            // Capacity limits
            maxActiveAgents: { type: 'integer' },
            maxActiveWorkflows: { type: 'integer' },
            maxActionsPerMinute: { type: 'integer' },
            maxReflectionRunsPerDay: { type: 'integer' },
            maxReflectionRunsPerWeek: { type: 'integer' },
            maxQueuedTasks: { type: 'integer' },
            maxConnectorWritesPerMinute: { type: 'integer' },
            dbConcurrencyBudget: { type: 'integer' },

            // Paid add-on features
            advancedAnalyticsEnabled: { type: 'boolean' },
            sharedCollaborationEnabled: { type: 'boolean' },
            humanExpertsEnabled: { type: 'boolean' },
            prioritySupportEnabled: { type: 'boolean' },
            dedicatedSupportEnabled: { type: 'boolean' },
            advancedSecurityEnabled: { type: 'boolean' },
            complianceEnabled: { type: 'boolean', description: 'SOC2/GDPR compliance' },
            ssoEnabled: { type: 'boolean' },
            overageProtectionEnabled: { type: 'boolean' },
            customRetentionEnabled: { type: 'boolean' },

            // Autonomous operation features (add-ons)
            scheduledAgentsEnabled: { type: 'boolean' },
            agentDelegationEnabled: { type: 'boolean' },
            crossAgentLearningEnabled: { type: 'boolean' },
            autoReflectionEnabled: { type: 'boolean' },

            // Autonomous operation limits
            maxScheduledAgents: { type: 'integer' },
            maxDelegationsPerHour: { type: 'integer' },
            maxDelegationDepth: { type: 'integer' },

            createdAt: { type: 'string', format: 'date-time' },
            updatedAt: { type: 'string', format: 'date-time' },
          },
        },

        // Tool classification
        SensitivityCategory: {
          type: 'string',
          enum: ['customerCommunication', 'financialActions', 'dataChanges', 'externalPublishing', 'hiringDecisions'],
        },

        ToolClassification: {
          type: 'object',
          required: ['toolName', 'integrationType', 'categories', 'classifiedAt'],
          properties: {
            toolName: { type: 'string' },
            integrationType: { type: 'string' },
            categories: { type: 'array', items: { $ref: '#/components/schemas/SensitivityCategory' } },
            draftVariant: { type: 'string' },
            classifiedAt: { type: 'string', format: 'date-time' },
          },
        },
      },
      securitySchemes: {
        bearerAuth: {
          type: 'http',
          scheme: 'bearer',
          bearerFormat: 'JWT',
          description: 'Firebase ID token',
        },
      },
    },
  };
}

// Generate TypeScript types from OpenAPI spec
function generateTypeScript(spec: OpenAPISpec): string {
  const lines: string[] = [
    '// Auto-generated API types',
    '// Generated by scripts/generate-api-types.ts',
    '// DO NOT EDIT MANUALLY',
    '',
    "import type { components } from './openapi';",
    '',
    '// Re-export all schema types',
    'export type ApiError = components["schemas"]["ApiError"];',
    'export type PaginatedResponse<T> = Omit<components["schemas"]["PaginatedResponse"], "items"> & { items: T[] };',
    '',
    '// HITL types',
    'export type HitlLevel = components["schemas"]["HitlLevel"];',
    'export type SensitiveWorkConfig = components["schemas"]["SensitiveWorkConfig"];',
    'export type OversightSettings = components["schemas"]["OversightSettings"];',
    '',
    '// Feedback types',
    'export type FeedbackStatus = components["schemas"]["FeedbackStatus"];',
    'export type FeedbackType = components["schemas"]["FeedbackType"];',
    'export type FeedbackPriority = components["schemas"]["FeedbackPriority"];',
    'export type FeedbackOption = components["schemas"]["FeedbackOption"];',
    'export type FeedbackRequest = components["schemas"]["FeedbackRequest"];',
    '',
    '// Entitlements types (team count based, not tier-based)',
    'export type TeamTier = components["schemas"]["TeamTier"];',
    'export type Entitlement = components["schemas"]["Entitlement"];',
    '',
    '// Tool classification types',
    'export type SensitivityCategory = components["schemas"]["SensitivityCategory"];',
    'export type ToolClassification = components["schemas"]["ToolClassification"];',
    '',
  ];

  return lines.join('\n');
}

async function main(): Promise<void> {
  const outputDir = path.join(__dirname, '..', 'generated');

  // Ensure output directory exists
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  // Generate OpenAPI spec
  const spec = generateOpenAPISpec();
  const specPath = path.join(outputDir, 'openapi.json');
  fs.writeFileSync(specPath, JSON.stringify(spec, null, 2));
  console.log(`Generated OpenAPI spec: ${specPath}`);

  // Generate TypeScript re-exports
  const tsContent = generateTypeScript(spec);
  const tsPath = path.join(outputDir, 'api-types.ts');
  fs.writeFileSync(tsPath, tsContent);
  console.log(`Generated TypeScript types: ${tsPath}`);

  console.log('\nTo generate full TypeScript types from OpenAPI, run:');
  console.log('  npx openapi-typescript generated/openapi.json -o generated/openapi.d.ts');
}

main().catch(console.error);
