// Who sent each message to Liftoff and to the Insights Manager (migration 492).
//
// The repositories' input is a discriminated union: a `role: 'user'` write
// cannot compile without a `senderAccountId: string`, and the assistant arm
// has none. This repo does not type-check its tests, so the contract is not a
// `@ts-expect-error` in this file, which nothing would read: it is a fixture
// compiled here through the compiler API with the repo's own tsconfig, where a
// `@ts-expect-error` that stops erroring is itself an error (TS2578). The
// runtime half below: the column is written from the user arm and NULL from
// the assistant arm, on both tables. Each of the six production writers is
// held to passing the CALLER's account id in its own suite (liftoff and
// insights router, stream-router and chat-service tests).

import * as ts from 'typescript';
import { join } from 'path';

const mockQuery = jest.fn();
jest.mock('../../infrastructure/database', () => ({
  getPool: () => ({ query: (...args: unknown[]) => mockQuery(...args) }),
  withTenantScope: jest.fn(),
  // touchThread's by-id bump runs under the admin scope.
  withAdminScope: async (_ctx: unknown, fn: (client: { query: jest.Mock }) => Promise<unknown>) =>
    fn({ query: (...args: unknown[]) => mockQuery(...args) }),
}));

import { appendMessage as appendLiftoff } from '../chat-repository';
import { appendMessage as appendInsights } from '../../insights/chat-repository';

const THREAD = '00000000-0000-0000-0000-000000000100';
const CALLER = '00000000-0000-0000-0000-000000000042';

beforeEach(() => {
  mockQuery.mockReset();
  mockQuery.mockResolvedValue({ rows: [{ id: 'm', thread_id: THREAD, role: 'user', content: 'x', created_at: new Date() }], rowCount: 1 });
});

describe('the input type', () => {
  it('cannot express a user message without a string sender, on either surface', () => {
    const repoRoot = join(__dirname, '..', '..', '..');
    const fixture = join(__dirname, 'fixtures', 'append-message-sender.contract.ts');
    const config = ts.readConfigFile(join(repoRoot, 'tsconfig.json'), ts.sys.readFile);
    expect(config.error).toBeUndefined();
    const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, repoRoot);
    const program = ts.createProgram([fixture], { ...parsed.options, noEmit: true });
    const source = program.getSourceFile(fixture);
    expect(source).toBeDefined();
    const diagnostics = [
      ...program.getSyntacticDiagnostics(source),
      ...program.getSemanticDiagnostics(source),
    ].map((d) => `${d.code}: ${ts.flattenDiagnosticMessageText(d.messageText, '\n')}`);
    // Every expected error occurs (no TS2578 "unused directive") and the two
    // valid shapes compile: nothing to report.
    expect(diagnostics).toEqual([]);
  }, 120_000);
});

/** Where a named column's value sits in the bind list, read from the statement
 *  itself.
 *
 *  Both halves of this test used to address the column positionally — one from
 *  the end, one by a hardcoded index — and both moved when a later migration
 *  added a column: `files` shifted the first, `turn_id` shifted it again. The
 *  position is a fact the SQL already states, so read it from there and no
 *  future column can move this test. */
function bindIndexOf(sql: string, column: string): number {
  const columns = sql.slice(sql.indexOf('(') + 1, sql.indexOf(')'))
    .split(',')
    .map((c) => c.trim());
  const at = columns.indexOf(column);
  expect(at).toBeGreaterThanOrEqual(0);
  return at;
}

describe('the column', () => {
  it.each([
    ['liftoff_chat_messages', appendLiftoff],
    ['insights_chat_messages', appendInsights],
  ] as const)('is written from the user arm and NULL from the assistant arm on %s', async (_table, append) => {
    await append({ threadId: THREAD, role: 'user', senderAccountId: CALLER, content: 'hello' });
    const [sql, params] = mockQuery.mock.calls[0] as [string, unknown[]];
    const at = bindIndexOf(sql, 'sender_account_id');
    expect(params[at]).toBe(CALLER);

    mockQuery.mockClear();
    await append({ threadId: THREAD, role: 'assistant', content: 'hi' });
    const [assistantSql, assistantParams] = mockQuery.mock.calls[0] as [string, unknown[]];
    expect(assistantParams[bindIndexOf(assistantSql, 'sender_account_id')]).toBeNull();
  });
});
