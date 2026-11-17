// Internal Agent Oversight Service
// Per implementation plan: Phase 1.2 Oversight Settings with versioning

import { pool, withTenantScope } from '../infrastructure/database';
import { log } from '../infrastructure/logging';
import { publishEvent } from '../events/publisher';
import {
  OversightSettings,
  UpdateOversightSettingsInput,
  OversightSettingsVersion,
  OversightVersionSource,
  AutonomyLevel,
  EscalationLevel,
  CommunicationMode,
  SensitiveWorkConfig,
  DEFAULT_SENSITIVE_WORK,
} from './types';

// 5-minute TTL cache — oversight settings change rarely; avoid a Postgres
// round-trip on every chat turn when resolving effective autonomy.
const OVERSIGHT_CACHE_TTL_MS = 5 * 60 * 1000;
interface OversightCacheEntry { settings: OversightSettings; cachedAt: number }
const oversightCache = new Map<string, OversightCacheEntry>();

/** An absent or unparseable value reads as 1: today's behaviour. */
function parseSemantics(raw: unknown): number {
  const n = typeof raw === 'number' ? raw : Number(raw);
  return Number.isInteger(n) && n >= 1 ? n : 1;
}

export class OversightService {
  // Invalidate the cache entry for a tenant (called on any settings write).
  private invalidateCache(tenantId: string): void {
    oversightCache.delete(tenantId);
  }

  // Get oversight settings for a tenant
  async getOversightSettings(tenantId: string): Promise<OversightSettings | null> {
    const cached = oversightCache.get(tenantId);
    if (cached && Date.now() - cached.cachedAt < OVERSIGHT_CACHE_TTL_MS) {
      return cached.settings;
    }
    const result = await withTenantScope(tenantId, (client) => client.query(
      `SELECT * FROM internal_agent_oversight_settings WHERE tenant_id = $1`,
      [tenantId]
    ));

    if (result.rows.length === 0) {
      return null;
    }

    const settings = this.mapSettings(result.rows[0]);
    oversightCache.set(tenantId, { settings, cachedAt: Date.now() });
    return settings;
  }

  // Get or create default oversight settings
  async getOrCreateOversightSettings(tenantId: string, createdBy?: string): Promise<OversightSettings> {
    const existing = await this.getOversightSettings(tenantId);
    if (existing) {
      return existing;
    }

    // Create default settings
    // A new workspace starts on the current meaning of both settings
    // (migration 508): there is no earlier behaviour to keep.
    const result = await withTenantScope(tenantId, (client) => client.query(
      `INSERT INTO internal_agent_oversight_settings
         (tenant_id, current_version, autonomy, escalation, sensitive_work, communication,
          escalation_semantics, communication_semantics)
       VALUES ($1, 1, 'balanced', 'important', $2, 'review', 2, 2)
       RETURNING *`,
      [tenantId, JSON.stringify(DEFAULT_SENSITIVE_WORK)]
    ));

    const settings = this.mapSettings(result.rows[0]);
    oversightCache.set(tenantId, { settings, cachedAt: Date.now() });

    // Create initial version
    await this.createVersion(settings, 'create', createdBy);

    log.info({ tenantId }, 'Created default oversight settings');

    return settings;
  }

  // Update oversight settings with versioning
  async updateOversightSettings(
    tenantId: string,
    input: UpdateOversightSettingsInput,
    userId?: string
  ): Promise<OversightSettings> {
    // Get current settings (or create if missing)
    let current = await this.getOversightSettings(tenantId);
    if (!current) {
      current = await this.getOrCreateOversightSettings(tenantId, userId);
    }

    const newVersion = current.currentVersion + 1;

    // Merge sensitive work updates
    const newSensitiveWork: SensitiveWorkConfig = input.sensitiveWork
      ? { ...current.sensitiveWork, ...input.sensitiveWork }
      : current.sensitiveWork;

    // Each semantics column moves to 2 ONLY on a save whose input names its
    // own setting (migration 508). The patch is partial — `input.x ??
    // current.x` per field — so an autonomy-only or sensitive-work-only save
    // bumps neither, and a save of Escalation alone never switches what
    // Communication means.
    const escalationSemantics = input.escalation !== undefined ? 2 : current.escalationSemantics;
    const communicationSemantics = input.communication !== undefined ? 2 : current.communicationSemantics;

    // Update current settings
    const result = await withTenantScope(tenantId, (client) => client.query(
      `UPDATE internal_agent_oversight_settings SET
        current_version = $2,
        autonomy = $3,
        escalation = $4,
        sensitive_work = $5,
        communication = $6,
        escalation_semantics = $7,
        communication_semantics = $8,
        updated_at = NOW()
       WHERE tenant_id = $1
       RETURNING *`,
      [
        tenantId,
        newVersion,
        input.autonomy ?? current.autonomy,
        input.escalation ?? current.escalation,
        JSON.stringify(newSensitiveWork),
        input.communication ?? current.communication,
        escalationSemantics,
        communicationSemantics,
      ]
    ));

    const settings = this.mapSettings(result.rows[0]);
    this.invalidateCache(tenantId);

    // Create version snapshot for audit trail
    await this.createVersion(settings, 'manual', userId);

    // Publish event to sync to tenant-runtime
    await publishEvent({
      entityType: 'oversight',
      entityId: tenantId,
      eventType: 'tenant.oversight.updated',
      entityVersion: newVersion,
      eventVersion: 1,
      tenantId,
      payload: {
        autonomy: settings.autonomy,
        escalation: settings.escalation,
        sensitiveWork: settings.sensitiveWork,
        communication: settings.communication,
        escalationSemantics: settings.escalationSemantics,
        communicationSemantics: settings.communicationSemantics,
      },
    });

    log.info({ tenantId, version: newVersion }, 'Oversight settings updated');

    return settings;
  }

