// The reflection engine's prompt host.
//
// The file name is historical: every model call in this class goes through
// llmClient by tier, not through a Vertex client. Renaming the file is a larger
// change (README, reflection-engine, the test mock).

import { logger } from './logging';
import { llmClient } from '../llm/client';

/** Log-safe fields from a caught value.
 *
 *  `{ error }` serializes an Error to `{}` — `message` and `stack` are
 *  non-enumerable — so every failure log in this file recorded that something
 *  went wrong and nothing about what. The reflection engine's first real LLM
 *  failure surfaced as `"error": {}`, which is worse than no log: it looks
 *  like the failure was captured. */
/** Output budget for one reflection analysis. See the call site for why 1024
 *  was not enough. */
const REFLECTION_MAX_OUTPUT_TOKENS = 8192;

/** Tier for the legacy compile / summary / scenario / planning methods.
 *
 *  They asked for a hardcoded Opus 4 id through a per-tenant config lookup and
 *  called the Vertex SDK directly, so their spend reached neither
 *  llm_usage_log nor the Operating Unit accounting. Medium matches what
 *  reflection settled on for comparable structured work, and the tier map now
 *  owns the model choice — the point being that no id is pinned here to go
 *  stale the way `claude-opus-4-20250514` did. */
const LEGACY_COMPILE_TIER = 'medium' as const;

/** The object the reflection prompt asks for, enforced by the provider rather
 *  than hoped for. Mirrors ReflectionAnalysis. */
const REFLECTION_RESPONSE_SCHEMA = {
  name: 'reflection_analysis',
  description: 'Structured analysis of an agent\'s recent evidence, and what to change.',
  schema: {
    type: 'object' as const,
    properties: {
      suggestion: { type: 'string' as const, description: 'The change to make, stated as an instruction.' },
      rule: { type: 'string' as const, description: 'Optional one-line rule form of the suggestion.' },
      why: { type: 'string' as const, description: 'Why the evidence supports this change.' },
      appliesWhen: { type: 'string' as const, description: 'The situation in which the rule applies.' },
      expectedOutcome: { type: 'string' as const, description: 'What should measurably improve, so closure can judge it.' },
      evidenceRefs: { type: 'array' as const, items: { type: 'string' as const }, description: 'Ids of the evidence rows this rests on.' },
      confidenceScore: { type: 'number' as const, description: '0-1 confidence the suggestion is correct.' },
      recurrenceScore: { type: 'number' as const, description: '0-1 how repeated the underlying pattern is.' },
      severity: { type: 'string' as const, enum: ['low', 'medium', 'high', 'critical'] },
      skillFeedback: {
        type: 'array' as const,
        description: 'Only skills whose outcome is not neutral.',
        items: {
          type: 'object' as const,
          properties: {
            skillId: { type: 'string' as const },
            skillName: { type: 'string' as const },
            outcome: { type: 'string' as const, enum: ['helped', 'neutral', 'harmed'] },
            refinedInstruction: { type: 'string' as const },
            refinedDescription: { type: 'string' as const },
            newPitfallSkill: {
              type: 'object' as const,
              properties: {
                name: { type: 'string' as const },
                description: { type: 'string' as const },
                instruction: { type: 'string' as const },
                tags: { type: 'array' as const, items: { type: 'string' as const } },
              },
              required: ['name', 'description', 'instruction'],
            },
          },
          required: ['skillName', 'outcome'],
        },
      },
    },
    required: ['suggestion', 'confidenceScore', 'recurrenceScore', 'severity'],
  },
};

function errorFields(error: unknown): Record<string, unknown> {
  const err = error as Error | undefined;
  return {
    error_message: err?.message ?? String(error),
    error_name: err?.name,
    stack: err?.stack?.split('\n').slice(0, 4).join(' | '),
  };
}

// The prompt STATES the rewrite bar; reflection-engine/service.ts ENFORCES it.
// Both read this one constant so the sentence the model is given and the rule
// the code applies cannot drift apart.
import { MIN_OBSERVATIONS_FOR_DESCRIPTION_REWRITE } from '../reflection-engine/skill-rewrite-policy';

