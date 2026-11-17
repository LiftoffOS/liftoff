// The per-tool result policy reaches the runtime, or it protects nobody.
//
// `resultRules` is authored by distillation here and enforced by the tool
// gateway in the tenant runtime. Between those two points it crosses seven
// links: the column, the row mapper, the create INSERT, the update SET, the
// request schema, the event payload, and the drift comparison. A field wired at
// six of seven passes lint, typecheck and its own unit tests while the agent it
// was meant to protect keeps acting on a preview.
//
// So this covers the CHAIN, not the feature. Each assertion names one link, and
// removing that link fails exactly one test.

import { createHash } from 'crypto';
import { readFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';

// distill-service pulls in proto-gen transitively, which does not resolve
// inside a worktree; same mock set as distill-prompt.test.ts.
jest.mock('../../llm/client', () => ({ llmClient: { complete: jest.fn() } }));
jest.mock('../../connectors/tenant-runtime-client', () => ({
  tenantRuntimeClient: { getTenantManifests: jest.fn(), getToolCatalog: jest.fn() },
}));
jest.mock('../../infrastructure/logging', () => ({
  log: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.mock('../effective-instructions-md', () => ({
  buildEffectiveInstructionsMd: jest.fn(async () => 'effective-md'),
}));
jest.mock('../integration-enrichment', () => ({
  enrichIntegrationsWithType: jest.fn(async (_t: string, i: unknown) => i),
}));

import { buildInternalAgentEventPayload } from '../event-payload';
import { isReadShapedTool } from '../distill-service';
import { mapInternalAgentRow } from '../row-mapper';
import { canonicalize, classifyDrift, computePbContentHashes } from '../reconciler';
import type { InternalAgent, ResultRule } from '../types';
import type { InternalAgentRow } from '../row-mapper';

const SRC = join(__dirname, '..', '..');
const read = (...p: string[]) => readFileSync(join(SRC, ...p), 'utf8');

const RULES: ResultRule[] = [{ toolName: 'google_sheets__read_rows', requiresComplete: true }];

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
    modelConfig: {},
    memoryScope: {},
    execConfig: {},
    workflowSteps: null,
    triggerConfig: null,
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
    resultRules: [],
    attachments: [],
    // The drift tests read this row as an InternalAgentRow; an absent
    // deletedAt reads as deleted and short-circuits every classification.
    deletedAt: null,
    ...overrides,
  } as unknown as InternalAgent;
}

// ── Link 1: the column ───────────────────────────────────────────────────────

describe('the column exists and every read of it is a list', () => {
  it('a migration adds result_rules to internal_agents', () => {
    const dir = join(SRC, '..', 'migrations');
    const named = readdirSync(dir).filter((f) => /result_rules/.test(f));
    expect(named.length).toBeGreaterThan(0);
    const sql = readFileSync(join(dir, named[0]), 'utf8');
    expect(sql).toMatch(/ALTER TABLE internal_agents/);
    expect(sql).toMatch(/ADD COLUMN IF NOT EXISTS result_rules JSONB/);
    // NOT NULL DEFAULT '[]' is what makes every reader's job unconditional. A
    // nullable column would push "what does null mean" onto seven call sites.
    expect(sql).toMatch(/NOT NULL DEFAULT '\[\]'::jsonb/);
  });

  it('the row mapper reads it, defaulting to an empty list', () => {
    expect(mapInternalAgentRow({ result_rules: RULES } as never).resultRules).toEqual(RULES);
    // pg returns jsonb parsed, but a text-typed readback arrives as a string.
    expect(mapInternalAgentRow({ result_rules: JSON.stringify(RULES) } as never).resultRules).toEqual(RULES);
    expect(mapInternalAgentRow({} as never).resultRules).toEqual([]);
    expect(mapInternalAgentRow({ result_rules: null } as never).resultRules).toEqual([]);
  });
});

// ── Links 2 and 3: persistence ───────────────────────────────────────────────

describe('both write paths persist it', () => {
  const service = read('internal-agents', 'service.ts');

  it('the create INSERT names the column and binds the input', () => {
    const insert = /INSERT INTO internal_agents \(([\s\S]*?)\)\s*\n\s*VALUES \(([\s\S]*?)\)/.exec(service);
    expect(insert).not.toBeNull();
    const [, columns, placeholders] = insert!;
    expect(columns).toContain('result_rules');
    // A column added to the list without a matching placeholder is a syntax
    // error at runtime only — the suite has no database to catch it.
    const columnCount = columns.split(',').length;
    const placeholderCount = placeholders.split(',').length;
    expect(placeholderCount).toBe(columnCount);
    expect(service).toContain('JSON.stringify(input.resultRules ?? [])');
  });

  it('the update path sets the column when the caller sends one', () => {
    expect(service).toMatch(/if \(input\.resultRules !== undefined\) \{/);
    expect(service).toMatch(/updates\.push\(`result_rules = \$\$\{paramIndex\}::jsonb`\)/);
  });

  it('a change to the rules alone bumps the version', () => {
    // The runtime drops an event whose entity_version is not ahead of what it
    // has already applied. A rules-only save that did not bump the version
    // would publish an event the runtime discards, so the policy would persist
    // here and never arrive there.
    const versioned = /const versionedFieldsChanged =([\s\S]*?);\n/.exec(service);
    expect(versioned).not.toBeNull();
    expect(versioned![1]).toContain('input.resultRules');
  });
});

// ── Link 4: the request schema ───────────────────────────────────────────────

describe('the request schema declares it on both routes', () => {
  // The update schema and its fragments live in workspace-actions/schemas.ts,
  // shared by the dashboard routes and the assistants' team tools; the create
  // schema stays with the create route.
  const router = read('workspace-actions', 'schemas.ts');
  const createRouter = read('internal-agents', 'router.ts');

  it('create and update both accept resultRules', () => {
    // zod strips unknown keys, so a schema that omits the field discards it
    // silently — the create succeeds and the policy is simply gone.
    const create = /const createInternalAgentSchema = z\.object\(\{([\s\S]*?)\n\}\)/.exec(createRouter);
    const update = /const updateInternalAgentSchema = z\.object\(\{([\s\S]*?)\n\}\);/.exec(router);
    expect(create).not.toBeNull();
    expect(update).not.toBeNull();
    expect(create![1]).toContain('resultRules:');
    expect(update![1]).toContain('resultRules:');
  });

  it('the declared shape is bounded', () => {
    const schema = /const resultRulesArraySchema = z\.array\(([\s\S]*?)\)\)\.max\((\d+)\);/.exec(router);
    expect(schema).not.toBeNull();
    expect(schema![1]).toContain('toolName: z.string().min(1).max(255)');
    expect(schema![1]).toContain('requiresComplete: z.boolean()');
    expect(Number(schema![2])).toBeLessThanOrEqual(50);
  });
});

// ── Link 5: the event payload ────────────────────────────────────────────────

describe('the payload the runtime compiles from carries it', () => {
  it('includes the rules on created and updated', async () => {
    for (const type of ['tenant.internal_agent.created', 'tenant.internal_agent.updated'] as const) {
      const payload = await buildInternalAgentEventPayload(makeAgent({ resultRules: RULES }), type);
      expect((payload as Record<string, unknown>).resultRules).toEqual(RULES);
    }
  });

  it('sends an empty list rather than omitting the field', async () => {
    // The runtime compiles a fresh instruction from this payload every time, so
    // an empty list is what retires a policy a previous distillation set.
    const payload = await buildInternalAgentEventPayload(makeAgent(), 'tenant.internal_agent.updated');
    expect(payload).toHaveProperty('resultRules');
    expect((payload as Record<string, unknown>).resultRules).toEqual([]);
  });

  it('still omits everything but the envelope on deleted', async () => {
    const payload = await buildInternalAgentEventPayload(
      makeAgent({ resultRules: RULES }), 'tenant.internal_agent.deleted',
    );
    expect(payload).not.toHaveProperty('resultRules');
  });
});

// ── Link 6: the producers ────────────────────────────────────────────────────

/** The object literal enclosing `at`, found by matching braces outward. */
function enclosingObjectLiteral(src: string, at: number): string {
  let depth = 0;
  let start = -1;
  for (let i = at; i >= 0; i--) {
    if (src[i] === '}') depth++;
    else if (src[i] === '{') {
      if (depth === 0) { start = i; break; }
      depth--;
    }
  }
  if (start === -1) return '';
  let d = 0;
  for (let i = start; i < src.length; i++) {
    if (src[i] === '{') d++;
    else if (src[i] === '}') {
      d--;
      if (d === 0) return src.slice(start, i + 1);
    }
  }
  return src.slice(start);
}

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry === '__tests__' || entry === 'node_modules') continue;
      walk(full, out);
    } else if (entry.endsWith('.ts')) {
      out.push(full);
    }
  }
  return out;
}

