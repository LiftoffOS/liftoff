// Microsoft Contacts Connector Client
// Per Section 11 & 12: Microsoft Graph API implementation for Contacts

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

export class MicrosoftContactsClient implements CompensationClient {
  readonly connector = 'microsoft_contacts';
  private credentialProvider: CredentialProvider;
  private baseUrl = 'https://graph.microsoft.com/v1.0';

  constructor(credentialProvider: CredentialProvider) {
    this.credentialProvider = credentialProvider;
  }

  private async request<T>(
    method: string,
    path: string,
    body?: Record<string, any>,
    options: { query?: Record<string, string> } = {}
  ): Promise<T> {
    // Always fetch fresh credentials per request — never cache. The provider
    // delegates to credentialService.getCredentials, which handles refresh.
    const credentials = await this.credentialProvider();
    let url = `${this.baseUrl}${path}`;

    if (options.query) {
      const params = new URLSearchParams(options.query);
      url += `?${params.toString()}`;
    }

    const response = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${credentials.accessToken}`,
        'Content-Type': 'application/json',
      },
      body: body ? JSON.stringify(body) : undefined,
    });

    if (!response.ok) {
      const error = await response.text();
      logger.error('Microsoft Contacts API error', { status: response.status, error, path });
      throw new Error(`Microsoft Contacts API error: ${response.status} - ${error}`);
    }

    if (response.status === 204) {
      return {} as T;
    }

    return response.json() as Promise<T>;
  }

  async read(entityType: string, entityId: string | undefined, payload?: Record<string, any>): Promise<ExternalRecord> {
    logger.info('Microsoft Contacts read', { entityType, entityId });

    switch (entityType) {
      case 'contact_list': {
        const p = payload ?? {};
        const result = await this.request<{ value: Array<Record<string, any>> }>(
          'GET', '/me/contacts',
          undefined, { query: { $top: String(p.pageSize ?? 100) } }
        );
        return { id: 'contact_list', data: { contacts: result.value } };
      }

      case 'contact_folders': {
        const result = await this.request<{ value: Array<Record<string, any>> }>('GET', '/me/contactFolders');
        return { id: 'contact_folders', data: { folders: result.value } };
      }

      case 'contact': {
        if (!entityId) throw new Error('entityId required for contact');
        const data = await this.request<Record<string, any>>(
          'GET',
          `/me/contacts/${entityId}`
        );
        return {
          id: entityId,
          data,
          versionToken: data.changeKey,
          lastModified: data.lastModifiedDateTime ? new Date(data.lastModifiedDateTime) : undefined,
        };
      }

      case 'contactFolder': {
        if (!entityId) throw new Error('entityId required for contactFolder');
        const data = await this.request<Record<string, any>>(
          'GET',
          `/me/contactFolders/${entityId}`
        );
        return {
          id: entityId,
          data,
          lastModified: undefined,
        };
      }

      default:
        throw new Error(`Unsupported entity type: ${entityType}`);
    }
  }

  // Reactive polling. The scheduler calls list('Contact') with the polling
  // entityType (capitalized) and an incremental `since` watermark. Microsoft
  // Graph contacts expose lastModifiedDateTime, so we page /me/contacts ordered
  // by it and filter forward from `since`. Pagination follows @odata.nextLink
  // ($skiptoken); we surface the raw skiptoken as the page token.
  async list(entityType: string, filters?: ListFilters): Promise<ListResult> {
    if (entityType !== 'Contact') return { records: [], hasMore: false, unsupported: true };

    const limit = filters?.limit ?? 100;
    const query: Record<string, string> = {
      $top: String(limit),
      $orderby: 'lastModifiedDateTime',
    };
    if (filters?.since instanceof Date) {
      query.$filter = `lastModifiedDateTime ge ${filters.since.toISOString()}`;
    }
    if (filters?.pageToken) query.$skiptoken = filters.pageToken;

    const result = await this.request<{
      value: Array<Record<string, any>>;
      '@odata.nextLink'?: string;
    }>('GET', '/me/contacts', undefined, { query });

    const records = (result.value ?? []).map(c => ({
      id: String(c.id ?? ''),
      data: c,
    }));
    const nextLink = result['@odata.nextLink'];
    const nextPageToken = nextLink
      ? new URL(nextLink).searchParams.get('$skiptoken') ?? undefined
      : undefined;

    return { records, nextPageToken, hasMore: !!nextPageToken };
  }


  async create(entityType: string, data: Record<string, any>): Promise<CreateResult> {
    logger.info('Microsoft Contacts create', { entityType });

    try {
      switch (entityType) {
        case 'contact': {
          const folderId = data.folderId;
          const path = folderId
            ? `/me/contactFolders/${folderId}/contacts`
            : '/me/contacts';

          const result = await this.request<{ id: string }>(
            'POST',
            path,
            {
              givenName: data.firstName,
              surname: data.lastName,
              displayName: data.displayName || `${data.firstName} ${data.lastName}`.trim(),
              emailAddresses: data.emails?.map((email: string) => ({
                address: email,
              })),
              businessPhones: data.businessPhones,
              mobilePhone: data.mobilePhone,
              companyName: data.company,
              jobTitle: data.jobTitle,
              department: data.department,
            }
          );

          return {
            success: true,
            id: result.id,
            data: result,
          };
        }

        case 'contactFolder': {
          const result = await this.request<{ id: string }>(
            'POST',
            '/me/contactFolders',
            {
              displayName: data.displayName,
            }
          );

          return {
            success: true,
            id: result.id,
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
    logger.info('Microsoft Contacts update', { entityType, entityId });

    try {
      switch (entityType) {
        case 'contact': {
          const updateData: Record<string, any> = {};
          if (data.firstName) updateData.givenName = data.firstName;
          if (data.lastName) updateData.surname = data.lastName;
          if (data.displayName) updateData.displayName = data.displayName;
          if (data.company) updateData.companyName = data.company;
          if (data.jobTitle) updateData.jobTitle = data.jobTitle;
          if (data.department) updateData.department = data.department;

          const result = await this.request<{ changeKey: string }>(
            'PATCH',
            `/me/contacts/${entityId}`,
            updateData
          );

          return {
            success: true,
            versionToken: result.changeKey,
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
    logger.info('Microsoft Contacts delete', { entityType, entityId });

    try {
      switch (entityType) {
        case 'contact': {
          await this.request<void>('DELETE', `/me/contacts/${entityId}`);
          return { success: true };
        }

        case 'contactFolder': {
          await this.request<void>('DELETE', `/me/contactFolders/${entityId}`);
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
    entityId: string,
    snapshot: Record<string, any>
  ): Promise<UpdateResult> {
    logger.info('Microsoft Contacts restore from snapshot', { entityType, entityId });

    if (entityType === 'contact') {
      return this.update(entityType, entityId, snapshot);
    }

    return {
      success: false,
      error: `Cannot restore Microsoft Contacts ${entityType}`,
    };
  }

  async semanticInverse(
    entityType: string,
    originalAction: string,
    entityId: string,
    originalResponse: Record<string, any>
  ): Promise<DeleteResult | UpdateResult> {
    logger.info('Microsoft Contacts semantic inverse', { entityType, originalAction, entityId });

    switch (originalAction) {
      case 'create':
        if (['contact', 'contactFolder'].includes(entityType)) {
          const id = originalResponse.id || entityId;
          return this.delete(entityType, id);
        }
        break;

      case 'delete':
        return {
          success: false,
          error: 'Cannot restore deleted contacts without backup',
        };

      case 'update':
        return {
          success: false,
          error: 'Update reversal requires pre-action snapshot',
        };

      default:
        return {
          success: false,
          error: `Cannot reverse Microsoft Contacts action: ${originalAction}`,
        };
    }

    return { success: false, error: 'Unknown entity type' };
  }

  // Utility methods
  async listContacts(options: {
    folderId?: string;
    pageSize?: number;
    skipToken?: string;
  } = {}): Promise<{ value: Array<Record<string, any>>; '@odata.nextLink'?: string }> {
    const query: Record<string, string> = {
      $top: (options.pageSize || 50).toString(),
    };

    if (options.skipToken) {
      query.$skiptoken = options.skipToken;
    }

    const path = options.folderId
      ? `/me/contactFolders/${options.folderId}/contacts`
      : '/me/contacts';

    return this.request<{ value: Array<Record<string, any>>; '@odata.nextLink'?: string }>(
      'GET',
      path,
      undefined,
      { query }
    );
  }
}
