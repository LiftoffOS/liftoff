// Google Ads Connector Client
// REST API v18 — requires OAuth 2.0 (adwords scope) + developer-token header.
// Entity ID format: "{customerId}/{resourceId}" for campaigns and ad groups;
// "{customerId}/{adGroupId}~{criterionId}" for keywords.

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

export class GoogleAdsClient implements CompensationClient {
  readonly connector = 'google_ads';
  private credentialProvider: CredentialProvider;
  private baseUrl = 'https://googleads.googleapis.com/v18';

  constructor(credentialProvider: CredentialProvider) {
    this.credentialProvider = credentialProvider;
  }

  private get developerToken(): string {
    return process.env.GOOGLE_ADS_DEVELOPER_TOKEN ?? '';
  }

  private async request<T>(
    method: string,
    path: string,
    body?: Record<string, any>
  ): Promise<T> {
    const credentials = await this.credentialProvider();

    // Support manager accounts via connectorConfig
    const loginCustomerId = credentials.connectorConfig?.loginCustomerId as string | undefined;
    const extraHeaders: Record<string, string> = {
      'developer-token': this.developerToken,
    };
    if (loginCustomerId) {
      extraHeaders['login-customer-id'] = loginCustomerId.replace(/-/g, '');
    }

    // composio_managed routing — see clients/composio-transport.ts.
    // Composio's Ads toolkit base is https://googleads.googleapis.com;
    // prepend /v18 to match our direct baseUrl path-portion.
    const composio = await tryComposioProxy<T>(credentials, {
      method: method.toUpperCase() as 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH',
      path: `/v18${path}`,
      body,
      headers: extraHeaders,
    });
    if (composio.handled) return composio.data;

    const headers: Record<string, string> = {
      Authorization: `Bearer ${bearerFor(credentials, 'google_ads')}`,
      ...extraHeaders,
      'Content-Type': 'application/json',
    };

    const response = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    });

    if (!response.ok) {
      const error = await response.text();
      logger.error('Google Ads API error', { status: response.status, error, path });
      throw new Error(`Google Ads API error: ${response.status} - ${error}`);
    }

    if (response.status === 204) {
      return {} as T;
    }

    return response.json() as Promise<T>;
  }

  // Run a GAQL query against a customer's account.
  private async search<T extends Record<string, any>>(
    customerId: string,
    query: string
  ): Promise<T[]> {
    const result = await this.request<{ results?: T[] }>(
      'POST',
      `/customers/${customerId}/googleAds:search`,
      { query }
    );
    return result.results ?? [];
  }

  // Mutate campaigns/adGroups/adGroupCriteria and return the first result.
  private async mutate<T>(
    customerId: string,
    resource: string,
    operations: Record<string, any>[]
  ): Promise<T> {
    return this.request<T>(
      'POST',
      `/customers/${customerId}/${resource}:mutate`,
      { operations }
    );
  }

  async read(entityType: string, entityId: string): Promise<ExternalRecord> {
    logger.info('Google Ads read', { entityType, entityId });

    const [customerId, resourceId] = this.parseId(entityId);

    switch (entityType) {
      case 'campaign': {
        const rows = await this.search<{ campaign: Record<string, any> }>(
          customerId,
          `SELECT campaign.id, campaign.name, campaign.status,
                  campaign.advertising_channel_type, campaign.bidding_strategy_type,
                  campaign.start_date, campaign.end_date
           FROM campaign
           WHERE campaign.id = ${resourceId}`
        );
        if (!rows[0]) throw new Error(`Campaign not found: ${entityId}`);
        return { id: entityId, data: rows[0].campaign };
      }

      case 'ad_group': {
        const rows = await this.search<{ adGroup: Record<string, any> }>(
          customerId,
          `SELECT ad_group.id, ad_group.name, ad_group.status,
                  ad_group.campaign, ad_group.type, ad_group.cpc_bid_micros
           FROM ad_group
           WHERE ad_group.id = ${resourceId}`
        );
        if (!rows[0]) throw new Error(`Ad group not found: ${entityId}`);
        return { id: entityId, data: rows[0].adGroup };
      }

      case 'keyword': {
        // resourceId format: "{adGroupId}~{criterionId}"
        const [adGroupId, criterionId] = resourceId.split('~');
        const rows = await this.search<{ adGroupCriterion: Record<string, any> }>(
          customerId,
          `SELECT ad_group_criterion.criterion_id, ad_group_criterion.keyword.text,
                  ad_group_criterion.keyword.match_type, ad_group_criterion.status,
                  ad_group_criterion.ad_group
           FROM ad_group_criterion
           WHERE ad_group_criterion.ad_group = 'customers/${customerId}/adGroups/${adGroupId}'
             AND ad_group_criterion.criterion_id = ${criterionId}`
        );
        if (!rows[0]) throw new Error(`Keyword not found: ${entityId}`);
        return { id: entityId, data: rows[0].adGroupCriterion };
      }

      case 'performance_report': {
        // entityId: "{customerId}" — resourceId is the customerId itself
        const rows = await this.search<{ campaign: Record<string, any>; metrics: Record<string, any> }>(
          customerId,
          `SELECT campaign.id, campaign.name, campaign.status,
                  metrics.impressions, metrics.clicks, metrics.cost_micros,
                  metrics.conversions, metrics.ctr, metrics.average_cpc
           FROM campaign
           WHERE segments.date DURING LAST_30_DAYS`
        );
        return {
          id: entityId,
          data: { campaigns: rows.map(r => ({ ...r.campaign, metrics: r.metrics })) },
        };
      }

      case 'campaign_budgets': {
        const [budgetCustomerId] = entityId ? entityId.split('/') : [''];
        const rows = await this.search<{ campaign_budget: Record<string, any> }>(
          budgetCustomerId || entityId || '',
          `SELECT campaign_budget.id, campaign_budget.name, campaign_budget.amount_micros,
                  campaign_budget.status, campaign_budget.type, campaign_budget.period
           FROM campaign_budget
           WHERE campaign_budget.status != 'REMOVED'`,
        );
        return {
          id: entityId ?? 'campaign_budgets',
          data: { budgets: rows.map(r => r.campaign_budget) },
        };
      }

      default:
        throw new Error(`Unsupported entity type: ${entityType}`);
    }
  }

  /** Enumerate campaigns or ad groups under one customer account.
   *
   *  Every Google Ads query is scoped to a customer id, and ids here are
   *  already "{customerId}/{resourceId}" (see the note at the top of this
   *  file), so `filters.folderId` carries the customer. Without it there is no
   *  account to query — an underspecified request, not a missing capability,
   *  so no unsupported marker.
   *
   *  Records keep the compound id so anything read back can be resolved by
   *  parseId without the caller having to reassemble it. */
  async list(entityType: string, filters?: ListFilters): Promise<ListResult> {
    const customerId = (filters as Record<string, unknown> | undefined)?.folderId as string | undefined;
    if (!customerId) return { records: [], hasMore: false };

    const limit = filters?.limit ?? 100;

    const gaql = (resource: string, fields: string[]) =>
      `SELECT ${fields.join(', ')} FROM ${resource} `
      + `WHERE ${resource}.status != 'REMOVED' LIMIT ${limit}`;

    switch (entityType) {
      case 'campaign':
      case 'campaigns': {
        const results = await this.search<Record<string, any>>(
          customerId,
          gaql('campaign', [
            'campaign.id', 'campaign.name', 'campaign.status',
            'campaign.advertising_channel_type',
          ]),
        );
        return {
          records: results.map(r => ({
            id: `${customerId}/${r.campaign?.id ?? ''}`,
            data: r.campaign ?? r,
          })),
          hasMore: false,
        };
      }

      case 'ad_group':
      case 'ad_groups': {
        const results = await this.search<Record<string, any>>(
          customerId,
          gaql('ad_group', [
            'ad_group.id', 'ad_group.name', 'ad_group.status', 'ad_group.campaign',
          ]),
        );
        return {
          records: results.map(r => ({
            id: `${customerId}/${r.ad_group?.id ?? ''}`,
            data: r.ad_group ?? r,
          })),
          hasMore: false,
        };
      }

      default:
        return { records: [], hasMore: false, unsupported: true };
    }
  }

  private async createBudget(customerId: string, data: Record<string, any>): Promise<Record<string, any>> {
    const operations = [{
      create: {
        name: data.name,
        amountMicros: data.amount_micros ?? Math.round((data.amount_usd ?? 0) * 1_000_000),
        deliveryMethod: data.delivery_method ?? 'STANDARD',
      },
    }];
    return this.mutate<Record<string, any>>(customerId, 'campaignBudgets', operations);
  }

  private async updateBudget(customerId: string, budgetId: string, data: Record<string, any>): Promise<Record<string, any>> {
    const operations = [{
      update: {
        resourceName: `customers/${customerId}/campaignBudgets/${budgetId}`,
        name: data.name,
        amountMicros: data.amount_micros ?? (data.amount_usd ? Math.round(data.amount_usd * 1_000_000) : undefined),
      },
      updateMask: Object.keys(data).filter(k => k !== 'id').join(','),
    }];
    return this.mutate<Record<string, any>>(customerId, 'campaignBudgets', operations);
  }

  async create(entityType: string, data: Record<string, any>): Promise<CreateResult> {
    logger.info('Google Ads create', { entityType });

    try {
      const { customerId, ...payload } = data;
      if (!customerId) {
        return { success: false, id: '', error: 'customerId is required' };
      }
      const cid = String(customerId).replace(/-/g, '');

      switch (entityType) {
        case 'campaign': {
          const result = await this.mutate<{ results: Array<{ resourceName: string }> }>(
            cid,
            'campaigns',
            [{ create: payload }]
          );
          const resourceName = result.results?.[0]?.resourceName ?? '';
          const campaignId = resourceName.split('/').pop() ?? '';
          return { success: true, id: `${cid}/${campaignId}`, data: result.results?.[0] };
        }

        case 'ad_group': {
          const result = await this.mutate<{ results: Array<{ resourceName: string }> }>(
            cid,
            'adGroups',
            [{ create: payload }]
          );
          const resourceName = result.results?.[0]?.resourceName ?? '';
          const adGroupId = resourceName.split('/').pop() ?? '';
          return { success: true, id: `${cid}/${adGroupId}`, data: result.results?.[0] };
        }

        case 'keyword': {
          // payload.adGroupId required
          const { adGroupId, ...criterionData } = payload;
          if (!adGroupId) {
            return { success: false, id: '', error: 'adGroupId is required for keyword creation' };
          }
          const criterion = {
            adGroup: `customers/${cid}/adGroups/${adGroupId}`,
            keyword: {
              text: criterionData.text,
              matchType: criterionData.matchType ?? 'BROAD',
            },
            status: criterionData.status ?? 'ENABLED',
          };
          const result = await this.mutate<{ results: Array<{ resourceName: string }> }>(
            cid,
            'adGroupCriteria',
            [{ create: criterion }]
          );
          const resourceName = result.results?.[0]?.resourceName ?? '';
          // resource name: customers/{cid}/adGroups/{agId}/criteria/{crit}
          const parts = resourceName.split('/');
          const criterionId = parts.pop() ?? '';
          const agId = parts[parts.length - 2] ?? adGroupId;
          return { success: true, id: `${cid}/${agId}~${criterionId}`, data: result.results?.[0] };
        }

        case 'campaign_budget': {
          const budgetCustomerId = data.customer_id as string;
          if (!budgetCustomerId) return { success: false, id: '', error: 'Google Ads: campaign_budget create requires customer_id' };
          const budgetCid = String(budgetCustomerId).replace(/-/g, '');
          const result = await this.createBudget(budgetCid, data);
          return { success: true, id: String((result as Record<string, any>).id ?? ''), data: result };
        }

        default:
          return { success: false, id: '', error: `Unsupported entity type: ${entityType}` };
      }
    } catch (error) {
      return { success: false, id: '', error: (error as Error).message };
    }
  }

  async update(
    entityType: string,
    entityId: string,
    data: Record<string, any>
  ): Promise<UpdateResult> {
    logger.info('Google Ads update', { entityType, entityId });

    try {
      const [customerId, resourceId] = this.parseId(entityId);

      switch (entityType) {
        case 'campaign': {
          const resourceName = `customers/${customerId}/campaigns/${resourceId}`;
          const updateFields = { resourceName, ...data };
          const updateMask = Object.keys(data).join(',');
          await this.mutate(customerId, 'campaigns', [{ update: updateFields, updateMask }]);
          return { success: true };
        }

        case 'ad_group': {
          const resourceName = `customers/${customerId}/adGroups/${resourceId}`;
          const updateFields = { resourceName, ...data };
          const updateMask = Object.keys(data).join(',');
          await this.mutate(customerId, 'adGroups', [{ update: updateFields, updateMask }]);
          return { success: true };
        }

        case 'keyword': {
          // resourceId: "{adGroupId}~{criterionId}"
          const [adGroupId, criterionId] = resourceId.split('~');
          const resourceName = `customers/${customerId}/adGroups/${adGroupId}/criteria/${criterionId}`;
          const { text: _text, matchType: _matchType, ...mutableFields } = data;
          const updateFields = { resourceName, ...mutableFields };
          const updateMask = Object.keys(mutableFields).join(',');
          await this.mutate(customerId, 'adGroupCriteria', [{ update: updateFields, updateMask }]);
          return { success: true };
        }

        case 'campaign_budget': {
          // entityId format: "customerId/budgetId" — parseId already split this above
          if (!customerId || !resourceId) return { success: false, error: 'Google Ads: campaign_budget update requires entityId as "customerId/budgetId"' };
          const result = await this.updateBudget(customerId, resourceId, data);
          return { success: true, data: result };
        }

        default:
          return { success: false, error: `Unsupported entity type: ${entityType}` };
      }
    } catch (error) {
      return { success: false, error: (error as Error).message };
    }
  }

  async delete(entityType: string, entityId: string): Promise<DeleteResult> {
    logger.info('Google Ads delete', { entityType, entityId });

    try {
      const [customerId, resourceId] = this.parseId(entityId);

      switch (entityType) {
        case 'campaign': {
          const resourceName = `customers/${customerId}/campaigns/${resourceId}`;
          await this.mutate(customerId, 'campaigns', [{ remove: resourceName }]);
          return { success: true };
        }

        case 'ad_group': {
          const resourceName = `customers/${customerId}/adGroups/${resourceId}`;
          await this.mutate(customerId, 'adGroups', [{ remove: resourceName }]);
          return { success: true };
        }

        case 'keyword': {
          const [adGroupId, criterionId] = resourceId.split('~');
          const resourceName = `customers/${customerId}/adGroups/${adGroupId}/criteria/${criterionId}`;
          await this.mutate(customerId, 'adGroupCriteria', [{ remove: resourceName }]);
          return { success: true };
        }

        default:
          return { success: false, error: `Unsupported entity type: ${entityType}` };
      }
    } catch (error) {
      return { success: false, error: (error as Error).message };
    }
  }

  async restore(
    entityType: string,
    entityId: string,
    snapshot: Record<string, any>
  ): Promise<UpdateResult> {
    logger.info('Google Ads restore from snapshot', { entityType, entityId });

    if (entityType === 'campaign') {
      const restoreFields: Record<string, any> = {};
      if (snapshot.name) restoreFields.name = snapshot.name;
      if (snapshot.status) restoreFields.status = snapshot.status;
      if (snapshot.startDate) restoreFields.startDate = snapshot.startDate;
      if (snapshot.endDate) restoreFields.endDate = snapshot.endDate;
      return this.update('campaign', entityId, restoreFields);
    }

    if (entityType === 'ad_group') {
      const restoreFields: Record<string, any> = {};
      if (snapshot.name) restoreFields.name = snapshot.name;
      if (snapshot.status) restoreFields.status = snapshot.status;
      if (snapshot.cpcBidMicros) restoreFields.cpcBidMicros = snapshot.cpcBidMicros;
      return this.update('ad_group', entityId, restoreFields);
    }

    return { success: false, error: `Cannot restore Google Ads ${entityType}` };
  }

  async semanticInverse(
    entityType: string,
    originalAction: string,
    entityId: string,
    originalResponse: Record<string, any>
  ): Promise<DeleteResult | UpdateResult> {
    logger.info('Google Ads semantic inverse', { entityType, originalAction, entityId });

    switch (originalAction) {
      case 'create':
        return this.delete(entityType, entityId || originalResponse.id);

      case 'delete':
        return {
          success: false,
          error: 'Cannot restore removed Google Ads resources without snapshot data',
        };

      case 'update':
        return {
          success: false,
          error: 'Update reversal requires pre-action snapshot',
        };

      default:
        return { success: false, error: `Cannot reverse Google Ads action: ${originalAction}` };
    }
  }

  // Parse "{customerId}/{resourceId}" → [customerId, resourceId]
  private parseId(entityId: string): [string, string] {
    const slashIdx = entityId.indexOf('/');
    if (slashIdx === -1) return ['', entityId];
    return [entityId.slice(0, slashIdx), entityId.slice(slashIdx + 1)];
  }
}
