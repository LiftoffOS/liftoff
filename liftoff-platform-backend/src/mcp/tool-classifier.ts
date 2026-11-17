// Tool Classifier (generic MCP tool classification).
// Phase 0 extraction: moved from src/external-agents/tool-classifier.ts.
// Used by every MCP consumer (external agents, custom MCP servers) for HITL classification.

import crypto from 'crypto';
import { pool } from '../infrastructure/database';
import { log } from '../infrastructure/logging';
import { llmClient } from '../llm/client';
import { ask } from '../typesafe/client';
import { isTypeSafeClassifierEnabled } from '../typesafe/flags';
import {
  CLASSIFICATION_VERSION,
  CLASSIFIER_CATEGORIES,
  CLASSIFIER_SET,
  type EffectClass,
} from '../typesafe/questions';

// Tool definition from any integration protocol
export interface ToolDefinition {
  name: string;
  description: string;
  parameters?: Record<string, unknown>;
}

// Classification categories matching SensitiveWorkConfig keys
export type SensitivityCategory =
  | 'customerCommunication'
  | 'financialActions'
  | 'dataChanges'
  | 'externalPublishing'
  | 'hiringDecisions';

// Connector-functions-registry action categories (used by allowedActionTypes filtering)
export type ActionCategory = 'read' | 'write' | 'destructive' | 'outbound' | 'sensitive';

/** The effect class stored beside the categories (1b): what one call does,
 *  in connector-service's vocabulary. `null` changes nothing downstream. */
export type StoredEffectClass = 'read' | 'write' | 'destructive' | 'outbound';
export const STORED_EFFECT_CLASSES: readonly StoredEffectClass[] = ['read', 'write', 'destructive', 'outbound'];

// Classification result
export interface ClassificationResult {
  categories: SensitivityCategory[];
  /** Present only when Jev answered confidently (see effectClassFromBands).
   *  Absent on the generation and keyword paths, which have no effect head. */
  effectClass?: StoredEffectClass | null;
  /** Which path answered. */
  by: 'jev' | 'generation' | 'keywords';
}

/** Attribution for the classifier's own usage rows. */
export interface ClassifyContext {
  /** Absent only for the global connector inventory (platform overhead). */
  tenantId?: string;
  purpose: 'tool_classification';
}

// Cached classification
export interface CachedClassification {
  toolName: string;
  integrationType: string;
  toolDescriptionHash: string;
  categories: SensitivityCategory[];
  draftVariant: string | null;
  classifiedAt: Date;
  reviewedBy: string | null;
  isManualOverride: boolean;
  tenantId: string | null;
  /** 1b. NULL on rows written before migration 507 and on seed rows. */
  effectClass: StoredEffectClass | null;
  /** The classification version (questions.ts) that wrote the row. NULL on
   *  rows written before migration 507 and on seed rows; a row older than
   *  the current version is re-classified on the next discovery. */
  classificationVersion: number | null;
}

const SENSITIVITY_TO_ACTION_MAP: Record<SensitivityCategory, ActionCategory[]> = {
  customerCommunication: ['outbound'],
  financialActions: ['write', 'sensitive'],
  dataChanges: ['write'],
  externalPublishing: ['outbound'],
  hiringDecisions: ['write', 'sensitive'],
};

/**
 * Convert SensitivityCategory[] to ActionCategory[] for unified filtering.
 */
export function mapSensitivityToActionCategories(categories: SensitivityCategory[]): ActionCategory[] {
  const actionCategories = new Set<ActionCategory>();
  for (const cat of categories) {
    const mapped = SENSITIVITY_TO_ACTION_MAP[cat];
    if (mapped) {
      for (const ac of mapped) actionCategories.add(ac);
    }
  }
  return Array.from(actionCategories);
}

export const FAIL_SECURE_DEFAULT_CATEGORIES: SensitivityCategory[] = [
  'dataChanges',
  'financialActions',
  'customerCommunication',
];
export const FAIL_SECURE_ACTION_CATEGORIES: ActionCategory[] = ['write', 'sensitive', 'destructive'];

