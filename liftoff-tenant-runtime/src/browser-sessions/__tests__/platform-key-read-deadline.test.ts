// The platform browser key read is bounded, and only a real answer is cached.
//
// Every palette build awaits it, and it cached the PENDING promise: one Secret
// Manager read on a dead connection stalled every later caller in the process
// behind it, with no end. Now a read that fails or times out answers "not
// configured" for the callers already waiting and is forgotten, so the next
// caller reads again.

const mockGetSecret = jest.fn<Promise<string>, [string]>();
jest.mock('../../integrations/web-fetch/web-tool-secrets', () => ({
  getWebToolSecret: (name: string) => mockGetSecret(name),
}));
jest.mock('../../integrations/web-fetch/global-flags', () => ({
  getAllVendorFlags: jest.fn(async () => ({ steel: true, browser_use: false })),
  isVendorExcludedForTenant: jest.fn(async () => false),
}));

import {
  platformPaneVendor,
  _resetPlatformKeyCache,
  PLATFORM_KEY_READ_DEADLINE_MS,
} from '../session-vendor-connectors';

describe('platform key read', () => {
  beforeEach(() => {
    _resetPlatformKeyCache();
    mockGetSecret.mockReset();
    jest.useFakeTimers();
  });
  afterEach(() => jest.useRealTimers());

  it('a hung read answers "no vendor" at the deadline, for every caller waiting on it', async () => {
    mockGetSecret.mockImplementation(() => new Promise<string>(() => undefined));

    const first = platformPaneVendor('t1');
    const second = platformPaneVendor('t1');
    await jest.advanceTimersByTimeAsync(PLATFORM_KEY_READ_DEADLINE_MS);

    await expect(first).resolves.toBeNull();
    await expect(second).resolves.toBeNull();
    // Both callers shared the one in-flight read.
    expect(mockGetSecret).toHaveBeenCalledTimes(1);
  });

  it('a timed-out read is not cached: the next caller reads again and gets the vendor', async () => {
    mockGetSecret.mockImplementationOnce(() => new Promise<string>(() => undefined));
    const timedOut = platformPaneVendor('t1');
    await jest.advanceTimersByTimeAsync(PLATFORM_KEY_READ_DEADLINE_MS);
    await expect(timedOut).resolves.toBeNull();

    mockGetSecret.mockResolvedValueOnce('sk-live');
    await expect(platformPaneVendor('t1')).resolves.toBe('steel');
    expect(mockGetSecret).toHaveBeenCalledTimes(2);
  });

  it('a failed read is not cached either', async () => {
    mockGetSecret.mockRejectedValueOnce(new Error('PERMISSION_DENIED'));
    await expect(platformPaneVendor('t1')).resolves.toBeNull();
    mockGetSecret.mockResolvedValueOnce('sk-live');
    await expect(platformPaneVendor('t1')).resolves.toBe('steel');
  });

  it('a real answer is cached: present keys are read once', async () => {
    mockGetSecret.mockResolvedValue('sk-live');
    await expect(platformPaneVendor('t1')).resolves.toBe('steel');
    await expect(platformPaneVendor('t1')).resolves.toBe('steel');
    expect(mockGetSecret).toHaveBeenCalledTimes(1);
  });

  it('an absent key is remembered for a while, then read again', async () => {
    mockGetSecret.mockResolvedValue('');
    await expect(platformPaneVendor('t1')).resolves.toBeNull();
    await expect(platformPaneVendor('t1')).resolves.toBeNull();
    expect(mockGetSecret).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(5 * 60_000);
    await expect(platformPaneVendor('t1')).resolves.toBeNull();
    expect(mockGetSecret).toHaveBeenCalledTimes(2);
  });
});
