// Command Logic Tests
// Tests state transitions for connect, pause, resume, disconnect, status

import fs from 'fs';
import os from 'os';
import path from 'path';

let tmpDir: string;

jest.mock('os', () => ({
  ...jest.requireActual('os'),
  homedir: () => tmpDir,
  hostname: () => 'test-host',
}));

import {
  setProxyConfig,
  removeProxyConfig,
  getProxyStatus,
} from '../claude-config';

import {
  saveState,
  loadState,
  deleteState,
} from '../state';

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cmd-test-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('connect flow', () => {
  it('sets proxy config in settings.json and saves state', () => {
    // Simulate what connect command does after auth
    setProxyConfig('https://api.example.com/proxy', 'liftoff_sk_test123');
    saveState({
      baseUrl: 'https://api.example.com/proxy',
      apiKey: 'liftoff_sk_test123',
      tenantId: 'tenant-1',
      connectedAt: new Date().toISOString(),
    });

    const status = getProxyStatus();
    expect(status.connected).toBe(true);
    expect(loadState()).not.toBeNull();
  });
});

describe('pause flow', () => {
  it('connected → paused: removes settings, preserves state', () => {
    // Setup: connected state
    setProxyConfig('https://api.example.com/proxy', 'liftoff_sk_test123');
    saveState({
      baseUrl: 'https://api.example.com/proxy',
      apiKey: 'liftoff_sk_test123',
      tenantId: 'tenant-1',
      connectedAt: new Date().toISOString(),
    });

    // Pause action
    removeProxyConfig();

    // Verify: settings cleared, state preserved
    expect(getProxyStatus().connected).toBe(false);
    expect(loadState()).not.toBeNull();
    expect(loadState()!.apiKey).toBe('liftoff_sk_test123');
  });
});

describe('resume flow', () => {
  it('paused → connected: restores settings from state', () => {
    // Setup: paused state (state file exists, settings cleared)
    saveState({
      baseUrl: 'https://api.example.com/proxy',
      apiKey: 'liftoff_sk_test123',
      tenantId: 'tenant-1',
      connectedAt: new Date().toISOString(),
    });

    // Resume action
    const state = loadState()!;
    setProxyConfig(state.baseUrl, state.apiKey);

    // Verify: connected again
    const status = getProxyStatus();
    expect(status.connected).toBe(true);
    expect(status.baseUrl).toBe('https://api.example.com/proxy');
  });
});

describe('disconnect flow', () => {
  it('connected → disconnected: clears settings and state', () => {
    // Setup: connected
    setProxyConfig('https://api.example.com/proxy', 'liftoff_sk_test123');
    saveState({
      baseUrl: 'https://api.example.com/proxy',
      apiKey: 'liftoff_sk_test123',
      tenantId: 'tenant-1',
      connectedAt: new Date().toISOString(),
    });

    // Disconnect action (backend revoke would happen here)
    removeProxyConfig();
    deleteState();

    // Verify: fully disconnected
    expect(getProxyStatus().connected).toBe(false);
    expect(loadState()).toBeNull();
  });

  it('paused → disconnected: clears state file', () => {
    // Setup: paused (state exists, no settings)
    saveState({
      baseUrl: 'https://api.example.com/proxy',
      apiKey: 'liftoff_sk_test123',
      tenantId: 'tenant-1',
      connectedAt: new Date().toISOString(),
    });

    // Disconnect from paused state
    deleteState();

    expect(loadState()).toBeNull();
  });
});

describe('status detection', () => {
  it('no config, no state → disconnected', () => {
    expect(getProxyStatus().connected).toBe(false);
    expect(loadState()).toBeNull();
  });

  it('config set → connected', () => {
    setProxyConfig('https://proxy.example.com', 'liftoff_sk_abc');
    expect(getProxyStatus().connected).toBe(true);
  });

  it('no config, state exists → paused', () => {
    saveState({
      baseUrl: 'https://proxy.example.com',
      apiKey: 'liftoff_sk_abc',
      tenantId: 't',
      connectedAt: new Date().toISOString(),
    });
    expect(getProxyStatus().connected).toBe(false);
    expect(loadState()).not.toBeNull();
  });
});
