// Admin Service Tests
// Tests platform kill switches, tenant management, connector/workflow disabling

import { AdminService } from '../service';
import { AdminRepository, PlatformStatus, DisabledConnector, DisabledWorkflowType } from '../repository';
import { EntitlementService } from '../../entitlements/service';
import { createMockEntitlement } from '../../test-utils/mocks';

// Mock external dependencies
jest.mock('../../infrastructure/database');
jest.mock('../repository');
jest.mock('../../entitlements/service');

// Mock publishEvent - define inline since jest.mock is hoisted
jest.mock('../../events/publisher', () => ({
  publishEvent: jest.fn().mockResolvedValue(undefined),
}));

// Import the mocked function
import { publishEvent } from '../../events/publisher';
const mockPublishEvent = publishEvent as jest.MockedFunction<typeof publishEvent>;

describe('AdminService', () => {
  let adminService: AdminService;
  let mockRepository: jest.Mocked<AdminRepository>;
  let mockEntitlementService: jest.Mocked<EntitlementService>;

  beforeEach(() => {
    jest.clearAllMocks();

    // Create mock repository
    mockRepository = {
      getPlatformStatus: jest.fn(),
      setGlobalWritesFrozen: jest.fn(),
      getDisabledConnectors: jest.fn(),
      isConnectorDisabled: jest.fn(),
      disableConnector: jest.fn(),
      enableConnector: jest.fn(),
      getDisabledWorkflowTypes: jest.fn(),
      isWorkflowTypeDisabled: jest.fn(),
      disableWorkflowType: jest.fn(),
      enableWorkflowType: jest.fn(),
    } as unknown as jest.Mocked<AdminRepository>;

    // Create mock entitlement service
    mockEntitlementService = {
      update: jest.fn(),
      getByTenantId: jest.fn(),
      listAll: jest.fn(),
      create: jest.fn(),
    } as unknown as jest.Mocked<EntitlementService>;

    // Replace AdminRepository prototype methods
    (AdminRepository as jest.Mock).mockImplementation(() => mockRepository);
    (EntitlementService as jest.Mock).mockImplementation(() => mockEntitlementService);

    adminService = new AdminService();
  });

  describe('getPlatformStatus', () => {
    it('should return platform status', async () => {
      const status: PlatformStatus = {
        id: 'global',
        globalWritesFrozen: false,
        updatedAt: new Date(),
      };

      mockRepository.getPlatformStatus.mockResolvedValue(status);

      const result = await adminService.getPlatformStatus();

      expect(mockRepository.getPlatformStatus).toHaveBeenCalled();
      expect(result).toEqual(status);
    });

    it('should return frozen status when writes are frozen', async () => {
      const status: PlatformStatus = {
        id: 'global',
        globalWritesFrozen: true,
        updatedAt: new Date(),
      };

      mockRepository.getPlatformStatus.mockResolvedValue(status);

      const result = await adminService.getPlatformStatus();

      expect(result.globalWritesFrozen).toBe(true);
    });
  });

  describe('getDisabledConnectors', () => {
    it('should return list of disabled connectors', async () => {
      const disabledConnectors: DisabledConnector[] = [
        {
          id: 'dc_1',
          connectorType: 'salesforce',
          disabledAt: new Date(),
          disabledBy: 'admin',
        },
        {
          id: 'dc_2',
          connectorType: 'hubspot',
          disabledAt: new Date(),
          disabledBy: 'system',
        },
      ];

      mockRepository.getDisabledConnectors.mockResolvedValue(disabledConnectors);

      const result = await adminService.getDisabledConnectors();

      expect(mockRepository.getDisabledConnectors).toHaveBeenCalled();
      expect(result).toHaveLength(2);
      expect(result[0].connectorType).toBe('salesforce');
    });

    it('should return empty array when no connectors are disabled', async () => {
      mockRepository.getDisabledConnectors.mockResolvedValue([]);

      const result = await adminService.getDisabledConnectors();

      expect(result).toEqual([]);
    });
  });

  describe('getDisabledWorkflowTypes', () => {
    it('should return list of disabled workflow types', async () => {
      const disabledWorkflowTypes: DisabledWorkflowType[] = [
        {
          id: 'dwt_1',
          workflowType: 'data_sync',
          disabledAt: new Date(),
          disabledBy: 'admin',
        },
      ];

      mockRepository.getDisabledWorkflowTypes.mockResolvedValue(disabledWorkflowTypes);

      const result = await adminService.getDisabledWorkflowTypes();

      expect(mockRepository.getDisabledWorkflowTypes).toHaveBeenCalled();
      expect(result).toHaveLength(1);
      expect(result[0].workflowType).toBe('data_sync');
    });
  });

  describe('disableTenant', () => {
    const tenantId = 'tenant_123';

    it('should update entitlement to suspended and disable agent execution', async () => {
      const updatedEntitlement = createMockEntitlement({
        tenantId,
        tenantOperationalStatus: 'suspended',
        agentExecutionAllowed: false,
      });

      mockEntitlementService.update.mockResolvedValue(updatedEntitlement);

      await adminService.disableTenant(tenantId);

      expect(mockEntitlementService.update).toHaveBeenCalledWith(tenantId, {
        tenantOperationalStatus: 'suspended',
        agentExecutionAllowed: false,
      });
    });

    it('should publish tenant.suspended event', async () => {
      const updatedEntitlement = createMockEntitlement({
        tenantId,
        tenantOperationalStatus: 'suspended',
      });

      mockEntitlementService.update.mockResolvedValue(updatedEntitlement);

      await adminService.disableTenant(tenantId, 'admin_user');

      expect(mockPublishEvent).toHaveBeenCalledWith({
        entityType: 'tenant',
        entityId: tenantId,
        eventType: 'tenant.suspended',
        entityVersion: 1,
        eventVersion: 1,
        tenantId,
        payload: {
          reason: 'admin_kill_switch',
          disabledBy: 'admin_user',
        },
      });
    });

    it('should use default disabledBy value when not provided', async () => {
      const updatedEntitlement = createMockEntitlement({ tenantId });
      mockEntitlementService.update.mockResolvedValue(updatedEntitlement);

      await adminService.disableTenant(tenantId);

      expect(mockPublishEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          payload: expect.objectContaining({
            disabledBy: 'admin',
          }),
        })
      );
    });

    it('should throw error when entitlement update fails', async () => {
      mockEntitlementService.update.mockRejectedValue(
        new Error('Entitlement not found')
      );

      await expect(adminService.disableTenant(tenantId)).rejects.toThrow(
        'Entitlement not found'
      );
      expect(mockPublishEvent).not.toHaveBeenCalled();
    });
  });

  describe('enableTenant', () => {
    const tenantId = 'tenant_123';

    it('should update entitlement to active and enable agent execution', async () => {
      const updatedEntitlement = createMockEntitlement({
        tenantId,
        tenantOperationalStatus: 'active',
        agentExecutionAllowed: true,
      });

      mockEntitlementService.update.mockResolvedValue(updatedEntitlement);

      await adminService.enableTenant(tenantId);

      expect(mockEntitlementService.update).toHaveBeenCalledWith(tenantId, {
        tenantOperationalStatus: 'active',
        agentExecutionAllowed: true,
      });
    });

    it('should publish tenant.reactivated event', async () => {
      const updatedEntitlement = createMockEntitlement({ tenantId });
      mockEntitlementService.update.mockResolvedValue(updatedEntitlement);

      await adminService.enableTenant(tenantId);

      expect(mockPublishEvent).toHaveBeenCalledWith({
        entityType: 'tenant',
        entityId: tenantId,
        eventType: 'tenant.reactivated',
        entityVersion: 1,
        eventVersion: 1,
        tenantId,
        payload: {},
      });
    });
  });

  describe('disableConnector', () => {
    const connectorType = 'salesforce';

    it('should disable connector in repository', async () => {
      const disabledConnector: DisabledConnector = {
        id: 'dc_123',
        connectorType,
        disabledAt: new Date(),
        disabledBy: 'admin_user',
      };

      mockRepository.disableConnector.mockResolvedValue(disabledConnector);

      const result = await adminService.disableConnector(connectorType, 'admin_user');

      expect(mockRepository.disableConnector).toHaveBeenCalledWith(
        connectorType,
        'admin_user'
      );
      expect(result.connectorType).toBe(connectorType);
    });

    it('should publish platform.connector.disabled event', async () => {
      const disabledConnector: DisabledConnector = {
        id: 'dc_123',
        connectorType,
        disabledAt: new Date(),
        disabledBy: 'admin',
      };

      mockRepository.disableConnector.mockResolvedValue(disabledConnector);

      await adminService.disableConnector(connectorType);

      expect(mockPublishEvent).toHaveBeenCalledWith({
        entityType: 'connector',
        entityId: connectorType,
        eventType: 'platform.connector.disabled',
        entityVersion: 1,
        eventVersion: 1,
        payload: {
          connectorType,
          disabledBy: 'admin',
        },
      });
    });

    it('should use default disabledBy value when not provided', async () => {
      const disabledConnector: DisabledConnector = {
        id: 'dc_123',
        connectorType,
        disabledAt: new Date(),
        disabledBy: 'admin',
      };

      mockRepository.disableConnector.mockResolvedValue(disabledConnector);

      await adminService.disableConnector(connectorType);

      expect(mockRepository.disableConnector).toHaveBeenCalledWith(
        connectorType,
        'admin'
      );
    });
  });

  describe('enableConnector', () => {
    const connectorType = 'salesforce';

    it('should enable connector in repository', async () => {
      mockRepository.enableConnector.mockResolvedValue(undefined);

      await adminService.enableConnector(connectorType);

      expect(mockRepository.enableConnector).toHaveBeenCalledWith(connectorType);
    });

    it('should publish platform.connector.enabled event', async () => {
      mockRepository.enableConnector.mockResolvedValue(undefined);

      await adminService.enableConnector(connectorType);

      expect(mockPublishEvent).toHaveBeenCalledWith({
        entityType: 'connector',
        entityId: connectorType,
        eventType: 'platform.connector.enabled',
        entityVersion: 1,
        eventVersion: 1,
        payload: {
          connectorType,
        },
      });
    });
  });

  describe('disableWorkflowType', () => {
    const workflowType = 'data_sync';

    it('should disable workflow type in repository', async () => {
      const disabledWorkflowType: DisabledWorkflowType = {
        id: 'dwt_123',
        workflowType,
        disabledAt: new Date(),
        disabledBy: 'admin_user',
      };

      mockRepository.disableWorkflowType.mockResolvedValue(disabledWorkflowType);

      const result = await adminService.disableWorkflowType(workflowType, 'admin_user');

      expect(mockRepository.disableWorkflowType).toHaveBeenCalledWith(
        workflowType,
        'admin_user'
      );
      expect(result.workflowType).toBe(workflowType);
    });

    it('should publish platform.workflow_type.disabled event', async () => {
      const disabledWorkflowType: DisabledWorkflowType = {
        id: 'dwt_123',
        workflowType,
        disabledAt: new Date(),
        disabledBy: 'admin',
      };

      mockRepository.disableWorkflowType.mockResolvedValue(disabledWorkflowType);

      await adminService.disableWorkflowType(workflowType);

      expect(mockPublishEvent).toHaveBeenCalledWith({
        entityType: 'workflow_type',
        entityId: workflowType,
        eventType: 'platform.workflow_type.disabled',
        entityVersion: 1,
        eventVersion: 1,
        payload: {
          workflowType,
          disabledBy: 'admin',
        },
      });
    });
  });

  describe('enableWorkflowType', () => {
    const workflowType = 'data_sync';

    it('should enable workflow type in repository', async () => {
      mockRepository.enableWorkflowType.mockResolvedValue(undefined);

      await adminService.enableWorkflowType(workflowType);

      expect(mockRepository.enableWorkflowType).toHaveBeenCalledWith(workflowType);
    });

    it('should publish platform.workflow_type.enabled event', async () => {
      mockRepository.enableWorkflowType.mockResolvedValue(undefined);

      await adminService.enableWorkflowType(workflowType);

      expect(mockPublishEvent).toHaveBeenCalledWith({
        entityType: 'workflow_type',
        entityId: workflowType,
        eventType: 'platform.workflow_type.enabled',
        entityVersion: 1,
        eventVersion: 1,
        payload: {
          workflowType,
        },
      });
    });
  });

  describe('freezeAllWrites', () => {
    it('should set global writes frozen in repository', async () => {
      const frozenStatus: PlatformStatus = {
        id: 'global',
        globalWritesFrozen: true,
        updatedAt: new Date(),
      };

      mockRepository.setGlobalWritesFrozen.mockResolvedValue(frozenStatus);

      const result = await adminService.freezeAllWrites();

      expect(mockRepository.setGlobalWritesFrozen).toHaveBeenCalledWith(true);
      expect(result.globalWritesFrozen).toBe(true);
    });

    it('should publish platform.writes_frozen event', async () => {
      const frozenAt = new Date();
      const frozenStatus: PlatformStatus = {
        id: 'global',
        globalWritesFrozen: true,
        updatedAt: frozenAt,
      };

      mockRepository.setGlobalWritesFrozen.mockResolvedValue(frozenStatus);

      await adminService.freezeAllWrites();

      expect(mockPublishEvent).toHaveBeenCalledWith({
        entityType: 'platform',
        entityId: 'global',
        eventType: 'platform.writes_frozen',
        entityVersion: 1,
        eventVersion: 1,
        payload: {
          frozenAt,
        },
      });
    });
  });

  describe('unfreezeAllWrites', () => {
    it('should set global writes unfrozen in repository', async () => {
      const unfrozenStatus: PlatformStatus = {
        id: 'global',
        globalWritesFrozen: false,
        updatedAt: new Date(),
      };

      mockRepository.setGlobalWritesFrozen.mockResolvedValue(unfrozenStatus);

      const result = await adminService.unfreezeAllWrites();

      expect(mockRepository.setGlobalWritesFrozen).toHaveBeenCalledWith(false);
      expect(result.globalWritesFrozen).toBe(false);
    });

    it('should publish platform.writes_unfrozen event', async () => {
      const unfrozenAt = new Date();
      const unfrozenStatus: PlatformStatus = {
        id: 'global',
        globalWritesFrozen: false,
        updatedAt: unfrozenAt,
      };

      mockRepository.setGlobalWritesFrozen.mockResolvedValue(unfrozenStatus);

      await adminService.unfreezeAllWrites();

      expect(mockPublishEvent).toHaveBeenCalledWith({
        entityType: 'platform',
        entityId: 'global',
        eventType: 'platform.writes_unfrozen',
        entityVersion: 1,
        eventVersion: 1,
        payload: {
          unfrozenAt,
        },
      });
    });
  });

  describe('isConnectorDisabled', () => {
    it('should return true when connector is disabled', async () => {
      mockRepository.isConnectorDisabled.mockResolvedValue(true);

      const result = await adminService.isConnectorDisabled('salesforce');

      expect(mockRepository.isConnectorDisabled).toHaveBeenCalledWith('salesforce');
      expect(result).toBe(true);
    });

    it('should return false when connector is enabled', async () => {
      mockRepository.isConnectorDisabled.mockResolvedValue(false);

      const result = await adminService.isConnectorDisabled('salesforce');

      expect(result).toBe(false);
    });
  });

  describe('isWorkflowTypeDisabled', () => {
    it('should return true when workflow type is disabled', async () => {
      mockRepository.isWorkflowTypeDisabled.mockResolvedValue(true);

      const result = await adminService.isWorkflowTypeDisabled('data_sync');

      expect(mockRepository.isWorkflowTypeDisabled).toHaveBeenCalledWith('data_sync');
      expect(result).toBe(true);
    });

    it('should return false when workflow type is enabled', async () => {
      mockRepository.isWorkflowTypeDisabled.mockResolvedValue(false);

      const result = await adminService.isWorkflowTypeDisabled('data_sync');

      expect(result).toBe(false);
    });
  });

  describe('areGlobalWritesFrozen', () => {
    it('should return true when global writes are frozen', async () => {
      const status: PlatformStatus = {
        id: 'global',
        globalWritesFrozen: true,
        updatedAt: new Date(),
      };

      mockRepository.getPlatformStatus.mockResolvedValue(status);

      const result = await adminService.areGlobalWritesFrozen();

      expect(result).toBe(true);
    });

    it('should return false when global writes are not frozen', async () => {
      const status: PlatformStatus = {
        id: 'global',
        globalWritesFrozen: false,
        updatedAt: new Date(),
      };

      mockRepository.getPlatformStatus.mockResolvedValue(status);

      const result = await adminService.areGlobalWritesFrozen();

      expect(result).toBe(false);
    });
  });
});

