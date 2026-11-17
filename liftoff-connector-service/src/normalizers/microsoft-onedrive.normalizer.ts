// Microsoft OneDrive Connector Normalizer
// Per Section 12: Connector ingestion - normalizes Microsoft Graph API responses

import { z } from 'zod';
import type { JSONSchema7 } from 'json-schema';
import { ConnectorNormalizer, NormalizedRecord } from './types.js';
import { buildEntitySchemas } from './zod-helpers.js';
import { hashCanonicalJson } from '../infra/idempotency.js';

const OneDriveItemDataSchema = z.object({
  id: z.string().describe('OneDrive item id.'),
  name: z.string(),
  description: z.string().optional(),
  size: z.number().optional(),
  mimeType: z.string().optional(),
  isFolder: z.boolean(),
  childCount: z.number().optional(),
  webUrl: z.string().optional(),
  downloadUrl: z.string().optional(),
  parentId: z.string().optional(),
  parentPath: z.string().optional(),
  driveId: z.string().optional(),
  createdBy: z.object({ email: z.string().optional(), displayName: z.string().optional() }).optional(),
  lastModifiedBy: z.object({ email: z.string().optional(), displayName: z.string().optional() }).optional(),
  shared: z.boolean(),
  sharedOwner: z.object({ email: z.string().optional(), displayName: z.string().optional() }).optional(),
  shareScope: z.string().optional(),
  sha1Hash: z.string().optional(),
  sha256Hash: z.string().optional(),
  createdAt: z.string().optional(),
  modifiedAt: z.string().optional().describe('Last modification timestamp.'),
});

// Microsoft OneDrive DriveItem structure
interface OneDriveItem {
  id: string;
  name: string;
  description?: string;
  size?: number;
  createdDateTime?: string;
  lastModifiedDateTime?: string;
  webUrl?: string;
  file?: {
    mimeType?: string;
    hashes?: {
      sha1Hash?: string;
      sha256Hash?: string;
      quickXorHash?: string;
    };
  };
  folder?: {
    childCount?: number;
  };
  parentReference?: {
    id?: string;
    path?: string;
    driveId?: string;
  };
  createdBy?: {
    user?: {
      id?: string;
      email?: string;
      displayName?: string;
    };
  };
  lastModifiedBy?: {
    user?: {
      id?: string;
      email?: string;
      displayName?: string;
    };
  };
  shared?: {
    owner?: {
      user?: {
        email?: string;
        displayName?: string;
      };
    };
    scope?: string;
  };
  '@microsoft.graph.downloadUrl'?: string;
  eTag?: string;
}

// OneDrive list response
interface OneDriveListResponse {
  '@odata.context'?: string;
  '@odata.nextLink'?: string;
  value: OneDriveItem[];
}

// Delta response for changes
interface OneDriveDeltaResponse {
  '@odata.context'?: string;
  '@odata.nextLink'?: string;
  '@odata.deltaLink'?: string;
  value: OneDriveItem[];
}

type OneDrivePayload = OneDriveItem | OneDriveListResponse | OneDriveDeltaResponse;

export class MicrosoftOneDriveNormalizer implements ConnectorNormalizer {
  connectorType = 'microsoft_onedrive';

  entitySchemas: Record<string, JSONSchema7> = buildEntitySchemas({
    File: OneDriveItemDataSchema,
    Folder: OneDriveItemDataSchema,
  });

  normalize(payload: unknown): NormalizedRecord[] {
    const records: NormalizedRecord[] = [];
    const drivePayload = payload as OneDrivePayload;

    // Handle list response
    if (this.isListResponse(drivePayload)) {
      for (const item of drivePayload.value) {
        records.push(this.normalizeItem(item));
      }
      return records;
    }

    // Handle single item
    if (this.isItem(drivePayload)) {
      records.push(this.normalizeItem(drivePayload));
      return records;
    }

    return records;
  }

  private normalizeItem(item: OneDriveItem): NormalizedRecord {
    const entityType = item.folder ? 'Folder' : 'File';

    return {
      entityType,
      externalId: item.id,
      data: OneDriveItemDataSchema.parse({
        id: item.id,
        // Core item data
        name: item.name,
        description: item.description,
        size: item.size,

        // File specific
        mimeType: item.file?.mimeType,
        isFolder: !!item.folder,
        childCount: item.folder?.childCount,

        // Links
        webUrl: item.webUrl,
        downloadUrl: item['@microsoft.graph.downloadUrl'],

        // Location
        parentId: item.parentReference?.id,
        parentPath: item.parentReference?.path,
        driveId: item.parentReference?.driveId,

        // Ownership
        createdBy: item.createdBy?.user
          ? {
              email: item.createdBy.user.email,
              displayName: item.createdBy.user.displayName,
            }
          : undefined,
        lastModifiedBy: item.lastModifiedBy?.user
          ? {
              email: item.lastModifiedBy.user.email,
              displayName: item.lastModifiedBy.user.displayName,
            }
          : undefined,

        // Sharing
        shared: !!item.shared,
        sharedOwner: item.shared?.owner?.user
          ? {
              email: item.shared.owner.user.email,
              displayName: item.shared.owner.user.displayName,
            }
          : undefined,
        shareScope: item.shared?.scope,

        // Hashes
        sha1Hash: item.file?.hashes?.sha1Hash,
        sha256Hash: item.file?.hashes?.sha256Hash,

        // Timestamps
        createdAt: item.createdDateTime,
        modifiedAt: item.lastModifiedDateTime,
      }),
      metadata: {
        source: 'microsoft_onedrive',
        syncedAt: new Date(),
        version: item.eTag ?? hashCanonicalJson(item),
      },
    };
  }

  extractEntityType(record: unknown): string {
    const r = record as OneDrivePayload;
    if (this.isListResponse(r)) return 'ItemList';
    if (this.isItem(r)) return r.folder ? 'Folder' : 'File';
    return 'Unknown';
  }

  extractExternalId(record: unknown): string {
    const r = record as OneDrivePayload;
    if (this.isItem(r)) return r.id;
    return '';
  }

  extractVersion(record: unknown): string | undefined {
    const r = record as OneDrivePayload;
    if (this.isItem(r)) return r.eTag;
    return undefined;
  }

  private isListResponse(payload: OneDrivePayload): payload is OneDriveListResponse {
    return 'value' in payload && Array.isArray(payload.value);
  }

  private isItem(payload: OneDrivePayload): payload is OneDriveItem {
    return 'id' in payload && 'name' in payload && !('value' in payload);
  }
}
