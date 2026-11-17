// Absorption — route imported artifacts to the home each one belongs in.
//
// People arriving from another agent runtime (Hermes, OpenClaw, Agno, GPTs,
// Claude projects) bring a pile of files: a persona prompt, some SKILL.md
// files, a MEMORY.md, a cron definition, a couple of reference docs. Before
// this service every attachment was flattened into the distill prompt, which
// meant a skill file became prose the distiller paraphrased, a memory file
// became configuration, and a 100K-char reference doc crowded out the actual
// instructions.
//
// Absorption classifies each artifact and sends it to its native home:
//
//   instructions | routine  → the distill prompt (unchanged behaviour)
//   skill                   → the skill rail (dedup + provenance, P1.0)
//   memory                  → the agent's memory store
//   reference               → a knowledge-library proposal, CONSENTED only
//
// Two rules shape this, both settled deliberately:
//
//  * Scope determines consent. Agent-scoped context (skills, individual-layer
//    memories) lands immediately and stays governable afterwards on the team
//    member's settings page. Workspace-scoped context — the knowledge library
//    is a curated help centre shared by every team member — is proposed, never
//    inserted silently.
//  * Ambiguity biases toward the agent. A "playbook" is nearly always "how this
//    team member works", not a company-wide document. Only unmistakably
//    help-centre-shaped material is offered to the library.

import { llmClient } from '../llm';
import { log } from '../infrastructure/logging';
import type { JSONSchema, LLMToolDefinition } from '../llm/types';
import { redactSensitiveText } from '../common/redact';

/** Where an imported artifact belongs. */
export type AbsorptionCategory =
  | 'instructions'
  | 'routine'
  | 'skill'
  | 'memory'
  | 'reference';

export interface ResolvedArtifact {
  name: string;
  source: 'responsibilities' | 'guidance';
  text: string;
}

export interface ExtractedSkill {
  name: string;
  description: string;
  instruction: string;
  tags?: string[];
}

export interface ExtractedMemory {
  content: string;
  /** Workspace-wide facts are proposed rather than written: the global layer is
   *  shared, so it follows the same consent rule as the knowledge library. */
  scope: 'individual' | 'workspace';
}

export interface ArtifactClassification {
  name: string;
  category: AbsorptionCategory;
  /** Populated for `skill`. One artifact can carry several skills. */
  skills?: ExtractedSkill[];
  /** Populated for `memory`. */
  memories?: ExtractedMemory[];
  /** Populated for `reference` — the proposed knowledge-library title. */
  referenceTitle?: string;
}

export interface AbsorptionResult {
  classifications: ArtifactClassification[];
  /** Artifact texts that still belong in the distill prompt, in input order. */
  distillArtifacts: ResolvedArtifact[];
}

/** Frontmatter (`---` … `---`) as a flat key/value map, plus the body. Skill
 *  files from every ecosystem we care about carry `name:` and `description:`
 *  there, and those are exactly the fields the skill rail wants — so the
 *  frontmatter is parsed for signal, then stripped from the instruction body. */