export interface InterpretedIntent {
  triggers: Array<{ type: string; config: Record<string, unknown> }>;
  objective: string;
  branches: Array<{ condition: string; action: string }>;
  tools: string[];
  connectors: string[];
  actionTypes: string[];
  writeScopes: string[];
  handoffs: Array<{ from: string; to: string; conditions: string[] }>;
  escalations: Array<{ condition: string; target: string; priority: string }>;
  approvals: Array<{ action: string; approvers: string[] }>;
  retries: Array<{ action: string; maxAttempts: number; backoff: string }>;
  conflictPolicies: string[];
  quotas: Array<{ resource: string; limit: number; period: string }>;
  undoHints: Array<{ action: string; undoAction: string }>;
}

export interface ReflectionAnalysis {
  suggestion: string;
  rule?: string;       // optional for backward compat
  why?: string;        // optional for backward compat
  appliesWhen?: string; // optional for backward compat
  evidenceRefs: string[];
  confidenceScore: number;
  recurrenceScore: number;
  severity: 'low' | 'medium' | 'high' | 'critical';
  /** What this suggestion expects to improve, and how to tell.
   *
   *  Required output rather than optional prose: nothing checks whether a
   *  refined skill or a promoted memory helped, and the reason is that nobody
   *  ever wrote down what "helped" would look like. An observed outcome with no
   *  stated expectation to compare against is not a measurement. */
  expectedOutcome?: string;
  skillFeedback?: Array<{
    skillId?: string;
    skillName: string;
    outcome: 'helped' | 'neutral' | 'harmed';
    refinedInstruction?: string;
    refinedDescription?: string;
    newPitfallSkill?: { name: string; description: string; instruction: string; tags?: string[] };
  }>;
}

export class VertexAIClient {
  // EVERY MODEL CALL HERE GOES THROUGH llmClient.
  //
  // Every method here resolves its model by TIER through llmClient, so the
  // spend reaches llm_usage_log and the Operating Unit accounting. Untracked
  // model spend is the one defect OU accounting cannot reconstruct after the
  // fact, so it is worth stating plainly: nothing in this class may call a
  // vendor SDK directly.