  // Get version history
  async getVersions(tenantId: string): Promise<OversightSettingsVersion[]> {
    const result = await withTenantScope(tenantId, (client) => client.query(
      `SELECT * FROM internal_agent_oversight_settings_versions
       WHERE tenant_id = $1
       ORDER BY version DESC`,
      [tenantId]
    ));

    return result.rows.map(row => this.mapVersion(row));
  }

  // Get a specific version
  async getVersion(tenantId: string, version: number): Promise<OversightSettingsVersion | null> {
    const result = await withTenantScope(tenantId, (client) => client.query(
      `SELECT * FROM internal_agent_oversight_settings_versions
       WHERE tenant_id = $1 AND version = $2`,
      [tenantId, version]
    ));

    if (result.rows.length === 0) {
      return null;
    }

    return this.mapVersion(result.rows[0]);
  }

  // Rollback to a specific version
  async rollbackToVersion(
    tenantId: string,
    targetVersion: number,
    userId?: string
  ): Promise<OversightSettings | null> {
    const version = await this.getVersion(tenantId, targetVersion);
    if (!version) {
      return null;
    }

    return this.updateOversightSettings(
      tenantId,
      {
        autonomy: version.autonomy,
        escalation: version.escalation,
        sensitiveWork: version.sensitiveWork,
        communication: version.communication,
      },
      userId
    );
  }

  // Create a version snapshot
  private async createVersion(
    settings: OversightSettings,
    source: OversightVersionSource,
    createdBy?: string
  ): Promise<void> {
    await withTenantScope(settings.tenantId, (client) => client.query(
      `INSERT INTO internal_agent_oversight_settings_versions
        (tenant_id, version, autonomy, escalation, sensitive_work, communication, source, created_by,
         escalation_semantics, communication_semantics)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [
        settings.tenantId,
        settings.currentVersion,
        settings.autonomy,
        settings.escalation,
        JSON.stringify(settings.sensitiveWork),
        settings.communication,
        source,
        createdBy || null,
        settings.escalationSemantics,
        settings.communicationSemantics,
      ]
    ));
  }

  // Map database row to OversightSettings
  private mapSettings(row: Record<string, unknown>): OversightSettings {
    return {
      tenantId: row.tenant_id as string,
      currentVersion: row.current_version as number,
      autonomy: row.autonomy as AutonomyLevel,
      escalation: row.escalation as EscalationLevel,
      sensitiveWork: this.parseSensitiveWork(row.sensitive_work),
      communication: row.communication as CommunicationMode,
      escalationSemantics: parseSemantics(row.escalation_semantics),
      communicationSemantics: parseSemantics(row.communication_semantics),
      createdAt: new Date(row.created_at as string),
      updatedAt: new Date(row.updated_at as string),
    };
  }

  // Map database row to OversightSettingsVersion
  private mapVersion(row: Record<string, unknown>): OversightSettingsVersion {
    return {
      id: row.id as string,
      tenantId: row.tenant_id as string,
      version: row.version as number,
      autonomy: row.autonomy as AutonomyLevel,
      escalation: row.escalation as EscalationLevel,
      sensitiveWork: this.parseSensitiveWork(row.sensitive_work),
      communication: row.communication as CommunicationMode,
      escalationSemantics: parseSemantics(row.escalation_semantics),
      communicationSemantics: parseSemantics(row.communication_semantics),
      source: row.source as OversightVersionSource,
      createdBy: row.created_by as string | null,
      createdAt: new Date(row.created_at as string),
    };
  }

  /** Parse sensitive work JSON, filling any category the row does not carry.
   *
   *  This used to cast the column straight through: `return raw as
   *  SensitiveWorkConfig`. The type promises six booleans, the column holds
   *  whatever was written when the row was created, and the cast asserted the
   *  difference away — so every category added after a tenant's row was written
   *  read back `undefined`, which is falsy, which is OFF.
   *
   *  `mergeToMain` is the one that made it visible: the Liftoff workspace had
   *  five categories on and no mergeToMain key at all, so the control that
   *  governs merging to a default branch was off while the page implied it was
   *  configurable. Nobody turned it off. It was never on.
   *
   *  Merging over the defaults fixes the whole class rather than that one key —
   *  the NEXT category added lands enabled for existing tenants too, instead of
   *  waiting silently for someone to open the page. An explicit `false` in the
   *  row still wins, because a category a tenant has actually switched off is a
   *  decision and this must not overturn it.
   */
  private parseSensitiveWork(raw: unknown): SensitiveWorkConfig {
    if (!raw) {
      return DEFAULT_SENSITIVE_WORK;
    }
    if (typeof raw === 'object') {
      return { ...DEFAULT_SENSITIVE_WORK, ...(raw as Partial<SensitiveWorkConfig>) };
    }
    try {
      return {
        ...DEFAULT_SENSITIVE_WORK,
        ...(JSON.parse(raw as string) as Partial<SensitiveWorkConfig>),
      };
    } catch {
      return DEFAULT_SENSITIVE_WORK;
    }
  }
}

export const oversightService = new OversightService();
