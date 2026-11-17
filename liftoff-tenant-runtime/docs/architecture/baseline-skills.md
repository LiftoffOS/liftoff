# Baseline Skills — Always-On Prompt Injection

## Why this exists

Distilled skills live in `agent_skills` and are RAG-retrieved at execution time via `retrieveContextSkills(tenantId, agentId, objective, contextTags, topK=5)`. Two problems follow:

- An agent distilled with `skills: []` (e.g. Code Reviewer in some early runs) gets nothing.
- An agent with many role-specific skills can crowd out identity / escalation guidance — those skills lose the top-K rank race for that invocation.

The fix is not to teach the distill LLM to emit more skills, nor to backfill rows, but to prepend a small set of always-on baselines in code at prompt-build time. They live in the runtime, bypass RAG, and are guaranteed to appear in every system prompt.

## Module layout

- `src/skills/baseline-skills.ts` — exports `BASELINE_SKILLS: ReadonlyArray<BaselineSkill>` and the `BaselineSkill` interface (`name`, `description`, `instruction`, `tags`). Two baselines today: **Identity and scope** and **Communication and escalation**.
- `src/skills/retrieval.ts` — `buildSkillContextBlock` (markdown) and `buildSkillTextBlock` (Codex plain-text) both call the private `prependBaselines<T>` helper before rendering. The helper dedups by `name` (baseline wins on collision) and concatenates baselines first.

## Wiring

```
agent-execution/service.ts            interactive-chat/chat-turn-handler.ts
┌────────────────────────┐            ┌────────────────────────────────────┐
│ retrieveContextSkills  │            │ retrieveContextSkills              │
│   (returns Skill[])    │            │   (returns Skill[])                │
└──────────┬─────────────┘            └──────────┬─────────────────────────┘
           │                                     │
           ▼                                     ▼
  isCodex ? buildSkillTextBlock              buildSkillContextBlock
          : buildSkillContextBlock
           │                                     │
           ▼                                     ▼
  prompt += '\n\n' + skillBlock            systemPrompt += '\n\n' + skillBlock
```

Both call sites invoke the build function unconditionally — there is no `if (skills.length > 0)` short-circuit. An empty retrieval result still produces a block containing the two baselines.

## Dedup rule

```typescript
const baselineNames = new Set(BASELINE_SKILLS.map(s => s.name));
const deduped = retrievedSkills.filter(s => !baselineNames.has(s.name));
const allSkills = [...BASELINE_SKILLS, ...deduped];
```

If a pre-existing agent has a skill literally named "Identity and scope" (or any other baseline name), the retrieved row is dropped and the baseline wins.

## Properties

| Property | Value |
|---|---|
| Always surfaces at runtime | Yes — fixed prepend, bypasses RAG |
| Reflection-engine can mutate baselines | No — they aren't DB rows |
| Backfill required | None — applies on next invocation |
| Updating wording requires | One commit; no redistill |
| Render order | Baselines first, then retrieved skills |
| Format coverage | Both `buildSkillContextBlock` (markdown) and `buildSkillTextBlock` (Codex plain-text) |

## Adding or editing a baseline

1. Edit the `BASELINE_SKILLS` array in `src/skills/baseline-skills.ts`.
2. Extend the unit test in `src/skills/__tests__/baseline-skills.test.ts` if the count changes.
3. Commit and deploy. No DB migration, no agent backfill, no per-tenant rollout.

## Out of scope

- UI: baselines don't appear in `AgentWorkflowViz`.
- Reflection-engine carve-out — irrelevant since baselines never enter the DB.
- Any change to distill-service, the `produce_agent` schema, the event pipeline, or `agent_skills`.
