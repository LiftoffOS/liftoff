// Google Drive Connector Normalizer
// Per Section 12: Connector ingestion - normalizes Google Drive API responses

import { ConnectorNormalizer, NormalizedRecord } from './types';
import { hashCanonicalJson } from './idempotency';

// Google Drive API File structure
interface GoogleDriveFile {
  kind: string;
  id: string;
  name: string;
  mimeType: string;
  description?: string;
  starred?: boolean;
  trashed?: boolean;
  explicitlyTrashed?: boolean;
  parents?: string[];
  version?: string;
  webViewLink?: string;
  webContentLink?: string;
  iconLink?: string;
  thumbnailLink?: string;
  viewedByMe?: boolean;
  viewedByMeTime?: string;
  createdTime?: string;
  modifiedTime?: string;
  modifiedByMeTime?: string;
  sharedWithMeTime?: string;
  sharingUser?: {
    kind: string;
    displayName?: string;
    photoLink?: string;
    me?: boolean;
    permissionId?: string;
    emailAddress?: string;
  };
  owners?: Array<{
    kind: string;
    displayName?: string;
    photoLink?: string;
    me?: boolean;
    permissionId?: string;
    emailAddress?: string;
  }>;
  lastModifyingUser?: {
    kind: string;
    displayName?: string;
    photoLink?: string;
    me?: boolean;
    permissionId?: string;
    emailAddress?: string;
  };
  shared?: boolean;
  ownedByMe?: boolean;
  capabilities?: {
    canEdit?: boolean;
    canComment?: boolean;
    canShare?: boolean;
    canCopy?: boolean;
    canDownload?: boolean;
    canDelete?: boolean;
    canRename?: boolean;
    canTrash?: boolean;
    canMoveItemIntoTeamDrive?: boolean;
    canMoveItemOutOfTeamDrive?: boolean;
    canMoveItemWithinTeamDrive?: boolean;
    canAddChildren?: boolean;
    canRemoveChildren?: boolean;
  };
  permissions?: Array<{
    id: string;
    type: string;
    role: string;
    emailAddress?: string;
    displayName?: string;
    domain?: string;
    allowFileDiscovery?: boolean;
    expirationTime?: string;
  }>;
  size?: string;
  quotaBytesUsed?: string;
  md5Checksum?: string;
  contentHints?: {
    indexableText?: string;
    thumbnail?: {
      image?: string;
      mimeType?: string;
    };
  };
  folderColorRgb?: string;
  fullFileExtension?: string;
  fileExtension?: string;
  originalFilename?: string;
  imageMediaMetadata?: {
    width?: number;
    height?: number;
    rotation?: number;
    cameraMake?: string;
    cameraModel?: string;
    exposureTime?: number;
    aperture?: number;
    flashUsed?: boolean;
    focalLength?: number;
    isoSpeed?: number;
    meteringMode?: string;
    sensor?: string;
    colorSpace?: string;
    whiteBalance?: string;
    time?: string;
    location?: {
      latitude?: number;
      longitude?: number;
      altitude?: number;
    };
  };
  videoMediaMetadata?: {
    width?: number;
    height?: number;
    durationMillis?: string;
  };
  shortcutDetails?: {
    targetId?: string;
    targetMimeType?: string;
    targetResourceKey?: string;
  };
  driveId?: string;
  teamDriveId?: string;
}

// Google Drive Change structure
interface GoogleDriveChange {
  kind: string;
  changeType?: 'file' | 'drive';
  time?: string;
  removed?: boolean;
  fileId?: string;
  file?: GoogleDriveFile;
  driveId?: string;
  drive?: {
    id: string;
    name: string;
    colorRgb?: string;
  };
}

// Google Drive List response
interface GoogleDriveListResponse {
  kind: string;
  nextPageToken?: string;
  incompleteSearch?: boolean;
  files: GoogleDriveFile[];
}

// Google Drive Changes response
interface GoogleDriveChangesResponse {
  kind: string;
  nextPageToken?: string;
  newStartPageToken?: string;
  changes: GoogleDriveChange[];
}

// Google Drive Push notification
interface GoogleDrivePushNotification {
  kind: string;
  resourceId: string;
  resourceUri: string;
  resourceState: 'sync' | 'add' | 'remove' | 'update' | 'trash' | 'untrash' | 'change';
  channelId: string;
  changed?: string; // Comma-separated list of changed properties
  expiration?: string;
}

type GoogleDrivePayload =
  | GoogleDriveFile
  | GoogleDriveListResponse
  | GoogleDriveChangesResponse
  | GoogleDrivePushNotification
  | GoogleDriveChange;

export class GoogleDriveNormalizer implements ConnectorNormalizer {
  connectorType = 'google_drive';

