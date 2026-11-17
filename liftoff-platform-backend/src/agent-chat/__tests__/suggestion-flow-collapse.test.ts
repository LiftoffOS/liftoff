// Both routine paths on one turn collapse to ONE proposal — for real.
//
// suggestion-flow-register.test.ts proves the two paths compose identical
// dedup keys and proposal text. This file proves the consequence, through the
// REAL createSuggestion: when the tool path has registered a proposal and the
// teaching path fires on the same turn with the same prose, the second
// attempt hits the one-open-proposal budget inside createSuggestion and
// nothing is inserted or delivered. Only the database is scripted.

const query = jest.fn();

jest.mock('../../infrastructure/database', () => ({
  withTenantScope: (_t: string, fn: (c: unknown) => unknown) =>
    fn({ query: (...a: unknown[]) => query(...a) }),
}));
jest.mock('../../infrastructure/logging', () => ({
  log: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.mock('../../internal-agents/service', () => ({
  internalAgentService: { getById: jest.fn(), update: jest.fn() },
}));
jest.mock('../../internal-agents/redistill-service', () => ({
  redistillAgent: jest.fn(),
}));

import { proposeRoutineFromChat, registerRoutineProposal } from '../suggestion-flow';

const TENANT = '00000000-0000-0000-0000-0000000000aa';
const AGENT = '00000000-0000-0000-0000-0000000000bb';
const THREAD = '00000000-0000-0000-0000-0000000000cc';
const PROSE = 'Every Monday at 9am, compile the overdue invoices and post the list here.';

function suggestionRow() {
  return {
    id: 's1',
    tenant_id: TENANT,
    agent_id: AGENT,
    dedup_key: `chat:${PROSE.trim().toLowerCase().slice(0, 200)}`,
    source: 'chat',
    proposal_text: 'irrelevant here',
    routine_prose: PROSE,
    provenance_note: null,
    status: 'pending',
    thread_id: null,
  };
}

it('the teaching path cannot stack a second proposal on the tool path', async () => {
  query
    // registerRoutineProposal → createSuggestion → getOpenSuggestion: none open.
    .mockResolvedValueOnce({ rows: [], rowCount: 0 })
    // createSuggestion → INSERT: the row lands.
    .mockResolvedValueOnce({ rows: [suggestionRow()], rowCount: 1 })
    // markOffered → UPDATE.
    .mockResolvedValueOnce({ rows: [], rowCount: 1 })
    // proposeRoutineFromChat → createSuggestion → getOpenSuggestion: the tool
    // path's proposal is open, so the budget declines before any INSERT.
    .mockResolvedValueOnce({ rows: [suggestionRow()], rowCount: 1 });

  const outcome = await registerRoutineProposal({
    tenantId: TENANT, agentId: AGENT, threadId: THREAD, routineProse: PROSE,
  });
  await proposeRoutineFromChat({
    tenantId: TENANT, agentId: AGENT, threadId: THREAD, routineProse: PROSE,
  });

  expect(outcome).toEqual({ registered: true });
  // Exactly four statements ran, and the last was the budget check — the
  // second path never reached an INSERT, and deliverSuggestion (which would
  // append a chat message) was never entered.
  expect(query).toHaveBeenCalledTimes(4);
  const statements = query.mock.calls.map((c) => String(c[0]));
  expect(statements.filter((sql) => /INSERT INTO agent_suggestions/.test(sql))).toHaveLength(1);
  expect(statements.some((sql) => /agent_chat_messages/.test(sql))).toBe(false);
  expect(statements[3]).toMatch(/status = 'pending'/);
});
