// State Persistence Tests
// Tests save/load/delete and file permissions

import fs from 'fs';
import os from 'os';
import path from 'path';

let tmpDir: string;

jest.mock('os', () => ({
  ...jest.requireActual('os'),
  homedir: () => tmpDir,
}));

import { saveState, loadState, deleteState, type ProxyState } from '../state';

const testState: ProxyState = {
  baseUrl: 'https://api.example.com/proxy',
  apiKey: 'liftoff_sk_testkey123',
  tenantId: 'tenant-1',
  connectedAt: '2025-01-01T00:00:00.000Z',
};

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'state-test-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('saveState', () => {
  it('creates directory and writes state file', () => {
    saveState(testState);
    const statePath = path.join(tmpDir, '.liftoff', 'proxy-state.json');
    expect(fs.existsSync(statePath)).toBe(true);
    // v2 on-disk shape: versioned clients store; the Claude
    // credential lives under clients.claude.
    const content = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
    expect(content.version).toBe(2);
    expect(content.clients.claude.apiKey).toBe('liftoff_sk_testkey123');
  });

  it('creates directory with 0700 permissions', () => {
    saveState(testState);
    const dirPath = path.join(tmpDir, '.liftoff');
    const stats = fs.statSync(dirPath);
    // Check owner-only permissions (0700 = rwx------)
    expect(stats.mode & 0o777).toBe(0o700);
  });

  it('creates state file with 0600 permissions', () => {
    saveState(testState);
    const statePath = path.join(tmpDir, '.liftoff', 'proxy-state.json');
    const stats = fs.statSync(statePath);
    // Check owner-only read/write (0600 = rw-------)
    expect(stats.mode & 0o777).toBe(0o600);
  });
});

describe('loadState', () => {
  it('returns state when file exists', () => {
    saveState(testState);
    const loaded = loadState();
    expect(loaded).toEqual(testState);
  });

  it('returns null when file does not exist', () => {
    expect(loadState()).toBeNull();
  });
});

describe('deleteState', () => {
  it('removes the state file', () => {
    saveState(testState);
    deleteState();
    expect(loadState()).toBeNull();
  });

  it('does not throw when file does not exist', () => {
    expect(() => deleteState()).not.toThrow();
  });
});

describe('round-trip', () => {
  it('save → load → delete → load returns null', () => {
    saveState(testState);
    expect(loadState()).toEqual(testState);
    deleteState();
    expect(loadState()).toBeNull();
  });
});
