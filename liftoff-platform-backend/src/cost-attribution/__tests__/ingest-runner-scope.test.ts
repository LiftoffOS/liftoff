/**
 * The cost pass reads only the feeds its scope names, and narrows the four
 * per-workspace ingesters to the workspace it names. No scope reads every
 * feed for every workspace, which is what the daily pass relies on.
 */
const calls: Array<[string, unknown]> = [];
const stub = (name: string, result: object) => jest.fn(async (arg?: unknown) => { calls.push([name, arg]); return result; });

jest.mock('../ingestion/platform-llm-ingester', () => ({ runPlatformLLMIngester: stub('platformLlm', { ingested: 0, skipped: 0 }) }));
jest.mock('../ingestion/runtime-ingester', () => ({ runRuntimeIngester: stub('runtime', { ingested: 0, skipped: 0, errors: 0 }) }));
jest.mock('../ingestion/governance-ingester', () => ({ runGovernanceIngester: stub('governance', { ingested: 0, skipped: 0, errors: 0 }) }));
jest.mock('../ingestion/developer-proxy-ingester', () => ({ runDeveloperProxyIngester: stub('developer_proxy', { ingested: 0, skipped: 0 }) }));
jest.mock('../ingestion/sandbox-ingester', () => ({ runSandboxIngester: stub('sandbox', { ingested: 0, skipped: 0, errors: 0 }) }));
jest.mock('../ingestion/usage-ledger-ingester', () => ({ runUsageLedgerIngester: stub('usageLedger', { ingested: 0, skipped: 0, errors: 0 }) }));
jest.mock('../../infrastructure/logging', () => ({ log: { info: jest.fn(), error: jest.fn() } }));

import { runAllIngesters } from '../ingestion/ingest-runner';
import { INGEST_SOURCES } from '../ingestion/ingest-scope';

beforeEach(() => { calls.length = 0; });

it('reads every feed for every workspace with no scope', async () => {
  await runAllIngesters();
  expect(calls.map(([n]) => n).sort()).toEqual([...INGEST_SOURCES].sort());
  expect(calls.every(([, arg]) => arg === undefined)).toBe(true);
});

it('reads only the named sources', async () => {
  await runAllIngesters({ sources: ['platformLlm'] });
  expect(calls).toEqual([['platformLlm', undefined]]);
});

it('passes the workspace to each per-workspace ingester it runs', async () => {
  await runAllIngesters({ sources: ['runtime', 'sandbox', 'usageLedger', 'governance'], tenantId: 't-1' });
  expect(calls.map(([n]) => n).sort()).toEqual(['governance', 'runtime', 'sandbox', 'usageLedger']);
  expect(calls.every(([, arg]) => arg === 't-1')).toBe(true);
});