describe('every place that persists a distillation carries the rules', () => {
  // Anchored on the skills handoff rather than a hand-written file list: skills
  // and resultRules are both distillation output written straight onto the
  // agent, so anywhere one is handed over is a place the other belongs. A
  // fourth producer added later fails here instead of shipping half a policy.
  const handoffs = walk(SRC).flatMap((file) => {
    const src = readFileSync(file, 'utf8');
    const sites: Array<{ file: string; literal: string }> = [];
    // `incumbency.skills` is the redistill path: it assigns surviving flow
    // identities before persisting, so the variable is no longer named for the
    // distillation it came from. Recognised here rather than renamed back,
    // because the property this test guards is that the SITE carries
    // resultRules — not what the local variable happens to be called.
    const re = /skills: (?:distilled|distillResult|incumbency)\.skills/g;
    for (let m = re.exec(src); m; m = re.exec(src)) {
      sites.push({ file: file.slice(SRC.length + 1), literal: enclosingObjectLiteral(src, m.index) });
    }
    return sites;
  });

  it('finds the handoffs at all', () => {
    // An empty list would make the assertion below pass for the wrong reason.
    //
    // Was 3 until ADR-050 removed runFullDistillFromTenant, the post-payment
    // distill of whatever a user assembled during onboarding. The first hire
    // now happens after onboarding, where the ordinary distill path runs, so
    // that producer is gone rather than silently no longer carrying the rules.
    // Lowered deliberately: the floor exists to catch a NEW producer shipping
    // half a policy, and leaving it at 3 would have failed forever on a
    // producer that no longer exists.
    expect(handoffs.length).toBeGreaterThanOrEqual(2);
  });

  it.each([0, 1])('handoff %i also passes resultRules', (i) => {
    const site = handoffs[i];
    expect(site).toBeDefined();
    expect({ file: site.file, hasRules: site.literal.includes('resultRules:') })
      .toEqual({ file: site.file, hasRules: true });
  });

  it('the redistill payload clears rather than inherits when a run names no tool', () => {
    // The rules describe the workflow that same distillation produced. Carrying
    // the previous run's policy forward would apply it to steps that no longer
    // exist.
    expect(read('internal-agents', 'redistill-service.ts'))
      .toContain('resultRules: distillResult.resultRules ?? []');
  });
});

