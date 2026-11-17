// ModelRegistryService.setContextWindow — the validation boundary.
//
// A context window is not a number to be lenient about. The runtime treats a
// value recorded here as exact and lets it end a session; a coerced or
// half-parsed one would be trusted the same way. So anything that is not a
// positive integer is refused rather than rounded, floored, or written as-is.

import { jest } from '@jest/globals';

const mockUpdateContextWindow = jest.fn();

jest.mock('../repository', () => ({
  ModelRepository: jest.fn().mockImplementation(() => ({
    updateContextWindow: (...args: unknown[]) => mockUpdateContextWindow(...args),
  })),
  ModelConfigRepository: jest.fn().mockImplementation(() => ({})),
  ModelRolloutRepository: jest.fn().mockImplementation(() => ({})),
}));

jest.mock('../../events/publisher', () => ({ publishEvent: jest.fn(async () => undefined) }));
jest.mock('../../infrastructure/logging', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
  logAudit: jest.fn(),
}));

import { ModelRegistryService } from '../service';

const service = new ModelRegistryService();

beforeEach(() => {
  mockUpdateContextWindow.mockReset();
});

describe('setContextWindow', () => {
  it('writes a positive integer through to the repository', async () => {
    mockUpdateContextWindow.mockResolvedValue({ id: 'm1', contextWindow: 200_000 } as never);

    await expect(service.setContextWindow('m1', 200_000)).resolves.toMatchObject({
      contextWindow: 200_000,
    });
    expect(mockUpdateContextWindow).toHaveBeenCalledWith('m1', 200_000);
  });

  // Clearing is legitimate: "unrecorded" is a state the runtime understands and
  // handles conservatively, so it must be reachable.
  it('passes null through to clear the window', async () => {
    mockUpdateContextWindow.mockResolvedValue({ id: 'm1', contextWindow: undefined } as never);

    await service.setContextWindow('m1', null);

    expect(mockUpdateContextWindow).toHaveBeenCalledWith('m1', null);
  });

  it.each([
    ['zero', 0],
    ['negative', -1],
    ['fractional', 1024.5],
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
  ])('refuses %s without touching the repository', async (_label, value) => {
    await expect(service.setContextWindow('m1', value)).rejects.toThrow('positive integer');
    expect(mockUpdateContextWindow).not.toHaveBeenCalled();
  });

  it('returns null for a model that does not exist', async () => {
    mockUpdateContextWindow.mockResolvedValue(null as never);

    await expect(service.setContextWindow('nope', 1000)).resolves.toBeNull();
  });
});
