// distill-ab-corpus — builds the stratified corpus the A/B harness replays.
//
// The corpus is the experiment's design, not an input to it: a comparison run
// over whatever happened to be handy measures whatever happened to be handy. The
// strata below are section 8 of the split plan (liftoff-react
// docs/distill-split-plan.md), and each exists because it stresses a different
// part of what the waved strategy changes.
//
// SOURCE: the agent-templates catalog.
//
// The plan leaves the choice open between this and the role/responsibilities on
// real agent rows. The catalog wins on the ground that matters most here: it is
// Liftoff's own authored content, so building a dev corpus from it moves no
// customer-written text between environments, and it already spans every
// department with prose written to the same standard. Its weakness is real and
// worth stating — 65 curated templates are more uniform than what customers
// actually type, so a defect that only appears in messy input will not be caught
// by this corpus.
//
// `--from-agents` sources from internal_agents instead, for when that truer
// distribution is wanted and the data-movement question has been answered.
import { writeFileSync } from 'fs';
import { getActiveTemplates, initTemplateLoader } from '../agent-templates/loader';
import { initDatabase, withAdminScope } from '../infrastructure/database';
import { log } from '../infrastructure/logging';
import type { AgentTemplate } from '../agent-templates/schema';

/** One corpus entry. Mirrors the harness's CorpusEntry. */
interface CorpusEntry {
  id: string;
  stratum: string;
  input: {
    role: string;
    responsibilities: string;
    integrations: Array<{ id: string; name: string; type: string; selectedObjects: string[] }>;
    additionalContext?: string | null;
    templateId?: string;
    agentId?: string;
  };
}

/**
 * The strata, with their targets from the plan.
 *
 * Ordered by how much each one stresses the split rather than by size. The first
 * two are the graph decision, which is the headline agreement metric; the
 * connector counts move the per-branch input size, which is where the cache
 * fragmentation risk lives; the last is the majority of real traffic.
 */
const STRATA: Array<{ name: string; target: number; matches: (t: AgentTemplate) => boolean }> = [
  {
    name: 'workflows-section',
    target: 20,
    // The dominant emit trigger: the prompt says a "## Workflows" section means
    // workflowSteps MUST be populated. These are the inputs where the graph
    // branch does real work and the wave-2 seed matters.
    matches: (t) => /##\s*(Workflows|Steps|Procedure|Instructions)\b/i.test(t.responsibilities ?? ''),
  },
  {
    name: 'conversational',
    target: 10,
    // The documented omit case. Wave 2 has to cohere with NO graph to write
    // against, which is the branch of produceWavedToolCall that the happy path
    // never exercises.
    matches: (t) => !/##\s*(Workflows|Steps|Procedure|Instructions)\b/i.test(t.responsibilities ?? ''),
  },
  {
    name: 'zero-connectors',
    target: 8,
    // Smallest user message, so the cached prefix is the largest share of input
    // — the best case for the fragmentation the split risks.
    matches: (t) => (t.requiredConnectors?.length ?? 0) === 0,
  },
  {
    name: 'many-connectors',
    target: 12,
    // Largest entity-schema payload, so the worst case for per-branch input:
    // every branch re-pays it.
    matches: (t) => (t.requiredConnectors?.length ?? 0) >= 4,
  },
];

/** The stratum a template primarily represents, for labelling in `--all` mode. */
function primaryStratum(t: AgentTemplate): string {
  for (const s of STRATA) {
    if (s.matches(t)) return s.name;
  }
  return 'unclassified';
}

/**
 * Every template the gallery displays, one entry each.
 *
 * `getActiveTemplates()` is exactly what the explore route serves, so this is
 * the set a customer can actually hire from — disabled templates (today:
 * contract-specialist, whose DocuSign connector is not built) are excluded for
 * the same reason they are hidden.
 *
 * Used when the question is "how does the split behave on our real catalogue"
 * rather than "does it hold across the plan's strata". Sampling would answer
 * the second question with a subset of the first, and at 64 templates there is
 * no reason to sample.
 */
