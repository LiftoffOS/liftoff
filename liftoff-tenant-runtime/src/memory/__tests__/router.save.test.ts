// The save route's contract with the control plane.
//
// This route answered 404 to every caller for months because it was never
// mounted. Mounting it is not the whole fix: the control plane addresses agents
// by internal_agents.id, while memories.agent_id is FK'd to the runtime's own
// agents(id), and the two id spaces are disjoint (INV-TR-010). An untranslated
// id fails the foreign key; worse, an individual-layer memory is retrieved by
// agent_id, so anything stored under the wrong space is unreachable even if it
// lands.

import express, { json } from 'express';
import request from 'supertest';
import { jest } from '@jest/globals';

const mockSave = jest.fn<() => Promise<{ memoryId: string }>>()
  .mockResolvedValue({ memoryId: 'mem-1' });
const mockResolveStrict = jest.fn<() => Promise<string | null>>()
  .mockResolvedValue(RUNTIME_AGENT_ID());

function RUNTIME_AGENT_ID(): string { return '99999999-9999-4999-8999-999999999999'; }
const INTERNAL_AGENT_ID = '11111111-1111-4111-8111-111111111111';
const TENANT_ID = '12345678-1234-4234-8234-123456789aaa';

const mockResolveRole = jest.fn();
jest.mock('../service', () => ({
  memoryService: {
    saveMemory: (...a: unknown[]) => mockSave(...(a as [])),
    resolveRoleScopeKey: (...a: unknown[]) => mockResolveRole(...(a as [])),
  },
}));
jest.mock('../../agent-lifecycle/resolve-runtime-agent-id', () => ({
  resolveRuntimeAgentId: jest.fn(),
  resolveRuntimeAgentIdStrict: (...a: unknown[]) => mockResolveStrict(...(a as [])),
}));
jest.mock('../../infrastructure/logging', () => ({
  log: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));
jest.mock('../provenance-service', () => ({ getProvenanceChain: jest.fn() }));
jest.mock('../redactor', () => ({
  redactCredentials: jest.fn((s: string) => ({ redacted: s })),
}));

const SERVICE_TOKEN = 'test-service-token';
process.env.TENANT_RUNTIME_SERVICE_TOKEN = SERVICE_TOKEN;

import { memoryRouter } from '../router';

const app = express();
app.use(json());
app.use((req, _res, next) => {
  (req as any).ctx = { tenantId: TENANT_ID };
  next();
});
app.use('/api/memory', memoryRouter);

const save = () =>
  request(app).post('/api/memory').set('X-Service-Auth', SERVICE_TOKEN);

beforeEach(() => {
  mockSave.mockClear();
  mockResolveStrict.mockClear();
  mockResolveStrict.mockResolvedValue(RUNTIME_AGENT_ID());
  mockResolveRole.mockReset();
  mockResolveRole.mockResolvedValue('Program Manager');
});

it('translates internalAgentId into the runtime id space before writing', async () => {
  const res = await save().send({
    layer: 'individual',
    content: 'a refined skill',
    internalAgentId: INTERNAL_AGENT_ID,
  });

  expect(res.status).toBe(201);
  expect(mockSave).toHaveBeenCalledWith(
    expect.objectContaining({ agentId: RUNTIME_AGENT_ID() }),
  );
});

it('scopes an individual memory to the translated agent, never the control-plane id', async () => {
  await save().send({
    layer: 'individual',
    content: 'a refined skill',
    internalAgentId: INTERNAL_AGENT_ID,
  });

  const written = mockSave.mock.calls[0][0] as unknown as { scopeKey: string };
  expect(written.scopeKey).toBe(RUNTIME_AGENT_ID());
  expect(written.scopeKey).not.toBe(INTERNAL_AGENT_ID);
});

it('refuses the write when the agent has no mapping rather than storing an unreachable row', async () => {
  mockResolveStrict.mockResolvedValue(null);

  const res = await save().send({
    layer: 'individual',
    content: 'a refined skill',
    internalAgentId: INTERNAL_AGENT_ID,
  });

  expect(res.status).toBe(409);
  expect(res.body.error).toBe('agent_not_provisioned');
  expect(mockSave).not.toHaveBeenCalled();
});

it('defaults a non-individual memory to the shared scope key', async () => {
  await save().send({ layer: 'global', content: 'shared context' });

  expect(mockSave).toHaveBeenCalledWith(
    expect.objectContaining({ scopeKey: 'shared' }),
  );
});

it('honours an explicit scope key', async () => {
  await save().send({
    layer: 'role',
    scopeKey: 'program-manager',
    content: 'role-wide pitfall',
  });

  expect(mockSave).toHaveBeenCalledWith(
    expect.objectContaining({ scopeKey: 'program-manager' }),
  );
});

it('rejects a scope key the column CHECK would refuse', async () => {
  // `memories.scope_key` is CHECK-constrained to ^[a-zA-Z0-9_-]+$. An agent
  // role is free text and always contains spaces, so this is the shape that
  // reaches the route in practice.
  const res = await save().send({
    layer: 'role',
    scopeKey: 'Program Manager',
    content: 'role-wide pitfall',
  });

  expect(res.status).toBe(400);
  expect(mockSave).not.toHaveBeenCalled();
});

it('requires a scope key for an individual memory with no agent', async () => {
  const res = await save().send({ layer: 'individual', content: 'orphan' });

  expect(res.status).toBe(400);
  expect(mockSave).not.toHaveBeenCalled();
});

// A role memory is retrieved by the role, so that is its key. The agent's
// recorded role supplies it when an agent is named; otherwise the caller must.
it('keys a role memory by the named agent\'s role', async () => {
  await save().send({ layer: 'role', internalAgentId: INTERNAL_AGENT_ID, content: 'role-wide pitfall' });

  expect(mockResolveRole).toHaveBeenCalledWith(TENANT_ID, RUNTIME_AGENT_ID());
  expect(mockSave).toHaveBeenCalledWith(expect.objectContaining({ scopeKey: 'Program Manager' }));
});

it('requires a scope key for a role memory with no agent', async () => {
  const res = await save().send({ layer: 'role', content: 'orphan' });

  expect(res.status).toBe(400);
  expect(mockSave).not.toHaveBeenCalled();
});

it('requires a scope key for a role memory when the named agent has no role recorded', async () => {
  mockResolveRole.mockResolvedValueOnce(null);
  const res = await save().send({ layer: 'role', internalAgentId: INTERNAL_AGENT_ID, content: 'orphan' });

  expect(res.status).toBe(400);
  expect(mockSave).not.toHaveBeenCalled();
});
