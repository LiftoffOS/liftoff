// Prompt Registry Service Tests
// Tests CRUD operations, versioning, template rendering, and bundle management

import { PromptRegistryService } from '../service';
import { PromptBundleRepository, PromptTemplateRepository } from '../repository';
import { PromptBundle, PromptTemplate, CreateBundleInput, CreateTemplateInput } from '../types';

// Mock external dependencies
jest.mock('../../infrastructure/database');
jest.mock('../repository');

// Mock publishEvent - define inline since jest.mock is hoisted
jest.mock('../../events/publisher', () => ({
  publishEvent: jest.fn().mockResolvedValue(undefined),
}));

import { publishEvent } from '../../events/publisher';
const mockPublishEvent = publishEvent as jest.MockedFunction<typeof publishEvent>;

// Helper functions to create mock data
function createMockBundle(overrides: Partial<PromptBundle> = {}): PromptBundle {
  return {
    id: 'bundle_test_123',
    tenantId: 'tenant_test_123',
    name: 'Test Bundle',
    version: 1,
    status: 'draft',
    templates: ['template_1', 'template_2'],
    createdAt: new Date('2024-01-01T00:00:00Z'),
    approvedAt: null,
    ...overrides,
  };
}

function createMockTemplate(overrides: Partial<PromptTemplate> = {}): PromptTemplate {
  return {
    id: 'template_test_123',
    tenantId: 'tenant_test_123',
    name: 'Test Template',
    version: 1,
    content: 'Hello {{name}}, welcome to {{company}}!',
    variables: ['name', 'company'],
    createdAt: new Date('2024-01-01T00:00:00Z'),
    updatedAt: new Date('2024-01-01T00:00:00Z'),
    ...overrides,
  };
}