export function parseFrontmatter(text: string): { frontmatter: Record<string, string>; body: string } {
  const match = /^\uFEFF?---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text);
  if (!match) return { frontmatter: {}, body: text };

  const frontmatter: Record<string, string> = {};
  for (const line of match[1].split(/\r?\n/)) {
    const kv = /^([A-Za-z0-9_.-]+)\s*:\s*(.*)$/.exec(line.trim());
    if (!kv) continue;
    frontmatter[kv[1].toLowerCase()] = kv[2].trim().replace(/^["']|["']$/g, '');
  }
  return { frontmatter, body: match[2] };
}

// The anti-capture rules. Imported material is written by a person describing
// how their old setup behaved, so it is full of environment-specific failures
// and "X does not work" claims that would harden into permanent self-imposed
// limits here. Capturing the fix is useful; capturing the complaint is not.
const ANTI_CAPTURE_RULES = `
Never carry across any of the following, in any category:
- Environment-dependent failures: missing binaries, "command not found",
  unconfigured credentials, uninstalled packages, path mismatches. These
  describe someone else's machine, not durable knowledge.
- Negative capability claims ("the browser tool does not work", "X is broken").
  They harden into refusals that outlive the problem.
- Unresolved failures written up as procedure. If the source material tried
  several things and none worked, that is not a workflow.
- One-off task narratives ("summarise today's numbers"). A single request is
  not a class of work.
When the source describes a problem AND its fix, keep the fix and drop the
complaint.`;

const CLASSIFY_TOOL_NAME = 'classify_artifacts';

function buildClassifyTool(artifacts: ResolvedArtifact[]): LLMToolDefinition {
  const schema: JSONSchema = {
    type: 'object',
    properties: {
      classifications: {
        type: 'array',
        description: `One entry per artifact, in the same order as the input. Exactly ${artifacts.length} entries.`,
        items: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'The artifact file name, copied verbatim.' },
            category: {
              type: 'string',
              enum: ['instructions', 'routine', 'skill', 'memory', 'reference'],
              description: [
                'instructions: who this team member is and how it operates — persona files, system prompts, operating rules.',
                'routine: a recurring schedule ("every weekday at 9am, do X"), including cron definitions.',
                'skill: how to perform one class of task. Reusable procedure.',
                'memory: durable facts or stated preferences ("the team lead prefers bullet summaries").',
                'reference: help-centre material a team member would CONSULT — product docs, policies, FAQs. Use only when the document reads as shared company reference, not as instructions for this one team member.',
              ].join(' '),
            },
            skills: {
              type: 'array',
              description: 'Only for category=skill. One entry per distinct procedure in the artifact.',
              items: {
                type: 'object',
                properties: {
                  name: { type: 'string', description: 'Short class-level name. Not a file name, not a date, not a one-off task.' },
                  description: { type: 'string', description: 'One sentence: when this skill applies. This is the retrieval anchor.' },
                  instruction: { type: 'string', description: 'The procedure itself, kept close to the source wording.' },
                  tags: { type: 'array', items: { type: 'string' } },
                },
                required: ['name', 'description', 'instruction'],
              },
            },
            memories: {
              type: 'array',
              description: 'Only for category=memory. One entry per durable fact.',
              items: {
                type: 'object',
                properties: {
                  content: { type: 'string', description: 'The fact or preference, as one self-contained sentence.' },
                  scope: {
                    type: 'string',
                    enum: ['individual', 'workspace'],
                    description: 'individual: about this team member or its work. workspace: a fact about the whole company.',
                  },
                },
                required: ['content', 'scope'],
              },
            },
            referenceTitle: {
              type: 'string',
              description: 'Only for category=reference. A human title for the knowledge-library entry.',
            },
          },
          required: ['name', 'category'],
        },
      },
    },
    required: ['classifications'],
  };

  return {
    name: CLASSIFY_TOOL_NAME,
    description: 'Classify each imported artifact and extract its content into the right shape.',
    input_schema: schema,
  };
}

/** Cap per artifact fed to the classifier. The classifier only needs enough to
 *  recognise the shape and lift the procedure; a whole reference manual would
 *  blow the request for no gain (and reference docs get routed to the library
 *  in full anyway). */
const MAX_CLASSIFIER_CHARS_PER_ARTIFACT = 12_000;

function buildPrompt(artifacts: ResolvedArtifact[]): string {
  const rendered = artifacts
    .map((a, i) => {
      const { frontmatter, body } = parseFrontmatter(a.text);
      const fmLine = Object.keys(frontmatter).length
        ? `Declared metadata: ${JSON.stringify(frontmatter)}\n`
        : '';
      // Redacted before it leaves for the model: imported files routinely carry
      // API keys in setup sections.
      const text = redactSensitiveText(body).slice(0, MAX_CLASSIFIER_CHARS_PER_ARTIFACT);
      return `<artifact index="${i + 1}" name="${a.name}">\n${fmLine}${text}\n</artifact>`;
    })
    .join('\n\n');

  return `You are sorting files a person is importing while setting up an agent member.
Classify every artifact into the ONE place it belongs, and extract its content.

Guidance:
- Most files are "instructions" or "skill". Prefer those.
- "reference" is only for shared help-centre documents. When a document could
  plausibly be instructions for THIS team member, it is instructions, not
  reference. Being long does not make something reference.
- A file with frontmatter declaring a name and description is almost always a
  skill; reuse those values.
- Preserve the source's own wording. Do not invent steps, commands, or flags
  that the source does not contain.
${ANTI_CAPTURE_RULES}

Return exactly one classification per artifact, in input order.

${rendered}`;
}