export const CLASSIFICATION_SYSTEM_PROMPT = `You are classifying tools for a human-in-the-loop safety system.

Given a tool name and description, determine which sensitivity categories apply.
A tool can have multiple categories. Return empty array only for truly read-only tools.

Categories:
- customerCommunication: Tools that send messages TO external people (customers, candidates, users outside the org). Includes email, SMS, chat replies, job offers.
- financialActions: Tools that create charges, invoices, refunds, subscriptions, or modify pricing/billing.
- dataChanges: Tools that CREATE, UPDATE, or DELETE any data - records, files, emails, tickets, channels, memberships. If it modifies state, it's a data change.
- externalPublishing: Tools that POST CONTENT visible to others - social media posts, Slack/Teams messages, comments on shared documents. NOT structural changes like creating channels.
- hiringDecisions: Tools that affect candidate progression - updating status, scheduling interviews, sending offers, rejecting applications. Any action that moves a candidate forward or backward in the hiring pipeline.

Guidelines:
- Read-only tools (search, get, list, read, fetch) → return empty array
- Draft creation (create_draft, save_draft) → return empty array (drafts aren't sent)
- DELETE operations → always include dataChanges (deletion is destructive)
- Scheduled messages → include externalPublishing (they WILL be published)
- Creating channels/workspaces → dataChanges (structural), NOT externalPublishing
- Inviting users to channels → dataChanges (membership change)
- Sending offers to candidates → BOTH hiringDecisions AND customerCommunication`;

export const VALID_CATEGORIES: SensitivityCategory[] = [
  'customerCommunication',
  'financialActions',
  'dataChanges',
  'externalPublishing',
  'hiringDecisions',
];

export function hashDescription(description: string): string {
  return crypto.createHash('sha256').update(description).digest('hex').substring(0, 12);
}

/** The three-band rule. Exported for the classifier test. */
export function includedByBands(pYes: number, includeT: number, excludeT: number): boolean {
  if (pYes >= includeT) return true;
  if (pYes <= excludeT) return false;
  return true;
}

/**
 * 1b's band rule, fail-secure. `read` is stored only when p(read) clears
 * EFFECT_READ_T AND every sensitivity category came back excluded; otherwise
 * the most restrictive answer at or above EFFECT_T, or null. `unclear` is
 * never stored. Exported for the classifier test.
 */
export function effectClassFromBands(
  probabilities: Readonly<Record<EffectClass, number>>,
  everyCategoryExcluded: boolean,
  effectReadT: number,
  effectT: number,
): StoredEffectClass | null {
  if (everyCategoryExcluded && probabilities.read >= effectReadT) return 'read';
  // Most restrictive first: an irreversible act, then one that leaves the
  // workspace, then a plain write.
  for (const klass of ['destructive', 'outbound', 'write'] as const) {
    if (probabilities[klass] >= effectT) return klass;
  }
  return null;
}

export class ToolClassifier {
  private _db?: typeof pool;
  private _client?: typeof llmClient;

  constructor(db?: typeof pool, client?: typeof llmClient) {
    this._db = db;
    this._client = client;
  }

  private get db(): typeof pool {
    return this._db || pool;
  }

  private get client(): typeof llmClient {
    return this._client || llmClient;
  }

  async classifyWithoutCache(tool: ToolDefinition, ctx?: ClassifyContext): Promise<SensitivityCategory[]> {
    return (await this.classifyTool(tool, ctx)).categories;
  }

  /**
   * Classify one tool: Jev first (Phase 1), the generation prompt when Jev
   * does not answer, the keyword heuristics when the generation fails.
   *
   * Inputs to Jev are the NAME and DESCRIPTION only, so `hashDescription`
   * still describes the input and the cache semantics do not change.
   */
  async classifyTool(tool: ToolDefinition, ctx?: ClassifyContext): Promise<ClassificationResult> {
    const context: ClassifyContext = ctx ?? { purpose: 'tool_classification' };
    const jev = await this.classifyByJev(tool, context);
    if (jev) return jev;
    return this.classifyByGeneration(tool, context);
  }

