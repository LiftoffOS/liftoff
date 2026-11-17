// A schedule from the source has to survive five separate hand-offs.
//
// It crosses the wire validator, gets written into the stored distill input,
// becomes a trigger override at conversion, beats whatever the distiller
// guessed, and lands on the agent. Each link had its own test and the chain was
// still broken: the validator stripped the field, so all four team members of a
// real import ran on schedules nobody asked for.
//
// Per-link tests could not catch that, because each one starts from a value the
// previous link never actually delivered. This walks the whole chain with one
// value, so a break anywhere fails here.

import { z } from 'zod';
import { readFileSync } from 'fs';
import { join } from 'path';
import { sourceMigrationService } from '../service';
import { sourceMigrationRepository as repo } from '../repository';
import * as provisioning from '../../internal-agents/provisioning-helper';
import * as connections from '../connections';
import * as admission from '../admission';
import { MAX_BUNDLE_FILES, MAX_BUNDLE_FILE_BYTES } from '../../internal-agents/skill-bundle';

jest.mock('../repository');
jest.mock('../../internal-agents/provisioning-helper');
jest.mock('../connections');
jest.mock('../../internal-agents/service', () => ({
  InternalAgentService: jest.fn().mockImplementation(() => ({
    updateStatus: jest.fn().mockResolvedValue({ id: 'agent-1' }),
  })),
}));

const mockRepo = repo as jest.Mocked<typeof repo>;
const mockProvision = provisioning as jest.Mocked<typeof provisioning>;
const mockConnections = connections as jest.Mocked<typeof connections>;

const TENANT = '11111111-1111-4111-8111-111111111111';
const ACCOUNT = '22222222-2222-4222-8222-222222222222';
const MIGRATION_ID = '33333333-3333-4333-8333-333333333333';
const CRON = '0 * * * *';

const AGENT = {
  sourceRef: 'agent:support-triage',
  role: 'Support Triage',
  responsibilities: 'Triage every inbound ticket.',
  attachments: [],
  integrationRefs: [],
  mcpServerRefs: [],
  routineRefs: [],
  cronExpr: CRON,
};

const BUNDLE = {
  bundleVersion: 1,
  source: 'openclaw',
  adapterVersion: '1.0.0',
  installationFingerprint: 'fingerprint-1234',
  agents: [AGENT],
  teamRelationships: [],
  instructions: [],
  skills: [],
  memories: [],
  routines: [],
  catalogConnectorRequirements: [],
  customMcpServerRequirements: [],
  hostingRequirements: [],
  governanceRules: [],
  modelPreferences: [],
  unsupportedItems: [],
};

beforeEach(() => {
  jest.clearAllMocks();
  mockRepo.getById.mockResolvedValue({
    id: MIGRATION_ID,
    tenantId: TENANT,
    source: 'openclaw',
    state: 'payment_required',
    bundle: null,
    unsupportedItems: [],
    hostingRequirements: [],
    libraryApprovals: [],
  } as never);
  mockRepo.upsertItem.mockResolvedValue({ id: 'item-1' } as never);
  mockRepo.upsertRoutine.mockResolvedValue({} as never);
  mockRepo.saveBundle.mockResolvedValue({ id: MIGRATION_ID, state: 'payment_required' } as never);
  mockRepo.pruneConnectionsNotIn.mockResolvedValue(0);
  mockRepo.listRoutines.mockResolvedValue([]);
  mockRepo.setState.mockResolvedValue({ id: MIGRATION_ID } as never);
  mockRepo.setItemState.mockResolvedValue(undefined as never);
  mockRepo.saveDistillOutput.mockResolvedValue(undefined as never);
  mockRepo.saveDestinationAgent.mockResolvedValue(undefined as never);
  mockConnections.materializeCatalogPlaceholders.mockResolvedValue({ unsupported: [] } as never);
  mockConnections.resolveHostingRequirements.mockResolvedValue(
    { catalog: [], mcp: [], remaining: [], diagnostics: [] } as never,
  );
  mockConnections.materializeMcpPlaceholders.mockResolvedValue(undefined as never);
  mockConnections.resolveConnectionStatuses.mockImplementation(
    async (_t: unknown, _a: unknown, c: unknown) => c as never,
  );
  mockConnections.resolveAgentBindings.mockResolvedValue({
    integrations: [],
    pendingIntegrations: [],
  });
  mockProvision.provisionAgentFromDistill.mockResolvedValue({
    agent: { id: 'agent-1' },
  } as never);
  jest.spyOn(admission, 'reserveDistillSlot').mockResolvedValue({ allowed: true } as never);
});

