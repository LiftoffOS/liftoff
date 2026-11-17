// Google Sheets Connector Client
// Per Section 11 & 12: Real Google Sheets API implementation

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

export class GoogleSheetsClient implements CompensationClient {
  readonly connector = 'google_sheets';
  private credentialProvider: CredentialProvider;
  private baseUrl = 'https://sheets.googleapis.com/v4';

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
        Authorization: `Bearer ${bearerFor(credentials, 'google_sheets')}`,
        'Content-Type': 'application/json',
      },
      body: body ? JSON.stringify(body) : undefined,
    });

    if (!response.ok) {
      const error = await response.text();
      logger.error('Google Sheets API error', { status: response.status, error, path });
      throw new Error(`Google Sheets API error: ${response.status} - ${error}`);
    }

    if (response.status === 204) {
      return {} as T;
    }

    return response.json() as Promise<T>;
  }

  private async requestDrive<T>(path: string, method: string = 'GET', query?: Record<string, string>): Promise<T> {
    const credentials = await this.credentialProvider();

    // composio_managed routing for the Drive endpoint (cross-API: a Sheets
    // account calling the Drive API — Composio allows cross-host absolute URLs).
    const composio = await tryComposioProxy<T>(credentials, {
      method: method.toUpperCase() as 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH',
      path: `https://www.googleapis.com/drive/v3${path}`,
      query,
    });
    if (composio.handled) return composio.data;

    const url = query
      ? `https://www.googleapis.com/drive/v3${path}?${new URLSearchParams(query).toString()}`
      : `https://www.googleapis.com/drive/v3${path}`;
    const response = await fetch(url, {
      method,
      headers: { Authorization: `Bearer ${bearerFor(credentials, 'google_sheets')}` },
    });
    if (!response.ok) {
      const error = await response.text();
      logger.error('Google Drive API error (from Sheets client)', { status: response.status, error });
      throw new Error(`Google Drive API error: ${response.status} - ${error}`);
    }
    if (response.status === 204 || response.headers.get('content-length') === '0') {
      return {} as T;
    }
    return response.json() as Promise<T>;
  }

  async read(
    entityType: string,
    entityId: string | undefined,
    payload?: Record<string, any>
  ): Promise<ExternalRecord> {
    logger.info('Google Sheets read', { entityType, entityId });

    if (entityType === 'spreadsheets') {
      const p = payload ?? {};
      const query: Record<string, string> = {
        q: `mimeType='application/vnd.google-apps.spreadsheet' and trashed=false`,
        fields: 'files(id,name,modifiedTime),nextPageToken',
        pageSize: String(p.pageSize ?? 100),
      };
      if (p.pageToken) query.pageToken = p.pageToken as string;
      const result = await this.requestDrive<{ files: Array<Record<string, any>>; nextPageToken?: string }>('/files', 'GET', query);
      return {
        id: 'spreadsheets',
        data: { spreadsheets: result.files ?? [], nextPageToken: result.nextPageToken },
      };
    }

    switch (entityType) {
      case 'spreadsheet': {
        // Accept either entityId or payload.spreadsheetId — the LLM-generated
        // tool call schema uses { spreadsheetId } for read_spreadsheet, not { id }.
        const id = entityId || payload?.spreadsheetId || payload?.id;
        if (!id) throw new Error('Google Sheets read spreadsheet: spreadsheetId required');
        const data = await this.request<Record<string, any>>(
          'GET',
          `/spreadsheets/${id}`
        );
        return {
          id,
          data,
          versionToken: data.spreadsheetId,
          lastModified: data.properties?.modifiedTime ? new Date(data.properties.modifiedTime) : undefined,
        };
      }

      case 'values': {
        // Accept either entityId in "spreadsheetId/range" form, or split fields
        // from the payload. The connector registry's read_values schema declares
        // { spreadsheetId, range } as separate properties — that path is the
        // common case.
        const spreadsheetId = payload?.spreadsheetId || (entityId ? this.parseValuesId(entityId)[0] : undefined);
        const range = payload?.range || (entityId ? this.parseValuesId(entityId)[1] : undefined);
        if (!spreadsheetId || !range) {
          throw new Error('Google Sheets read values: spreadsheetId and range required');
        }
        const data = await this.request<Record<string, any>>(
          'GET',
          `/spreadsheets/${spreadsheetId}/values/${encodeURIComponent(range)}`
        );
        return {
          id: `${spreadsheetId}/${range}`,
          data,
        };
      }

      case 'sheet': {
        // Accepts entityId="spreadsheetId/sheetId" OR payload.spreadsheetId + payload.sheetId
        const sid = payload?.spreadsheetId || (entityId ? this.parseSheetId(entityId)[0] : undefined);
        const shid = payload?.sheetId !== undefined ? String(payload.sheetId) : (entityId ? this.parseSheetId(entityId)[1] : undefined);
        if (!sid || shid === undefined) throw new Error('Google Sheets read sheet: spreadsheetId and sheetId required');
        const spreadsheet = await this.request<Record<string, any>>(
          'GET',
          `/spreadsheets/${sid}?includeGridData=false`
        );
        const sheet = spreadsheet.sheets?.find(
          (s: { properties?: { sheetId?: number } }) => s.properties?.sheetId === parseInt(shid)
        );
        if (!sheet) {
          throw new Error(`Sheet ${shid} not found in spreadsheet ${sid}`);
        }
        return {
          id: entityId ?? `${sid}/${shid}`,
          data: sheet,
        };
      }

      case 'sheets': {
        // List all sheets (tabs) in a spreadsheet
        const spreadsheetId = payload?.spreadsheetId || entityId;
        if (!spreadsheetId) throw new Error('Google Sheets list sheets: spreadsheetId required');
        const spreadsheet = await this.request<Record<string, any>>(
          'GET',
          `/spreadsheets/${spreadsheetId}?includeGridData=false`
        );
        return {
          id: spreadsheetId,
          data: { sheets: spreadsheet.sheets ?? [] },
        };
      }

      default:
        throw new Error(`Unsupported entity type: ${entityType}`);
    }
  }

  /** Enumerate the spreadsheets this connection can see.
   *
   *  A spreadsheet is a Drive file, so this goes through the Drive endpoint
   *  rather than the Sheets one — Sheets can read a spreadsheet you already
   *  name but cannot tell you which exist. That is why this returned an empty
   *  array until now, and an empty array is the one answer a picker must never
   *  give: it is indistinguishable from "you have none", so a person is told
   *  their workspace is empty when the gap is ours.
   *
   *  `trashed = false` matters. Drive keeps deleted files listable, and a team
   *  pointed at a trashed spreadsheet writes into something nobody will look at
   *  again. */
  async list(entityType: string, filters?: ListFilters): Promise<ListResult> {
    if (entityType !== 'spreadsheet' && entityType !== 'tables' && entityType !== 'file') {
      return { records: [], hasMore: false, unsupported: true };
    }

    const clauses = ["mimeType = 'application/vnd.google-apps.spreadsheet'", 'trashed = false'];
    if (filters?.q) {
      // Drive's `contains` is a prefix match on name tokens, and a quote in the
      // query would terminate the clause early, so it is stripped rather than
      // passed through.
      clauses.push(`name contains '${String(filters.q).replace(/'/g, '')}'`);
    }

    const query: Record<string, string> = {
      q: clauses.join(' and '),
      fields: 'nextPageToken, files(id, name, webViewLink, modifiedTime, owners(displayName))',
      // Most recently touched first: the spreadsheet someone is currently
      // working in is far likelier to be the one they mean than the oldest.
      orderBy: 'modifiedTime desc',
      pageSize: String(filters?.limit ?? 100),
      supportsAllDrives: 'true',
      includeItemsFromAllDrives: 'true',
    };
    if (filters?.pageToken) query.pageToken = filters.pageToken;

    const result = await this.requestDrive<{
      files?: Array<Record<string, unknown>>;
      nextPageToken?: string;
    }>('/files', 'GET', query);

    const files = result.files ?? [];
    return {
      records: files.map((f) => ({ id: String(f.id ?? ''), data: f })),
      hasMore: Boolean(result.nextPageToken),
      nextPageToken: result.nextPageToken,
    };
  }

  async create(entityType: string, data: Record<string, any>): Promise<CreateResult> {
    logger.info('Google Sheets create', { entityType });

    try {
      switch (entityType) {
        case 'spreadsheet': {
          const result = await this.request<{ spreadsheetId: string }>(
            'POST',
            '/spreadsheets',
            data
          );

          return {
            success: true,
            id: result.spreadsheetId,
            data: result,
          };
        }

        case 'sheet': {
          // Add a new sheet to existing spreadsheet
          const spreadsheetId = data.spreadsheetId;
          const { spreadsheetId: _, ...sheetProperties } = data;

          const result = await this.request<{ replies: Array<{ addSheet: { properties: { sheetId: number } } }> }>(
            'POST',
            `/spreadsheets/${spreadsheetId}:batchUpdate`,
            {
              requests: [{
                addSheet: {
                  properties: sheetProperties.properties || { title: sheetProperties.title || 'New Sheet' },
                },
              }],
            }
          );

          const newSheetId = result.replies?.[0]?.addSheet?.properties?.sheetId;
          return {
            success: true,
            id: `${spreadsheetId}/${newSheetId}`,
            data: result,
          };
        }

        case 'values': {
          // Append values to a range
          const spreadsheetId = data.spreadsheetId;
          const range = data.range;
          const values = data.values;

          const result = await this.request<{ updates: Record<string, any> }>(
            'POST',
            `/spreadsheets/${spreadsheetId}/values/${encodeURIComponent(range)}:append?valueInputOption=USER_ENTERED`,
            { values }
          );

          return {
            success: true,
            id: `${spreadsheetId}/${range}`,
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
    entityId: string | undefined,
    data: Record<string, any>
  ): Promise<UpdateResult> {
    logger.info('Google Sheets update', { entityType, entityId });

    try {
      switch (entityType) {
        case 'spreadsheet': {
          const id = entityId || data.spreadsheetId || data.id;
          if (!id) throw new Error('Google Sheets update spreadsheet: spreadsheetId required');
          const result = await this.request<Record<string, any>>(
            'POST',
            `/spreadsheets/${id}:batchUpdate`,
            { requests: data.requests || [] }
          );

          return {
            success: true,
            data: result,
          };
        }

        case 'values': {
          const spreadsheetId = data.spreadsheetId || (entityId ? this.parseValuesId(entityId)[0] : undefined);
          const range = data.range || (entityId ? this.parseValuesId(entityId)[1] : undefined);
          if (!spreadsheetId || !range) {
            throw new Error('Google Sheets update values: spreadsheetId and range required');
          }
          const result = await this.request<Record<string, any>>(
            'PUT',
            `/spreadsheets/${spreadsheetId}/values/${encodeURIComponent(range)}?valueInputOption=USER_ENTERED`,
            { values: data.values }
          );

          return {
            success: true,
            data: result,
          };
        }

        case 'sheet': {
          if (!entityId) throw new Error('Google Sheets update sheet: entityId required');
          const [spreadsheetId, sheetId] = this.parseSheetId(entityId);
          const result = await this.request<Record<string, any>>(
            'POST',
            `/spreadsheets/${spreadsheetId}:batchUpdate`,
            {
              requests: [{
                updateSheetProperties: {
                  properties: {
                    sheetId: parseInt(sheetId),
                    ...data.properties,
                  },
                  fields: data.fields || 'title',
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

  async delete(
    entityType: string,
    entityId: string | undefined,
    payload?: Record<string, any>
  ): Promise<DeleteResult> {
    logger.info('Google Sheets delete', { entityType, entityId });

    try {
      switch (entityType) {
        case 'sheet': {
          const spreadsheetId = payload?.spreadsheetId || (entityId ? this.parseSheetId(entityId)[0] : undefined);
          const rawSheetId = payload?.sheetId !== undefined ? payload.sheetId : (entityId ? this.parseSheetId(entityId)[1] : undefined);
          if (!spreadsheetId || rawSheetId === undefined) throw new Error('Google Sheets delete sheet: spreadsheetId and sheetId required');
          await this.request<void>(
            'POST',
            `/spreadsheets/${spreadsheetId}:batchUpdate`,
            {
              requests: [{
                deleteSheet: {
                  sheetId: typeof rawSheetId === 'string' ? parseInt(rawSheetId) : rawSheetId,
                },
              }],
            }
          );
          return { success: true };
        }

        case 'values': {
          const spreadsheetId = payload?.spreadsheetId || (entityId ? this.parseValuesId(entityId)[0] : undefined);
          const range = payload?.range || (entityId ? this.parseValuesId(entityId)[1] : undefined);
          if (!spreadsheetId || !range) {
            throw new Error('Google Sheets delete values: spreadsheetId and range required');
          }
          await this.request<void>(
            'POST',
            `/spreadsheets/${spreadsheetId}/values/${encodeURIComponent(range)}:clear`,
            {}
          );
          return { success: true };
        }

        case 'spreadsheet': {
          const id = entityId || payload?.id || payload?.spreadsheetId;
          if (!id) throw new Error('Google Sheets delete spreadsheet: id required');
          await this.requestDrive<void>(`/files/${id}`, 'DELETE');
          return { success: true };
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

  async restore(
    entityType: string,
    entityId: string | undefined,
    snapshot: Record<string, any>
  ): Promise<UpdateResult> {
    logger.info('Google Sheets restore from snapshot', { entityType, entityId });

    if (entityType === 'values') {
      // Restore cell values to previous state
      return this.update(entityType, entityId, { values: snapshot.values });
    }

    if (entityType === 'sheet') {
      // Restore sheet properties
      const restoreData: Record<string, any> = {
        properties: {},
        fields: '',
      };
      const fields: string[] = [];

      if (snapshot.properties?.title) {
        restoreData.properties.title = snapshot.properties.title;
        fields.push('title');
      }
      if (snapshot.properties?.gridProperties) {
        restoreData.properties.gridProperties = snapshot.properties.gridProperties;
        fields.push('gridProperties');
      }

      restoreData.fields = fields.join(',');
      return this.update(entityType, entityId, restoreData);
    }

    return {
      success: false,
      error: `Cannot restore Google Sheets ${entityType}`,
    };
  }

  async semanticInverse(
    entityType: string,
    originalAction: string,
    entityId: string | undefined,
    originalResponse: Record<string, any>
  ): Promise<DeleteResult | UpdateResult> {
    logger.info('Google Sheets semantic inverse', { entityType, originalAction, entityId });

    switch (originalAction) {
      case 'create':
        if (entityType === 'sheet') {
          const sheetId = originalResponse.replies?.[0]?.addSheet?.properties?.sheetId;
          if (sheetId && entityId) {
            const spreadsheetId = entityId.split('/')[0];
            return this.delete('sheet', `${spreadsheetId}/${sheetId}`);
          }
        }
        if (entityType === 'values') {
          // Clear the appended values
          return this.delete('values', entityId);
        }
        break;

      case 'delete':
        return {
          success: false,
          error: 'Cannot restore deleted Google Sheets data without snapshot',
        };

      case 'update':
        return {
          success: false,
          error: 'Update reversal requires pre-action snapshot',
        };

      default:
        return {
          success: false,
          error: `Cannot reverse Google Sheets action: ${originalAction}`,
        };
    }

    return { success: false, error: 'Unknown entity type or action' };
  }

  private parseValuesId(entityId: string): [string, string] {
    if (entityId.includes('/')) {
      const parts = entityId.split('/');
      return [parts[0], parts.slice(1).join('/')];
    }
    return [entityId, 'Sheet1'];
  }

  private parseSheetId(entityId: string): [string, string] {
    if (entityId.includes('/')) {
      const parts = entityId.split('/');
      return [parts[0], parts[1]];
    }
    return [entityId, '0'];
  }
}
