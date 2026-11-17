// The distilled instruction has to teach an ATTRIBUTED escalation.
//
// The runtime routes an escalation by who can clear it: 'customer' parks the
// run and asks that person, 'platform' becomes an operator record, and anything
// unattributed is treated as the platform's. That default is deliberate — an
// unattributed blocker should not be put in front of a customer who cannot act
// on it — but it means a bare [ESCALATE] permanently hides every blocker the
// customer COULD have fixed.
//
// This prompt is where agents learn the contract, so it is where the audience
// has to be taught. Measured consequence: prod escalation c2de23d2 used a bare
// marker, is customer-actionable ("18 duplicate campaign_url rows"), and has
// re-raised itself three times without ever reaching the tenant.

jest.mock('../../llm/client', () => ({ llmClient: { complete: jest.fn() } }));
jest.mock('../../connectors/tenant-runtime-client', () => ({
  tenantRuntimeClient: { getTenantManifests: jest.fn(), getToolCatalog: jest.fn() },
}));
jest.mock('../../infrastructure/logging', () => ({
  log: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));
jest.mock('../distill-cache', () => ({
  computePriorArtHash: jest.fn().mockReturnValue(''),
  computeCatalogHash: jest.fn(),
  computeFingerprint: jest.fn(),
  getCachedDistillation: jest.fn(),
  setCachedDistillation: jest.fn(),
}));
jest.mock('../../connectors/connector-service-client', () => ({
  getCatalog: jest.fn(),
  resetCatalogCache: jest.fn(),
}));

import { __internalGetInstructionsMdDesc } from '../distill-service';

const desc = __internalGetInstructionsMdDesc('tenant-1');

describe('distilled escalation rules carry an audience', () => {
  it('teaches both qualified forms', () => {
    expect(desc).toContain('[ESCALATE:customer]');
    expect(desc).toContain('[ESCALATE:platform]');
  });

  it('says explicitly not to write the bare form', () => {
    expect(desc).toMatch(/bare \[ESCALATE\] cannot say who can act/);
  });

  it('explains what each audience means, not just its name', () => {
    // A label with no explanation gets guessed at. The model needs to know
    // 'customer' means somebody in the workspace can act.
    expect(desc).toMatch(/customer's workspace can act/);
    expect(desc).toMatch(/only the platform team can act/);
  });

  it('states the consequence of each choice, since that is what makes it stick', () => {
    expect(desc).toMatch(/parks the run/);
    expect(desc).toMatch(/operator record/);
  });

  it('still teaches the other two terminal markers', () => {
    // The audience change must not quietly drop the rest of the contract.
    expect(desc).toContain('[FAIL]');
    expect(desc).toContain('[COMPLETE]');
  });

  it('keeps the escalation rules under their required heading', () => {
    const heading = desc.indexOf('## Escalation rules');
    const nextHeading = desc.indexOf('## Output format');

    expect(heading).toBeGreaterThan(-1);
    expect(nextHeading).toBeGreaterThan(heading);
    // The audience guidance belongs to that section, not loose in the document.
    expect(desc.slice(heading, nextHeading)).toContain('[ESCALATE:customer]');
  });
});
