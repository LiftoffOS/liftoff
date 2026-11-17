// Box Connector Normalizer
// Per Section 12: Connector ingestion - normalizes Box API responses

import { z } from 'zod';
import type { JSONSchema7 } from 'json-schema';
import { ConnectorNormalizer, NormalizedRecord } from './types.js';
import { buildEntitySchemas } from './zod-helpers.js';
import { hashCanonicalJson } from '../infra/idempotency.js';

const BoxSharedLinkSchema = z.object({
  url: z.string().optional(),
  downloadUrl: z.string().optional(),
  access: z.string().optional(),
  effectiveAccess: z.string().optional(),
  isPasswordEnabled: z.boolean().optional(),
  downloadCount: z.number().optional(),
  previewCount: z.number().optional(),
});

const BoxPermissionsSchema = z.object({
  canDownload: z.boolean().optional(),
  canPreview: z.boolean().optional(),
  canUpload: z.boolean().optional(),
  canComment: z.boolean().optional(),
  canRename: z.boolean().optional(),
  canDelete: z.boolean().optional(),
  canShare: z.boolean().optional(),
});

const BoxItemDataSchema = z.object({
  id: z.string().describe('Box item id.'),
  name: z.string(),
  description: z.string().optional(),
  size: z.number().optional(),
  type: z.string(),
  itemStatus: z.string().optional(),
  isTrashed: z.boolean(),
  versionNumber: z.string().optional(),
  sequenceId: z.string().optional(),
  sha1: z.string().optional(),
  parent: z.object({ id: z.string(), name: z.string().optional() }).optional(),
  pathCollection: z.array(z.object({ id: z.string(), name: z.string() })).optional(),
  createdBy: z.object({ id: z.string(), name: z.string().optional(), login: z.string().optional() }).optional(),
  modifiedBy: z.object({ id: z.string(), name: z.string().optional(), login: z.string().optional() }).optional(),
  ownedBy: z.object({ id: z.string(), name: z.string().optional(), login: z.string().optional() }).optional(),
  sharedLink: BoxSharedLinkSchema.optional(),
  permissions: BoxPermissionsSchema.optional(),
  childCount: z.number().optional(),
  tags: z.array(z.string()).optional(),
  commentCount: z.number().optional(),
  createdAt: z.string().optional(),
  modifiedAt: z.string().optional().describe('Last modification timestamp.'),
  trashedAt: z.string().optional(),
  contentCreatedAt: z.string().optional(),
  contentModifiedAt: z.string().optional(),
  eventType: z.string().optional(),
  eventId: z.string().optional(),
  eventCreatedAt: z.string().optional(),
});

// Box item (file/folder) structure
interface BoxItem {
  type: 'file' | 'folder' | 'web_link';
  id: string;
  etag?: string;
  name: string;
  description?: string;
  size?: number;
  created_at?: string;
  modified_at?: string;
  trashed_at?: string;
  purged_at?: string;
  content_created_at?: string;
  content_modified_at?: string;
  sequence_id?: string;
  sha1?: string;
  parent?: {
    type: string;
    id: string;
    name?: string;
    etag?: string;
    sequence_id?: string;
  };
  path_collection?: {
    total_count: number;
    entries: Array<{
      type: string;
      id: string;
      name: string;
      etag?: string;
      sequence_id?: string;
    }>;
  };
  created_by?: {
    type: string;
    id: string;
    name?: string;
    login?: string;
  };
  modified_by?: {
    type: string;
    id: string;
    name?: string;
    login?: string;
  };
  owned_by?: {
    type: string;
    id: string;
    name?: string;
    login?: string;
  };
  shared_link?: {
    url?: string;
    download_url?: string;
    access?: string;
    effective_access?: string;
    effective_permission?: string;
    is_password_enabled?: boolean;
    unshared_at?: string;
    download_count?: number;
    preview_count?: number;
  };
  item_status?: string;
  version_number?: string;
  comment_count?: number;
  permissions?: {
    can_download?: boolean;
    can_preview?: boolean;
    can_upload?: boolean;
    can_comment?: boolean;
    can_rename?: boolean;
    can_delete?: boolean;
    can_share?: boolean;
    can_set_share_access?: boolean;
  };
  tags?: string[];
  item_collection?: {
    total_count: number;
    entries: BoxItem[];
  };
}

// Box list response
interface BoxListResponse {
  total_count: number;
  entries: BoxItem[];
  offset?: number;
  limit?: number;
  order?: Array<{
    by: string;
    direction: string;
  }>;
}

// Box events response
interface BoxEventsResponse {
  chunk_size: number;
  next_stream_position: string;
  entries: Array<{
    type: string;
    event_id: string;
    event_type: string;
    created_at: string;
    source: BoxItem;
    created_by?: {
      type: string;
      id: string;
      name?: string;
      login?: string;
    };
  }>;
}

type BoxPayload = BoxItem | BoxListResponse | BoxEventsResponse;

export class BoxNormalizer implements ConnectorNormalizer {
  connectorType = 'box';