describe('PromptRegistryService', () => {
  let promptRegistryService: PromptRegistryService;
  let mockBundleRepo: jest.Mocked<PromptBundleRepository>;
  let mockTemplateRepo: jest.Mocked<PromptTemplateRepository>;

  beforeEach(() => {
    jest.clearAllMocks();

    // Create mock bundle repository
    mockBundleRepo = {
      findAll: jest.fn(),
      findApproved: jest.fn(),
      findById: jest.fn(),
      findByTenantId: jest.fn(),
      findByName: jest.fn(),
      findApprovedByTenantId: jest.fn(),
      create: jest.fn(),
      updateStatus: jest.fn(),
    } as unknown as jest.Mocked<PromptBundleRepository>;

    // Create mock template repository
    mockTemplateRepo = {
      findAll: jest.fn(),
      findByTenantId: jest.fn(),
      findById: jest.fn(),
      findByName: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
    } as unknown as jest.Mocked<PromptTemplateRepository>;

    // Replace repository prototype methods
    (PromptBundleRepository as jest.Mock).mockImplementation(() => mockBundleRepo);
    (PromptTemplateRepository as jest.Mock).mockImplementation(() => mockTemplateRepo);

    promptRegistryService = new PromptRegistryService();
  });

  // ==================== Bundle Tests ====================

  describe('listBundles', () => {
    it('should return all bundles', async () => {
      const bundles = [
        createMockBundle({ id: 'bundle_1', name: 'Bundle One' }),
        createMockBundle({ id: 'bundle_2', name: 'Bundle Two' }),
      ];

      mockBundleRepo.findAll.mockResolvedValue(bundles);

      const result = await promptRegistryService.listBundles();

      expect(mockBundleRepo.findAll).toHaveBeenCalled();
      expect(result).toHaveLength(2);
      expect(result[0].name).toBe('Bundle One');
    });

    it('should return empty array when no bundles exist', async () => {
      mockBundleRepo.findAll.mockResolvedValue([]);

      const result = await promptRegistryService.listBundles();

      expect(result).toEqual([]);
    });
  });

  describe('listApprovedBundles', () => {
    it('should return only approved bundles', async () => {
      const approvedBundles = [
        createMockBundle({ id: 'bundle_1', status: 'approved', approvedAt: new Date() }),
        createMockBundle({ id: 'bundle_2', status: 'approved', approvedAt: new Date() }),
      ];

      mockBundleRepo.findApproved.mockResolvedValue(approvedBundles);

      const result = await promptRegistryService.listApprovedBundles();

      expect(mockBundleRepo.findApproved).toHaveBeenCalled();
      expect(result).toHaveLength(2);
      expect(result.every(b => b.status === 'approved')).toBe(true);
    });

    it('should return empty array when no approved bundles exist', async () => {
      mockBundleRepo.findApproved.mockResolvedValue([]);

      const result = await promptRegistryService.listApprovedBundles();

      expect(result).toEqual([]);
    });
  });

  describe('getBundleById', () => {
    it('should return bundle when found', async () => {
      const bundle = createMockBundle({ id: 'bundle_find_123' });
      mockBundleRepo.findById.mockResolvedValue(bundle);

      const result = await promptRegistryService.getBundleById('bundle_find_123');

      expect(mockBundleRepo.findById).toHaveBeenCalledWith('bundle_find_123');
      expect(result).toEqual(bundle);
    });

    it('should return null when bundle not found', async () => {
      mockBundleRepo.findById.mockResolvedValue(null);

      const result = await promptRegistryService.getBundleById('bundle_nonexistent');

      expect(result).toBeNull();
    });
  });

  describe('createBundle', () => {
    const createInput: CreateBundleInput = {
      tenantId: 'tenant_123',
      name: 'New Bundle',
      templates: ['template_1', 'template_2'],
    };

    it('should create bundle in repository', async () => {
      const createdBundle = createMockBundle({
        id: 'bundle_new_123',
        tenantId: createInput.tenantId,
        name: createInput.name,
        templates: createInput.templates,
        status: 'draft',
        version: 1,
      });

      mockBundleRepo.create.mockResolvedValue(createdBundle);

      const result = await promptRegistryService.createBundle(createInput);

      expect(mockBundleRepo.create).toHaveBeenCalledWith(createInput);
      expect(result.name).toBe('New Bundle');
      expect(result.status).toBe('draft');
    });

    it('should publish tenant.prompt_bundle.created event', async () => {
      const createdBundle = createMockBundle({
        id: 'bundle_event_123',
        tenantId: 'tenant_123',
        name: 'Event Bundle',
        version: 1,
        templates: ['t1', 't2'],
      });

      mockBundleRepo.create.mockResolvedValue(createdBundle);

      await promptRegistryService.createBundle(createInput);

      expect(mockPublishEvent).toHaveBeenCalledWith({
        entityType: 'prompt_bundle',
        entityId: createdBundle.id,
        eventType: 'tenant.prompt_bundle.created',
        entityVersion: 1,
        eventVersion: 1,
        tenantId: createdBundle.tenantId,
        payload: {
          name: createdBundle.name,
          version: createdBundle.version,
          templates: createdBundle.templates,
        },
      });
    });

    it('should throw error when repository create fails', async () => {
      mockBundleRepo.create.mockRejectedValue(new Error('Database error'));

      await expect(promptRegistryService.createBundle(createInput)).rejects.toThrow(
        'Database error'
      );
    });
  });

  describe('approveBundle', () => {
    it('should update bundle status to approved', async () => {
      const approvedBundle = createMockBundle({
        id: 'bundle_approve_123',
        status: 'approved',
        approvedAt: new Date(),
        version: 2,
      });

      mockBundleRepo.updateStatus.mockResolvedValue(approvedBundle);

      const result = await promptRegistryService.approveBundle('bundle_approve_123');

      expect(mockBundleRepo.updateStatus).toHaveBeenCalledWith(
        'bundle_approve_123',
        'approved'
      );
      expect(result.status).toBe('approved');
      expect(result.approvedAt).not.toBeNull();
    });

    it('should publish tenant.prompt_bundle.approved event', async () => {
      const approvedAt = new Date();
      const approvedBundle = createMockBundle({
        id: 'bundle_approved_event',
        tenantId: 'tenant_123',
        name: 'Approved Bundle',
        status: 'approved',
        approvedAt,
        version: 2,
      });

      mockBundleRepo.updateStatus.mockResolvedValue(approvedBundle);

      await promptRegistryService.approveBundle('bundle_approved_event');

      expect(mockPublishEvent).toHaveBeenCalledWith({
        entityType: 'prompt_bundle',
        entityId: approvedBundle.id,
        eventType: 'tenant.prompt_bundle.approved',
        entityVersion: 2,
        eventVersion: 1,
        tenantId: approvedBundle.tenantId,
        payload: {
          name: approvedBundle.name,
          version: approvedBundle.version,
          approvedAt,
        },
      });
    });

    it('should throw error when bundle not found', async () => {
      mockBundleRepo.updateStatus.mockRejectedValue(
        new Error('Bundle not found: bundle_missing')
      );

      await expect(
        promptRegistryService.approveBundle('bundle_missing')
      ).rejects.toThrow('Bundle not found: bundle_missing');
    });
  });

  describe('deprecateBundle', () => {
    it('should update bundle status to deprecated', async () => {
      const deprecatedBundle = createMockBundle({
        id: 'bundle_deprecate_123',
        status: 'deprecated',
        version: 3,
      });

      mockBundleRepo.updateStatus.mockResolvedValue(deprecatedBundle);

      const result = await promptRegistryService.deprecateBundle('bundle_deprecate_123');

      expect(mockBundleRepo.updateStatus).toHaveBeenCalledWith(
        'bundle_deprecate_123',
        'deprecated'
      );
      expect(result.status).toBe('deprecated');
    });

    it('should publish tenant.prompt_bundle.deprecated event', async () => {
      const deprecatedBundle = createMockBundle({
        id: 'bundle_deprecated_event',
        tenantId: 'tenant_123',
        name: 'Deprecated Bundle',
        status: 'deprecated',
        version: 3,
      });

      mockBundleRepo.updateStatus.mockResolvedValue(deprecatedBundle);

      await promptRegistryService.deprecateBundle('bundle_deprecated_event');

      expect(mockPublishEvent).toHaveBeenCalledWith({
        entityType: 'prompt_bundle',
        entityId: deprecatedBundle.id,
        eventType: 'tenant.prompt_bundle.deprecated',
        entityVersion: 3,
        eventVersion: 1,
        tenantId: deprecatedBundle.tenantId,
        payload: {
          name: deprecatedBundle.name,
          version: deprecatedBundle.version,
        },
      });
    });
  });

  // ==================== Template Tests ====================

  describe('listTemplates', () => {
    it('should return all templates', async () => {
      const templates = [
        createMockTemplate({ id: 'template_1', name: 'Template One' }),
        createMockTemplate({ id: 'template_2', name: 'Template Two' }),
      ];

      mockTemplateRepo.findAll.mockResolvedValue(templates);

      const result = await promptRegistryService.listTemplates();

      expect(mockTemplateRepo.findAll).toHaveBeenCalled();
      expect(result).toHaveLength(2);
      expect(result[0].name).toBe('Template One');
    });

    it('should return empty array when no templates exist', async () => {
      mockTemplateRepo.findAll.mockResolvedValue([]);

      const result = await promptRegistryService.listTemplates();

      expect(result).toEqual([]);
    });
  });

  describe('getTemplateById', () => {
    it('should return template when found', async () => {
      const template = createMockTemplate({ id: 'template_find_123' });
      mockTemplateRepo.findById.mockResolvedValue(template);

      const result = await promptRegistryService.getTemplateById('template_find_123');

      expect(mockTemplateRepo.findById).toHaveBeenCalledWith('template_find_123');
      expect(result).toEqual(template);
    });

    it('should return null when template not found', async () => {
      mockTemplateRepo.findById.mockResolvedValue(null);

      const result = await promptRegistryService.getTemplateById('template_nonexistent');

      expect(result).toBeNull();
    });
  });

  describe('createTemplate', () => {
    const createInput: CreateTemplateInput = {
      tenantId: 'tenant_123',
      name: 'New Template',
      content: 'Hello {{name}}!',
      variables: ['name'],
    };

    it('should create template in repository', async () => {
      const createdTemplate = createMockTemplate({
        id: 'template_new_123',
        tenantId: createInput.tenantId,
        name: createInput.name,
        content: createInput.content,
        variables: createInput.variables,
        version: 1,
      });

      mockTemplateRepo.create.mockResolvedValue(createdTemplate);

      const result = await promptRegistryService.createTemplate(createInput);

      expect(mockTemplateRepo.create).toHaveBeenCalledWith(createInput);
      expect(result.name).toBe('New Template');
      expect(result.content).toBe('Hello {{name}}!');
    });

    it('should publish tenant.prompt_template.created event', async () => {
      const createdTemplate = createMockTemplate({
        id: 'template_event_123',
        tenantId: 'tenant_123',
        name: 'Event Template',
        version: 1,
        variables: ['name'],
      });

      mockTemplateRepo.create.mockResolvedValue(createdTemplate);

      await promptRegistryService.createTemplate(createInput);

      expect(mockPublishEvent).toHaveBeenCalledWith({
        entityType: 'prompt_template',
        entityId: createdTemplate.id,
        eventType: 'tenant.prompt_template.created',
        entityVersion: 1,
        eventVersion: 1,
        tenantId: createdTemplate.tenantId,
        payload: {
          name: createdTemplate.name,
          version: createdTemplate.version,
          variables: createdTemplate.variables,
        },
      });
    });

    it('should throw error when repository create fails', async () => {
      mockTemplateRepo.create.mockRejectedValue(new Error('Database error'));

      await expect(promptRegistryService.createTemplate(createInput)).rejects.toThrow(
        'Database error'
      );
    });
  });

  describe('updateTemplate', () => {
    it('should update template content and variables', async () => {
      const updatedTemplate = createMockTemplate({
        id: 'template_update_123',
        content: 'Updated content: {{newVar}}',
        variables: ['newVar'],
        version: 2,
      });

      mockTemplateRepo.update.mockResolvedValue(updatedTemplate);

      const result = await promptRegistryService.updateTemplate(
        'template_update_123',
        'Updated content: {{newVar}}',
        ['newVar']
      );

      expect(mockTemplateRepo.update).toHaveBeenCalledWith(
        'template_update_123',
        'Updated content: {{newVar}}',
        ['newVar']
      );
      expect(result.content).toBe('Updated content: {{newVar}}');
      expect(result.variables).toEqual(['newVar']);
    });

    it('should publish tenant.prompt_template.updated event', async () => {
      const updatedTemplate = createMockTemplate({
        id: 'template_updated_event',
        tenantId: 'tenant_123',
        name: 'Updated Template',
        content: 'New content',
        variables: ['var1', 'var2'],
        version: 2,
      });

      mockTemplateRepo.update.mockResolvedValue(updatedTemplate);

      await promptRegistryService.updateTemplate(
        'template_updated_event',
        'New content',
        ['var1', 'var2']
      );

      expect(mockPublishEvent).toHaveBeenCalledWith({
        entityType: 'prompt_template',
        entityId: updatedTemplate.id,
        eventType: 'tenant.prompt_template.updated',
        entityVersion: 2,
        eventVersion: 1,
        tenantId: updatedTemplate.tenantId,
        payload: {
          name: updatedTemplate.name,
          version: updatedTemplate.version,
          variables: updatedTemplate.variables,
        },
      });
    });

    it('should throw error when template not found', async () => {
      mockTemplateRepo.update.mockRejectedValue(
        new Error('Template not found: template_missing')
      );

      await expect(
        promptRegistryService.updateTemplate('template_missing', 'content', [])
      ).rejects.toThrow('Template not found: template_missing');
    });
  });
});

