// Google Slides Connector Client
// Per Section 11 & 12: Real Google Slides API implementation

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

export class GoogleSlidesClient implements CompensationClient {
  readonly connector = 'google_slides';
  private credentialProvider: CredentialProvider;
  private baseUrl = 'https://slides.googleapis.com/v1';

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
        Authorization: `Bearer ${bearerFor(credentials, 'google_slides')}`,
        'Content-Type': 'application/json',
      },
      body: body ? JSON.stringify(body) : undefined,
    });

    if (!response.ok) {
      const error = await response.text();
      logger.error('Google Slides API error', { status: response.status, error, path });
      throw new Error(`Google Slides API error: ${response.status} - ${error}`);
    }

    if (response.status === 204) {
      return {} as T;
    }

    return response.json() as Promise<T>;
  }

  private async requestDrive<T>(
    method: string,
    path: string,
    body?: Record<string, unknown>,
  ): Promise<T> {
    const credentials = await this.credentialProvider();

    // composio_managed routing for the Drive endpoint (cross-API: a Slides
    // account calling the Drive API — Composio allows cross-host absolute URLs).
    const composio = await tryComposioProxy<T>(credentials, {
      method: method.toUpperCase() as 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH',
      path: `https://www.googleapis.com/drive/v3${path}`,
      body: body as Record<string, any> | undefined,
    });
    if (composio.handled) return composio.data;

    const response = await fetch(`https://www.googleapis.com/drive/v3${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${bearerFor(credentials, 'google_slides')}`,
        'Content-Type': 'application/json',
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!response.ok) {
      const error = await response.text();
      logger.error('Google Drive API error', { status: response.status, error, path });
      throw new Error(`Google Drive API error: ${response.status} - ${error}`);
    }
    if (response.status === 204) return {} as T;
    return response.json() as Promise<T>;
  }

  async read(entityType: string, entityId: string | undefined, payload?: Record<string, any>): Promise<ExternalRecord> {
    logger.info('Google Slides read', { entityType, entityId });

    switch (entityType) {
      case 'presentations': {
        const p = payload ?? {};
        const params = new URLSearchParams({
          q: "mimeType='application/vnd.google-apps.presentation' and trashed=false",
          fields: 'files(id,name,modifiedTime),nextPageToken',
          pageSize: String(p.pageSize ?? 100),
        });
        const result = await this.requestDrive<{ files: Array<Record<string, any>>; nextPageToken?: string }>(
          'GET',
          `/files?${params}`
        );
        return { id: 'presentations', data: { presentations: result.files, nextPageToken: result.nextPageToken } };
      }

      case 'presentation': {
        if (!entityId) throw new Error('entityId required for presentation');
        const data = await this.request<Record<string, any>>(
          'GET',
          `/presentations/${entityId}`
        );
        return {
          id: entityId,
          data,
          versionToken: data.revisionId,
          lastModified: data.revisionId ? new Date() : undefined,
        };
      }

      case 'slide': {
        const presentationId = payload?.presentationId || (entityId ? this.parseSlideId(entityId)[0] : undefined);
        const slideId = payload?.slideId || (entityId ? this.parseSlideId(entityId)[1] : undefined);
        if (!presentationId || !slideId) throw new Error('read_slide: presentationId and slideId required');
        const presentation = await this.request<Record<string, any>>(
          'GET',
          `/presentations/${presentationId}`
        );
        const slide = presentation.slides?.find(
          (s: { objectId?: string }) => s.objectId === slideId
        );
        if (!slide) {
          throw new Error(`Slide ${slideId} not found in presentation ${presentationId}`);
        }
        return {
          id: entityId ?? `${presentationId}/${slideId}`,
          data: slide,
        };
      }

      case 'element': {
        const presentationId = payload?.presentationId || (entityId ? this.parseElementId(entityId)[0] : undefined);
        const slideId = payload?.slideId || (entityId ? this.parseElementId(entityId)[1] : undefined);
        const elementId = payload?.elementId || (entityId ? this.parseElementId(entityId)[2] : undefined);
        if (!presentationId || !slideId || !elementId) throw new Error('read_element: presentationId, slideId, and elementId required');
        const presentation = await this.request<Record<string, any>>(
          'GET',
          `/presentations/${presentationId}`
        );
        const slide = presentation.slides?.find(
          (s: { objectId?: string }) => s.objectId === slideId
        );
        if (!slide) {
          throw new Error(`Slide ${slideId} not found`);
        }
        const element = slide.pageElements?.find(
          (e: { objectId?: string }) => e.objectId === elementId
        );
        if (!element) {
          throw new Error(`Element ${elementId} not found on slide ${slideId}`);
        }
        return {
          id: entityId ?? `${presentationId}/${slideId}/${elementId}`,
          data: element,
        };
      }

      default:
        throw new Error(`Unsupported entity type: ${entityType}`);
    }
  }

  async list(_entityType: string, filters?: ListFilters): Promise<ListResult> {
    const params = new URLSearchParams({
      q: "mimeType='application/vnd.google-apps.presentation' and trashed=false",
      fields: 'files(id,name,modifiedTime,webViewLink)',
      pageSize: String(filters?.limit ?? 50),
    });
    if (filters?.pageToken) params.set('pageToken', filters.pageToken as string);

    const resp = await this.requestDrive<{
      files: Array<{ id: string; name: string; modifiedTime: string; webViewLink?: string }>;
      nextPageToken?: string;
    }>('GET', `/files?${params}`);

    return {
      records: (resp.files ?? []).map(f => ({
        id: f.id, type: 'presentation',
        data: { name: f.name, modifiedAt: f.modifiedTime, webViewUrl: f.webViewLink },
      })),
      hasMore: !!resp.nextPageToken,
      nextPageToken: resp.nextPageToken,
    };
  }

  async create(entityType: string, data: Record<string, any>): Promise<CreateResult> {
    logger.info('Google Slides create', { entityType });

    try {
      switch (entityType) {
        case 'presentation': {
          const result = await this.request<{ presentationId: string; title: string }>(
            'POST',
            '/presentations',
            { title: data.title || 'Untitled Presentation' }
          );

          return {
            success: true,
            id: result.presentationId,
            data: result,
          };
        }

        case 'slide': {
          const presentationId = data.presentationId;
          const insertionIndex = data.insertionIndex;
          const slideLayoutReference = data.slideLayoutReference || {
            predefinedLayout: 'BLANK',
          };

          const objectId = data.objectId || `slide_${Date.now()}`;

          const result = await this.request<{ replies: Array<{ createSlide: { objectId: string } }> }>(
            'POST',
            `/presentations/${presentationId}:batchUpdate`,
            {
              requests: [{
                createSlide: {
                  objectId,
                  insertionIndex,
                  slideLayoutReference,
                },
              }],
            }
          );

          const createdSlideId = result.replies?.[0]?.createSlide?.objectId || objectId;
          return {
            success: true,
            id: `${presentationId}/${createdSlideId}`,
            data: result,
          };
        }

        case 'textbox': {
          const presentationId = data.presentationId;
          const slideId = data.slideId;
          const objectId = data.objectId || `textbox_${Date.now()}`;

          const result = await this.request<{ replies: Array<Record<string, any>> }>(
            'POST',
            `/presentations/${presentationId}:batchUpdate`,
            {
              requests: [
                {
                  createShape: {
                    objectId,
                    shapeType: 'TEXT_BOX',
                    elementProperties: {
                      pageObjectId: slideId,
                      size: data.size || {
                        width: { magnitude: 300, unit: 'PT' },
                        height: { magnitude: 50, unit: 'PT' },
                      },
                      transform: data.transform || {
                        scaleX: 1,
                        scaleY: 1,
                        translateX: data.x || 100,
                        translateY: data.y || 100,
                        unit: 'PT',
                      },
                    },
                  },
                },
                ...(data.text ? [{
                  insertText: {
                    objectId,
                    text: data.text,
                    insertionIndex: 0,
                  },
                }] : []),
              ],
            }
          );

          return {
            success: true,
            id: `${presentationId}/${slideId}/${objectId}`,
            data: result,
          };
        }

        case 'image': {
          const presentationId = data.presentationId;
          const slideId = data.slideId;
          const objectId = data.objectId || `image_${Date.now()}`;

          const result = await this.request<{ replies: Array<Record<string, any>> }>(
            'POST',
            `/presentations/${presentationId}:batchUpdate`,
            {
              requests: [{
                createImage: {
                  objectId,
                  url: data.url,
                  elementProperties: {
                    pageObjectId: slideId,
                    size: data.size,
                    transform: data.transform || {
                      scaleX: 1,
                      scaleY: 1,
                      translateX: data.x || 100,
                      translateY: data.y || 100,
                      unit: 'PT',
                    },
                  },
                },
              }],
            }
          );

          return {
            success: true,
            id: `${presentationId}/${slideId}/${objectId}`,
            data: result,
          };
        }

        case 'shape': {
          const presentationId = data.presentationId;
          const slideId = data.slideId;
          const objectId = data.objectId || `shape_${Date.now()}`;

          const result = await this.request<{ replies: Array<Record<string, any>> }>(
            'POST',
            `/presentations/${presentationId}:batchUpdate`,
            {
              requests: [{
                createShape: {
                  objectId,
                  shapeType: data.shapeType || 'RECTANGLE',
                  elementProperties: {
                    pageObjectId: slideId,
                    size: data.size,
                    transform: data.transform,
                  },
                },
              }],
            }
          );

          return {
            success: true,
            id: `${presentationId}/${slideId}/${objectId}`,
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
    logger.info('Google Slides update', { entityType, entityId });

    try {
      switch (entityType) {
        case 'presentation': {
          // Update presentation title
          const result = await this.request<Record<string, any>>(
            'POST',
            `/presentations/${entityId}:batchUpdate`,
            { requests: data.requests || [] }
          );

          return {
            success: true,
            data: result,
          };
        }

        case 'slide': {
          const presentationId = data.presentationId || (entityId ? this.parseSlideId(entityId)[0] : undefined);
          const slideId = data.slideId || (entityId ? this.parseSlideId(entityId)[1] : undefined);
          if (!presentationId || !slideId) throw new Error('update_slide: presentationId and slideId required');
          const requests: Array<Record<string, any>> = data.requests ?? [];

          if (data.background) {
            requests.push({
              updatePageProperties: {
                objectId: slideId,
                pageProperties: {
                  pageBackgroundFill: data.background,
                },
                fields: 'pageBackgroundFill',
              },
            });
          }

          const result = await this.request<Record<string, any>>(
            'POST',
            `/presentations/${presentationId}:batchUpdate`,
            { requests }
          );

          return {
            success: true,
            data: result,
          };
        }

        case 'element': {
          const presentationId = data.presentationId || (entityId ? this.parseElementId(entityId)[0] : undefined);
          const elementId = data.elementId || (entityId ? this.parseElementId(entityId)[2] : undefined);
          if (!presentationId || !elementId) throw new Error('update_element: presentationId and elementId required');
          const requests: Array<Record<string, any>> = [];

          if (data.text !== undefined) {
            // Delete existing text and insert new
            requests.push({
              deleteText: {
                objectId: elementId,
                textRange: { type: 'ALL' },
              },
            });
            if (data.text) {
              requests.push({
                insertText: {
                  objectId: elementId,
                  text: data.text,
                  insertionIndex: 0,
                },
              });
            }
          }

          if (data.transform) {
            requests.push({
              updatePageElementTransform: {
                objectId: elementId,
                transform: data.transform,
                applyMode: 'ABSOLUTE',
              },
            });
          }

          if (data.style) {
            requests.push({
              updateShapeProperties: {
                objectId: elementId,
                shapeProperties: data.style,
                fields: data.fields || '*',
              },
            });
          }

          const result = await this.request<Record<string, any>>(
            'POST',
            `/presentations/${presentationId}:batchUpdate`,
            { requests }
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

  async delete(entityType: string, entityId: string | undefined, payload?: Record<string, any>): Promise<DeleteResult> {
    logger.info('Google Slides delete', { entityType, entityId });

    try {
      switch (entityType) {
        case 'slide': {
          const presentationId = payload?.presentationId || (entityId ? this.parseSlideId(entityId)[0] : undefined);
          const slideId = payload?.slideId || (entityId ? this.parseSlideId(entityId)[1] : undefined);
          if (!presentationId || !slideId) throw new Error('delete_slide: presentationId and slideId required');
          await this.request<void>(
            'POST',
            `/presentations/${presentationId}:batchUpdate`,
            {
              requests: [{
                deleteObject: {
                  objectId: slideId,
                },
              }],
            }
          );
          return { success: true };
        }

        case 'element': {
          const presentationId = payload?.presentationId || (entityId ? this.parseElementId(entityId)[0] : undefined);
          const elementId = payload?.elementId || (entityId ? this.parseElementId(entityId)[2] : undefined);
          if (!presentationId || !elementId) throw new Error('delete_element: presentationId and elementId required');
          await this.request<void>(
            'POST',
            `/presentations/${presentationId}:batchUpdate`,
            {
              requests: [{
                deleteObject: {
                  objectId: elementId,
                },
              }],
            }
          );
          return { success: true };
        }

        case 'presentation':
          // Presentations are deleted via Drive API
          return {
            success: false,
            error: 'Use Google Drive API to delete presentations',
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
    logger.info('Google Slides restore from snapshot', { entityType, entityId });

    if (entityType === 'element') {
      const restoreData: Record<string, any> = {};

      // Restore text content
      if (snapshot.text) {
        restoreData.text = snapshot.text;
      }

      // Restore transform
      if (snapshot.transform) {
        restoreData.transform = snapshot.transform;
      }

      // Restore style
      if (snapshot.shapeProperties) {
        restoreData.style = snapshot.shapeProperties;
      }

      return this.update(entityType, entityId, restoreData);
    }

    if (entityType === 'slide') {
      // Restore slide background
      if (snapshot.pageProperties?.pageBackgroundFill) {
        return this.update(entityType, entityId, {
          background: snapshot.pageProperties.pageBackgroundFill,
        });
      }
    }

    return {
      success: false,
      error: `Cannot restore Google Slides ${entityType}`,
    };
  }

  async semanticInverse(
    entityType: string,
    originalAction: string,
    entityId: string,
    originalResponse: Record<string, any>
  ): Promise<DeleteResult | UpdateResult> {
    logger.info('Google Slides semantic inverse', { entityType, originalAction, entityId });

    switch (originalAction) {
      case 'create':
        if (entityType === 'slide') {
          const slideId = originalResponse.replies?.[0]?.createSlide?.objectId;
          if (slideId) {
            const presentationId = entityId.split('/')[0];
            return this.delete('slide', `${presentationId}/${slideId}`);
          }
        }
        if (['textbox', 'image', 'shape', 'element'].includes(entityType)) {
          return this.delete('element', entityId);
        }
        // For presentation creation, use Drive API
        return {
          success: false,
          error: 'Use Google Drive API to delete created presentations',
        };

      case 'delete':
        return {
          success: false,
          error: 'Cannot restore deleted Google Slides elements without snapshot',
        };

      case 'update':
        return {
          success: false,
          error: 'Update reversal requires pre-action snapshot',
        };

      default:
        return {
          success: false,
          error: `Cannot reverse Google Slides action: ${originalAction}`,
        };
    }
  }

  // Utility methods
  async duplicateSlide(
    presentationId: string,
    slideId: string,
    insertionIndex?: number
  ): Promise<CreateResult> {
    try {
      const newSlideId = `slide_${Date.now()}`;
      const result = await this.request<{ replies: Array<{ duplicateObject: { objectId: string } }> }>(
        'POST',
        `/presentations/${presentationId}:batchUpdate`,
        {
          requests: [{
            duplicateObject: {
              objectId: slideId,
              objectIds: {
                [slideId]: newSlideId,
              },
            },
          }],
        }
      );

      const duplicatedSlideId = result.replies?.[0]?.duplicateObject?.objectId || newSlideId;

      // Move to insertion index if specified
      if (insertionIndex !== undefined) {
        await this.request<void>(
          'POST',
          `/presentations/${presentationId}:batchUpdate`,
          {
            requests: [{
              updateSlidesPosition: {
                slideObjectIds: [duplicatedSlideId],
                insertionIndex,
              },
            }],
          }
        );
      }

      return {
        success: true,
        id: `${presentationId}/${duplicatedSlideId}`,
        data: result,
      };
    } catch (error) {
      return {
        success: false,
        id: '',
        error: (error as Error).message,
      };
    }
  }

  async reorderSlides(
    presentationId: string,
    slideIds: string[],
    insertionIndex: number
  ): Promise<UpdateResult> {
    try {
      const result = await this.request<Record<string, any>>(
        'POST',
        `/presentations/${presentationId}:batchUpdate`,
        {
          requests: [{
            updateSlidesPosition: {
              slideObjectIds: slideIds,
              insertionIndex,
            },
          }],
        }
      );

      return {
        success: true,
        data: result,
      };
    } catch (error) {
      return {
        success: false,
        error: (error as Error).message,
      };
    }
  }

  async replaceAllText(
    presentationId: string,
    replacements: Array<{ find: string; replace: string; matchCase?: boolean }>,
  ): Promise<UpdateResult> {
    const requests = replacements.map(r => ({
      replaceAllText: {
        replaceText: r.replace,
        pageObjectIds: [],
        containsText: { text: r.find, matchCase: r.matchCase ?? false },
      },
    }));
    const result = await this.request<{ replies: unknown[] }>(
      'POST', `/presentations/${presentationId}:batchUpdate`, { requests },
    );
    return { success: true, data: result };
  }

  async createTable(
    presentationId: string,
    slideId: string,
    options: { rows: number; columns: number; x?: number; y?: number; width?: number; height?: number },
  ): Promise<{ tableObjectId: string }> {
    const requests = [{
      createTable: {
        objectId: undefined,
        elementProperties: {
          pageObjectId: slideId,
          size: {
            width: { magnitude: options.width ?? 6000000, unit: 'EMU' },
            height: { magnitude: options.height ?? 3000000, unit: 'EMU' },
          },
          transform: {
            scaleX: 1, scaleY: 1,
            translateX: options.x ?? 1000000,
            translateY: options.y ?? 1000000,
            unit: 'EMU',
          },
        },
        rows: options.rows,
        columns: options.columns,
      },
    }];
    const result = await this.request<{ replies: Array<{ createTable?: { objectId: string } }> }>(
      'POST', `/presentations/${presentationId}:batchUpdate`, { requests },
    );
    const tableObjectId = result.replies?.[0]?.createTable?.objectId;
    if (!tableObjectId) throw new Error('createTable: no objectId returned from API');
    return { tableObjectId };
  }

  async insertTableCellText(
    presentationId: string,
    tableObjectId: string,
    rowIndex: number,
    columnIndex: number,
    text: string,
  ): Promise<UpdateResult> {
    const requests = [
      {
        deleteText: {
          objectId: tableObjectId,
          cellLocation: { rowIndex, columnIndex },
          textRange: { type: 'ALL' },
        },
      },
      {
        insertText: {
          objectId: tableObjectId,
          cellLocation: { rowIndex, columnIndex },
          insertionIndex: 0,
          text,
        },
      },
    ];
    const result = await this.request<{ replies: unknown[] }>(
      'POST', `/presentations/${presentationId}:batchUpdate`, { requests },
    );
    return { success: true, data: result };
  }

  private parseSlideId(entityId: string): [string, string] {
    if (entityId.includes('/')) {
      const parts = entityId.split('/');
      return [parts[0], parts[1]];
    }
    return [entityId, ''];
  }

  private parseElementId(entityId: string): [string, string, string] {
    if (entityId.includes('/')) {
      const parts = entityId.split('/');
      return [parts[0], parts[1], parts[2] || ''];
    }
    return [entityId, '', ''];
  }
}
