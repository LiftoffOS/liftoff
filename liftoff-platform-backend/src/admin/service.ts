// Admin Service Implementation
// Per Section 15: Platform kill switches

import { AdminRepository, PlatformStatus, DisabledConnector, DisabledWorkflowType } from './repository';
import { EntitlementService } from '../entitlements/service';
import { publishEvent } from '../events/publisher';

export class AdminService {
  private repository = new AdminRepository();
  private entitlementService = new EntitlementService();

  // Per Section 15: Platform kill switches
  // - disable tenant
  // - disable connector
  // - disable workflow type
  // - freeze all writes globally

  async getPlatformStatus(): Promise<PlatformStatus> {
    return this.repository.getPlatformStatus();
  }

  async getDisabledConnectors(): Promise<DisabledConnector[]> {
    return this.repository.getDisabledConnectors();
  }

  async getDisabledWorkflowTypes(): Promise<DisabledWorkflowType[]> {
    return this.repository.getDisabledWorkflowTypes();
  }

  async disableTenant(tenantId: string, disabledBy: string = 'admin'): Promise<void> {
    // Update entitlement to suspended and disable agent execution
    await this.entitlementService.update(tenantId, {
      tenantOperationalStatus: 'suspended',
      agentExecutionAllowed: false,
    });

    // Per Section 4: Publish tenant.suspended event
    await publishEvent({
      entityType: 'tenant',
      entityId: tenantId,
      eventType: 'tenant.suspended',
      entityVersion: 1,
      eventVersion: 1,
      tenantId,
      payload: {
        reason: 'admin_kill_switch',
        disabledBy,
      },
    });
  }

  async enableTenant(tenantId: string): Promise<void> {
    // Update entitlement to active and enable agent execution
    await this.entitlementService.update(tenantId, {
      tenantOperationalStatus: 'active',
      agentExecutionAllowed: true,
    });

    // Per Section 4: Publish tenant.reactivated event
    await publishEvent({
      entityType: 'tenant',
      entityId: tenantId,
      eventType: 'tenant.reactivated',
      entityVersion: 1,
      eventVersion: 1,
      tenantId,
      payload: {},
    });
  }

  async disableConnector(connectorType: string, disabledBy: string = 'admin'): Promise<DisabledConnector> {
    const disabled = await this.repository.disableConnector(connectorType, disabledBy);

    await publishEvent({
      entityType: 'connector',
      entityId: connectorType,
      eventType: 'platform.connector.disabled',
      entityVersion: 1,
      eventVersion: 1,
      payload: {
        connectorType,
        disabledBy,
      },
    });

    return disabled;
  }

  async enableConnector(connectorType: string): Promise<void> {
    await this.repository.enableConnector(connectorType);

    await publishEvent({
      entityType: 'connector',
      entityId: connectorType,
      eventType: 'platform.connector.enabled',
      entityVersion: 1,
      eventVersion: 1,
      payload: {
        connectorType,
      },
    });
  }

  async disableWorkflowType(workflowType: string, disabledBy: string = 'admin'): Promise<DisabledWorkflowType> {
    const disabled = await this.repository.disableWorkflowType(workflowType, disabledBy);

    await publishEvent({
      entityType: 'workflow_type',
      entityId: workflowType,
      eventType: 'platform.workflow_type.disabled',
      entityVersion: 1,
      eventVersion: 1,
      payload: {
        workflowType,
        disabledBy,
      },
    });

    return disabled;
  }

  async enableWorkflowType(workflowType: string): Promise<void> {
    await this.repository.enableWorkflowType(workflowType);

    await publishEvent({
      entityType: 'workflow_type',
      entityId: workflowType,
      eventType: 'platform.workflow_type.enabled',
      entityVersion: 1,
      eventVersion: 1,
      payload: {
        workflowType,
      },
    });
  }

  async freezeAllWrites(): Promise<PlatformStatus> {
    const status = await this.repository.setGlobalWritesFrozen(true);

    await publishEvent({
      entityType: 'platform',
      entityId: 'global',
      eventType: 'platform.writes_frozen',
      entityVersion: 1,
      eventVersion: 1,
      payload: {
        frozenAt: status.updatedAt,
      },
    });

    return status;
  }

  async unfreezeAllWrites(): Promise<PlatformStatus> {
    const status = await this.repository.setGlobalWritesFrozen(false);

    await publishEvent({
      entityType: 'platform',
      entityId: 'global',
      eventType: 'platform.writes_unfrozen',
      entityVersion: 1,
      eventVersion: 1,
      payload: {
        unfrozenAt: status.updatedAt,
      },
    });

    return status;
  }

  // Check methods for runtime to use
  async isConnectorDisabled(connectorType: string): Promise<boolean> {
    return this.repository.isConnectorDisabled(connectorType);
  }

  async isWorkflowTypeDisabled(workflowType: string): Promise<boolean> {
    return this.repository.isWorkflowTypeDisabled(workflowType);
  }

  async areGlobalWritesFrozen(): Promise<boolean> {
    const status = await this.repository.getPlatformStatus();
    return status.globalWritesFrozen;
  }
}