// ── A rule naming a tool that does not exist ─────────────────────────────────

describe('an unresolvable rule is fed back, not silently dropped', () => {
  // A distillation can declare `google_sheets_read_values`
  // for an agent whose catalog calls it `google-sheets-d14f7fd5__batch_get_
  // values`: the right operation, the wrong vocabulary. Dropping that leaves
  // the agent with no policy and a log line as the only trace — which is the
  // shape of failure this feature exists to remove.
  const service = read('internal-agents', 'distill-service.ts');
  const block = /const unknownRuleTools = resultRules[\s\S]*?const agentResult: DistillOutput/.exec(service)?.[0] ?? '';

  it('finds the validation block', () => {
    expect(block).not.toBe('');
  });

  it('retries with feedback while retries remain', () => {
    expect(block).toContain('attempt < MAX_RETRIES - 1');
    expect(block).toContain('validationFeedback');
    expect(block).toContain('continue;');
  });

  it('names the nearest real tool in the feedback', () => {
    // The model is choosing from a set it can see, so the fix is to show it the
    // set — not to guess on its behalf. A rule resolved to the wrong tool fails
    // calls that were fine, which is worse than asking again.
    expect(block).toContain('nearestToolName(wrong, known)');
    expect(block).toMatch(/Did you mean/);
  });

  it('keeps what resolved and counts what did not, once retries are gone', () => {
    expect(block).toContain("metric: 'distill.result_rules.dropped_terminal'");
    expect(block).toContain('kept: keptResultRules.length');
  });

  it('the schema tells the model where the exact name already is', () => {
    expect(service).toContain('copy its ');
    expect(service).toContain('verbatim. A shortened or invented name matches no tool');
  });
});

