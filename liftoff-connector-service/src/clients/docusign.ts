// DocuSign eSign REST API Client
// Auth: OAuth2 Bearer token from CredentialProvider.
// Base URL (full, incl. accountId) stored in credential.instanceUrl.
// See mcp-servers/docusign/API_REFERENCE.md for endpoint reference.

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

// Maximum number of 429-retry attempts before giving up.
const MAX_RETRY_ATTEMPTS = 3;

export class DocuSignClient implements CompensationClient {
  readonly connector = 'docusign';
  private credentialProvider: CredentialProvider;

  constructor(credentialProvider: CredentialProvider) {
    this.credentialProvider = credentialProvider;
  }

  // ── Internal request helper ─────────────────────────────────────────────────

  private async request<T>(
    method: string,
    path: string,
    body?: Record<string, unknown>,
    queryParams?: Record<string, string>,
    attempt = 0,
  ): Promise<T> {
    // Fetch credentials fresh per-request — never cache.
    // instanceUrl holds the full base URL:
    //   https://{accountId}.docusign.net/restapi/v2.1/accounts/{accountId}
    const credentials = await this.credentialProvider();
    const baseUrl = credentials.instanceUrl;
    if (!baseUrl) {
      throw new Error('DocuSign credential missing instanceUrl (base URL with accountId)');
    }

    let url = `${baseUrl}${path}`;
    if (queryParams && Object.keys(queryParams).length > 0) {
      url = `${url}?${new URLSearchParams(queryParams).toString()}`;
    }

    const response = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${credentials.accessToken}`,
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      body: body ? JSON.stringify(body) : undefined,
    });

    // 429 Rate limit — read Retry-After and retry up to MAX_RETRY_ATTEMPTS
    if (response.status === 429) {
      if (attempt >= MAX_RETRY_ATTEMPTS) {
        const retryAfter = response.headers.get('Retry-After') ?? '60';
        throw new Error(`DocuSign rate limit exceeded. Retry after ${retryAfter}s.`);
      }
      const retryAfterHeader = response.headers.get('Retry-After');
      const waitMs = retryAfterHeader ? Number(retryAfterHeader) * 1000 : 2000 * (attempt + 1);
      logger.warn('DocuSign 429 — backing off', { attempt, waitMs, path });
      await new Promise((resolve) => setTimeout(resolve, waitMs));
      return this.request<T>(method, path, body, queryParams, attempt + 1);
    }

    // 204 No Content (e.g., some PUT responses)
    if (response.status === 204) {
      return {} as T;
    }

    if (!response.ok) {
      const error = await response.text();
      logger.error('DocuSign API error', { status: response.status, error, path, method });
      throw new Error(`DocuSign API error: ${response.status} - ${error}`);
    }

    return response.json() as Promise<T>;
  }

  // ── Envelope operations ─────────────────────────────────────────────────────

  /**
   * Create (send) a DocuSign envelope.
   * Supports both inline-document mode (documentBase64 + signerEmail/signerName)
   * and full recipients/documents objects for advanced use cases.
   */
  async createEnvelope(data: Record<string, unknown>): Promise<Record<string, unknown>> {
    // Build a minimal envelope body, merging any full-body fields from data.
    const body: Record<string, unknown> = {
      emailSubject: data.emailSubject,
      status: data.status ?? 'sent',
    };

    if (data.emailBlurb) body.emailBlurb = data.emailBlurb;

    // Full recipients/documents override short-form helpers
    if (data.recipients) {
      body.recipients = data.recipients;
    } else if (data.signerEmail && data.signerName) {
      body.recipients = {
        signers: [
          {
            email: data.signerEmail,
            name: data.signerName,
            recipientId: '1',
          },
        ],
      };
    }

    if (data.documents) {
      body.documents = data.documents;
    } else if (data.documentBase64) {
      body.documents = [
        {
          documentBase64: data.documentBase64,
          name: data.documentName ?? 'document.pdf',
          fileExtension: data.fileExtension ?? 'pdf',
          documentId: '1',
        },
      ];
    }

    // Template-based envelopes
    if (data.templateId) {
      body.templateId = data.templateId;
      if (data.templateRoles) body.templateRoles = data.templateRoles;
    }

    return this.request<Record<string, unknown>>('POST', '/envelopes', body);
  }

  /**
   * Get envelope status and metadata.
   */
  async getEnvelope(envelopeId: string): Promise<Record<string, unknown>> {
    return this.request<Record<string, unknown>>('GET', `/envelopes/${envelopeId}`);
  }

  /**
   * List envelopes, optionally filtered by status/date.
   */
  async listEnvelopes(params: Record<string, string> = {}): Promise<Record<string, unknown>> {
    // DocuSign requires from_date; default to 30 days ago if not supplied
    const queryParams: Record<string, string> = {};
    if (params.from_date) queryParams.from_date = params.from_date;
    if (params.status) queryParams.status = params.status;
    if (params.count) queryParams.count = params.count;
    if (params.start_position) queryParams.start_position = params.start_position;
    return this.request<Record<string, unknown>>('GET', '/envelopes', undefined, queryParams);
  }

  /**
   * Void (cancel) an envelope in sent or delivered status.
   */
  async voidEnvelope(
    envelopeId: string,
    voidedReason: string,
  ): Promise<Record<string, unknown>> {
    return this.request<Record<string, unknown>>('PUT', `/envelopes/${envelopeId}`, {
      status: 'voided',
      voidedReason,
    });
  }

  /**
   * List all recipients for an envelope.
   */
  async listRecipients(envelopeId: string): Promise<Record<string, unknown>> {
    return this.request<Record<string, unknown>>('GET', `/envelopes/${envelopeId}/recipients`);
  }

  /**
   * Download a document from an envelope as base64.
   * documentId can be numeric or "combined" (all documents merged into one PDF).
   */
  async getDocument(
    envelopeId: string,
    documentId: string = 'combined',
  ): Promise<Record<string, unknown>> {
    const credentials = await this.credentialProvider();
    const baseUrl = credentials.instanceUrl;
    if (!baseUrl) {
      throw new Error('DocuSign credential missing instanceUrl');
    }
    const url = `${baseUrl}/envelopes/${envelopeId}/documents/${documentId}`;

    const response = await fetch(url, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${credentials.accessToken}`,
        Accept: 'application/pdf',
      },
    });

    if (response.status === 429) {
      const retryAfter = response.headers.get('Retry-After') ?? '60';
      throw new Error(`DocuSign rate limit exceeded. Retry after ${retryAfter}s.`);
    }

    if (!response.ok) {
      const error = await response.text();
      logger.error('DocuSign document download error', {
        status: response.status,
        envelopeId,
        documentId,
        error,
      });
      throw new Error(`DocuSign document download error: ${response.status} - ${error}`);
    }

    // Convert binary response to base64 for transport
    const buffer = await response.arrayBuffer();
    const base64 = Buffer.from(buffer).toString('base64');
    return {
      envelopeId,
      documentId,
      contentBase64: base64,
      contentType: response.headers.get('Content-Type') ?? 'application/pdf',
    };
  }

  // ── CompensationClient interface ─────────────────────────────────────────────

  /**
   * read() — maps entity type to the correct DocuSign read operation.
   *
   * Supported entityTypes:
   *   - 'envelope'    → getEnvelope(entityId)
   *   - 'envelopes'   → listEnvelopes(payload as query params)
   *   - 'recipients'  → listRecipients(envelopeId from payload.envelopeId)
   *   - 'document'    → getDocument(payload.envelopeId, payload.documentId)
   */
  async read(
    entityType: string,
    entityId: string | undefined,
    payload?: Record<string, unknown>,
  ): Promise<ExternalRecord> {
    logger.info('DocuSign read', { entityType, entityId });

    switch (entityType) {
      case 'envelope': {
        const id = entityId ?? (payload?.id as string);
        if (!id) throw new Error('DocuSign: envelope read requires entityId');
        const data = await this.getEnvelope(id);
        return {
          id,
          data,
          versionToken: data.statusChangedDateTime as string | undefined,
          lastModified: data.statusChangedDateTime
            ? new Date(data.statusChangedDateTime as string)
            : undefined,
        };
      }

      case 'envelopes': {
        const params: Record<string, string> = {};
        if (payload) {
          for (const [k, v] of Object.entries(payload)) {
            if (typeof v === 'string') params[k] = v;
          }
        }
        const data = await this.listEnvelopes(params);
        return { id: 'envelopes', data };
      }

      case 'recipients': {
        const envelopeId = (payload?.envelopeId as string) ?? entityId;
        if (!envelopeId) throw new Error('DocuSign: recipients read requires envelopeId');
        const data = await this.listRecipients(envelopeId);
        return { id: `recipients:${envelopeId}`, data };
      }

      case 'document': {
        const envelopeId = (payload?.envelopeId as string) ?? entityId;
        const documentId = (payload?.documentId as string) ?? 'combined';
        if (!envelopeId) throw new Error('DocuSign: document read requires envelopeId');
        const data = await this.getDocument(envelopeId, documentId);
        return { id: `document:${envelopeId}:${documentId}`, data };
      }

      default:
        throw new Error(`DocuSign: unsupported read entity type "${entityType}"`);
    }
  }

  /**
   * create() — creates a DocuSign envelope.
   *
   * Supported entityTypes:
   *   - 'envelope' → createEnvelope(data)
   */
  /** Enumerate envelopes, or the recipients of one.
   *
   *  DocuSign requires a lower bound on envelope searches, so an absent
   *  `filters.since` becomes the last 30 days rather than an unbounded scan of
   *  the account. Recipients need `filters.folderId` to name the envelope;
   *  without it the answer is empty but NOT unsupported, because the client can
   *  do it once told which envelope. */
  async list(entityType: string, filters?: ListFilters): Promise<ListResult> {
    const rows = (data: unknown[]) =>
      data.map(row => {
        const r = row as Record<string, any>;
        return { id: String(r.envelopeId ?? r.recipientId ?? r.id ?? ''), data: r };
      });

    switch (entityType) {
      case 'envelope':
      case 'envelopes': {
        const since = filters?.since
          ?? new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
        const result = await this.listEnvelopes({
          from_date: since.toISOString(),
          count: String(filters?.limit ?? 100),
        }) as Record<string, any>;
        return {
          records: rows(result.envelopes ?? []),
          hasMore: false,
        };
      }

      case 'recipient':
      case 'recipients': {
        const envelopeId = (filters as Record<string, unknown> | undefined)?.folderId as string | undefined;
        if (!envelopeId) return { records: [], hasMore: false };
        const result = await this.listRecipients(envelopeId) as Record<string, any>;
        return { records: rows(result.signers ?? []), hasMore: false };
      }

      default:
        return { records: [], hasMore: false, unsupported: true };
    }
  }


  async create(entityType: string, data: Record<string, unknown>): Promise<CreateResult> {
    logger.info('DocuSign create', { entityType });

    try {
      switch (entityType) {
        case 'envelope': {
          const result = await this.createEnvelope(data);
          const id = (result.envelopeId as string) ?? '';
          return { success: true, id, data: result };
        }

        case 'recipients': {
          // manage_recipients routes here (write, name doesn't start with update/edit/modify)
          const envelopeId = data.envelopeId as string | undefined;
          if (!envelopeId) {
            return { success: false, id: '', error: 'DocuSign manage_recipients: envelopeId is required' };
          }
          const operation = data.operation as string | undefined;
          let result: Record<string, unknown>;
          if (operation === 'update') {
            result = await this.request<Record<string, unknown>>(
              'PUT',
              `/envelopes/${envelopeId}/recipients`,
              data.recipients as Record<string, unknown>,
            );
          } else if (operation === 'delete') {
            result = await this.request<Record<string, unknown>>(
              'DELETE',
              `/envelopes/${envelopeId}/recipients`,
              data.recipients as Record<string, unknown>,
            );
          } else {
            result = await this.request<Record<string, unknown>>(
              'POST',
              `/envelopes/${envelopeId}/recipients`,
              data.recipients as Record<string, unknown>,
            );
          }
          return { success: true, id: envelopeId, data: result };
        }

        default:
          return {
            success: false,
            id: '',
            error: `DocuSign: unsupported create entity type "${entityType}"`,
          };
      }
    } catch (error) {
      return { success: false, id: '', error: (error as Error).message };
    }
  }

  /**
   * update() — supports updating an envelope (status, emailSubject, voidedReason).
   * Also handles the envelope void via status=voided.
   */
  async update(
    entityType: string,
    entityId: string | undefined,
    data: Record<string, unknown>,
  ): Promise<UpdateResult> {
    logger.info('DocuSign update', { entityType, entityId });

    try {
      switch (entityType) {
        case 'envelope': {
          if (!entityId) {
            return { success: false, error: 'DocuSign update_envelope: entityId (envelopeId) is required' };
          }
          const result = await this.request<Record<string, unknown>>(
            'PUT',
            `/envelopes/${entityId}`,
            data,
          );
          return { success: true, data: result };
        }

        default:
          return {
            success: false,
            error: `DocuSign: update not supported for entity type "${entityType}" — use void_envelope to cancel`,
          };
      }
    } catch (error) {
      return { success: false, error: (error as Error).message };
    }
  }

  /**
   * delete() — voids a DocuSign envelope.
   *
   * Supported entityTypes:
   *   - 'envelope_void' → voidEnvelope(entityId, payload.voidedReason)
   */
  async delete(
    entityType: string,
    entityId: string | undefined,
    payload?: Record<string, unknown>,
  ): Promise<DeleteResult> {
    logger.info('DocuSign delete (void)', { entityType, entityId });

    try {
      if (entityType === 'envelope_void') {
        const id = entityId ?? (payload?.id as string);
        if (!id) {
          return { success: false, error: 'DocuSign: voidEnvelope requires entityId' };
        }
        const reason = (payload?.voidedReason as string) ?? 'Voided via Liftoff agent';
        await this.voidEnvelope(id, reason);
        return { success: true };
      }

      return {
        success: false,
        error: `DocuSign: unsupported delete entity type "${entityType}"`,
      };
    } catch (error) {
      return { success: false, error: (error as Error).message };
    }
  }

  // ── Compensation ─────────────────────────────────────────────────────────────

  async restore(
    entityType: string,
    _entityId: string | undefined,
    _snapshot: Record<string, unknown>,
  ): Promise<UpdateResult> {
    logger.info('DocuSign restore (not supported)', { entityType });
    return {
      success: false,
      error: 'DocuSign: envelopes cannot be restored — they are append-only',
    };
  }

  async semanticInverse(
    entityType: string,
    originalAction: string,
    entityId: string | undefined,
    _originalResponse: Record<string, unknown>,
  ): Promise<DeleteResult | UpdateResult> {
    logger.info('DocuSign semantic inverse', { entityType, originalAction, entityId });

    switch (originalAction) {
      case 'create':
        // Inverse of send_envelope: void it
        if (entityType === 'envelope' && entityId) {
          return this.delete('envelope_void', entityId, {
            voidedReason: 'Compensating transaction — voiding sent envelope',
          });
        }
        return {
          success: false,
          error: `DocuSign: cannot invert create for entity type "${entityType}" without entityId`,
        };

      case 'delete':
        return {
          success: false,
          error: 'DocuSign: cannot restore a voided envelope',
        };

      default:
        return {
          success: false,
          error: `DocuSign: cannot reverse action ${originalAction} on ${entityType}`,
        };
    }
  }
}
