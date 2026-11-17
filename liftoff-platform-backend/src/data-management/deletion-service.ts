// Deletion Service
// Per Section 21: Tenant-scoped deletion for GDPR compliance

import Stripe from 'stripe';
import { DataManagementRepository } from './repository';
import {
  DeletionRequest,
  CreateDeletionRequestInput,
  EntityType,
  DeletionScope,
} from './types';
import { pool, withTenantScope } from '../infrastructure/database';
import { log, logAudit } from '../infrastructure/logging';
import { publishEvent } from '../events/publisher';
import { getStripeSecretKey } from '../infrastructure/secrets';
import { AccountService } from '../accounts/service';

// Same Firebase-UID-vs-accountId resolution as in export-service.ts —
// `requestedBy` stores the Firebase UID per the pre-existing column shape,
// but `audit_log.user_id` is UUID-typed and would NULL out a firebase UID.
const _accountService = new AccountService();
async function actorAccountId(firebaseUidOrAccountId: string): Promise<string | undefined> {
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(firebaseUidOrAccountId)) {
    return firebaseUidOrAccountId;
  }
  const account = await _accountService.getByFirebaseUid(firebaseUidOrAccountId);
  return account?.id;
}

let _stripe: Stripe | null = null;
async function getStripe(): Promise<Stripe> {
  if (!_stripe) {
    _stripe = new Stripe(await getStripeSecretKey());
  }
  return _stripe;
}

// Table mappings for each entity type
// `tenant` is in this map but CANNOT be soft-deleted: the tenants table has
// no deleted_at column and no migration adds one, so the generic UPDATE below
// could only ever raise `column "deleted_at" does not exist`. Deleting a
// workspace is AccountService.cascadeDelete's job, which removes every
// tenant-scoped row in foreign-key order and the tenants row with them -
// a different operation from marking a row, and the reason this one refuses
// instead of pretending.
const UNSUPPORTED_ENTITY_TYPES: Partial<Record<EntityType, string>> = {
  tenant:
    'Deleting a workspace is not a retention operation: it has no deleted_at column '
    + 'and its rows span every tenant-scoped table. Use the account cascade '
    + '(DELETE /api/admin/accounts/:id?cascade=true) instead.',
};

const ENTITY_TABLE_MAP: Record<EntityType, string> = {
  workflow: 'workflows',
  action: 'actions',
  usage_event: 'usage_events',
  // Singular: actual table name is `audit_log`. Migration 220 adds the
  // `deleted_at` column the generic soft-delete UPDATE expects.
  audit_log: 'audit_log',
  connector_record: 'connector_records',
  reflection: 'reflections',
  feedback: 'feedback_requests',
  account: 'accounts',
  tenant: 'tenants',
};

export class DeletionService {
  private repository = new DataManagementRepository();

  async createDeletionRequest(input: CreateDeletionRequestInput): Promise<DeletionRequest> {
    const request = await this.repository.createDeletionRequest(input);

    const userId = await actorAccountId(input.requestedBy);
    logAudit(
      'compliance.deletion_requested',
      { tenantId: input.tenantId, userId },
      {
        resourceType: 'deletion_request',
        resourceId: request.id,
        newState: {
          deletionType: input.deletionType,
          scope: input.scope,
          reason: input.reason,
        },
      },
    );

    log.info({
      requestId: request.id,
      tenantId: input.tenantId,
      deletionType: input.deletionType,
    }, 'Deletion request created');

    return request;
  }

  async verifyDeletion(requestId: string, token: string): Promise<DeletionRequest | null> {
    const request = await this.repository.verifyDeletionRequest(requestId, token);

    if (request) {
      const userId = await actorAccountId(request.requestedBy);
      logAudit(
        'compliance.deletion_verified',
        { tenantId: request.tenantId, userId },
        {
          resourceType: 'deletion_request',
          resourceId: requestId,
          newState: { requestId },
        },
      );

      log.info({ requestId }, 'Deletion request verified');
    }

    return request;
  }

