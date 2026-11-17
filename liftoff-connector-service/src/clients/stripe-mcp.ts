import { CompensationClient, ExternalRecord, CreateResult, UpdateResult, DeleteResult, ListFilters, ListResult } from './types.js';
import { MCPClient } from '../mcp/mcp-client.js';
import { MCPError, MCPErrorCode } from '../mcp/mcp-errors.js';
import { OAuthTokenProvider } from '../mcp/token-provider.js';
import { CredentialStore } from '../mcp/credential-store.js';
import { validateStripeInput, validateStripeEntityId } from './stripe-validation.js';
import { logger } from '../infra/logging.js';

// Stripe entity types we support
type StripeEntityType =
  | 'customer'
  | 'subscription'
  | 'invoice'
  | 'payment_intent'
  | 'product'
  | 'price'
  | 'payment_link'
  | 'coupon'
  | 'refund';

// Stripe API operation ids, verified against the live server via
// `stripe_api_details` (which prints the HTTP path, so `idParam` below is read
// off the URL template rather than inferred).
//
// WHY NOT NAMED TOOLS. This client used to call `list_invoices`,
// `retrieve_customer`, `create_refund` and friends. Every one of them is now
// `Unknown tool` — Stripe's hosted MCP consolidated onto nine tools, of which
// `stripe_api_read` / `stripe_api_write` reach the REST API dynamically via an
// operation id. So named-tool calls leave Stripe polling and compensation BOTH
// dead, silently: an unknown-tool error is not credential-shaped, so the poll
// classifier files it as transient and retries forever without ever flipping
// the connector.
//
// Operations Stripe does NOT expose are omitted deliberately, and the methods
// below return an explicit failure for them rather than inventing a call:
// PostPaymentIntents, PostPaymentIntentsIntentCancel, DeleteCustomersCustomer
// and DeleteProductsId all answer "Operation is not available".
interface StripeOps {
  /** Path parameter name, taken from the operation's URL template. */
  idParam: string;
  list?: string;
  read?: string;
  create?: string;
  update?: string;
  delete?: string;
}

const STRIPE_OPS: Record<StripeEntityType, StripeOps> = {
  customer: {
    idParam: 'customer', list: 'GetCustomers', read: 'GetCustomersCustomer',
    create: 'PostCustomers', update: 'PostCustomersCustomer',
    // delete: DeleteCustomersCustomer is not exposed by the server.
  },
  subscription: {
    idParam: 'subscription_exposed_id', list: 'GetSubscriptions',
    read: 'GetSubscriptionsSubscriptionExposedId', create: 'PostSubscriptions',
    update: 'PostSubscriptionsSubscriptionExposedId',
    delete: 'DeleteSubscriptionsSubscriptionExposedId',
  },
  invoice: {
    idParam: 'invoice', list: 'GetInvoices', read: 'GetInvoicesInvoice',
    create: 'PostInvoices', update: 'PostInvoicesInvoice',
    // delete: invoices are voided (PostInvoicesInvoiceVoid), never deleted.
  },
  payment_intent: {
    idParam: 'intent', list: 'GetPaymentIntents', read: 'GetPaymentIntentsIntent',
    // create/cancel: not exposed by the server.
  },
  product: {
    idParam: 'id', list: 'GetProducts', read: 'GetProductsId',
    create: 'PostProducts', update: 'PostProductsId',
    // delete: DeleteProductsId is not exposed by the server.
  },
  price: {
    idParam: 'price', list: 'GetPrices', read: 'GetPricesPrice',
    create: 'PostPrices', update: 'PostPricesPrice',
    // delete: prices cannot be deleted, only archived.
  },
  payment_link: {
    idParam: 'payment_link', list: 'GetPaymentLinks', read: 'GetPaymentLinksPaymentLink',
    create: 'PostPaymentLinks', update: 'PostPaymentLinksPaymentLink',
    // delete: payment links cannot be deleted.
  },
  coupon: {
    idParam: 'coupon', list: 'GetCoupons', read: 'GetCouponsCoupon',
    create: 'PostCoupons', update: 'PostCouponsCoupon', delete: 'DeleteCouponsCoupon',
  },
  refund: {
    idParam: 'refund', list: 'GetRefunds', read: 'GetRefundsRefund', create: 'PostRefunds',
    // update/delete: refunds cannot be modified.
  },
};

