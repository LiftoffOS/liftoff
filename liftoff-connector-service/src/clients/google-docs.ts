// Google Docs Connector Client
// Per Section 11 & 12: Real Google Docs API implementation

import {
  CompensationClient,
  CredentialProvider,
  ExternalRecord,
  CreateResult,
  UpdateResult,
  DeleteResult,
  ListFilters,
  ListResult,
} from './types.js';
import { logger } from '../infra/logging.js';
import { tryComposioProxy, bearerFor } from './composio-transport.js';

export class GoogleDocsClient implements CompensationClient {
  readonly connector = 'google_docs';
  private credentialProvider: CredentialProvider;
  private baseUrl = 'https://docs.googleapis.com/v1';

  constructor(credentialProvider: CredentialProvider) {
    this.credentialProvider = credentialProvider;
  }

  private async request<T>(
    method: string,
    path: string,
    body?: Record<string, any>
  ): Promise<T> {
    // Always fetch fresh credentials per request — never cache. The provider
    // delegates to credentialService.getCredentials, which handles refresh.
    const credentials = await this.credentialProvider();

    // composio_managed routing — see clients/composio-transport.ts.
    // Pass the ABSOLUTE vendor URL (same as the direct fetch below): Composio's
    // per-toolkit proxy bases are inconsistent, so a version-prefixed path is
    // unreliable.
    const composio = await tryComposioProxy<T>(credentials, {
      method: method.toUpperCase() as 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH',
      path: `${this.baseUrl}${path}`,
      body,
    });
    if (composio.handled) return composio.data;

    const response = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${bearerFor(credentials, 'google_docs')}`,
        'Content-Type': 'application/json',
      },
      body: body ? JSON.stringify(body) : undefined,
    });

    if (!response.ok) {
      const error = await response.text();
      logger.error('Google Docs API error', { status: response.status, error, path });
      throw new Error(`Google Docs API error: ${response.status} - ${error}`);
    }

    if (response.status === 204) {
      return {} as T;
    }

    return response.json() as Promise<T>;
  }

  private async requestDrive<T>(path: string, query?: Record<string, string>): Promise<T> {
    const credentials = await this.credentialProvider();

    // composio_managed routing — cross-API Drive call from a Docs-typed
    // account. Absolute vendor URL; Composio allows cross-host absolute URLs.
    const composio = await tryComposioProxy<T>(credentials, {
      method: 'GET',
      path: `https://www.googleapis.com/drive/v3${path}`,
      query,
    });
    if (composio.handled) return composio.data;

    const url = query
      ? `https://www.googleapis.com/drive/v3${path}?${new URLSearchParams(query).toString()}`
      : `https://www.googleapis.com/drive/v3${path}`;
    const response = await fetch(url, {
      method: 'GET',
      headers: { Authorization: `Bearer ${bearerFor(credentials, 'google_docs')}` },
    });
    if (!response.ok) {
      const error = await response.text();
      logger.error('Google Drive API error (from Docs client)', { status: response.status, error });
      throw new Error(`Google Drive API error: ${response.status} - ${error}`);
    }
    return response.json() as Promise<T>;
  }

  async read(entityType: string, entityId: string | undefined, payload?: Record<string, any>): Promise<ExternalRecord> {
    logger.info('Google Docs read', { entityType, entityId });

    if (entityType === 'documents') {
      const p = payload ?? {};
      const query: Record<string, string> = {
        q: `mimeType='application/vnd.google-apps.document' and trashed=false${p.query ? ` and ${p.query}` : ''}`,
        fields: 'files(id,name,modifiedTime),nextPageToken',
        pageSize: String(p.pageSize ?? 100),
      };
      if (p.pageToken) query.pageToken = p.pageToken as string;
      const result = await this.requestDrive<{ files: Array<Record<string, any>>; nextPageToken?: string }>('/files', query);
      return {
        id: 'documents',
        data: { documents: result.files ?? [], nextPageToken: result.nextPageToken },
      };
    }

    if (!entityId) throw new Error(`entityId required for ${entityType} read`);

    switch (entityType) {
      case 'document': {
        const data = await this.request<Record<string, any>>(
          'GET',
          `/documents/${entityId}`
        );
        return {
          id: entityId,
          data,
          versionToken: data.revisionId,
          lastModified: data.revisionId ? new Date() : undefined,
        };
      }

      case 'content': {
        // Read document content as plain text
        const data = await this.request<Record<string, any>>(
          'GET',
          `/documents/${entityId}`
        );
        const text = this.extractText(data.body?.content || []);
        return {
          id: entityId,
          data: { text, structure: data.body?.content },
          versionToken: data.revisionId,
        };
      }

      default:
        throw new Error(`Unsupported entity type: ${entityType}`);
    }
  }

  /** Enumerate what this connection can see in Drive.
   *
   *  Same stub, same cause, same fix as GoogleSheetsClient.list: a Doc is a
   *  Drive file, and the Docs API reads a document you already name rather than
   *  telling you which exist. Returning an empty array made the hire flow's
   *  picker say the workspace was empty when the gap was ours.
   *
   *  `folder` is the important entity here: a template asking where its output
   *  should live wants a destination to write INTO, not an existing document to
   *  overwrite. `document` is served too, for the read case.
   *
   *  trashed = false because Drive keeps deleted items listable, and a team
   *  pointed at a trashed folder writes where nobody looks again. */
  async list(entityType: string, filters?: ListFilters): Promise<ListResult> {
    if (entityType !== 'folder' && entityType !== 'document' && entityType !== 'file') {
      return { records: [], hasMore: false, unsupported: true };
    }

    // 'file' means BOTH, because the caller is a tree: it splits the response
    // into folders to open and documents to choose. This used to fall through
    // to the folder-only branch, so a picker asking for files was handed
    // folders and nothing else, and no document in the workspace was reachable.
    const DOC = "mimeType = 'application/vnd.google-apps.document'";
    const FOLDER = "mimeType = 'application/vnd.google-apps.folder'";
    const mime = entityType === 'document' ? DOC
      : entityType === 'folder' ? FOLDER
      : `(${DOC} or ${FOLDER})`;

    const clauses = [mime, 'trashed = false'];
    if (filters?.q) {
      clauses.push(`name contains '${String(filters.q).replace(/'/g, '')}'`);
    }

    const query: Record<string, string> = {
      q: clauses.join(' and '),
      // mimeType is what tells a folder from a document downstream. Without it
      // every row looked alike and the picker had to be told what each one was
      // by the connector type, which stopped being true the moment this client
      // started returning both.
      fields: 'nextPageToken, files(id, name, mimeType, webViewLink, modifiedTime, owners(displayName))',
      orderBy: 'modifiedTime desc',
      pageSize: String(filters?.limit ?? 100),
      supportsAllDrives: 'true',
      includeItemsFromAllDrives: 'true',
    };
    if (filters?.pageToken) query.pageToken = filters.pageToken;

    const result = await this.requestDrive<{
      files?: Array<Record<string, unknown>>;
      nextPageToken?: string;
    }>('/files', query);

    const files = result.files ?? [];
    return {
      records: files.map((f) => ({ id: String(f.id ?? ''), data: f })),
      hasMore: Boolean(result.nextPageToken),
      nextPageToken: result.nextPageToken,
    };
  }

  async create(entityType: string, data: Record<string, any>): Promise<CreateResult> {
    logger.info('Google Docs create', { entityType });

    try {
      switch (entityType) {
        case 'document': {
          const result = await this.request<{ documentId: string; title: string }>(
            'POST',
            '/documents',
            { title: data.title || 'Untitled Document' }
          );

          // If content is provided, insert it
          if (data.content) {
            await this.insertContent(result.documentId, data.content);
          }

          return {
            success: true,
            id: result.documentId,
            data: result,
          };
        }

        case 'content': {
          // Insert content into existing document
          const documentId = data.documentId;
          const content = data.content;
          const index = data.index || 1;

          const result = await this.request<Record<string, any>>(
            'POST',
            `/documents/${documentId}:batchUpdate`,
            {
              requests: [{
                insertText: {
                  location: { index },
                  text: content,
                },
              }],
            }
          );

          return {
            success: true,
            id: documentId,
            data: result,
          };
        }

        default:
          return {
            success: false,
            id: '',
            error: `Unsupported entity type: ${entityType}`,
          };
      }
    } catch (error) {
      return {
        success: false,
        id: '',
        error: (error as Error).message,
      };
    }
  }

  async update(
    entityType: string,
    entityId: string,
    data: Record<string, any>
  ): Promise<UpdateResult> {
    logger.info('Google Docs update', { entityType, entityId });

    try {
      switch (entityType) {
        case 'document': {
          // Execute batch update requests
          const result = await this.request<Record<string, any>>(
            'POST',
            `/documents/${entityId}:batchUpdate`,
            { requests: data.requests || [] }
          );

          return {
            success: true,
            data: result,
          };
        }

        case 'content': {
          // Replace content in range
          const requests: Record<string, any>[] = [];

          if (data.deleteRange) {
            requests.push({
              deleteContentRange: {
                range: data.deleteRange,
              },
            });
          }

          if (data.insertText) {
            requests.push({
              insertText: {
                location: { index: data.insertIndex || 1 },
                text: data.insertText,
              },
            });
          }

          const result = await this.request<Record<string, any>>(
            'POST',
            `/documents/${entityId}:batchUpdate`,
            { requests }
          );

          return {
            success: true,
            data: result,
          };
        }

        case 'formatting': {
          // Apply formatting updates
          const result = await this.request<Record<string, any>>(
            'POST',
            `/documents/${entityId}:batchUpdate`,
            {
              requests: [{
                updateTextStyle: {
                  range: data.range,
                  textStyle: data.textStyle,
                  fields: data.fields || '*',
                },
              }],
            }
          );

          return {
            success: true,
            data: result,
          };
        }

        default:
          return {
            success: false,
            error: `Unsupported entity type: ${entityType}`,
          };
      }
    } catch (error) {
      return {
        success: false,
        error: (error as Error).message,
      };
    }
  }

  async delete(entityType: string, entityId: string): Promise<DeleteResult> {
    logger.info('Google Docs delete', { entityType, entityId });

    try {
      switch (entityType) {
        case 'content': {
          // Delete content range - entityId format: "documentId/startIndex-endIndex"
          const [documentId, rangeStr] = this.parseContentId(entityId);
          const [startIndex, endIndex] = rangeStr.split('-').map(Number);

          await this.request<void>(
            'POST',
            `/documents/${documentId}:batchUpdate`,
            {
              requests: [{
                deleteContentRange: {
                  range: {
                    startIndex,
                    endIndex,
                  },
                },
              }],
            }
          );
          return { success: true };
        }

        case 'document':
          // Documents are deleted via Drive API
          return {
            success: false,
            error: 'Use Google Drive API to delete documents',
          };

        default:
          return {
            success: false,
            error: `Unsupported entity type: ${entityType}`,
          };
      }
    } catch (error) {
      return {
        success: false,
        error: (error as Error).message,
      };
    }
  }

  async restore(
    entityType: string,
    entityId: string,
    snapshot: Record<string, any>
  ): Promise<UpdateResult> {
    logger.info('Google Docs restore from snapshot', { entityType, entityId });

    if (entityType === 'content') {
      // Restore content by deleting current and inserting snapshot
      const doc = await this.read('document', entityId);
      const currentEndIndex = this.getDocumentEndIndex(doc.data.body?.content || []);

      const requests: Record<string, any>[] = [];

      // Delete current content (except the required newline at index 1)
      if (currentEndIndex > 2) {
        requests.push({
          deleteContentRange: {
            range: { startIndex: 1, endIndex: currentEndIndex - 1 },
          },
        });
      }

      // Insert snapshot content
      if (snapshot.text) {
        requests.push({
          insertText: {
            location: { index: 1 },
            text: snapshot.text,
          },
        });
      }

      return this.update('document', entityId, { requests });
    }

    return {
      success: false,
      error: `Cannot restore Google Docs ${entityType}`,
    };
  }

  async semanticInverse(
    entityType: string,
    originalAction: string,
    entityId: string,
    originalResponse: Record<string, any>
  ): Promise<DeleteResult | UpdateResult> {
    logger.info('Google Docs semantic inverse', { entityType, originalAction, entityId });

    switch (originalAction) {
      case 'create':
        if (entityType === 'content') {
          // Delete the inserted content
          const insertedLength = originalResponse.insertedLength || 0;
          const startIndex = originalResponse.insertIndex || 1;
          if (insertedLength > 0) {
            return this.delete('content', `${entityId}/${startIndex}-${startIndex + insertedLength}`);
          }
        }
        // For document creation, use Drive API
        return {
          success: false,
          error: 'Use Google Drive API to delete created documents',
        };

      case 'delete':
        return {
          success: false,
          error: 'Cannot restore deleted Google Docs content without snapshot',
        };

      case 'update':
        return {
          success: false,
          error: 'Update reversal requires pre-action snapshot',
        };

      default:
        return {
          success: false,
          error: `Cannot reverse Google Docs action: ${originalAction}`,
        };
    }
  }

  private async insertContent(documentId: string, content: string): Promise<void> {
    await this.request<void>(
      'POST',
      `/documents/${documentId}:batchUpdate`,
      {
        requests: [{
          insertText: {
            location: { index: 1 },
            text: content,
          },
        }],
      }
    );
  }

  private extractText(content: Array<Record<string, any>>): string {
    let text = '';
    for (const element of content) {
      if (element.paragraph?.elements) {
        for (const el of element.paragraph.elements) {
          if (el.textRun?.content) {
            text += el.textRun.content;
          }
        }
      }
      if (element.table) {
        for (const row of element.table.tableRows || []) {
          for (const cell of row.tableCells || []) {
            text += this.extractText(cell.content || []);
          }
        }
      }
    }
    return text;
  }

  private getDocumentEndIndex(content: Array<Record<string, any>>): number {
    let maxIndex = 1;
    for (const element of content) {
      if (element.endIndex && element.endIndex > maxIndex) {
        maxIndex = element.endIndex;
      }
    }
    return maxIndex;
  }

  private parseContentId(entityId: string): [string, string] {
    if (entityId.includes('/')) {
      const parts = entityId.split('/');
      return [parts[0], parts.slice(1).join('/')];
    }
    return [entityId, '1-1'];
  }
}
