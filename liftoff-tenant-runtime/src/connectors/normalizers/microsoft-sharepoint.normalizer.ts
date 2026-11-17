// Microsoft SharePoint Connector Normalizer
// Per Section 12: Connector ingestion - normalizes Microsoft Graph API responses

import { ConnectorNormalizer, NormalizedRecord } from './types';
import { hashCanonicalJson } from './idempotency';

// SharePoint Site structure
interface SharePointSite {
  id: string;
  displayName?: string;
  name?: string;
  description?: string;
  webUrl?: string;
  createdDateTime?: string;
  lastModifiedDateTime?: string;
  root?: Record<string, any>;
  siteCollection?: {
    hostname?: string;
  };
}

// SharePoint List structure
interface SharePointList {
  id: string;
  displayName?: string;
  name?: string;
  description?: string;
  webUrl?: string;
  createdDateTime?: string;
  lastModifiedDateTime?: string;
  list?: {
    contentTypesEnabled?: boolean;
    hidden?: boolean;
    template?: string;
  };
  siteId?: string;
}

// SharePoint List Item structure
interface SharePointListItem {
  id: string;
  webUrl?: string;
  createdDateTime?: string;
  lastModifiedDateTime?: string;
  eTag?: string;
  fields?: Record<string, any>;
  createdBy?: {
    user?: {
      email?: string;
      displayName?: string;
    };
  };
  lastModifiedBy?: {
    user?: {
      email?: string;
      displayName?: string;
    };
  };
  siteId?: string;
  listId?: string;
}

// SharePoint Drive Item structure
interface SharePointDriveItem {
  id: string;
  name?: string;
  description?: string;
  webUrl?: string;
  size?: number;
  createdDateTime?: string;
  lastModifiedDateTime?: string;
  eTag?: string;
  file?: {
    mimeType?: string;
    hashes?: {
      sha1Hash?: string;
    };
  };
  folder?: {
    childCount?: number;
  };
  parentReference?: {
    id?: string;
    path?: string;
    driveId?: string;
    siteId?: string;
  };
  createdBy?: {
    user?: {
      email?: string;
      displayName?: string;
    };
  };
  lastModifiedBy?: {
    user?: {
      email?: string;
      displayName?: string;
    };
  };
}

// List response
interface SharePointListResponse {
  '@odata.context'?: string;
  '@odata.nextLink'?: string;
  value: (SharePointSite | SharePointList | SharePointListItem | SharePointDriveItem)[];
}

type SharePointPayload = SharePointSite | SharePointList | SharePointListItem | SharePointDriveItem | SharePointListResponse;

export class MicrosoftSharePointNormalizer implements ConnectorNormalizer {
  connectorType = 'microsoft_sharepoint';

  normalize(payload: unknown): NormalizedRecord[] {
    const records: NormalizedRecord[] = [];
    const spPayload = payload as SharePointPayload;

    // Handle list response
    if (this.isListResponse(spPayload)) {
      for (const item of spPayload.value) {
        records.push(this.normalizeItem(item));
      }
      return records;
    }

    // Handle single item
    if (this.isSite(spPayload) || this.isList(spPayload) || this.isListItem(spPayload) || this.isDriveItem(spPayload)) {
      records.push(this.normalizeItem(spPayload));
      return records;
    }

    return records;
  }

  private normalizeItem(item: SharePointSite | SharePointList | SharePointListItem | SharePointDriveItem): NormalizedRecord {
    if (this.isSite(item)) {
      return this.normalizeSite(item);
    }
    if (this.isList(item)) {
      return this.normalizeList(item);
    }
    if (this.isListItem(item)) {
      return this.normalizeListItem(item);
    }
    return this.normalizeDriveItem(item as SharePointDriveItem);
  }

  private normalizeSite(site: SharePointSite): NormalizedRecord {
    return {
      entityType: 'Site',
      externalId: site.id,
      data: {
        displayName: site.displayName,
        name: site.name,
        description: site.description,
        webUrl: site.webUrl,
        hostname: site.siteCollection?.hostname,
        isRoot: !!site.root,
        createdAt: site.createdDateTime,
        modifiedAt: site.lastModifiedDateTime,
      },
      metadata: {
        source: 'microsoft_sharepoint',
        syncedAt: new Date(),
        version: site.lastModifiedDateTime ?? hashCanonicalJson(site),
      },
    };
  }