// ── Link 7: drift ────────────────────────────────────────────────────────────

describe('drift detection compares the rules', () => {
  const hashOf = (v: unknown) => createHash('sha256').update(canonicalize(v)).digest('hex');

  function runtimeState(over: Record<string, unknown> = {}) {
    return {
      hasMapping: true,
      hasActiveInstruction: true,
      cachedEntityVersion: 1,
      cachedStatus: 'active' as const,
      triggerConfigHash: hashOf(null),
      instructionsHash: 'ignored-here',
      capabilityTier: 'connector_only',
      ...over,
    };
  }

  it('exposes a hash of its own, not one folded into instructionsHash', async () => {
    // instructionsHash's canonical shape is agreed with the runtime byte for
    // byte. Adding a key would change every agent's hash on both sides, and any
    // skew in deploy order would report the whole estate as drifted.
    const withRules = await computePbContentHashes(makeAgent({ resultRules: RULES }) as InternalAgentRow);
    const without = await computePbContentHashes(makeAgent() as InternalAgentRow);

    expect(withRules.resultRulesHash).not.toBe(without.resultRulesHash);
    expect(withRules.instructionsHash).toBe(without.instructionsHash);
    expect(without.resultRulesHash).toBe(hashOf([]));
  });

  it('flags stale_content when the runtime compiled different rules', async () => {
    const pbHashes = await computePbContentHashes(makeAgent({ resultRules: RULES }) as InternalAgentRow);
    const drift = classifyDrift(
      makeAgent() as InternalAgentRow,
      runtimeState({ instructionsHash: pbHashes.instructionsHash, resultRulesHash: hashOf([]) }),
      pbHashes,
    );
    expect(drift).toBe('stale_content');
  });

  it('is quiet when both sides agree', async () => {
    const pbHashes = await computePbContentHashes(makeAgent({ resultRules: RULES }) as InternalAgentRow);
    const drift = classifyDrift(
      makeAgent() as InternalAgentRow,
      runtimeState({
        instructionsHash: pbHashes.instructionsHash,
        resultRulesHash: pbHashes.resultRulesHash,
      }),
      pbHashes,
    );
    expect(drift).toBeNull();
  });

  it('degrades rather than republishing the estate against an older runtime', async () => {
    // A runtime that has not shipped the field yet sends undefined. Reading
    // that as a mismatch would mark every agent drifted for the length of the
    // gap between the two deploys.
    const pbHashes = await computePbContentHashes(makeAgent({ resultRules: RULES }) as InternalAgentRow);
    const drift = classifyDrift(
      makeAgent() as InternalAgentRow,
      runtimeState({ instructionsHash: pbHashes.instructionsHash, resultRulesHash: undefined }),
      pbHashes,
    );
    expect(drift).toBeNull();
  });
});

// ── A rule on a tool that writes ─────────────────────────────────────────────