export interface StripeMCPClientConfig {
  tenantId: string;
  credentialStore: CredentialStore;
  correlationId?: string;
}

export class StripeMCPClient implements CompensationClient {
  readonly connector = 'stripe';
  private mcpClient: MCPClient;
  private readonly tenantId: string;
  private readonly correlationId: string;

  constructor(config: StripeMCPClientConfig) {
    this.tenantId = config.tenantId;
    this.correlationId = config.correlationId || crypto.randomUUID();

    // Create token provider for dynamic token refresh
    const tokenProvider = new OAuthTokenProvider(
      {
        tenantId: config.tenantId,
        connectorType: 'stripe',
      },
      config.credentialStore
    );

    // NOTE: tenant-runtime's MCPClient had a retryConfig option that was
    // threaded into a bespoke retry loop. The ported MCPClient in
    // src/mcp/mcp-client.ts does not expose that yet — the underlying
    // @liftoffos/mcp-transports does not model retry, and Phase 1c left
    // retry wiring as a follow-up. Using the circuit-breaker default here;
    // add retry back behind a wrapper once the transport grows it.
    this.mcpClient = new MCPClient({
      url: 'https://mcp.stripe.com',
      tokenProvider,
      timeout: 30000,
    });

    this.mcpClient.setCorrelationId(this.correlationId);
  }

  /** Read a Stripe GET operation through the dynamic API tool. */
  private async apiRead(operationId: string, parameters: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.parseToolResult(
      await this.mcpClient.callTool('stripe_api_read', { stripe_api_operation_id: operationId, parameters }),
    );
  }

  /** Execute a Stripe POST/DELETE operation through the dynamic API tool. */
  private async apiWrite(operationId: string, parameters: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.parseToolResult(
      await this.mcpClient.callTool('stripe_api_write', { stripe_api_operation_id: operationId, parameters }),
    );
  }

  private getToolMapping(entityType: string): StripeOps {
    const mapping = STRIPE_OPS[entityType as StripeEntityType];
    if (!mapping) {
      throw new MCPError(
        MCPErrorCode.INVALID_ENTITY_TYPE,
        `Unsupported Stripe entity type: ${entityType}`,
        undefined,
        { entityType }
      );
    }
    return mapping;
  }

  private parseToolResult(result: MCPToolResult): Record<string, unknown> {
    if (result.isError) {
      const errorText = result.content.find(c => c.type === 'text')?.text;
      throw new MCPError(
        MCPErrorCode.TOOL_EXECUTION_FAILED,
        errorText || 'Unknown MCP error'
      );
    }
    const textContent = result.content.find(c => c.type === 'text');
    if (textContent?.text) {
      return JSON.parse(textContent.text);
    }
    return {};
  }

  async read(entityType: string, entityId: string): Promise<ExternalRecord> {
    // Validate inputs
    validateStripeEntityId(entityType, entityId);

    logger.info('Stripe MCP read', {
      entityType,
      entityId,
      tenantId: this.tenantId,
      correlationId: this.correlationId,
    });

    const mapping = this.getToolMapping(entityType);
    if (!mapping.read) {
      throw new MCPError(
        MCPErrorCode.TOOL_EXECUTION_FAILED,
        `Stripe does not expose a read operation for ${entityType}`,
        undefined,
        { entityType },
      );
    }
    const data = await this.apiRead(mapping.read, { [mapping.idParam]: entityId });

    return {
      id: entityId,
      data,
      lastModified: data.created ? new Date((data.created as number) * 1000) : undefined,
    };
  }