  /**
   * The contract (replace): per category, p(yes) at or
   * above INCLUDE_T is included, at or below EXCLUDE_T excluded, and anything
   * between is included. A category is omitted only on a confident "no" at
   * the pinned thresholds. Returns null when the kill is off, the vendor is
   * unavailable, the model drifted, or a threshold is unpinned — `ask` covers
   * the last three — and the caller falls to the generation prompt.
   */
  async classifyByJev(tool: ToolDefinition, ctx: ClassifyContext): Promise<ClassificationResult | null> {
    if (!isTypeSafeClassifierEnabled()) return null;
    const result = await ask(
      CLASSIFIER_SET,
      { tool: { name: tool.name, description: tool.description } },
      {
        deadlineMs: 4_000,
        attemptTimeoutMs: 2_500,
        maxRetries: 1,
        purpose: ctx.purpose,
        ...(ctx.tenantId ? { tenantId: ctx.tenantId } : {}),
      },
    );
    if (!result) return null;
    const t = CLASSIFIER_SET.thresholds;
    const categories: SensitivityCategory[] = [];
    let everyCategoryExcluded = true;
    for (const category of CLASSIFIER_CATEGORIES) {
      const p = result.answers[category].probabilities.yes;
      const included = includedByBands(p, t.INCLUDE_T as number, t.EXCLUDE_T as number);
      if (included) { categories.push(category); everyCategoryExcluded = false; }
    }
    const effect = result.answers.effect.probabilities;
    const effectClass = effectClassFromBands(
      effect,
      everyCategoryExcluded,
      t.EFFECT_READ_T as number,
      t.EFFECT_T as number,
    );
    return { categories, effectClass, by: 'jev' };
  }

  /** Today's body: one generation with the classification prompt, the keyword
   *  heuristics on any failure. Carries tenant and purpose so the row reaches
   *  cost attribution (the rows had a null tenant before this). */
  async classifyByGeneration(tool: ToolDefinition, ctx: ClassifyContext): Promise<ClassificationResult> {
    try {
      const response = await this.client.complete({
        messages: [
          { role: 'system', content: CLASSIFICATION_SYSTEM_PROMPT },
          { role: 'user', content: `Tool name: ${tool.name}\nDescription: ${tool.description}` }
        ],
        temperature: 0.1,
        responseSchema: {
          name: 'classify_tool',
          schema: {
            type: 'object',
            properties: {
              categories: {
                type: 'array',
                items: { type: 'string' }
              }
            },
            required: ['categories']
          }
        }
      }, undefined, {
        purpose: ctx.purpose,
        ...(ctx.tenantId ? { tenantId: ctx.tenantId } : {}),
      });

      const { categories } = JSON.parse(response.content);
      return { categories: this.validateCategories(categories), by: 'generation' };
    } catch (error) {
      log.error({ error, toolName: tool.name }, 'Failed to classify tool');
      return { categories: this.getConservativeFallback(tool), by: 'keywords' };
    }
  }

  private getConservativeFallback(tool: ToolDefinition): SensitivityCategory[] {
    const name = tool.name.toLowerCase();
    const categories: SensitivityCategory[] = [];

    if (name.includes('send') || name.includes('email') || name.includes('message')) {
      categories.push('customerCommunication');
    }
    if (name.includes('charge') || name.includes('refund') || name.includes('invoice')) {
      categories.push('financialActions');
    }
    if (name.includes('create') || name.includes('update') || name.includes('delete')) {
      categories.push('dataChanges');
    }
    if (name.includes('post') || name.includes('publish') || name.includes('share')) {
      categories.push('externalPublishing');
    }

    return categories.length > 0 ? categories : ['dataChanges'];
  }

  validateCategories(categories: string[]): SensitivityCategory[] {
    return categories.filter(cat => VALID_CATEGORIES.includes(cat as SensitivityCategory)) as SensitivityCategory[];
  }

  hashDescription(description: string): string {
    return hashDescription(description);
  }

  async getCachedClassification(
    toolName: string,
    integrationType?: string,
    tenantId?: string,
  ): Promise<CachedClassification | null> {
    // Identity is (tool_name, integration_type, tenant), not the name alone: two
    // connectors/servers in one tenant can expose the same tool name. A caller that
    // supplies no integrationType matches only an untyped/global row — never a typed
    // one by name (matching by name alone is what let two sources collide). COALESCE
    // mirrors the unique index (migration 458): a NULL integration_type is one slot.
    if (tenantId) {
      const tenantResult = await this.db.query(
        `SELECT * FROM tool_classification_cache
           WHERE tool_name = $1 AND COALESCE(integration_type, '') = COALESCE($2, '') AND tenant_id = $3`,
        [toolName, integrationType ?? null, tenantId]
      );
      if (tenantResult.rows.length > 0) {
        return this.mapCacheRow(tenantResult.rows[0]);
      }
    }

    const result = await this.db.query(
      `SELECT * FROM tool_classification_cache
         WHERE tool_name = $1 AND COALESCE(integration_type, '') = COALESCE($2, '') AND tenant_id IS NULL`,
      [toolName, integrationType ?? null]
    );

    if (result.rows.length === 0) {
      return null;
    }

    return this.mapCacheRow(result.rows[0]);
  }

