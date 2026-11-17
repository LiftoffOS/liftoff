// Per-AI-team AI vendor override.
//
// The case that matters most here is `'default'`. It is a real, selectable
// override meaning "pin this team to Liftoff Managed", NOT a synonym for
// inherit — and it is the one value a schema author is most likely to drop,
// because at the tenant level 'default' does mean "no explicit choice". If it
// is missing from the enum the shipped React client 400s on a legitimate
// selection, and because the field rides the same PUT as role /
// responsibilities / skills / attachments, the whole save fails with it.
//
// Covers: the wire enum (including nullability), the read path, the translation
// at the event-payload seam, and redistill preservation.

jest.mock('../effective-instructions-md', () => ({
  buildEffectiveInstructionsMd: jest.fn(async () => 'effective-md'),
}));
jest.mock('../integration-enrichment', () => ({
  enrichIntegrationsWithType: jest.fn(async (_t: string, i: unknown) => i),
}));

import { z } from 'zod';
import {
  LIFTOFF_MANAGED_VENDOR,
  WORKSPACE_AI_SELECTIONS,
  WORKSPACE_AI_VENDORS,
  effectiveModelConfig,
  resolveWorkspaceAiVendor,
} from '../../model-registry/workspace-ai-vendors';
import { buildInternalAgentEventPayload } from '../event-payload';
import { mapInternalAgentRow } from '../row-mapper';
import type { InternalAgent, ModelConfig } from '../types';

// The React wire vocabulary, transcribed from the shipped
// `WorkspaceAiVendor` union in liftoff-react src/services/tenants.ts. Pinned
// here so a change on either side has to be a deliberate, visible edit rather
// than a silent drift that only shows up as a failed save in production.
const REACT_WORKSPACE_AI_VENDOR_UNION = [
  'default', 'anthropic', 'openai', 'google', 'deepseek', 'glm', 'grok', 'kimi', 'minimax',
  'qwen', 'xiaomi',
];

// The schema fragment the router builds. Restated rather than imported because
// importing router.ts pulls the whole service graph into a unit test; the
// assertion below is that the SOURCE list it is built from is right, which is
// the only part that can drift.
const aiVendorOverrideSchema = z.enum([...WORKSPACE_AI_SELECTIONS]).nullable().optional();

function makeAgent(overrides: Partial<InternalAgent> = {}): InternalAgent {
  return {
    id: 'a1',
    tenantId: 't1',
    role: 'role',
    responsibilities: null,
    integrations: [],
    pendingIntegrations: [],
    additionalContext: null,
    summary: null,
    systemPrompt: null,
    userInstructions: null,
    instructionsMd: null,
    temperature: 0.3,
    status: 'draft',
    currentVersion: 1,
    tasksCompleted: 0,
    tasks30d: 0,
    monthlyCost: 0,
    lastActive: null,
    createdAt: new Date(0),
    updatedAt: new Date(0),
    agentType: 'agent',
    modelConfig: { tier: 'medium' },
    memoryScope: {},
    execConfig: {},
    workflowSteps: null,
    triggerConfig: null,
    delegates: [],
    workforcePlanId: null,
    pinnedKnowledgeIds: [],
    reviewedAt: null,
    reviewedBy: null,
    workflowStepsHash: null,
    messagingNickname: null,
    lastActivity: null,
    lastActivityAction: null,
    workflowVisualizationSteps: null,
    autonomyOverride: null,
    aiVendorOverride: null,
    skills: [],
    capabilityTier: 'connector_only',
    attachments: [],
    ...overrides,
  };
}