  normalize(payload: unknown): NormalizedRecord[] {
    const records: NormalizedRecord[] = [];
    const drivePayload = payload as GoogleDrivePayload;

    // Handle file list response
    if (this.isFileListResponse(drivePayload)) {
      for (const file of drivePayload.files) {
        records.push(this.normalizeFile(file));
      }
      return records;
    }

    // Handle changes response
    if (this.isChangesResponse(drivePayload)) {
      for (const change of drivePayload.changes) {
        records.push(this.normalizeChange(change));
      }
      return records;
    }

    // Handle push notification
    if (this.isPushNotification(drivePayload)) {
      records.push(this.normalizePushNotification(drivePayload));
      return records;
    }

    // Handle single change
    if (this.isChange(drivePayload)) {
      records.push(this.normalizeChange(drivePayload));
      return records;
    }

    // Handle single file
    if (this.isFile(drivePayload)) {
      records.push(this.normalizeFile(drivePayload));
      return records;
    }

    return records;
  }

  private normalizeFile(file: GoogleDriveFile): NormalizedRecord {
    const entityType = this.getEntityTypeForFile(file);

    return {
      entityType,
      externalId: file.id,
      data: {
        // Core file data
        name: file.name,
        mimeType: file.mimeType,
        description: file.description,
        starred: file.starred,
        trashed: file.trashed,

        // Location
        parents: file.parents,
        driveId: file.driveId || file.teamDriveId,
        isInTeamDrive: !!(file.driveId || file.teamDriveId),

        // Links
        webViewLink: file.webViewLink,
        webContentLink: file.webContentLink,
        iconLink: file.iconLink,
        thumbnailLink: file.thumbnailLink,

        // Ownership and sharing
        ownedByMe: file.ownedByMe,
        shared: file.shared,
        owners: file.owners?.map((o) => ({
          email: o.emailAddress,
          displayName: o.displayName,
        })),
        sharingUser: file.sharingUser
          ? {
              email: file.sharingUser.emailAddress,
              displayName: file.sharingUser.displayName,
            }
          : undefined,
        lastModifyingUser: file.lastModifyingUser
          ? {
              email: file.lastModifyingUser.emailAddress,
              displayName: file.lastModifyingUser.displayName,
            }
          : undefined,

        // Permissions summary
        permissionCount: file.permissions?.length || 0,
        permissions: file.permissions?.map((p) => ({
          id: p.id,
          type: p.type,
          role: p.role,
          email: p.emailAddress,
          displayName: p.displayName,
          domain: p.domain,
        })),

        // Capabilities
        canEdit: file.capabilities?.canEdit,
        canComment: file.capabilities?.canComment,
        canShare: file.capabilities?.canShare,
        canDownload: file.capabilities?.canDownload,
        canDelete: file.capabilities?.canDelete,

        // Size and content
        size: file.size ? parseInt(file.size, 10) : undefined,
        sizeBytes: file.size,
        md5Checksum: file.md5Checksum,
        fileExtension: file.fileExtension || file.fullFileExtension,
        originalFilename: file.originalFilename,

        // Timestamps
        createdAt: file.createdTime,
        modifiedAt: file.modifiedTime,
        viewedByMeAt: file.viewedByMeTime,
        sharedWithMeAt: file.sharedWithMeTime,

        // Media metadata
        imageMetadata: file.imageMediaMetadata
          ? {
              width: file.imageMediaMetadata.width,
              height: file.imageMediaMetadata.height,
              cameraMake: file.imageMediaMetadata.cameraMake,
              cameraModel: file.imageMediaMetadata.cameraModel,
            }
          : undefined,
        videoMetadata: file.videoMediaMetadata
          ? {
              width: file.videoMediaMetadata.width,
              height: file.videoMediaMetadata.height,
              durationMs: file.videoMediaMetadata.durationMillis,
            }
          : undefined,

        // Shortcut data
        isShortcut: file.mimeType === 'application/vnd.google-apps.shortcut',
        shortcutTarget: file.shortcutDetails
          ? {
              targetId: file.shortcutDetails.targetId,
              targetMimeType: file.shortcutDetails.targetMimeType,
            }
          : undefined,

        // Folder color
        folderColor: file.folderColorRgb,
      },
      metadata: {
        source: 'google_drive',
        syncedAt: new Date(),
        version: file.version,
      },
    };
  }

