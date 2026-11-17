// A tool result the model must read whole arrives whole.
//
// The sanitizer's 500-character default is a context-size guard written for
// unbounded third-party content (an audit reason, a vendor's response body),
// and applied to every string value of every workspace action it would cut a
// document at 500 characters and trail a bare ellipsis, so an assistant could
// tell a person a document "does not say" something — true of the 500
// characters it was given and false of the document. The same cut would sit on
// an agent's own prose and its memories, which every writer requires quoted
// back exactly.
//
// The tools below need the bound for that reason. That the cut SAYS so in words is covered by
// insights/tools/__tests__/sanitize.test.ts.

jest.mock('../../infrastructure/logging', () => ({
  log: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
  logAudit: jest.fn(),
}));
jest.mock('../../internal-agents/service', () => ({ internalAgentService: { getById: jest.fn(), listAllByTenant: jest.fn() } }));
jest.mock('../../external-agents/service', () => ({ externalAgentService: { listAllByTenant: jest.fn() } }));

import { WORKSPACE_ACTION_TOOLS, dispatchWorkspaceAction } from '../tools';
import { DEFAULT_MAX_STRING_LEN } from '../../insights/tools/sanitize';
import type { Actor } from '../actor';

const actor: Actor = {
  tenantId: '22222222-2222-2222-2222-222222222222',
  accountId: 'acct-1',
  role: 'owner',
  displayName: 'Ada',
  surface: 'liftoff',
};

/** Every tool whose result the default would ruin, with the bound it declares.
 *  A document, or text a writer requires quoted back exactly. */
const BOUNDED: Record<string, number> = {
  team_get: 12_000,
  team_update: 12_000,
  team_skills: 12_000,
  team_memories: 6_000,
  team_memory_edit: 6_000,
};

it('bounds exactly the tools whose result the default would ruin', () => {
  const declared = Object.fromEntries(
    WORKSPACE_ACTION_TOOLS
      .filter((t) => t.maxResultStringLength !== undefined)
      .map((t) => [t.definition.name, t.maxResultStringLength]),
  );
  expect(declared).toEqual(BOUNDED);
});

it('never bounds a tool below the default', () => {
  for (const [name, bound] of Object.entries(BOUNDED)) {
    expect(bound).toBeGreaterThan(DEFAULT_MAX_STRING_LEN);
    expect(name).toBeTruthy();
  }
});