describe('the wire vocabulary', () => {
  it('carries all eleven React keys, INCLUDING the default sentinel', () => {
    expect([...WORKSPACE_AI_SELECTIONS].sort()).toEqual(
      [...REACT_WORKSPACE_AI_VENDOR_UNION].sort(),
    );
    expect(WORKSPACE_AI_SELECTIONS).toContain('default');
    expect(WORKSPACE_AI_SELECTIONS).toHaveLength(11);
  });

  it.each([...WORKSPACE_AI_SELECTIONS])('accepts %s', (vendor) => {
    expect(aiVendorOverrideSchema.safeParse(vendor).success).toBe(true);
  });

  it('accepts null — this is how the client reverts to inherit', () => {
    // `.optional()` alone would reject it and make revert-to-inherit a
    // validation failure on a control that looks like it worked.
    expect(aiVendorOverrideSchema.safeParse(null).success).toBe(true);
  });

  it('accepts an absent field — the vast majority of saves do not touch it', () => {
    expect(aiVendorOverrideSchema.safeParse(undefined).success).toBe(true);
  });

  it('rejects a vendor nobody ships', () => {
    expect(aiVendorOverrideSchema.safeParse('mistral').success).toBe(false);
  });
});

describe('the router actually wires the field', () => {
  // The mirror above proves the vocabulary is right; it cannot prove the router
  // uses it. Without this, a schema that never gained the key would pass every
  // test here while the shipped client's field kept getting stripped — which is
  // precisely the failure this whole workstream exists to fix.
  // The update schema and its fragments live in workspace-actions/schemas.ts,
  // shared by the dashboard routes and the assistants' team tools; the create
  // schema stays with the create route.
  const routerSrc: string = require('fs').readFileSync(
    require('path').join(__dirname, '..', '..', 'workspace-actions', 'schemas.ts'),
    'utf8',
  );
  const createSrc: string = require('fs').readFileSync(
    require('path').join(__dirname, '..', 'router.ts'),
    'utf8',
  );

  function schemaBody(name: string): string {
    const src = name === 'createInternalAgentSchema' ? createSrc : routerSrc;
    const start = src.indexOf(`const ${name} = z.object({`);
    expect(start).toBeGreaterThan(-1);
    return src.slice(start, src.indexOf('\n});', start));
  }

  it('updateInternalAgentSchema carries aiVendorOverride', () => {
    expect(schemaBody('updateInternalAgentSchema')).toContain(
      'aiVendorOverride: aiVendorOverrideSchema',
    );
  });

  it('createInternalAgentSchema does NOT — the create path never receives it', () => {
    // Only TeamUpdatePage sends the field; the build wizard has no card. A key
    // on the create schema would be dead schema implying an entry point that
    // does not exist.
    expect(schemaBody('createInternalAgentSchema')).not.toContain('aiVendorOverride');
  });

  it('builds the fragment off the shared selection list, nullable', () => {
    expect(routerSrc).toContain(
      'const aiVendorOverrideSchema = z.enum([...WORKSPACE_AI_SELECTIONS]).nullable().optional();',
    );
  });

  it('leaves the admin-only modelConfig schemas alone', () => {
    // The override is the customer-safe surface in FRONT of modelConfig, not a
    // widening of it.
    expect(routerSrc).toContain('const customerModelConfigSchema = z.undefined().optional();');
    const adminStart = routerSrc.indexOf('const adminModelConfigSchema = z.object({');
    const adminBody = routerSrc.slice(adminStart, routerSrc.indexOf("}).default({ tier: 'medium' });", adminStart));
    expect(adminBody).not.toContain('aiVendorOverride');
    expect(adminBody).toContain('provider: z.string().max(50).optional()');
  });
});