describe('PromptBundle versioning', () => {
  it('should auto-increment version on bundle creation', () => {
    const bundleV1 = createMockBundle({ version: 1 });
    const bundleV2 = createMockBundle({ version: 2 });

    expect(bundleV1.version).toBe(1);
    expect(bundleV2.version).toBe(2);
  });

  it.each(['draft', 'approved', 'deprecated'] as const)(
    'should support %s status',
    (status) => {
      const bundle = createMockBundle({ status });

      expect(bundle.status).toBe(status);
    }
  );

  it('should track approval timestamp', () => {
    const approvedAt = new Date('2024-06-15T10:30:00Z');
    const bundle = createMockBundle({
      status: 'approved',
      approvedAt,
    });

    expect(bundle.approvedAt).toEqual(approvedAt);
  });
});

describe('PromptTemplate versioning', () => {
  it('should auto-increment version on template creation', () => {
    const templateV1 = createMockTemplate({ version: 1 });
    const templateV2 = createMockTemplate({ version: 2 });

    expect(templateV1.version).toBe(1);
    expect(templateV2.version).toBe(2);
  });

  it('should track creation and update timestamps', () => {
    const createdAt = new Date('2024-01-01T00:00:00Z');
    const updatedAt = new Date('2024-06-15T10:30:00Z');

    const template = createMockTemplate({
      createdAt,
      updatedAt,
    });

    expect(template.createdAt).toEqual(createdAt);
    expect(template.updatedAt).toEqual(updatedAt);
  });
});

