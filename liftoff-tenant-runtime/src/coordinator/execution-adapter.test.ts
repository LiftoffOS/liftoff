jest.mock('../infrastructure/cloud-tasks', () => ({
  enqueueConnectorWriteback: jest.fn(),
}));
jest.mock('../infrastructure/logging', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

import { SandboxedAdapter } from './execution-adapter';
import { enqueueConnectorWriteback } from '../infrastructure/cloud-tasks';
import type { ToolGatewayDispatcher } from '../tool-gateway/dispatcher';

const mockEnqueue = enqueueConnectorWriteback as jest.MockedFunction<typeof enqueueConnectorWriteback>;

describe('SandboxedAdapter', () => {
  const mockExecute = jest.fn();
  const mockToolGateway = { execute: mockExecute } as unknown as ToolGatewayDispatcher;

  let adapter: SandboxedAdapter;

  const workflow = { id: 'wf-1', tenantId: 'tenant-1', agentId: 'agent-1' } as any;
  const task = { id: 'task-1' } as any;
  const checkpoint = { idempotencyKey: 'ck-abc' } as any;

  beforeEach(() => {
    jest.clearAllMocks();
    adapter = new SandboxedAdapter(mockToolGateway);
  });

  describe('executeToolCall', () => {
    it('routes write action with connector through Cloud Tasks', async () => {
      mockEnqueue.mockResolvedValue('projects/p/locations/us/queues/q/tasks/t1' as any);

      const toolCall = {
        id: 'tc-1', connector: 'google_sheets', entityType: 'row',
        actionType: 'create', payload: { val: 1 },
      } as any;

      const result = await adapter.executeToolCall(workflow, task, toolCall, checkpoint);

      expect(mockEnqueue).toHaveBeenCalledWith('google_sheets', expect.objectContaining({
        tenantId: 'tenant-1',
        agentId: 'agent-1',
        workflowId: 'wf-1',
        taskId: 'task-1',
        actionType: 'create',
        idempotencyKey: 'ck-abc-tc-1',
        payload: expect.objectContaining({
          connector: 'google_sheets',
          entityType: 'row',
          payload: { val: 1 },
        }),
      }));
      expect(result).toMatchObject({ enqueued: true, idempotencyKey: 'ck-abc-tc-1' });
      expect(mockExecute).not.toHaveBeenCalled();
    });

    it('routes write action without connector through toolGateway', async () => {
      mockExecute.mockResolvedValue({ id: 'tc-2', success: true } as any);

      const toolCall = {
        id: 'tc-2', connector: null, entityType: 'bash',
        actionType: 'create', payload: { command: 'ls' },
      } as any;

      await adapter.executeToolCall(workflow, task, toolCall, checkpoint);

      expect(mockEnqueue).not.toHaveBeenCalled();
      expect(mockExecute).toHaveBeenCalledWith(expect.objectContaining({
        tenantId: 'tenant-1',
        agentId: 'agent-1',
        actionType: 'create',
        idempotencyKey: 'ck-abc-tc-2',
      }));
    });

    it('routes read action through toolGateway even when connector is set', async () => {
      mockExecute.mockResolvedValue({ id: 'tc-3', success: true } as any);

      const toolCall = {
        id: 'tc-3', connector: 'github', entityType: 'pr',
        actionType: 'read', payload: {},
      } as any;

      await adapter.executeToolCall(workflow, task, toolCall, checkpoint);

      expect(mockEnqueue).not.toHaveBeenCalled();
      expect(mockExecute).toHaveBeenCalled();
    });

    it.each(['create', 'update', 'write', 'patch', 'delete'])(
      'treats "%s" as a write action and routes to Cloud Tasks when connector is set',
      async (actionType) => {
        mockEnqueue.mockResolvedValue('task-name' as any);

        await adapter.executeToolCall(
          workflow, task,
          { id: 'tc', connector: 'gs', entityType: 'e', actionType, payload: {} } as any,
          checkpoint,
        );

        expect(mockEnqueue).toHaveBeenCalledTimes(1);
        expect(mockExecute).not.toHaveBeenCalled();
      },
    );

    it('routes non-write actions to toolGateway regardless of connector', async () => {
      mockExecute.mockResolvedValue({ id: 'tc', success: true } as any);

      for (const actionType of ['read', 'list', 'search', 'get']) {
        jest.clearAllMocks();
        mockExecute.mockResolvedValue({ id: 'tc', success: true } as any);

        await adapter.executeToolCall(
          workflow, task,
          { id: 'tc', connector: 'gs', entityType: 'e', actionType, payload: {} } as any,
          checkpoint,
        );

        expect(mockEnqueue).not.toHaveBeenCalled();
      }
    });

    it('builds idempotency key as checkpoint.idempotencyKey + "-" + toolCall.id', async () => {
      mockExecute.mockResolvedValue({ id: 'tc', success: true } as any);

      await adapter.executeToolCall(
        workflow, task,
        { id: 'tool-xyz', connector: null, entityType: 'e', actionType: 'read', payload: {} } as any,
        { idempotencyKey: 'prefix-999' } as any,
      );

      expect(mockExecute).toHaveBeenCalledWith(
        expect.objectContaining({ idempotencyKey: 'prefix-999-tool-xyz' }),
      );
    });

    it('includes traceId with writeback prefix in Cloud Tasks payload', async () => {
      mockEnqueue.mockResolvedValue('task-name' as any);

      await adapter.executeToolCall(
        workflow, task,
        { id: 'tc-trace', connector: 'slack', entityType: 'msg', actionType: 'create', payload: {} } as any,
        checkpoint,
      );

      expect(mockEnqueue).toHaveBeenCalledWith(
        'slack',
        expect.objectContaining({
          payload: expect.objectContaining({
            traceId: expect.stringMatching(/^writeback-/),
          }),
        }),
      );
    });
  });

  it('supportsResume returns true', () => {
    expect(adapter.supportsResume()).toBe(true);
  });

  it('needsSandbox returns true', () => {
    expect(adapter.needsSandbox()).toBe(true);
  });

  it('destroy resolves without error', async () => {
    await expect(adapter.destroy()).resolves.toBeUndefined();
  });
});