  async executeDeletion(requestId: string): Promise<DeletionRequest> {
    const request = await this.repository.findDeletionRequestById(requestId);
    if (!request) {
      throw new Error(`Deletion request ${requestId} not found`);
    }

    if (request.status !== 'verified' && request.status !== 'scheduled') {
      throw new Error(`Deletion request ${requestId} is not in a valid state for execution`);
    }

    // Update status to running
    await this.repository.updateDeletionRequestStatus(requestId, 'running');

    try {
      const entityCounts: Record<EntityType, number> = {} as Record<EntityType, number>;

      // Execute deletion for each entity type in scope
      for (const entityType of request.scope.entityTypes) {
        const count = await this.deleteEntities(
          entityType,
          request.tenantId,
          request.scope
        );
        entityCounts[entityType] = count;
      }

      // SE-P2-003: When the deletion scope includes account-level data, nullify
      // billing_controls Stripe references and delete the Stripe customer record.
      // Must happen after entity deletion so the stripe_customer_id can still be read.
      if (request.scope.entityTypes.includes('account') || request.scope.entityTypes.includes('tenant')) {
        await this.nullifyBillingControls(request.tenantId);
      }

      // Update status to completed
      const completedRequest = await this.repository.updateDeletionRequestStatus(
        requestId,
        'completed',
        { entityCounts }
      );

      const userId = await actorAccountId(request.requestedBy);
      logAudit(
        'compliance.deletion_executed',
        { tenantId: request.tenantId, userId },
        {
          resourceType: 'deletion_request',
          resourceId: requestId,
          newState: { requestId, entityCounts },
        },
      );

      // Publish event
      await publishEvent({
        entityType: 'deletion_request',
        entityId: requestId,
        eventType: 'data.deletion.completed',
        entityVersion: 1,
        eventVersion: 1,
        tenantId: request.tenantId,
        payload: { entityCounts },
      });

      log.info({
        requestId,
        tenantId: request.tenantId,
        entityCounts,
      }, 'Deletion completed');

      return completedRequest;
    } catch (error) {
      log.error({ error, requestId }, 'Deletion failed');

      await this.repository.updateDeletionRequestStatus(
        requestId,
        'failed',
        { errorMessage: error instanceof Error ? error.message : 'Unknown error' }
      );

      throw error;
    }
  }

  private async deleteEntities(
    entityType: EntityType,
    tenantId: string,
    scope: DeletionScope
  ): Promise<number> {
    const unsupported = UNSUPPORTED_ENTITY_TYPES[entityType];
    if (unsupported) {
      // Thrown, not logged-and-skipped: a deletion request that reports
      // success while deleting nothing is the worst outcome available here.
      throw new Error(`Cannot delete entity type "${entityType}". ${unsupported}`);
    }

    const tableName = ENTITY_TABLE_MAP[entityType];
    if (!tableName) {
      log.warn({ entityType }, 'Unknown entity type for deletion');
      return 0;
    }

    const conditions: string[] = [];
    const params: unknown[] = [];
    let paramIndex = 1;

    // Tenant ID condition
    if (scope.tenantId) {
      conditions.push(`tenant_id = $${paramIndex++}`);
      params.push(scope.tenantId);
    } else {
      conditions.push(`tenant_id = $${paramIndex++}`);
      params.push(tenantId);
    }

    // User ID condition (for user-specific deletions)
    if (scope.userId) {
      // Different tables have different user ID column names
      const userColumn = this.getUserColumn(entityType);
      if (userColumn) {
        conditions.push(`${userColumn} = $${paramIndex++}`);
        params.push(scope.userId);
      }
    }

    // Date condition (for retention-based deletion)
    if (scope.olderThan) {
      conditions.push(`created_at < $${paramIndex++}`);
      params.push(scope.olderThan);
    }

    // Step one of two. This marks the rows, which removes them from every
    // read, list and export immediately; the hard delete happens in
    // src/maintenance/purge-soft-deleted.ts once the grace period
    // (SOFT_DELETE_PURGE_AFTER_DAYS, 30 by default) has elapsed.
    //
    // Both steps are required for this endpoint to mean what its name says.
    // Before the purge pass existed only this one ran, so a deletion request
    // marked rows that were never removed and the data stayed in the database
    // indefinitely under a method called deleteEntities.
    const query = `
      UPDATE ${tableName}
      SET deleted_at = NOW()
      WHERE ${conditions.join(' AND ')}
      AND deleted_at IS NULL
    `;

    // Dynamic ${tableName} from ENTITY_TABLE_MAP; audit_log is RLS-enabled.
    // The UPDATE is always tenant-filtered (tenant_id = scope.tenantId ??
    // tenantId) → withTenantScope on that same tenant.
    const result = await withTenantScope(scope.tenantId ?? tenantId, (client) => client.query(query, params));

    log.info({
      entityType,
      tableName,
      deletedCount: result.rowCount,
      tenantId,
    }, 'Entities soft-deleted');

    return result.rowCount || 0;
  }