describe('requiresComplete is a constraint on a read', () => {
  // A distillation can name `google-sheets-d14f7fd5__batch_update_values` for a
  // rule about the read that decides what already exists. A real tool, the
  // right connector, the wrong operation — so it passes the catalog check and
  // ships, leaving the dangerous call unprotected while a harmless one carries
  // the policy. Worse than an invented name, because nothing fails.

  it.each([
    'google-sheets-d14f7fd5__batch_get_values',
    'google-sheets-d14f7fd5__get_sheet_names',
    'gmail-x__list_messages',
    'notion-y__search_pages',
    'jira-z__fetch_issue',
  ])('%s reads', (name) => {
    expect(isReadShapedTool(name)).toBe(true);
  });

  it.each([
    'google-sheets-d14f7fd5__batch_update_values',
    'google-sheets-d14f7fd5__append_row',
    'gmail-x__send_message',
    'jira-z__create_issue',
    'notion-y__delete_page',
    'slack-a__post_message',
  ])('%s writes', (name) => {
    expect(isReadShapedTool(name)).toBe(false);
  });

  it('treats a mixed verb as a write — the safe direction', () => {
    // Rejecting costs one more question. Accepting puts the policy on a call
    // that changes state, where completeness means nothing.
    expect(isReadShapedTool('x__get_or_create_row')).toBe(false);
  });

  it('the validation drops write-shaped rules and feeds back the reads beside them', () => {
    const service = readFileSync(join(SRC, 'internal-agents', 'distill-service.ts'), 'utf8');
    expect(service).toContain('writeShapedRuleTools');
    // The kept set is filtered on read-shape, not only on catalog membership —
    // otherwise a write-shaped name survives because the tool does exist.
    expect(service).toMatch(/keptResultRules = resultRules\.filter\([\s\S]*?isReadShapedTool\(r\.toolName\)/);
    // And the correction names that connector's reads, because the model picked
    // the right integration and the wrong operation.
    expect(service).toContain('n.startsWith(`${alias}__`) && isReadShapedTool(n)');
  });

  it('the schema says it in the first line, not only in the check', () => {
    const service = readFileSync(join(SRC, 'internal-agents', 'distill-service.ts'), 'utf8');
    expect(service).toContain('READ tools whose result this agent may only act on IN FULL');
    expect(service).toContain('Never a tool that writes, appends, updates or sends.');
  });
});

// ── The catalog is the agent's own connectors ────────────────────────────────

describe('distillation authors against connectors the agent is bound to', () => {
  // A manifest outlives the connector it describes. A tenant can carry an old
  // `google-sheets-d14f7fd5` manifest beside the live `google-sheets-2b820bc9`,
  // and nothing removes the first when its connector goes. Filtering on type
  // alone puts both in the catalog, and a distillation can author its steps AND
  // its result rules against the dead one — names that resolve to nothing at run
  // time, while every check passes because the tools exist in the catalog they
  // are checked against.
  const service = read('internal-agents', 'distill-service.ts');
  const block = /const integrationTypes = new Set\([\s\S]*?const relevantManifests = /.exec(service)?.[0] ?? '';

  it('finds the manifest filter', () => {
    expect(block).not.toBe('');
  });

  it('narrows by the bound connector id, not only by type', () => {
    expect(block).toContain('boundIdPrefixes');
    expect(block).toMatch(/\(m\.alias \?\? ''\)\.slice\(-8\)/);
  });

  it('matches the alias suffix rather than rebuilding the runtime alias here', () => {
    // The runtime composes `<type-with-dashes>-<id first 8>`. Restating that
    // formula in this repo is a cross-service assumption that breaks quietly.
    expect(block).not.toMatch(/replace\(\/_\/g, ?'-'\)/);
  });

  it('falls back to the type match rather than distilling against nothing', () => {
    // A pending integration has no manifest, and a caller may pass one with no
    // id. Neither is a reason to hand the distiller an empty catalog — that is
    // the failure this function exists to prevent.
    expect(service).toContain('byBinding.length > 0 ? byBinding : byType');
  });

  it('says what it dropped, so a wrong binding is visible', () => {
    expect(service).toContain("metric: 'distill.catalog.unbound_manifests_dropped'");
  });
});
