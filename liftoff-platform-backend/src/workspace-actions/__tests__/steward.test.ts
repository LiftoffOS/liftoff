// A change to an agent is the Chief AI Officer's to make, whoever asks.
//
// All three assistants hold the same registry. The steward mark on every
// mutating team and collaborator action keeps Liftoff and the Insights Manager
// from being offered it, and refuses it at dispatch if a model tries anyway;
// the Chief AI Officer's surface keeps everything. An answer-only turn (a
// colleague a team brought in for a question) is offered no mutating action
// at all.

jest.mock('../../infrastructure/logging', () => ({
  log: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
  logAudit: jest.fn(),
}));
jest.mock('../../internal-agents/service', () => ({ internalAgentService: { getById: jest.fn(), listAllByTenant: jest.fn() } }));
jest.mock('../../external-agents/service', () => ({ externalAgentService: { listAllByTenant: jest.fn() } }));
const mockResolveActor = jest.fn();
jest.mock('../actor', () => ({
  ...jest.requireActual('../actor'),
  resolveActor: (...a: unknown[]) => mockResolveActor(...a),
}));

import { WORKSPACE_ACTION_TOOLS, dispatchWorkspaceAction, toolsForActor } from '../tools';
import type { Actor } from '../actor';

const base = { tenantId: '22222222-2222-2222-2222-222222222222', accountId: 'acct-1', role: 'owner' as const, displayName: 'Ada' };
const liftoff: Actor = { ...base, surface: 'liftoff' };
const insights: Actor = { ...base, surface: 'insights' };
const caio: Actor = { ...base, surface: 'caio' };

const STEWARDED = [
  'team_update', 'team_status', 'team_archive', 'team_memory_delete', 'team_memory_edit', 'team_webhook_set', 'team_rollback',
  'collaborator_rollback', 'collaborator_connect', 'collaborator_update', 'collaborator_status', 'collaborator_rediscover',
  'collaborator_set_endpoint', 'collaborator_archive', 'collaboration_wire', 'collaboration_unwire',
];

it('marks every mutating team and collaborator action as the Chief AI Officer\'s, and nothing else', () => {
  const marked = WORKSPACE_ACTION_TOOLS.filter((t) => t.steward === 'caio').map((t) => t.definition.name).sort();
  expect(marked).toEqual([...STEWARDED].sort());
  for (const t of WORKSPACE_ACTION_TOOLS.filter((t) => t.steward === 'caio')) expect(t.mutating).toBe(true);
});

it('offers a stewarded action to the Chief AI Officer\'s surface alone, and reads of a team to everyone', () => {
  const names = (a: Actor, opts?: { answerOnly?: boolean }) => toolsForActor(a, opts).map((t) => t.definition.name);
  for (const a of [liftoff, insights]) {
    for (const s of STEWARDED) expect(names(a)).not.toContain(s);
    expect(names(a)).toEqual(expect.arrayContaining(['team_get', 'teams_list', 'team_start_readiness', 'collaborator_get']));
  }
  expect(names(caio)).toEqual(expect.arrayContaining(STEWARDED));
});

it('offers an answer-only turn no mutating action at all', () => {
  const names = toolsForActor(liftoff, { answerOnly: true }).map((t) => t.definition.name);
  const mutating = WORKSPACE_ACTION_TOOLS.filter((t) => t.mutating).map((t) => t.definition.name);
  for (const m of mutating) expect(names).not.toContain(m);
  expect(names).toContain('team_get');
});

it('refuses a stewarded action at dispatch off the Chief AI Officer\'s surface, before any preview', async () => {
  const out = JSON.parse(await dispatchWorkspaceAction('team_status', { teamId: 'x', status: 'active' }, liftoff));
  expect(out).toMatchObject({ refused: true, reason: 'caio_only' });
  expect(out.message).toMatch(/Chief AI Officer's to make/);
  expect(mockResolveActor).not.toHaveBeenCalled();
});