  private mapCacheRow(row: any): CachedClassification {
    return {
      toolName: row.tool_name,
      integrationType: row.integration_type,
      toolDescriptionHash: row.tool_description_hash,
      categories: row.categories || [],
      draftVariant: row.draft_variant,
      classifiedAt: new Date(row.classified_at),
      reviewedBy: row.reviewed_by || null,
      isManualOverride: row.is_manual_override || false,
      tenantId: row.tenant_id || null,
      effectClass: STORED_EFFECT_CLASSES.includes(row.effect_class) ? row.effect_class : null,
      classificationVersion: typeof row.classification_version === 'number' ? row.classification_version : null,
    };
  }

  async cacheClassification(
    toolName: string,
    integrationType: string,
    toolDescriptionHash: string,
    categories: SensitivityCategory[],
    draftVariant?: string,
    options?: {
      reviewedBy?: string;
      isManualOverride?: boolean;
      tenantId?: string;
      /** 1b. A manual override may set it too, and wins as it does for
       *  categories. Omitted or null: the column is cleared on a re-write
       *  (a re-classification that produced no confident class must not
       *  leave a stale one deciding). */
      effectClass?: StoredEffectClass | null;
      /** The classification version that produced this row. Omitted on a
       *  manual override, which is not a classification. */
      classificationVersion?: number | null;
    }
  ): Promise<void> {
    await this.db.query(
      `INSERT INTO tool_classification_cache
         (tool_name, integration_type, tool_description_hash, categories, draft_variant, classified_at, reviewed_by, is_manual_override, tenant_id,
          effect_class, classification_version)
       VALUES ($1, $2, $3, $4, $5, NOW(), $6, $7, $8, $9, $10)
       ON CONFLICT (tool_name, COALESCE(integration_type, ''), COALESCE(tenant_id, '__global__')) DO UPDATE SET
         integration_type = EXCLUDED.integration_type,
         tool_description_hash = EXCLUDED.tool_description_hash,
         categories = CASE
           WHEN tool_classification_cache.is_manual_override = true AND EXCLUDED.is_manual_override = false
           THEN tool_classification_cache.categories
           ELSE EXCLUDED.categories
         END,
         effect_class = CASE
           WHEN tool_classification_cache.is_manual_override = true AND EXCLUDED.is_manual_override = false
           THEN tool_classification_cache.effect_class
           ELSE EXCLUDED.effect_class
         END,
         classification_version = CASE
           WHEN tool_classification_cache.is_manual_override = true AND EXCLUDED.is_manual_override = false
           THEN tool_classification_cache.classification_version
           ELSE EXCLUDED.classification_version
         END,
         draft_variant = EXCLUDED.draft_variant,
         classified_at = EXCLUDED.classified_at,
         reviewed_by = COALESCE(EXCLUDED.reviewed_by, tool_classification_cache.reviewed_by),
         is_manual_override = COALESCE(EXCLUDED.is_manual_override, tool_classification_cache.is_manual_override)`,
      [
        toolName,
        integrationType,
        toolDescriptionHash,
        categories,
        draftVariant || null,
        options?.reviewedBy || null,
        options?.isManualOverride || false,
        options?.tenantId || null,
        options?.effectClass ?? null,
        options?.classificationVersion ?? null,
      ]
    );
  }

  /**
   * The effect classes stored for a set of tools under one source identity
   * (1b): one read, keyed by bare tool name. Tools with no confident class
   * are absent. Used by the internal endpoints that hand a custom MCP
   * server's or an external agent's tools to the runtime.
   */
  async getEffectClasses(
    toolNames: readonly string[],
    integrationType: string,
    tenantId?: string,
  ): Promise<Record<string, StoredEffectClass>> {
    if (toolNames.length === 0) return {};
    const result = await this.db.query(
      `SELECT tool_name, effect_class FROM tool_classification_cache
         WHERE tool_name = ANY($1::text[])
           AND COALESCE(integration_type, '') = COALESCE($2, '')
           AND (tenant_id = $3 OR ($3::text IS NULL AND tenant_id IS NULL))
           AND effect_class IS NOT NULL`,
      [toolNames, integrationType, tenantId ?? null],
    );
    const out: Record<string, StoredEffectClass> = {};
    for (const row of result.rows as Array<{ tool_name: string; effect_class: string }>) {
      if (STORED_EFFECT_CLASSES.includes(row.effect_class as StoredEffectClass)) {
        out[row.tool_name] = row.effect_class as StoredEffectClass;
      }
    }
    return out;
  }

