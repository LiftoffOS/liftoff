// Archival Service Types
// GAP-022 FIX: Define archival interfaces

export interface ArchivedItem {
  id: string;
  tenantId: string;
  entityType: ArchivalEntityType;
  entityId: string;
  archivedAt: Date;
  expiresAt: Date | null;
  gcsPath: string;
  size: number;
  metadata: Record<string, unknown>;
  retentionPolicy: RetentionPolicy;
}

export type ArchivalEntityType =
  | 'workflow'
  | 'task'
  | 'action'
  | 'connector_payload'
  | 'audit_log'
  | 'reflection_data'
  | 'agent_snapshot';

export interface RetentionPolicy {
  id: string;
  name: string;
  retentionDays: number;
  entityTypes: ArchivalEntityType[];
  archiveAfterDays: number;
  deleteAfterArchival: boolean;
  compressOnArchive: boolean;
}

export interface ArchivalJob {
  id: string;
  tenantId: string;
  status: 'pending' | 'running' | 'completed' | 'failed';
  entityType: ArchivalEntityType;
  itemsProcessed: number;
  itemsArchived: number;
  itemsDeleted: number;
  errors: string[];
  startedAt: Date;
  completedAt: Date | null;
}

export interface CleanupJob {
  id: string;
  tenantId: string | null; // null for global cleanup
  status: 'pending' | 'running' | 'completed' | 'failed';
  itemsScanned: number;
  itemsDeleted: number;
  spaceFreed: number;
  errors: string[];
  startedAt: Date;
  completedAt: Date | null;
}

export interface ArchivalStats {
  tenantId: string;
  totalArchivedItems: number;
  totalArchivedSize: number;
  byEntityType: Record<ArchivalEntityType, {
    count: number;
    size: number;
    oldestItem: Date | null;
    newestItem: Date | null;
  }>;
  lastArchivalAt: Date | null;
  lastCleanupAt: Date | null;
}

export interface ArchiveInput {
  tenantId: string;
  entityType: ArchivalEntityType;
  entityId: string;
  data: unknown;
  metadata?: Record<string, unknown>;
  retentionDays?: number;
}

export interface RestoreInput {
  archiveId: string;
  targetLocation?: 'database' | 'memory';
}