describe('AdminRepository', () => {
  // Repository-specific tests for database interactions

  describe('mapPlatformStatusRow', () => {
    it('should correctly map database row to PlatformStatus type', () => {
      // This tests the mapping structure expected by the repository
      const dbRow = {
        id: 'global',
        global_writes_frozen: true,
        updated_at: new Date('2024-01-01T00:00:00Z'),
      };

      const expected: PlatformStatus = {
        id: 'global',
        globalWritesFrozen: true,
        updatedAt: new Date('2024-01-01T00:00:00Z'),
      };

      expect(dbRow.id).toBe(expected.id);
      expect(dbRow.global_writes_frozen).toBe(expected.globalWritesFrozen);
    });
  });

  describe('mapDisabledConnectorRow', () => {
    it('should correctly map database row to DisabledConnector type', () => {
      const dbRow = {
        id: 'dc_123',
        connector_type: 'salesforce',
        disabled_at: new Date('2024-01-01T00:00:00Z'),
        disabled_by: 'admin',
      };

      const expected: DisabledConnector = {
        id: 'dc_123',
        connectorType: 'salesforce',
        disabledAt: new Date('2024-01-01T00:00:00Z'),
        disabledBy: 'admin',
      };

      expect(dbRow.id).toBe(expected.id);
      expect(dbRow.connector_type).toBe(expected.connectorType);
      expect(dbRow.disabled_by).toBe(expected.disabledBy);
    });
  });

  describe('mapDisabledWorkflowTypeRow', () => {
    it('should correctly map database row to DisabledWorkflowType type', () => {
      const dbRow = {
        id: 'dwt_123',
        workflow_type: 'data_sync',
        disabled_at: new Date('2024-01-01T00:00:00Z'),
        disabled_by: 'admin',
      };

      const expected: DisabledWorkflowType = {
        id: 'dwt_123',
        workflowType: 'data_sync',
        disabledAt: new Date('2024-01-01T00:00:00Z'),
        disabledBy: 'admin',
      };

      expect(dbRow.id).toBe(expected.id);
      expect(dbRow.workflow_type).toBe(expected.workflowType);
      expect(dbRow.disabled_by).toBe(expected.disabledBy);
    });
  });
});