  async interpretInstructions(tenantId: string, input: unknown): Promise<InterpretedIntent> {
    // Routed through llmClient (see the note above the class), so the spend
    // lands in llm_usage_log and drains Operating Units like every other model
    // call. The tier decides the model; there is no hardcoded id to go stale.
    const useCase = 'instruction_compile';

    // Per Section 9: Claude Opus on Vertex AI interprets and normalizes intent
    const prompt = `You are helping compile user instructions into a structured policy format for an AI agent platform.

Input:
${JSON.stringify(input, null, 2)}

Analyze these instructions and extract the following fields. Return ONLY valid JSON with no explanation:

{
  "triggers": [{"type": "webhook|schedule|event|manual", "config": {...}}],
  "objective": "string describing the workflow goal",
  "branches": [{"condition": "if condition", "action": "then action"}],
  "tools": ["list of allowed tool names"],
  "connectors": ["list of external system connectors: salesforce, hubspot, slack, jira, etc."],
  "actionTypes": ["read", "write", "delete", "notify", etc.],
  "writeScopes": ["systems/resources the agent can modify"],
  "handoffs": [{"from": "agent1", "to": "agent2", "conditions": ["when to handoff"]}],
  "escalations": [{"condition": "when to escalate", "target": "human|manager|admin", "priority": "low|medium|high|critical"}],
  "approvals": [{"action": "action requiring approval", "approvers": ["role1", "role2"]}],
  "retries": [{"action": "action name", "maxAttempts": 3, "backoff": "exponential|linear|fixed"}],
  "conflictPolicies": ["compare-and-set", "fresh-read-before-write", "last-write-wins", "escalate-on-conflict", "merge"],
  "quotas": [{"resource": "resource name", "limit": 100, "period": "minute|hour|day"}],
  "undoHints": [{"action": "action name", "undoAction": "how to reverse it"}]
}`;

    try {
      const response = await llmClient.complete(
        {
          messages: [{ role: 'user', content: prompt }],
          maxTokens: 4096,
          tier: LEGACY_COMPILE_TIER,
        },
        undefined,
        { tenantId, purpose: useCase },
      );

      const content = { text: response.content };

      // Parse JSON from response, handling potential markdown code blocks
      let jsonText = content.text.trim();
      if (jsonText.startsWith('```json')) {
        jsonText = jsonText.slice(7);
      }
      if (jsonText.startsWith('```')) {
        jsonText = jsonText.slice(3);
      }
      if (jsonText.endsWith('```')) {
        jsonText = jsonText.slice(0, -3);
      }

      const parsed = JSON.parse(jsonText.trim());

      logger.info('Instruction interpretation completed', {
        triggersCount: parsed.triggers?.length || 0,
        connectorsCount: parsed.connectors?.length || 0,
      });

      return {
        triggers: parsed.triggers || [],
        objective: parsed.objective || '',
        branches: parsed.branches || [],
        tools: parsed.tools || [],
        connectors: parsed.connectors || [],
        actionTypes: parsed.actionTypes || [],
        writeScopes: parsed.writeScopes || [],
        handoffs: parsed.handoffs || [],
        escalations: parsed.escalations || [],
        approvals: parsed.approvals || [],
        retries: parsed.retries || [],
        conflictPolicies: parsed.conflictPolicies || [],
        quotas: parsed.quotas || [],
        undoHints: parsed.undoHints || [],
      };
    } catch (error) {
      logger.error('Failed to interpret instructions via Vertex AI', errorFields(error));
      throw error;
    }
  }

  async generateSummary(tenantId: string, compiled: unknown): Promise<string> {
    // Routed through llmClient (see the note above the class), so the spend
    // lands in llm_usage_log and drains Operating Units like every other model
    // call. The tier decides the model; there is no hardcoded id to go stale.
    const useCase = 'summary';

    // Per Section 10: Level 1 gives a plain-language summary
    const prompt = `Generate a clear, plain-language summary (2-3 sentences) of what this AI agent does based on its compiled configuration. Write for a non-technical user who needs to understand and approve the agent's behavior.

Agent configuration:
${JSON.stringify(compiled, null, 2)}

Return ONLY the summary text, no JSON or formatting.`;

    try {
      const response = await llmClient.complete(
        {
          messages: [{ role: 'user', content: prompt }],
          maxTokens: 512,
          tier: LEGACY_COMPILE_TIER,
        },
        undefined,
        { tenantId, purpose: useCase },
      );

      const content = { text: response.content };

      return content.text.trim();
    } catch (error) {
      logger.error('Failed to generate summary via Vertex AI', errorFields(error));
      throw error;
    }
  }

  async generateScenarios(tenantId: string, compiled: unknown): Promise<Array<{ title: string; description: string; steps: string[] }>> {
    // Routed through llmClient (see the note above the class), so the spend
    // lands in llm_usage_log and drains Operating Units like every other model
    // call. The tier decides the model; there is no hardcoded id to go stale.
    const useCase = 'summary';

    // Per Section 10: Level 4 shows concrete example scenarios
    const prompt = `Generate 3 concrete example scenarios showing how this AI agent would handle real situations. Each scenario should demonstrate a different capability of the agent.

Agent configuration:
${JSON.stringify(compiled, null, 2)}

Return ONLY valid JSON array:
[
  {
    "title": "Short scenario title",
    "description": "Brief description of the situation",
    "steps": ["Step 1: ...", "Step 2: ...", "Step 3: ..."]
  }
]`;

    try {
      const response = await llmClient.complete(
        {
          messages: [{ role: 'user', content: prompt }],
          maxTokens: 2048,
          tier: LEGACY_COMPILE_TIER,
        },
        undefined,
        { tenantId, purpose: useCase },
      );

      const content = { text: response.content };

      let jsonText = content.text.trim();
      if (jsonText.startsWith('```json')) {
        jsonText = jsonText.slice(7);
      }
      if (jsonText.startsWith('```')) {
        jsonText = jsonText.slice(3);
      }
      if (jsonText.endsWith('```')) {
        jsonText = jsonText.slice(0, -3);
      }

      return JSON.parse(jsonText.trim());
    } catch (error) {
      logger.error('Failed to generate scenarios via Vertex AI', errorFields(error));
      throw error;
    }
  }

