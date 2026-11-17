// Dropbox Connector Normalizer
// Per Section 12: Connector ingestion - normalizes Dropbox API responses

import { z } from 'zod';
import type { JSONSchema7 } from 'json-schema';
import { ConnectorNormalizer, NormalizedRecord } from './types.js';
import { buildEntitySchemas } from './zod-helpers.js';
import { hashCanonicalJson } from '../infra/idempotency.js';

const FileLikeDataSchema = z.object({
  id: z.string().describe('Dropbox file/folder id.'),
  name: z.string(),
  pathLower: z.string().optional(),
  pathDisplay: z.string().optional(),
  isFolder: z.boolean(),
  isDeleted: z.boolean(),
  isDownloadable: z.boolean().optional(),
  size: z.number().optional(),
  contentHash: z.string().optional(),
  parentSharedFolderId: z.string().optional(),
  hasExplicitSharedMembers: z.boolean().optional(),
  sharingInfo: z.object({
    readOnly: z.boolean().optional(),
    parentSharedFolderId: z.string().optional(),
    modifiedBy: z.string().optional(),
  }).optional(),
  propertyGroups: z.array(z.object({
    templateId: z.string(),
    fields: z.array(z.object({ name: z.string(), value: z.string() })),
  })).optional(),
  clientModifiedAt: z.string().optional(),
  serverModifiedAt: z.string().optional().describe('Server-side modification timestamp.'),
});

// Dropbox file/folder metadata
interface DropboxMetadata {
  '.tag': 'file' | 'folder' | 'deleted';
  id: string;
  name: string;
  path_lower?: string;
  path_display?: string;
  parent_shared_folder_id?: string;
  client_modified?: string;
  server_modified?: string;
  rev?: string;
  size?: number;
  is_downloadable?: boolean;
  content_hash?: string;
  sharing_info?: {
    read_only?: boolean;
    parent_shared_folder_id?: string;
    modified_by?: string;
  };
  has_explicit_shared_members?: boolean;
  property_groups?: Array<{
    template_id: string;
    fields: Array<{
      name: string;
      value: string;
    }>;
  }>;
}

// Dropbox list folder response
interface DropboxListFolderResponse {
  entries: DropboxMetadata[];
  cursor: string;
  has_more: boolean;
}

// Dropbox delta/longpoll response
interface DropboxDeltaResponse {
  entries: DropboxMetadata[];
  cursor: string;
  has_more: boolean;
}

type DropboxPayload = DropboxMetadata | DropboxListFolderResponse | DropboxDeltaResponse;

export class DropboxNormalizer implements ConnectorNormalizer {
  connectorType = 'dropbox';

  entitySchemas: Record<string, JSONSchema7> = buildEntitySchemas({
    File: FileLikeDataSchema,
    Folder: FileLikeDataSchema,
    DeletedItem: FileLikeDataSchema,
  });

  normalize(payload: unknown): NormalizedRecord[] {
    const records: NormalizedRecord[] = [];
    const dropboxPayload = payload as DropboxPayload;

    // Handle list response
    if (this.isListResponse(dropboxPayload)) {
      for (const entry of dropboxPayload.entries) {
        records.push(this.normalizeEntry(entry));
      }
      return records;
    }

    // Handle single entry
    if (this.isEntry(dropboxPayload)) {
      records.push(this.normalizeEntry(dropboxPayload));
      return records;
    }

    return records;
  }

  private normalizeEntry(entry: DropboxMetadata): NormalizedRecord {
    const entityType = this.getEntityType(entry);

    return {
      entityType,
      externalId: entry.id,
      data: FileLikeDataSchema.parse({
        id: entry.id,
        // Core data
        name: entry.name,
        pathLower: entry.path_lower,
        pathDisplay: entry.path_display,

        // Type info
        isFolder: entry['.tag'] === 'folder',
        isDeleted: entry['.tag'] === 'deleted',
        isDownloadable: entry.is_downloadable,

        // Size
        size: entry.size,

        // Content hash for file integrity
        contentHash: entry.content_hash,

        // Sharing
        parentSharedFolderId: entry.parent_shared_folder_id,
        hasExplicitSharedMembers: entry.has_explicit_shared_members,
        sharingInfo: entry.sharing_info
          ? {
              readOnly: entry.sharing_info.read_only,
              parentSharedFolderId: entry.sharing_info.parent_shared_folder_id,
              modifiedBy: entry.sharing_info.modified_by,
            }
          : undefined,

        // Property groups (custom metadata)
        propertyGroups: entry.property_groups?.map((pg) => ({
          templateId: pg.template_id,
          fields: pg.fields,
        })),

        // Timestamps
        clientModifiedAt: entry.client_modified,
        serverModifiedAt: entry.server_modified,
      }),
      metadata: {
        source: 'dropbox',
        syncedAt: new Date(),
        version: entry.rev ?? hashCanonicalJson(entry),
      },
    };
  }

  private getEntityType(entry: DropboxMetadata): string {
    switch (entry['.tag']) {
      case 'folder':
        return 'Folder';
      case 'deleted':
        return 'DeletedItem';
      case 'file':
      default:
        return 'File';
    }
  }

  extractEntityType(record: unknown): string {
    const r = record as DropboxPayload;
    if (this.isListResponse(r)) return 'EntryList';
    if (this.isEntry(r)) return this.getEntityType(r);
    return 'Unknown';
  }

  extractExternalId(record: unknown): string {
    const r = record as DropboxPayload;
    if (this.isEntry(r)) return r.id;
    return '';
  }

  extractVersion(record: unknown): string | undefined {
    const r = record as DropboxPayload;
    if (this.isEntry(r)) return r.rev;
    return undefined;
  }

  private isListResponse(payload: DropboxPayload): payload is DropboxListFolderResponse {
    return 'entries' in payload && 'cursor' in payload && 'has_more' in payload;
  }

  private isEntry(payload: DropboxPayload): payload is DropboxMetadata {
    return '.tag' in payload && 'id' in payload && 'name' in payload;
  }
}