  private normalizeList(list: SharePointList): NormalizedRecord {
    return {
      entityType: 'List',
      externalId: list.siteId ? `${list.siteId}:${list.id}` : list.id,
      data: {
        displayName: list.displayName,
        name: list.name,
        description: list.description,
        webUrl: list.webUrl,
        template: list.list?.template,
        isHidden: list.list?.hidden,
        contentTypesEnabled: list.list?.contentTypesEnabled,
        siteId: list.siteId,
        createdAt: list.createdDateTime,
        modifiedAt: list.lastModifiedDateTime,
      },
      metadata: {
        source: 'microsoft_sharepoint',
        syncedAt: new Date(),
        version: list.lastModifiedDateTime ?? hashCanonicalJson(list),
      },
    };
  }

  private normalizeListItem(item: SharePointListItem): NormalizedRecord {
    const externalId = item.siteId && item.listId
      ? `${item.siteId}:${item.listId}:${item.id}`
      : item.id;

    return {
      entityType: 'ListItem',
      externalId,
      data: {
        webUrl: item.webUrl,
        fields: item.fields,
        createdBy: item.createdBy?.user ? {
          email: item.createdBy.user.email,
          displayName: item.createdBy.user.displayName,
        } : undefined,
        lastModifiedBy: item.lastModifiedBy?.user ? {
          email: item.lastModifiedBy.user.email,
          displayName: item.lastModifiedBy.user.displayName,
        } : undefined,
        siteId: item.siteId,
        listId: item.listId,
        createdAt: item.createdDateTime,
        modifiedAt: item.lastModifiedDateTime,
      },
      metadata: {
        source: 'microsoft_sharepoint',
        syncedAt: new Date(),
        version: item.eTag,
      },
    };
  }

  private normalizeDriveItem(item: SharePointDriveItem): NormalizedRecord {
    const siteId = item.parentReference?.siteId;
    const externalId = siteId ? `${siteId}:${item.id}` : item.id;

    return {
      entityType: item.folder ? 'Folder' : 'File',
      externalId,
      data: {
        name: item.name,
        description: item.description,
        webUrl: item.webUrl,
        size: item.size,
        mimeType: item.file?.mimeType,
        isFolder: !!item.folder,
        childCount: item.folder?.childCount,
        parentId: item.parentReference?.id,
        parentPath: item.parentReference?.path,
        driveId: item.parentReference?.driveId,
        siteId,
        sha1Hash: item.file?.hashes?.sha1Hash,
        createdBy: item.createdBy?.user ? {
          email: item.createdBy.user.email,
          displayName: item.createdBy.user.displayName,
        } : undefined,
        lastModifiedBy: item.lastModifiedBy?.user ? {
          email: item.lastModifiedBy.user.email,
          displayName: item.lastModifiedBy.user.displayName,
        } : undefined,
        createdAt: item.createdDateTime,
        modifiedAt: item.lastModifiedDateTime,
      },
      metadata: {
        source: 'microsoft_sharepoint',
        syncedAt: new Date(),
        version: item.eTag,
      },
    };
  }

  extractEntityType(record: unknown): string {
    const r = record as SharePointPayload;
    if (this.isListResponse(r)) return 'ItemList';
    if (this.isSite(r)) return 'Site';
    if (this.isList(r)) return 'List';
    if (this.isListItem(r)) return 'ListItem';
    if (this.isDriveItem(r)) return (r as SharePointDriveItem).folder ? 'Folder' : 'File';
    return 'Unknown';
  }

  extractExternalId(record: unknown): string {
    const r = record as SharePointPayload;
    if (this.isSite(r) || this.isList(r) || this.isListItem(r) || this.isDriveItem(r)) return r.id;
    return '';
  }

  extractVersion(record: unknown): string | undefined {
    const r = record as SharePointPayload;
    if (this.isListItem(r) || this.isDriveItem(r)) return (r as SharePointListItem | SharePointDriveItem).eTag;
    return undefined;
  }

  private isListResponse(payload: SharePointPayload): payload is SharePointListResponse {
    return 'value' in payload && Array.isArray(payload.value);
  }

  private isSite(payload: SharePointPayload): payload is SharePointSite {
    return 'id' in payload && 'webUrl' in payload && ('siteCollection' in payload || 'root' in payload);
  }

  private isList(payload: SharePointPayload): payload is SharePointList {
    return 'id' in payload && 'list' in payload;
  }

  private isListItem(payload: SharePointPayload): payload is SharePointListItem {
    return 'id' in payload && 'fields' in payload;
  }

  private isDriveItem(payload: SharePointPayload): payload is SharePointDriveItem {
    return 'id' in payload && 'name' in payload && ('file' in payload || 'folder' in payload);
  }
}
