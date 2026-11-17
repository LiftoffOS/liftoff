// An actor run is booked under its own run id, once, and a run that returned
// results is what teaches the platform the automation's output shape.

jest.mock('../../infrastructure/logging', () => ({
  log: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.mock('../../connectors/connector-service-client', () => ({
  getCatalog: jest.fn(),
  getConnectorServiceClient: jest.fn(),
  listConnectorsForTenant: jest.fn(),
}));
jest.mock('../../connectors/connector-type-registry', () => ({ fetchRegistry: jest.fn() }));
jest.mock('../../mcp/tool-classifier', () => ({ toolClassifier: { getCachedClassification: jest.fn() } }));
jest.mock('../evidence', () => ({ recordUsageEvidence: jest.fn().mockResolvedValue(undefined) }));
jest.mock('../../cost-attribution/repository', () => ({
  ingestEventWithBuckets: jest.fn().mockResolvedValue(1),
  resolveAccountIdForTenant: jest.fn().mockResolvedValue('acct-1'),
}));
jest.mock('../apify-executor', () => ({ runApifyActor: jest.fn() }));
jest.mock('../probe-runner', () => ({ elevateBlueprintFromRun: jest.fn().mockResolvedValue(undefined) }));
jest.mock('../vendor-gate', () => ({
  platformVendorSwitchedOff: jest.fn().mockResolvedValue(false),
  isCooling: jest.fn().mockReturnValue(false),
  parkCredential: jest.fn().mockResolvedValue(undefined),
}));

import { toolClassifier } from '../../mcp/tool-classifier';
import { getCatalog, getConnectorServiceClient, listConnectorsForTenant } from '../../connectors/connector-service-client';
import { fetchRegistry } from '../../connectors/connector-type-registry';
import { ingestEventWithBuckets } from '../../cost-attribution/repository';
import { recordUsageEvidence } from '../evidence';
import { runApifyActor } from '../apify-executor';
import { elevateBlueprintFromRun } from '../probe-runner';
import { platformVendorSwitchedOff } from '../vendor-gate';
import { executeVendorTool } from '../vendor-execution';

beforeEach(() => {
  jest.clearAllMocks();
  (getCatalog as jest.Mock).mockResolvedValue({ connectors: [{ type: 'apify', status: 'internal' }] });
  (fetchRegistry as jest.Mock).mockResolvedValue(new Map());
  (toolClassifier.getCachedClassification as jest.Mock).mockResolvedValue({
    categories: ['read'], isManualOverride: false, toolDescriptionHash: 'h',
  });
  (getConnectorServiceClient as jest.Mock).mockReturnValue({ execute: jest.fn() });
  (listConnectorsForTenant as jest.Mock).mockResolvedValue([]);
});

const runActor = (extra: Record<string, unknown> = {}) =>
  executeVendorTool({
    tenantId: 't1', accountId: 'acct-7', connectorType: 'apify', toolName: 'run_actor',
    args: { subreddit: 'explainlikeimfive' }, presetArgs: { actorId: 'clearpath/reddit-subreddit-posts-scraper' },
    caller: 'assistant',
    ...extra,
  });

describe('booking an actor run', () => {
  it('books the run under its own id and returns that reference with the result', async () => {
    (runApifyActor as jest.Mock).mockResolvedValue({ success: true, items: [{ title: 'x' }], costUsd: 0.0305, runId: 'km7COT0OGYBfE2i0N' });

    const out = await runActor();

    expect(ingestEventWithBuckets).toHaveBeenCalledWith(
      'acct-1',
      'apify:run:km7COT0OGYBfE2i0N',
      0.0305,
      expect.objectContaining({ tenantId: 't1', eventType: 'connector_call', connector: 'apify', actionType: 'run_actor' }),
    );
    expect(out).toMatchObject({ success: true, costUsd: 0.0305, vendorRunRef: 'apify:run:km7COT0OGYBfE2i0N' });
    // Evidence lands on the thing that ran — the actor, under the key the
    // store search ranks it by — so the ranking's evidence read finds it.
    expect(recordUsageEvidence).toHaveBeenCalledWith(
      expect.objectContaining({
        source: 'apify_store',
        sourceRef: 'clearpath/reddit-subreddit-posts-scraper',
        success: true,
        costUsd: 0.0305,
        outputNote: 'ok apify:run:km7COT0OGYBfE2i0N items=1',
      }),
    );
    expect(recordUsageEvidence).not.toHaveBeenCalledWith(expect.objectContaining({ sourceRef: 'apify:run_actor' }));
  });

  it('keeps a caller-supplied booking key (an approved agent run resuming) over the run id', async () => {
    (runApifyActor as jest.Mock).mockResolvedValue({ success: true, items: [{ title: 'x' }], costUsd: 0.01, runId: 'run-1' });

    await runActor({ caller: 'agent', approved: true, idempotencyKey: 'approval-abc' });

    expect(ingestEventWithBuckets).toHaveBeenCalledWith('acct-1', 'approval-abc', 0.01, expect.any(Object));
  });

  it('books nothing when the run reported no cost, and still records the run', async () => {
    (runApifyActor as jest.Mock).mockResolvedValue({ success: true, items: [{ title: 'x' }], costUsd: undefined, runId: 'run-free' });

    const out = await runActor();

    expect(ingestEventWithBuckets).not.toHaveBeenCalled();
    expect(out).toMatchObject({ success: true, vendorRunRef: 'apify:run:run-free' });
    expect(out).not.toHaveProperty('costUsd');
  });

  it('hands a run that returned results to blueprint elevation, and an empty one to nobody', async () => {
    (runApifyActor as jest.Mock).mockResolvedValue({ success: true, items: [{ title: 'x' }], costUsd: 0.01, runId: 'run-1' });
    await runActor();
    expect(elevateBlueprintFromRun).toHaveBeenCalledWith({
      source: 'apify_store',
      sourceRef: 'clearpath/reddit-subreddit-posts-scraper',
      items: [{ title: 'x' }],
      runId: 'run-1',
    });

    jest.clearAllMocks();
    (runApifyActor as jest.Mock).mockResolvedValue({ success: true, items: [], costUsd: 0.0005, runId: 'run-2' });
    await runActor();
    expect(elevateBlueprintFromRun).not.toHaveBeenCalled();
  });

  it('refuses to run a vendor the operator has switched off, before any vendor call', async () => {
    (platformVendorSwitchedOff as jest.Mock).mockResolvedValueOnce(true);

    const out = await runActor();

    expect(out).toEqual({ success: false, reason: 'connector apify is switched off by the operator' });
    expect(runApifyActor).not.toHaveBeenCalled();
    expect(ingestEventWithBuckets).not.toHaveBeenCalled();
  });

  it('books nothing for a failed run and returns the failure', async () => {
    (runApifyActor as jest.Mock).mockResolvedValue({ success: false, error: 'the source returned an error (run FAILED)', runId: 'run-bad' });

    const out = await runActor();

    expect(ingestEventWithBuckets).not.toHaveBeenCalled();
    expect(elevateBlueprintFromRun).not.toHaveBeenCalled();
    expect(out).toEqual({ success: false, reason: 'the source returned an error (run FAILED)' });
    expect(recordUsageEvidence).toHaveBeenCalledWith(
      expect.objectContaining({
        source: 'apify_store', sourceRef: 'clearpath/reddit-subreddit-posts-scraper',
        success: false, outputNote: 'vendor failure apify:run:run-bad',
      }),
    );
  });
});