  async runReflection(tenantId: string, agentId: string, context: unknown): Promise<ReflectionAnalysis> {
    // Route through llmClient (tier-based routing) so cost is tracked in
    // llm_usage_log with tenantId, agentId, and purpose = 'reflection'.
    // validateAndGetModel removed — model selection is handled by routing policy.
    // Ask for a TIER, not a pre-resolved model id.
    //
    // This resolved the id from the `anthropic-vertex` catalogue and then
    // called complete() with no provider, so the request went to whichever
    // provider is preferred — in practice direct `anthropic`, confirmed in
    // llm_usage_log — carrying a name looked up in a DIFFERENT provider's
    // table. It works only because both catalogues happen to list identical
    // names today; the moment Vertex takes a suffixed id the call breaks, and
    // the failure would read as an unknown model rather than a routing bug.
    //
    // Passing the tier lets whichever provider serves the request resolve its
    // own catalogue, which is what the tier abstraction is for.
    const REFLECTION_LLM_TIER = 'medium' as const;

    // Per Section 16: Reflection analysis using Claude
    const injectedSkillsContext = (context as { injectedSkills?: Array<{ id: string; name: string; description: string; instruction: string; usefulnessScore: number; observationCount?: number }> }).injectedSkills;

    const prompt = `Analyze this AI agent's execution history and suggest a specific improvement.

Context (workflow summaries, task outcomes, escalations, undos, human feedback, policy denials):
${JSON.stringify(context, null, 2)}

Based on patterns in the data:
1. Identify the most significant pattern of failure, inefficiency, or user correction
2. Suggest ONE specific, actionable improvement to the agent's instructions
3. Reference the evidence that supports this suggestion
4. Rate your confidence based on the strength and consistency of the evidence

Return ONLY valid JSON:
{
  "suggestion": "Specific, actionable suggestion for improving the agent's instructions",
  "rule": "The core behavioral rule in second person (e.g., 'Always verify the contact exists before updating')",
  "why": "Root cause — what pattern in the execution data led to this conclusion",
  "appliesWhen": "Specific conditions where this rule applies (e.g., 'When calling hubspot__update_contact')",
  "evidenceRefs": ["workflow_id:123 - failed due to X", "task_id:456 - user corrected Y"],
  "confidenceScore": 0.85,
  "recurrenceScore": 0.7,
  "severity": "low|medium|high|critical",
  "expectedOutcome": "What should measurably improve if this is applied, and how someone would check — e.g. 'hubspot__update_contact should stop failing with 404; check the failure count for that tool over the next 20 runs'",

  "skillFeedback": [{ "skillId": "optional", "skillName": "string", "outcome": "helped|neutral|harmed", "refinedInstruction": "optional full replacement", "refinedDescription": "optional narrowed scope ≤500 chars", "newPitfallSkill": { "name": "...", "description": "...", "instruction": "...", "tags": [] } }]
}

Field guidance:
- rule: One sentence, second person, imperative. This is what the agent will see.
- why: The evidence-backed reason. Reference specific patterns from the data.
- appliesWhen: Tool names, connector types, or task conditions. Be specific.
- suggestion: Longer explanation if needed. Falls back to this if rule is missing.

Scoring guide:
- confidenceScore: How certain are you this is a real issue? (0-1)
- recurrenceScore: How often does this issue occur? (0-1)
- severity: Impact on user outcomes (low=minor annoyance, critical=blocks core functionality)
- expectedOutcome: Name the observable that should change and how to check it. Not
  "the agent will do better" — something a person could look up afterwards and
  disagree with. A suggestion whose effect cannot be checked cannot be known to
  have helped, and one that changed nothing is exactly what we currently cannot see.

Never record any of the following. Each one becomes a permanent, self-imposed
constraint that outlives the situation that produced it, and the agent will
cite it against itself long after the problem is fixed:
- Environment-dependent failures: a missing binary, "command not found", an
  unconfigured credential, an expired token, a path that does not exist. These
  describe the state of the world on one day, not durable knowledge.
- Negative capability claims ("the browser tool does not work", "X is broken",
  "cannot use Y"). If a tool failed, the useful lesson is the working approach,
  never the blanket refusal.
- Failures that were never resolved. If several things were tried and none
  worked, that is not a procedure — do not write the dead ends up as one.
- One-off task narratives. A single request is not a class of work.
When the execution history contains a problem AND its fix, keep the fix and
drop the complaint. If the only thing to say is one of the above, return no
suggestion rather than an unhelpful one.${injectedSkillsContext?.length ? `

## Injected Skills Evaluation

The following skill modules were active during this task:
${injectedSkillsContext.map(s => `
### ${s.name} (id: ${s.id}, usefulness_score: ${s.usefulnessScore}, observation_count: ${s.observationCount ?? 0})
Description: ${s.description}
Instruction: ${s.instruction}`).join('\n')}

For each skill, emit it in "skillFeedback" only if outcome != neutral:
- outcome "harmed": skill caused incorrect or counterproductive behaviour
- outcome "helped": skill was actively useful
- refinedInstruction: only if the instruction text is substantively wrong (full replacement)
- refinedDescription: only if instruction is correct but skill fires in wrong contexts AND usefulness_score <= 0 AND observation_count >= ${MIN_OBSERVATIONS_FOR_DESCRIPTION_REWRITE} (persistent misfire, evidenced). Do NOT emit if usefulness_score > 0. Do NOT emit if observation_count < ${MIN_OBSERVATIONS_FOR_DESCRIPTION_REWRITE} — a low score from few runs is noise, and usefulness is only settled on autonomous runs, so a skill used mainly in chat accrues observations slowly and must not be rewritten on that silence.
- Do not emit both refinedInstruction and refinedDescription for the same skill.
- newPitfallSkill: only for clear recurring failure modes with no existing coverage.
- Omit neutral skills from skillFeedback entirely.` : ''}`;

    try {
      // Structured output, not prose-with-fences.
      //
      // This asked for JSON in the prompt, then hand-stripped ```json fences
      // and JSON.parse'd whatever came back. `responseSchema` makes the
      // provider emit the object through forced tool use, so `content` is
      // already valid JSON and there are no fences to strip or prose to
      // survive.
      //
      // maxTokens was 1024, for an object carrying a suggestion, a rule, the
      // reasoning, evidence refs, three scores and a skillFeedback array. The
      // first reflection that ever reached this call was cut off mid-string
      // and died in JSON.parse with `Unterminated string at position 3990` —
      // a truncation reported as a syntax error, which says nothing about the
      // cause. 8192 covers the full shape with room for several skills.
      const response = await llmClient.complete(
        {
          messages: [{ role: 'user', content: prompt }],
          maxTokens: REFLECTION_MAX_OUTPUT_TOKENS,
          tier: REFLECTION_LLM_TIER,
          responseSchema: REFLECTION_RESPONSE_SCHEMA,
        },
        undefined,
        { tenantId, agentId, purpose: 'reflection' },
      );

      // Fail closed and SAY SO, rather than letting a half-written object
      // reach JSON.parse. The distiller learned this the same way.
      if (response.stopReason === 'max_tokens') {
        throw new Error(
          `Reflection response truncated at max_tokens (cap=${REFLECTION_MAX_OUTPUT_TOKENS}). `
          + 'The analysis is incomplete; raise the cap or reduce the skill set in the prompt.',
        );
      }

      const parsed = JSON.parse(response.content.trim());

      logger.info('Reflection analysis completed', {
        severity: parsed.severity,
        confidence: parsed.confidenceScore,
      });

      return {
        suggestion: parsed.suggestion || '',
        rule: parsed.rule || undefined,
        why: parsed.why || undefined,
        appliesWhen: parsed.appliesWhen || undefined,
        evidenceRefs: parsed.evidenceRefs || [],
        confidenceScore: typeof parsed.confidenceScore === 'number' ? parsed.confidenceScore : 0.5,
        recurrenceScore: typeof parsed.recurrenceScore === 'number' ? parsed.recurrenceScore : 0.5,
        severity: ['low', 'medium', 'high', 'critical'].includes(parsed.severity) ? parsed.severity : 'medium',
        skillFeedback: Array.isArray(parsed.skillFeedback) ? parsed.skillFeedback : undefined,
      };
    } catch (error) {
      logger.error('Failed to run reflection via Vertex AI', errorFields(error));
      throw error;
    }
  }

