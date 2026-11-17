// The datasets a job already holds reach the model at the start of a turn:
// one call to the control plane per turn, kept for the turn, empty when the
// job holds none or the call fails.

const mockRunDatasetTool = jest.fn();
jest.mock('../../clients/platform-backend-client', () => ({
  runDatasetToolViaBackend: (...a: unknown[]) => mockRunDatasetTool(...a),
}));
jest.mock('../../infrastructure/logging', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import { _clearDatasetInventoryCacheForTests, datasetInventoryBlock, forgetDatasetInventory } from '../dataset-inventory';

beforeEach(() => {
  mockRunDatasetTool.mockReset();
  _clearDatasetInventoryCacheForTests();
});

describe('datasetInventoryBlock', () => {
  it('asks dataset_list for the inventory, scoped to the job, once per turn', async () => {
    mockRunDatasetTool.mockResolvedValue('Datasets kept for this conversation.\n- id "posts" — 100 records; fields title (text)\n');
    const first = await datasetInventoryBlock('t1', 'thread-1');
    const second = await datasetInventoryBlock('t1', 'thread-1');
    expect(first).toBe('Datasets kept for this conversation.\n- id "posts" — 100 records; fields title (text)');
    expect(second).toBe(first);
    expect(mockRunDatasetTool).toHaveBeenCalledTimes(1);
    expect(mockRunDatasetTool).toHaveBeenCalledWith('t1', 'dataset_list', { inventory: true }, 'thread-1');
  });

  it('two callers in the same turn share one call in flight', async () => {
    let resolve!: (value: string) => void;
    mockRunDatasetTool.mockReturnValue(new Promise<string>((r) => { resolve = r; }));
    const a = datasetInventoryBlock('t1', 'inv-1');
    const b = datasetInventoryBlock('t1', 'inv-1');
    resolve('block');
    expect(await a).toBe('block');
    expect(await b).toBe('block');
    expect(mockRunDatasetTool).toHaveBeenCalledTimes(1);
  });

  it('is empty when the job holds none, when the call fails, and when there is no job', async () => {
    mockRunDatasetTool.mockResolvedValue('');
    expect(await datasetInventoryBlock('t1', 'thread-2')).toBe('');
    mockRunDatasetTool.mockRejectedValue(new Error('backend down'));
    expect(await datasetInventoryBlock('t1', 'thread-3')).toBe('');
    expect(await datasetInventoryBlock('t1', undefined)).toBe('');
    expect(mockRunDatasetTool).toHaveBeenCalledTimes(2);
  });

  it('a later turn asks again once the job\'s answer is forgotten', async () => {
    mockRunDatasetTool.mockResolvedValue('one');
    await datasetInventoryBlock('t1', 'thread-4');
    forgetDatasetInventory('t1', 'thread-4');
    mockRunDatasetTool.mockResolvedValue('two');
    expect(await datasetInventoryBlock('t1', 'thread-4')).toBe('two');
    expect(mockRunDatasetTool).toHaveBeenCalledTimes(2);
  });
});