  private getUserColumn(entityType: EntityType): string | null {
    switch (entityType) {
      case 'workflow':
        return 'created_by';
      case 'action':
        return 'agent_id';
      case 'feedback':
        return 'assigned_to';
      case 'account':
        return 'id';
      default:
        return null;
    }
  }

  // SE-P2-003: Nullify Stripe identifiers in billing_controls and delete the
  // Stripe customer record so no billing data persists after a DSR deletion.
  //
  // Sequence: read → Stripe delete → DB nullify.
  // If stripe.customers.del() fails, we still nullify the DB references so
  // the link is severed. The orphaned Stripe customer can be cleaned up manually.
  private async nullifyBillingControls(tenantId: string): Promise<void> {
    // Resolve the account_id and stripe_customer_id for this tenant
    const result = await pool.query<{ account_id: string; stripe_customer_id: string | null }>(
      `SELECT bc.account_id, bc.stripe_customer_id
       FROM billing_controls bc
       JOIN tenants t ON t.account_id = bc.account_id
       WHERE t.id = $1`,
      [tenantId],
    );

    if (result.rows.length === 0) {
      log.info({ tenantId }, 'billing.dsr: no billing_controls row found — nothing to nullify');
      return;
    }

    const { account_id: accountId, stripe_customer_id: stripeCustomerId } = result.rows[0];

    // Delete the Stripe customer record (best-effort — DB nullification still runs)
    if (stripeCustomerId) {
      try {
        const stripe = await getStripe();
        await stripe.customers.del(stripeCustomerId);
        log.info({ tenantId, accountId, stripeCustomerId }, 'billing.dsr: Stripe customer deleted');
      } catch (err) {
        log.warn({ tenantId, accountId, stripeCustomerId, error: (err as Error).message },
          'billing.dsr: stripe.customers.del() failed — nullifying DB references anyway');
      }
    }

    // Nullify Stripe references so no billable customer link remains in our DB
    await pool.query(
      `UPDATE billing_controls
       SET stripe_customer_id     = NULL,
           stripe_subscription_id = NULL,
           updated_at             = NOW()
       WHERE account_id = $1`,
      [accountId],
    );

    log.info({ tenantId, accountId }, 'billing.dsr: billing_controls Stripe references nullified');
  }

  async getDeletionRequest(requestId: string): Promise<DeletionRequest | null> {
    return this.repository.findDeletionRequestById(requestId);
  }

  async getTenantDeletionRequests(tenantId: string): Promise<DeletionRequest[]> {
    return this.repository.findDeletionRequestsByTenant(tenantId);
  }

  async cancelDeletionRequest(requestId: string): Promise<DeletionRequest> {
    const request = await this.repository.findDeletionRequestById(requestId);
    if (!request) {
      throw new Error(`Deletion request ${requestId} not found`);
    }

    if (request.status === 'running' || request.status === 'completed') {
      throw new Error(`Cannot cancel deletion request in ${request.status} status`);
    }

    return this.repository.updateDeletionRequestStatus(requestId, 'canceled');
  }

  async processScheduledDeletions(): Promise<number> {
    const scheduled = await this.repository.findScheduledDeletions();
    let processedCount = 0;

    for (const request of scheduled) {
      try {
        await this.executeDeletion(request.id);
        processedCount++;
      } catch (error) {
        log.error({
          error,
          requestId: request.id,
        }, 'Failed to process scheduled deletion');
      }
    }

    return processedCount;
  }
}