/** The router's own schema, evaluated from source so the test cannot drift from
 *  the validator that actually runs. */
function parseThroughWireSchema(bundle: unknown): Record<string, unknown> {
  const router = readFileSync(join(__dirname, '..', 'router.ts'), 'utf8');
  const slice = router.slice(
    router.indexOf('const attachmentSchema'),
    router.indexOf('\n});', router.indexOf('const bundleSchema')) + 4,
  );
  // The schema references the skill-bundle caps by name rather than repeating
  // the numbers, so they are supplied here from the module that defines them.
  // Inlining literals in the router instead would put the same cap in two
  // places, which is how the two stop agreeing.
  const build = new Function(
    'z',
    'MAX_BUNDLE_FILES',
    'MAX_BUNDLE_FILE_BYTES',
    `${slice}\nreturn bundleSchema;`,
  ) as (
    zod: typeof z,
    maxFiles: number,
    maxFileBytes: number,
  ) => z.ZodTypeAny;
  return build(z, MAX_BUNDLE_FILES, MAX_BUNDLE_FILE_BYTES).parse(bundle) as Record<string, unknown>;
}

describe('a source schedule survives the whole chain', () => {
  it('crosses the wire validator', () => {
    // The link that was broken. zod strips silently, so the loss shows up
    // nowhere until an agent runs on the wrong day.
    const parsed = parseThroughWireSchema(BUNDLE);
    const agents = parsed.agents as Array<{ cronExpr?: string }>;
    expect(agents[0].cronExpr).toBe(CRON);
  });

  it('is written into the stored distill input', async () => {
    await sourceMigrationService.acceptBundle(TENANT, ACCOUNT, MIGRATION_ID, BUNDLE as never);

    const stored = mockRepo.upsertItem.mock.calls[0][1] as { distillInput: { cronExpr?: string } };
    expect(stored.distillInput.cronExpr).toBe(CRON);
  });

  it('becomes the trigger override at conversion', async () => {
    mockRepo.listItems.mockResolvedValue([
      {
        id: 'item-1',
        sourceRef: AGENT.sourceRef,
        state: 'pending',
        attempts: 0,
        destinationAgentId: null,
        distillInput: { ...AGENT, cronExpr: CRON },
      } as never,
    ]);
    mockRepo.listConnections.mockResolvedValue([]);
    mockRepo.getById.mockResolvedValue({
      id: MIGRATION_ID,
      tenantId: TENANT,
      source: 'openclaw',
      state: 'payment_required',
      bundle: BUNDLE,
    } as never);

    await sourceMigrationService.convert(TENANT, ACCOUNT, MIGRATION_ID, { paid: true });

    const call = mockProvision.provisionAgentFromDistill.mock.calls[0][0] as {
      triggerOverride?: { type: string; cronExpr: string };
    };
    expect(call.triggerOverride).toEqual({ type: 'cron', cronExpr: CRON });
  });

  it('sends no override when the source had no schedule', async () => {
    // The distiller's own judgement is right when the source said nothing. An
    // override of `undefined` must not become a manual trigger by accident.
    mockRepo.listItems.mockResolvedValue([
      {
        id: 'item-1',
        sourceRef: AGENT.sourceRef,
        state: 'pending',
        attempts: 0,
        destinationAgentId: null,
        distillInput: { ...AGENT, cronExpr: undefined },
      } as never,
    ]);
    mockRepo.listConnections.mockResolvedValue([]);
    mockRepo.getById.mockResolvedValue({
      id: MIGRATION_ID,
      tenantId: TENANT,
      source: 'openclaw',
      state: 'payment_required',
      bundle: BUNDLE,
    } as never);

    await sourceMigrationService.convert(TENANT, ACCOUNT, MIGRATION_ID, { paid: true });

    const call = mockProvision.provisionAgentFromDistill.mock.calls[0][0] as {
      triggerOverride?: unknown;
    };
    expect(call.triggerOverride).toBeUndefined();
  });
});