  entitySchemas: Record<string, JSONSchema7> = buildEntitySchemas({
    File: BoxItemDataSchema,
    Folder: BoxItemDataSchema,
    WebLink: BoxItemDataSchema,
  });

  normalize(payload: unknown): NormalizedRecord[] {
    const records: NormalizedRecord[] = [];
    const boxPayload = payload as BoxPayload;

    // Handle list response
    if (this.isListResponse(boxPayload)) {
      for (const item of boxPayload.entries) {
        records.push(this.normalizeItem(item));
      }
      return records;
    }

    // Handle events response
    if (this.isEventsResponse(boxPayload)) {
      for (const event of boxPayload.entries) {
        if (event.source) {
          const record = this.normalizeItem(event.source);
          record.data.eventType = event.event_type;
          record.data.eventId = event.event_id;
          record.data.eventCreatedAt = event.created_at;
          records.push(record);
        }
      }
      return records;
    }

    // Handle single item
    if (this.isItem(boxPayload)) {
      records.push(this.normalizeItem(boxPayload));
      return records;
    }

    return records;
  }

  private normalizeItem(item: BoxItem): NormalizedRecord {
    const entityType = this.getEntityType(item);

    return {
      entityType,
      externalId: item.id,
      data: BoxItemDataSchema.parse({
        id: item.id,
        // Core data
        name: item.name,
        description: item.description,
        size: item.size,
        type: item.type,

        // Status
        itemStatus: item.item_status,
        isTrashed: !!item.trashed_at,

        // Versioning
        versionNumber: item.version_number,
        sequenceId: item.sequence_id,
        sha1: item.sha1,

        // Location
        parent: item.parent
          ? {
              id: item.parent.id,
              name: item.parent.name,
            }
          : undefined,
        pathCollection: item.path_collection?.entries?.map((e) => ({
          id: e.id,
          name: e.name,
        })),

        // Ownership
        createdBy: item.created_by
          ? {
              id: item.created_by.id,
              name: item.created_by.name,
              login: item.created_by.login,
            }
          : undefined,
        modifiedBy: item.modified_by
          ? {
              id: item.modified_by.id,
              name: item.modified_by.name,
              login: item.modified_by.login,
            }
          : undefined,
        ownedBy: item.owned_by
          ? {
              id: item.owned_by.id,
              name: item.owned_by.name,
              login: item.owned_by.login,
            }
          : undefined,

        // Sharing
        sharedLink: item.shared_link
          ? {
              url: item.shared_link.url,
              downloadUrl: item.shared_link.download_url,
              access: item.shared_link.access,
              effectiveAccess: item.shared_link.effective_access,
              isPasswordEnabled: item.shared_link.is_password_enabled,
              downloadCount: item.shared_link.download_count,
              previewCount: item.shared_link.preview_count,
            }
          : undefined,

        // Permissions
        permissions: item.permissions
          ? {
              canDownload: item.permissions.can_download,
              canPreview: item.permissions.can_preview,
              canUpload: item.permissions.can_upload,
              canComment: item.permissions.can_comment,
              canRename: item.permissions.can_rename,
              canDelete: item.permissions.can_delete,
              canShare: item.permissions.can_share,
            }
          : undefined,

        // Folder specific
        childCount: item.item_collection?.total_count,

        // Metadata
        tags: item.tags,
        commentCount: item.comment_count,

        // Timestamps
        createdAt: item.created_at,
        modifiedAt: item.modified_at,
        trashedAt: item.trashed_at,
        contentCreatedAt: item.content_created_at,
        contentModifiedAt: item.content_modified_at,
      }),
      metadata: {
        source: 'box',
        syncedAt: new Date(),
        version: item.etag ?? hashCanonicalJson(item),
      },
    };
  }

  private getEntityType(item: BoxItem): string {
    switch (item.type) {
      case 'folder':
        return 'Folder';
      case 'web_link':
        return 'WebLink';
      case 'file':
      default:
        return 'File';
    }
  }

  extractEntityType(record: unknown): string {
    const r = record as BoxPayload;
    if (this.isListResponse(r)) return 'ItemList';
    if (this.isEventsResponse(r)) return 'EventList';
    if (this.isItem(r)) return this.getEntityType(r);
    return 'Unknown';
  }

  extractExternalId(record: unknown): string {
    const r = record as BoxPayload;
    if (this.isItem(r)) return r.id;
    return '';
  }

  extractVersion(record: unknown): string | undefined {
    const r = record as BoxPayload;
    if (this.isItem(r)) return r.etag;
    return undefined;
  }

  private isListResponse(payload: BoxPayload): payload is BoxListResponse {
    return 'entries' in payload && 'total_count' in payload && !('chunk_size' in payload);
  }

  private isEventsResponse(payload: BoxPayload): payload is BoxEventsResponse {
    return 'entries' in payload && 'chunk_size' in payload && 'next_stream_position' in payload;
  }

  private isItem(payload: BoxPayload): payload is BoxItem {
    return 'type' in payload && 'id' in payload && 'name' in payload && !('entries' in payload);
  }
}