describe('nothing feeds the row-mapper a partial row', () => {
  // The defect class this closes is not specific to the vendor override, but it
  // is how the override would have been lost: mapInternalAgentRow reads ~38
  // columns and maps every ABSENT one to a default, which is indistinguishable
  // from a real NULL. Hand a it row from a narrow SELECT and it fabricates a
  // plausible agent — then `buildInternalAgentEventPayload` publishes it, and
  // the runtime rebuilds the agent from that. `skills: []` erases the agent's
  // skills; `capabilityTier: 'connector_only'` demotes an execution_enabled one.
  //
  // The rule is simply: every query whose rows reach the mapper selects *.
  const FILES = ['internal-agents/router.ts', 'internal-agents/service.ts', 'internal-agents/reconciler.ts'];

  const read = (p: string): string =>
    require('fs').readFileSync(require('path').join(__dirname, '..', '..', p), 'utf8');

  it.each(FILES)('%s: every mapped query is SELECT *', (file) => {
    const src = read(file);
    // Each mapper call, paired with the nearest query text above it.
    const callRe = /\bmap(?:InternalAgentRow|InternalAgentRowWithDeletedAt|InternalAgent)\s*\(/g;
    const offenders: string[] = [];
    let m: RegExpExecArray | null;
    while ((m = callRe.exec(src)) !== null) {
      const before = src.slice(Math.max(0, m.index - 1200), m.index);
      const lastSelect = before.lastIndexOf('SELECT');
      if (lastSelect === -1) continue;                       // mapper wrapper / import line
      const stmt = before.slice(lastSelect, before.indexOf('FROM', lastSelect) + 40);
      if (!/FROM\s+internal_agents/i.test(stmt)) continue;    // some other table's query
      if (!/^SELECT\s+\*/i.test(stmt)) {
        offenders.push(stmt.replace(/\s+/g, ' ').slice(0, 120));
      }
    }
    expect(offenders).toEqual([]);
  });

  it('the checker can actually see a violation', () => {
    // Guards the guard: the regexes above are load-bearing, and a silently
    // non-matching scan would report "clean" forever.
    const sample = "const r = await c.query(`SELECT id, role FROM internal_agents WHERE tenant_id = $1`); const a = mapInternalAgentRow(r.rows[0]);";
    const before = sample.slice(0, sample.indexOf('mapInternalAgentRow('));
    const stmt = before.slice(before.lastIndexOf('SELECT'), before.indexOf('FROM', before.lastIndexOf('SELECT')) + 40);
    expect(/FROM\s+internal_agents/i.test(stmt)).toBe(true);
    expect(/^SELECT\s+\*/i.test(stmt)).toBe(false);
  });
});

describe('read path (row-mapper)', () => {
  const baseRow = {
    id: 'agent-1',
    tenant_id: 'tenant-1',
    role: 'Customer Success Manager',
    status: 'active',
    temperature: '0.3',
    created_at: '2026-08-06T00:00:00Z',
    updated_at: '2026-08-06T00:00:00Z',
  };

  it('returns the stored override', () => {
    const agent = mapInternalAgentRow({ ...baseRow, ai_vendor_override: 'qwen' });
    expect(agent.aiVendorOverride).toBe('qwen');
  });

  it("returns 'default' as itself, not collapsed to null", () => {
    const agent = mapInternalAgentRow({ ...baseRow, ai_vendor_override: 'default' });
    expect(agent.aiVendorOverride).toBe('default');
  });

  it('returns null on pre-migration rows', () => {
    expect(mapInternalAgentRow(baseRow).aiVendorOverride).toBeNull();
  });

});

describe('effectiveModelConfig', () => {
  it('leaves the config untouched when the override is null (inherit)', () => {
    const agent = makeAgent({ aiVendorOverride: null });
    expect(effectiveModelConfig(agent)).toEqual({ tier: 'medium' });
  });

  it('translates a concrete vendor into provider + tier, and NO modelId', () => {
    // The dropdown offers a vendor; which model its tier means is the
    // runtime's to resolve from the registry when it runs. A materialized id
    // is also indistinguishable from a deliberate pin, and code_session reads
    // one as exactly that.
    const agent = makeAgent({ aiVendorOverride: 'qwen', modelConfig: { tier: 'large' } });
    expect(effectiveModelConfig(agent)).toEqual({
      tier: 'large',
      provider: WORKSPACE_AI_VENDORS.qwen.provider,
    });
  });

  it("stamps Liftoff Managed for 'default' rather than falling through", () => {
    const managed = WORKSPACE_AI_VENDORS[LIFTOFF_MANAGED_VENDOR];
    const agent = makeAgent({ aiVendorOverride: 'default' });
    expect(effectiveModelConfig(agent)).toEqual({
      tier: 'medium',
      provider: managed.provider,
    });
  });

  it('defaults to the medium tier when the row carries none', () => {
    const agent = makeAgent({ aiVendorOverride: 'google', modelConfig: {} });
    expect(effectiveModelConfig(agent)).toEqual({
      tier: 'medium',
      provider: WORKSPACE_AI_VENDORS.google.provider,
    });
  });

  it('preserves unrelated modelConfig keys', () => {
    const agent = makeAgent({
      aiVendorOverride: 'openai',
      modelConfig: { tier: 'small', maxTokens: 4096, temperature: 0.1 },
    });
    expect(effectiveModelConfig(agent)).toMatchObject({ maxTokens: 4096, temperature: 0.1 });
  });

  it('lets a tuned modelConfig win unchanged', () => {
    const tuned: ModelConfig = { tier: 'medium', modelId: 'ft:acme-42', provider: 'openai' };
    const agent = makeAgent({ aiVendorOverride: 'kimi', modelConfig: tuned });
    expect(effectiveModelConfig(agent)).toEqual(tuned);
  });

  it('reuses the tenant-level managed-default resolution rather than re-deriving it', () => {
    expect(resolveWorkspaceAiVendor('default')).toBe(LIFTOFF_MANAGED_VENDOR);
  });
});

describe('event payload', () => {
  it('carries the translated provider + tier for a concrete vendor', async () => {
    const agent = makeAgent({ aiVendorOverride: 'deepseek' });
    const payload = await buildInternalAgentEventPayload(agent, 'tenant.internal_agent.updated');
    expect(payload.modelConfig).toEqual({
      tier: 'medium',
      provider: WORKSPACE_AI_VENDORS.deepseek.provider,
    });
  });

  it("stamps anthropic-medium for 'default' on a workspace pinned to qwen", async () => {
    // THE test. On a qwen workspace, an agent set to Liftoff Managed must route
    // anthropic — falling through to the inherit path would resolve qwen, the
    // exact opposite of the selection. The workspace vendor never enters this
    // computation, which is why the qwen workspace is expressed by the absence
    // of any workspace input rather than by a fixture: nothing here can read it.
    const agent = makeAgent({ aiVendorOverride: 'default' });
    const payload = await buildInternalAgentEventPayload(agent, 'tenant.internal_agent.created');
    expect(payload.modelConfig).toEqual({
      tier: 'medium',
      provider: 'anthropic',
    });
    expect((payload.modelConfig as ModelConfig).provider).not.toBe(
      WORKSPACE_AI_VENDORS.qwen.provider,
    );
  });

  it('reverts to an unstamped config when the override is cleared', async () => {
    const agent = makeAgent({ aiVendorOverride: null });
    const payload = await buildInternalAgentEventPayload(agent, 'tenant.internal_agent.updated');
    expect(payload.modelConfig).toEqual({ tier: 'medium' });
    expect((payload.modelConfig as ModelConfig).provider).toBeUndefined();
    expect((payload.modelConfig as ModelConfig).modelId).toBeUndefined();
  });

  it('never stamps over a tuned model', async () => {
    const tuned: ModelConfig = { tier: 'large', modelId: 'ft:acme-42', provider: 'openai' };
    const agent = makeAgent({ aiVendorOverride: 'glm', modelConfig: tuned });
    const payload = await buildInternalAgentEventPayload(agent, 'tenant.internal_agent.updated');
    expect(payload.modelConfig).toEqual(tuned);
  });
});

describe('redistill preservation', () => {
  it('does not touch aiVendorOverride', () => {
    // Same class of check as the attachments-preservation one: buildUpdatePayload
    // enumerates the fields distillation owns, and an override the operator set
    // is not one of them. A redistill that named the field would silently reset
    // every overridden team to inherit.
    const src = require('fs').readFileSync(
      require('path').join(__dirname, '..', 'redistill-service.ts'),
      'utf8',
    );
    const buildFn = src.slice(
      src.indexOf('function buildUpdatePayload'),
      src.indexOf('/** Per-binding integration-config diff entry'),
    );
    expect(buildFn.length).toBeGreaterThan(0);
    expect(buildFn).not.toContain('aiVendorOverride');
  });
});