function buildAllDisplayed(): CorpusEntry[] {
  initTemplateLoader();
  return getActiveTemplates().map((t) => ({
    id: t.id,
    stratum: primaryStratum(t),
    input: {
      role: t.role,
      responsibilities: t.responsibilities ?? '',
      // Empty for the same reason as the stratified mode: binding real
      // connectors would tie the corpus to whatever the run's tenant happens to
      // have wired, and two runs a week apart would not be comparable.
      integrations: [],
      additionalContext: t.additionalContext ?? null,
      templateId: t.id,
    },
  }));
}

function buildFromTemplates(): CorpusEntry[] {
  initTemplateLoader();
  const templates = getActiveTemplates();
  const chosen = new Map<string, CorpusEntry>();

  for (const stratum of STRATA) {
    const candidates = templates.filter(stratum.matches);
    let taken = 0;
    for (const t of candidates) {
      if (taken >= stratum.target) break;
      // One entry per template. A template counted twice would weight its role
      // double in every aggregate, and the strata overlap by construction (a
      // zero-connector template usually also has a workflows section).
      if (chosen.has(t.id)) continue;
      chosen.set(t.id, {
        id: t.id,
        stratum: stratum.name,
        input: {
          role: t.role,
          responsibilities: t.responsibilities ?? '',
          // Deliberately empty. Binding real connectors would make the corpus
          // depend on which connectors the run's tenant happens to have wired,
          // so the run would not be reproducible and two runs a week apart
          // would not be comparable.
          integrations: [],
          additionalContext: t.additionalContext ?? null,
          templateId: t.id,
        },
      });
      taken++;
    }
    if (taken < stratum.target) {
      log.warn(
        { stratum: stratum.name, wanted: stratum.target, got: taken },
        'Stratum under-filled: the catalog does not contain enough templates matching it',
      );
    }
  }

  return [...chosen.values()];
}

/**
 * The truer distribution: what customers actually typed.
 *
 * Includes `agentId`, so the harness exercises the `distill_update` path — 61%
 * of real volume, and the flow the plan found benefits least from the split.
 */
async function buildFromAgents(limit: number): Promise<CorpusEntry[]> {
  // Standalone entrypoint: open the pool before the first query.
  await initDatabase();
  const rows = await withAdminScope(
    { caller: 'distill-ab-corpus', reason: 'cross-tenant read to build an A/B corpus from real distill inputs' },
    (client) => client.query<{ id: string; role: string; responsibilities: string | null; additional_context: string | null }>(
      `SELECT id, role, responsibilities, additional_context
         FROM internal_agents
        WHERE deleted_at IS NULL
          AND responsibilities IS NOT NULL
          AND length(responsibilities) > 200
        ORDER BY updated_at DESC
        LIMIT $1`,
      [limit],
    ),
  );

  return rows.rows.map((r) => ({
    id: `agent-${r.id}`,
    stratum: /##\s*(Workflows|Steps|Procedure|Instructions)\b/i.test(r.responsibilities ?? '')
      ? 'redistill-workflows'
      : 'redistill-conversational',
    input: {
      role: r.role,
      responsibilities: r.responsibilities ?? '',
      integrations: [],
      additionalContext: r.additional_context,
      agentId: r.id,
    },
  }));
}

async function main(): Promise<void> {
  const out = process.argv[2];
  if (!out) {
    console.error('usage: distill-ab-corpus <out.json> [--all | --from-agents N]');
    process.exit(1);
  }
  const fromAgentsIndex = process.argv.indexOf('--from-agents');
  const entries = fromAgentsIndex > -1
    ? await buildFromAgents(Number(process.argv[fromAgentsIndex + 1] ?? 5))
    : process.argv.includes('--all')
      ? buildAllDisplayed()
      : buildFromTemplates();

  writeFileSync(out, JSON.stringify(entries, null, 2));
  const byStratum = entries.reduce<Record<string, number>>((acc, e) => {
    acc[e.stratum] = (acc[e.stratum] ?? 0) + 1;
    return acc;
  }, {});
  log.info({ out, entries: entries.length, byStratum }, 'A/B corpus written');
  console.log(JSON.stringify({ out, entries: entries.length, byStratum }, null, 2));
}

if (require.main === module) {
  main().then(
    () => process.exit(0),
    (err) => {
      log.error({ error: (err as Error).message }, 'corpus build failed');
      process.exit(1);
    },
  );
}

export { buildFromTemplates, buildAllDisplayed, STRATA };
export type { CorpusEntry };