/**
 * Classify imported artifacts. Never throws: absorption is an enhancement on
 * top of the import, so a classifier failure degrades to "everything is
 * instructions" — which is exactly the behaviour that shipped before this
 * service existed.
 */
export async function classifyArtifacts(
  artifacts: ResolvedArtifact[],
  ctx: { tenantId?: string; agentId?: string },
): Promise<AbsorptionResult> {
  if (artifacts.length === 0) {
    return { classifications: [], distillArtifacts: [] };
  }

  const fallback = (): AbsorptionResult => ({
    classifications: artifacts.map((a) => ({ name: a.name, category: 'instructions' as const })),
    distillArtifacts: artifacts,
  });

  let parsed: { classifications?: ArtifactClassification[] } | undefined;
  try {
    const response = await llmClient.complete(
      {
        messages: [{ role: 'user', content: buildPrompt(artifacts) }],
        tier: 'small',
        maxTokens: 8192,
        temperature: 0,
        tools: [buildClassifyTool(artifacts)],
        toolChoice: { name: CLASSIFY_TOOL_NAME },
      },
      undefined,
      {
        tenantId: ctx.tenantId || 'unknown',
        ...(ctx.agentId ? { agentId: ctx.agentId } : {}),
        purpose: 'absorption_classification',
      },
    );
    const call = response.toolCalls?.find((c) => c.name === CLASSIFY_TOOL_NAME);
    if (!call) {
      log.warn({ tenantId: ctx.tenantId }, 'absorption: classifier returned no tool call — importing everything as instructions');
      return fallback();
    }
    parsed = call.input as { classifications?: ArtifactClassification[] };
  } catch (err) {
    log.warn(
      { tenantId: ctx.tenantId, error: (err as Error).message },
      'absorption: classifier failed — importing everything as instructions',
    );
    return fallback();
  }

  const VALID_CATEGORIES = new Set<string>([
    'instructions', 'routine', 'skill', 'memory', 'reference',
  ]);

  const byName = new Map<string, ArtifactClassification>();
  for (const c of parsed?.classifications ?? []) {
    if (c && typeof c.name === 'string') byName.set(c.name, c);
  }

  // Reconcile against the real artifact list rather than trusting the model's
  // ordering or naming: an artifact the classifier skipped or renamed must
  // still be imported, and the safe default is the pre-absorption behaviour.
  const classifications: ArtifactClassification[] = artifacts.map((a) => {
    const c = byName.get(a.name);
    if (!c) return { name: a.name, category: 'instructions' };

    // A category outside the enum is not just untidy: it matches no branch in
    // applyAbsorption AND is withheld from the prompt, so the file would vanish
    // from the import entirely. Tool-schema enums are not guaranteed
    // enforcement across providers, so this is checked rather than trusted.
    const declared = VALID_CATEGORIES.has(c.category as string)
      ? c.category
      : 'instructions';

    const category: AbsorptionCategory =
      declared === 'skill' && (c.skills?.length ?? 0) === 0
        ? 'instructions' // claimed a skill but extracted none — do not silently drop the file
        : declared === 'memory' && (c.memories?.length ?? 0) === 0
          ? 'instructions'
          // A `reference` with no title is fine: the apply step falls back to
          // the file name, so the consent item still has something to show.
          : declared;

    return {
      name: a.name,
      category,
      ...(c.skills?.length ? { skills: c.skills } : {}),
      ...(c.memories?.length ? { memories: c.memories } : {}),
      ...(c.referenceTitle ? { referenceTitle: c.referenceTitle } : {}),
    };
  });

  const promptCategories = new Set<AbsorptionCategory>(['instructions', 'routine']);
  const distillArtifacts = artifacts.filter((a) => {
    const c = classifications.find((x) => x.name === a.name);
    return promptCategories.has(c?.category ?? 'instructions');
  });

  log.info(
    {
      tenantId: ctx.tenantId,
      agentId: ctx.agentId,
      total: artifacts.length,
      toPrompt: distillArtifacts.length,
      skills: classifications.filter((c) => c.category === 'skill').length,
      memories: classifications.filter((c) => c.category === 'memory').length,
      references: classifications.filter((c) => c.category === 'reference').length,
    },
    'absorption: artifacts classified',
  );

  return { classifications, distillArtifacts };
}