  // Reactive polling. The scheduler calls list('PaymentIntent' | 'Invoice' |
  // 'Subscription') with the capitalized polling entityType + an incremental
  // `since` watermark. Stripe's hosted MCP exposes the agent-toolkit's granular
  // list tools (same `retrieve_*`/`create_*` family this client already uses in
  // prod, so the `list_*` variants are evidence-backed). Stripe list objects are
  // `{ object: 'list', data: [...], has_more }`; pagination is cursor-based via
  // `starting_after` (the last id), incremental via `created.gte` (unix seconds).
  async list(entityType: string, filters?: ListFilters): Promise<ListResult> {
    const LIST_ENTITY: Record<string, StripeEntityType> = {
      PaymentIntent: 'payment_intent',
      Invoice: 'invoice',
      Subscription: 'subscription',
    };
    const key = LIST_ENTITY[entityType];
    const operationId = key && STRIPE_OPS[key].list;
    if (!operationId) return { records: [], hasMore: false, unsupported: true };

    // `created.gte` is a CREATION watermark, so this path carries creations
    // only. An invoice created before the window that later moves draft -> open
    // -> paid is never returned, which is why `invoice.updated` and
    // `subscription.updated` are not advertised on the poll (0df6fa2). Stripe
    // has no modified-since filter on any list — that is what its webhooks are
    // for, and they are the paired half of this fix.
    //
    // Keeping the watermark deliberately: dropping it to re-fetch everything and
    // lean on the content-hash version would make updates partly visible, but
    // the scheduler drains while `hasMore`, so an unfiltered list walks the whole
    // account history every cycle.
    const args: Record<string, unknown> = { limit: filters?.limit ?? 100 };
    if (filters?.since instanceof Date) {
      args.created = { gte: Math.floor(filters.since.getTime() / 1000) };
    }
    if (filters?.pageToken) args.starting_after = filters.pageToken;

    try {
      const parsed = await this.apiRead(operationId, args) as {
        data?: Array<Record<string, unknown>>;
        has_more?: boolean;
      };
      const rows = parsed.data ?? [];
      const records = rows.map(r => ({ id: String(r.id ?? ''), data: r }));
      const lastId = rows.length ? String(rows[rows.length - 1].id ?? '') : undefined;
      return {
        records,
        nextPageToken: parsed.has_more ? lastId : undefined,
        hasMore: !!parsed.has_more,
      };
    } catch (err) {
      // Fail safe: if the assumed list tool name is wrong on the live MCP,
      // surface it loudly (the scheduler catches + logs) rather than crashing
      // the cycle — the first live poll reveals the true tool name to confirm.
      logger.warn('Stripe MCP list failed', {
        entityType, operationId, tenantId: this.tenantId,
        error: (err as Error).message,
      });
      throw err;
    }
  }

  async create(entityType: string, data: Record<string, unknown>): Promise<CreateResult> {
    // Validate inputs
    validateStripeInput(entityType, 'create', data);

    logger.info('Stripe MCP create', {
      entityType,
      tenantId: this.tenantId,
      correlationId: this.correlationId,
    });

    try {
      const mapping = this.getToolMapping(entityType);

      if (!mapping.create) {
        return { success: false, id: '', error: `Cannot create ${entityType}` };
      }

      const responseData = await this.apiWrite(mapping.create, data);

      logger.info('Stripe MCP create success', {
        entityType,
        entityId: responseData.id,
        tenantId: this.tenantId,
        correlationId: this.correlationId,
      });

      return {
        success: true,
        id: responseData.id as string,
        data: responseData,
      };
    } catch (error) {
      logger.error('Stripe MCP create failed', {
        entityType,
        tenantId: this.tenantId,
        correlationId: this.correlationId,
        error: (error as Error).message,
      });

      return {
        success: false,
        id: '',
        error: (error as Error).message,
      };
    }
  }