  async generateComplexPlan(tenantId: string, objective: string, constraints: unknown): Promise<{ steps: Array<{ action: string; dependencies: string[]; estimatedDuration: string }> }> {
    // Routed through llmClient (see the note above the class), so the spend
    // lands in llm_usage_log and drains Operating Units like every other model
    // call. The tier decides the model; there is no hardcoded id to go stale.
    const useCase = 'planning';

    // Per Section 17: Use Claude for complex planning
    const prompt = `Create an execution plan for the following objective, considering the given constraints.

Objective: ${objective}

Constraints:
${JSON.stringify(constraints, null, 2)}

Return ONLY valid JSON:
{
  "steps": [
    {
      "action": "Description of the step",
      "dependencies": ["step_ids this depends on"],
      "estimatedDuration": "estimated time (e.g., '5 minutes', '1 hour')"
    }
  ]
}`;

    try {
      const response = await llmClient.complete(
        {
          messages: [{ role: 'user', content: prompt }],
          maxTokens: 2048,
          tier: LEGACY_COMPILE_TIER,
        },
        undefined,
        { tenantId, purpose: useCase },
      );

      const content = { text: response.content };

      let jsonText = content.text.trim();
      if (jsonText.startsWith('```json')) {
        jsonText = jsonText.slice(7);
      }
      if (jsonText.startsWith('```')) {
        jsonText = jsonText.slice(3);
      }
      if (jsonText.endsWith('```')) {
        jsonText = jsonText.slice(0, -3);
      }

      return JSON.parse(jsonText.trim());
    } catch (error) {
      logger.error('Failed to generate plan via Vertex AI', errorFields(error));
      throw error;
    }
  }

  async generateHumanFacingSummary(tenantId: string, data: unknown, audience: 'customer' | 'operator' | 'admin'): Promise<string> {
    // Routed through llmClient (see the note above the class), so the spend
    // lands in llm_usage_log and drains Operating Units like every other model
    // call. The tier decides the model; there is no hardcoded id to go stale.
    const useCase = 'summary';

    // Per Section 17: High-risk human-facing summaries
    const audienceContext = {
      customer: 'a non-technical end user who needs to understand what happened with their request',
      operator: 'a support team member who needs to troubleshoot issues',
      admin: 'a system administrator who needs full technical details',
    };

    const prompt = `Summarize the following data for ${audienceContext[audience]}.

Data:
${JSON.stringify(data, null, 2)}

Write a clear, appropriate summary for this audience. Be concise but complete.`;

    try {
      const response = await llmClient.complete(
        {
          messages: [{ role: 'user', content: prompt }],
          maxTokens: 1024,
          tier: LEGACY_COMPILE_TIER,
        },
        undefined,
        { tenantId, purpose: useCase },
      );

      const content = { text: response.content };

      return content.text.trim();
    } catch (error) {
      logger.error('Failed to generate human-facing summary via Vertex AI', errorFields(error));
      throw error;
    }
  }
}