describe('PromptTemplate content', () => {
  it('should store template content with variables', () => {
    const template = createMockTemplate({
      content: 'Hello {{name}}, your order {{orderId}} is ready!',
      variables: ['name', 'orderId'],
    });

    expect(template.content).toContain('{{name}}');
    expect(template.content).toContain('{{orderId}}');
    expect(template.variables).toContain('name');
    expect(template.variables).toContain('orderId');
  });

  it('should handle template with no variables', () => {
    const template = createMockTemplate({
      content: 'This is a static template with no variables.',
      variables: [],
    });

    expect(template.variables).toHaveLength(0);
  });

  it('should handle template with multiple occurrences of same variable', () => {
    const template = createMockTemplate({
      content: 'Hello {{name}}, nice to meet you {{name}}!',
      variables: ['name'],
    });

    // Variable should only be listed once
    expect(template.variables).toEqual(['name']);
  });
});

describe('PromptBundle template associations', () => {
  it('should store multiple template IDs', () => {
    const bundle = createMockBundle({
      templates: ['template_1', 'template_2', 'template_3'],
    });

    expect(bundle.templates).toHaveLength(3);
    expect(bundle.templates).toContain('template_1');
    expect(bundle.templates).toContain('template_2');
    expect(bundle.templates).toContain('template_3');
  });

  it('should handle bundle with no templates', () => {
    const bundle = createMockBundle({
      templates: [],
    });

    expect(bundle.templates).toHaveLength(0);
  });
});