  async update(entityType: string, entityId: string, data: Record<string, unknown>): Promise<UpdateResult> {
    // Validate inputs
    validateStripeEntityId(entityType, entityId);
    validateStripeInput(entityType, 'update', data);

    logger.info('Stripe MCP update', {
      entityType,
      entityId,
      tenantId: this.tenantId,
      correlationId: this.correlationId,
    });

    try {
      const mapping = this.getToolMapping(entityType);

      if (!mapping.update) {
        return { success: false, error: `Cannot update ${entityType}` };
      }

      const responseData = await this.apiWrite(mapping.update, { [mapping.idParam]: entityId, ...data });

      logger.info('Stripe MCP update success', {
        entityType,
        entityId,
        tenantId: this.tenantId,
        correlationId: this.correlationId,
      });

      return {
        success: true,
        data: responseData,
      };
    } catch (error) {
      logger.error('Stripe MCP update failed', {
        entityType,
        entityId,
        tenantId: this.tenantId,
        correlationId: this.correlationId,
        error: (error as Error).message,
      });

      return {
        success: false,
        error: (error as Error).message,
      };
    }
  }

  async delete(entityType: string, entityId: string): Promise<DeleteResult> {
    // Validate inputs
    validateStripeEntityId(entityType, entityId);

    logger.info('Stripe MCP delete', {
      entityType,
      entityId,
      tenantId: this.tenantId,
      correlationId: this.correlationId,
    });

    try {
      const mapping = this.getToolMapping(entityType);

      if (!mapping.delete) {
        return { success: false, error: `Cannot delete ${entityType}` };
      }

      await this.apiWrite(mapping.delete, { [mapping.idParam]: entityId });

      logger.info('Stripe MCP delete success', {
        entityType,
        entityId,
        tenantId: this.tenantId,
        correlationId: this.correlationId,
      });

      return { success: true };
    } catch (error) {
      logger.error('Stripe MCP delete failed', {
        entityType,
        entityId,
        tenantId: this.tenantId,
        correlationId: this.correlationId,
        error: (error as Error).message,
      });

      return {
        success: false,
        error: (error as Error).message,
      };
    }
  }

  async restore(entityType: string, entityId: string, snapshot: Record<string, unknown>): Promise<UpdateResult> {
    logger.info('Stripe MCP restore from snapshot', {
      entityType,
      entityId,
      tenantId: this.tenantId,
      correlationId: this.correlationId,
    });

    // Filter out read-only fields
    const writableFields = this.filterWritableFields(entityType, snapshot);

    return this.update(entityType, entityId, writableFields);
  }

  async semanticInverse(
    entityType: string,
    originalAction: string,
    entityId: string,
    originalResponse: Record<string, unknown>
  ): Promise<DeleteResult | UpdateResult> {
    logger.info('Stripe MCP semantic inverse', {
      entityType,
      originalAction,
      entityId,
      tenantId: this.tenantId,
      correlationId: this.correlationId,
    });

    switch (originalAction) {
      case 'create':
        // Delete/cancel what was created
        return this.delete(entityType, entityId || (originalResponse.id as string));

      case 'charge':
      case 'payment':
        // Refund the payment
        try {
          await this.apiWrite('PostRefunds', {
            payment_intent: entityId || originalResponse.id,
          });

          logger.info('Stripe MCP refund success', {
            paymentIntentId: entityId || originalResponse.id,
            tenantId: this.tenantId,
            correlationId: this.correlationId,
          });

          return { success: true };
        } catch (error) {
          logger.error('Stripe MCP refund failed', {
            paymentIntentId: entityId || originalResponse.id,
            tenantId: this.tenantId,
            correlationId: this.correlationId,
            error: (error as Error).message,
          });

          return { success: false, error: (error as Error).message };
        }

      default:
        return {
          success: false,
          error: `Cannot reverse Stripe action: ${originalAction}`,
        };
    }
  }

  private filterWritableFields(entityType: string, data: Record<string, unknown>): Record<string, unknown> {
    // Remove Stripe read-only fields
    const readOnlyFields = ['id', 'object', 'created', 'livemode', 'updated'];
    const filtered: Record<string, unknown> = {};

    for (const [key, value] of Object.entries(data)) {
      if (!readOnlyFields.includes(key)) {
        filtered[key] = value;
      }
    }

    return filtered;
  }

  // Cleanup on client disposal
  dispose(): void {
    this.mcpClient.disconnect();
  }
}

interface MCPToolResult {
  content: Array<{
    type: 'text' | 'image' | 'resource';
    text?: string;
    data?: string;
    mimeType?: string;
  }>;
  isError?: boolean;
}