  async classifyAndCache(
    tool: ToolDefinition,
    integrationType: string,
    draftVariant?: string,
    options?: { tenantId?: string }
  ): Promise<SensitivityCategory[]> {
    const descriptionHash = this.hashDescription(tool.description);

    const cached = await this.getCachedClassification(tool.name, integrationType, options?.tenantId);

    if (cached && cached.isManualOverride) {
      return cached.categories;
    }

    if (cached && cached.toolDescriptionHash === descriptionHash) {
      return cached.categories;
    }

    const classified = await this.classifyTool(tool, {
      purpose: 'tool_classification',
      ...(options?.tenantId ? { tenantId: options.tenantId } : {}),
    });
    const llmCategories = classified.categories;

    await this.cacheClassification(tool.name, integrationType, descriptionHash, llmCategories, draftVariant, {
      tenantId: options?.tenantId,
      effectClass: classified.effectClass ?? null,
      classificationVersion: classified.by === 'jev' ? CLASSIFICATION_VERSION : null,
    });

    if (cached && JSON.stringify(cached.categories) !== JSON.stringify(llmCategories)) {
      log.warn({ toolName: tool.name, old: cached.categories, new: llmCategories }, 'Classification changed');
    }

    log.info({ toolName: tool.name, categories: llmCategories }, 'Tool classified');

    return llmCategories;
  }

  async classifyIntegrationTools(
    integrationId: string,
    integrationType: string,
    tools: ToolDefinition[],
    draftVariantMap?: Record<string, string>
  ): Promise<Map<string, SensitivityCategory[]>> {
    const results = new Map<string, SensitivityCategory[]>();

    for (const tool of tools) {
      const draftVariant = draftVariantMap?.[tool.name];
      const categories = await this.classifyAndCache(tool, integrationType, draftVariant);
      results.set(tool.name, categories);
    }

    return results;
  }

  async getToolCategories(toolName: string, integrationType?: string, tenantId?: string): Promise<SensitivityCategory[]> {
    const cached = await this.getCachedClassification(toolName, integrationType, tenantId);
    return cached?.categories || [];
  }

  async getDraftVariant(toolName: string, integrationType?: string, tenantId?: string): Promise<string | null> {
    const cached = await this.getCachedClassification(toolName, integrationType, tenantId);
    return cached?.draftVariant || null;
  }

  async isReviewed(toolName: string, integrationType?: string, tenantId?: string): Promise<boolean> {
    const cached = await this.getCachedClassification(toolName, integrationType, tenantId);
    return cached?.reviewedBy !== null && cached?.reviewedBy !== undefined;
  }

  async setManualOverride(
    toolName: string,
    integrationType: string,
    categories: SensitivityCategory[],
    reviewedBy: string,
    tenantId?: string,
    effectClass?: StoredEffectClass | null,
  ): Promise<void> {
    // Write under the connector's REAL integration_type, not a 'manual' sentinel.
    // Identity is (tool_name, integration_type, tenant) — migration 458 — and the
    // reads qualify by integration_type, so an override stored under 'manual' is
    // invisible to getCachedClassification(toolName, <connectorType>, tenant): the
    // review would never take effect. Manual-ness is carried by is_manual_override
    // / reviewed_by, which are orthogonal to identity; conflating the two into
    // integration_type is what hid the override.
    const descriptionHash = '';
    await this.cacheClassification(
      toolName, integrationType, descriptionHash, categories, undefined,
      { reviewedBy, isManualOverride: true, tenantId, effectClass: effectClass ?? null },
    );
    log.info({ toolName, integrationType, categories, effectClass: effectClass ?? null, reviewedBy, tenantId }, 'Manual classification override set');
  }

  async invalidateCache(toolName: string): Promise<void> {
    await this.db.query(
      `DELETE FROM tool_classification_cache WHERE tool_name = $1`,
      [toolName]
    );
  }
}

export const toolClassifier = new ToolClassifier();