  private normalizeChange(change: GoogleDriveChange): NormalizedRecord {
    if (change.changeType === 'drive' && change.drive) {
      return {
        entityType: 'SharedDrive',
        externalId: change.driveId || change.drive.id,
        data: {
          driveId: change.drive.id,
          name: change.drive.name,
          colorRgb: change.drive.colorRgb,
          removed: change.removed,
          changeTime: change.time,
        },
        metadata: {
          source: 'google_drive',
          syncedAt: new Date(),
          version: change.time,
        },
      };
    }

    // File change
    if (change.file) {
      const fileRecord = this.normalizeFile(change.file);
      fileRecord.data.removed = change.removed;
      fileRecord.data.changeTime = change.time;
      return fileRecord;
    }

    // Removed file (no file data available)
    return {
      entityType: 'FileChange',
      externalId: change.fileId || '',
      data: {
        fileId: change.fileId,
        removed: change.removed,
        changeTime: change.time,
      },
      metadata: {
        source: 'google_drive',
        syncedAt: new Date(),
        version: change.time,
      },
    };
  }

  private normalizePushNotification(
    notification: GoogleDrivePushNotification
  ): NormalizedRecord {
    return {
      entityType: 'DriveNotification',
      externalId: notification.channelId,
      data: {
        resourceId: notification.resourceId,
        resourceUri: notification.resourceUri,
        resourceState: notification.resourceState,
        channelId: notification.channelId,
        changedProperties: notification.changed?.split(','),
        expiration: notification.expiration,
        requiresFetch: true,
      },
      metadata: {
        source: 'google_drive',
        syncedAt: new Date(),
        version: hashCanonicalJson(notification),
      },
    };
  }

  private getEntityTypeForFile(file: GoogleDriveFile): string {
    const mimeType = file.mimeType;

    if (mimeType === 'application/vnd.google-apps.folder') {
      return 'Folder';
    }
    if (mimeType === 'application/vnd.google-apps.shortcut') {
      return 'Shortcut';
    }
    if (mimeType === 'application/vnd.google-apps.document') {
      return 'Document';
    }
    if (mimeType === 'application/vnd.google-apps.spreadsheet') {
      return 'Spreadsheet';
    }
    if (mimeType === 'application/vnd.google-apps.presentation') {
      return 'Presentation';
    }
    if (mimeType === 'application/vnd.google-apps.form') {
      return 'Form';
    }
    if (mimeType === 'application/vnd.google-apps.drawing') {
      return 'Drawing';
    }
    if (mimeType?.startsWith('image/')) {
      return 'Image';
    }
    if (mimeType?.startsWith('video/')) {
      return 'Video';
    }
    if (mimeType?.startsWith('audio/')) {
      return 'Audio';
    }
    if (mimeType === 'application/pdf') {
      return 'PDF';
    }

    return 'File';
  }

  extractEntityType(record: unknown): string {
    const r = record as GoogleDrivePayload;
    if (this.isFileListResponse(r)) return 'FileList';
    if (this.isChangesResponse(r)) return 'ChangeList';
    if (this.isPushNotification(r)) return 'DriveNotification';
    if (this.isChange(r)) return 'FileChange';
    if (this.isFile(r)) return this.getEntityTypeForFile(r);
    return 'Unknown';
  }

  extractExternalId(record: unknown): string {
    const r = record as GoogleDrivePayload;
    if (this.isFileListResponse(r)) return r.nextPageToken || '';
    if (this.isChangesResponse(r)) return r.nextPageToken || r.newStartPageToken || '';
    if (this.isPushNotification(r)) return r.channelId;
    if (this.isChange(r)) return r.fileId || r.driveId || '';
    if (this.isFile(r)) return r.id;
    return '';
  }

  extractVersion(record: unknown): string | undefined {
    const r = record as GoogleDrivePayload;
    if (this.isFile(r)) return r.version;
    if (this.isChange(r)) return r.time;
    return undefined;
  }

  private isFileListResponse(payload: GoogleDrivePayload): payload is GoogleDriveListResponse {
    return (
      'kind' in payload &&
      payload.kind === 'drive#fileList' &&
      'files' in payload
    );
  }

  private isChangesResponse(payload: GoogleDrivePayload): payload is GoogleDriveChangesResponse {
    return (
      'kind' in payload &&
      payload.kind === 'drive#changeList' &&
      'changes' in payload
    );
  }

  private isPushNotification(
    payload: GoogleDrivePayload
  ): payload is GoogleDrivePushNotification {
    return (
      'resourceState' in payload &&
      'channelId' in payload
    );
  }

  private isChange(payload: GoogleDrivePayload): payload is GoogleDriveChange {
    return (
      'kind' in payload &&
      payload.kind === 'drive#change'
    );
  }

  private isFile(payload: GoogleDrivePayload): payload is GoogleDriveFile {
    return (
      'kind' in payload &&
      payload.kind === 'drive#file' &&
      'id' in payload &&
      'name' in payload
    );
  }
}