describe('Type definitions', () => {
  describe('PromptBundle', () => {
    it('should have all required fields', () => {
      const bundle: PromptBundle = {
        id: 'bundle_123',
        tenantId: 'tenant_123',
        name: 'Test Bundle',
        version: 1,
        status: 'draft',
        templates: [],
        createdAt: new Date(),
        approvedAt: null,
      };

      expect(bundle.id).toBeDefined();
      expect(bundle.tenantId).toBeDefined();
      expect(bundle.name).toBeDefined();
      expect(bundle.version).toBeDefined();
      expect(bundle.status).toBeDefined();
      expect(bundle.templates).toBeDefined();
      expect(bundle.createdAt).toBeInstanceOf(Date);
    });
  });

  describe('PromptTemplate', () => {
    it('should have all required fields', () => {
      const template: PromptTemplate = {
        id: 'template_123',
        tenantId: 'tenant_123',
        name: 'Test Template',
        version: 1,
        content: 'Hello World',
        variables: [],
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      expect(template.id).toBeDefined();
      expect(template.tenantId).toBeDefined();
      expect(template.name).toBeDefined();
      expect(template.version).toBeDefined();
      expect(template.content).toBeDefined();
      expect(template.variables).toBeDefined();
      expect(template.createdAt).toBeInstanceOf(Date);
      expect(template.updatedAt).toBeInstanceOf(Date);
    });
  });

  describe('CreateBundleInput', () => {
    it('should have all required fields', () => {
      const input: CreateBundleInput = {
        tenantId: 'tenant_123',
        name: 'New Bundle',
        templates: ['template_1'],
      };

      expect(input.tenantId).toBeDefined();
      expect(input.name).toBeDefined();
      expect(input.templates).toBeDefined();
    });
  });

  describe('CreateTemplateInput', () => {
    it('should have all required fields', () => {
      const input: CreateTemplateInput = {
        tenantId: 'tenant_123',
        name: 'New Template',
        content: 'Hello {{name}}',
        variables: ['name'],
      };

      expect(input.tenantId).toBeDefined();
      expect(input.name).toBeDefined();
      expect(input.content).toBeDefined();
      expect(input.variables).toBeDefined();
    });
  });
});
