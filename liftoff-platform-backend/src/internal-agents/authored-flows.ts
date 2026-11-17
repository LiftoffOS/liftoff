// Authored flows and tool notes, rendered as skills.
//
// A template's `flows` are skills the catalog already wrote. Handing them to
// the distiller as prose and asking for skills back would re-derive on every
// hire what is already written, and re-derive it DIFFERENTLY each time — which
// is the measured harm this exists to stop: ~90% of `agent_skill_metrics` rows
// are orphaned because a skill's identity does not survive a republish, so
// skill-level learning can never accumulate.
//
// So an authored flow's id becomes the skill's id, verbatim, and it survives
// every redistill. The distiller may still add novel skills — that is the
// product, and Custom Hire depends on it — but not ones that overlap an
// authored key, because two skills matching the same request compete inside one
// agent's top-K and retrieval starts choosing by tie-break.
//
// PROVENANCE: 'distilled', deliberately, not 'operator'. Per ADR-043 a
// redistill replaces the `distilled` slice and leaves `learned` and `operator`
// alone. An authored flow SHOULD be replaced by the next redistill of its
// template — that is how a catalog edit reaches hired agents. Marking it
// operator would freeze the template's own text against the template.

import type { AgentTemplate } from '../agent-templates/schema';
import type { Skill } from './types';

type Flow = NonNullable<AgentTemplate['flows']>[number];

/** The gloss line a flow opens with, when the template defines vocabulary.
 *
 *  Rendered at the top of each flow rather than once in a preamble: a skill is
 *  retrieved on its own, so a glossary the model saw thousands of tokens ago is
 *  a glossary it is not reading when it needs the term. */
function aliasLine(aliases: Record<string, string> | undefined, body: string): string {
  const used = Object.entries(aliases ?? {}).filter(
    ([term]) => new RegExp(`\\b${term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(body),
  );
  if (used.length === 0) return '';
  const glosses = used.map(([term, gloss]) => `'${term}' means ${gloss}`).join('; ');
  return `Below, ${glosses}.\n\n`;
}

/**
 * Render a template's authored flows as skills.
 *
 * The boundary is rendered INTO the instruction as well as being the retrieval
 * key, because the model reads the instruction and the retriever reads the key,
 * and an exclusion only one of them can see is an exclusion that holds half the
 * time.
 */
export function flowsAsSkills(template: AgentTemplate): Skill[] {
  return (template.flows ?? []).map((flow: Flow) => ({
    id: flow.id,
    name: flow.name,
    description: `Use when: ${flow.useWhen} Not needed for: ${flow.notNeededFor}`,
    instruction: `${aliasLine(template.domainAliases, flow.body)}${flow.body}\n\n`
      + `Not needed for: ${flow.notNeededFor}`,
    tags: ['flow', 'authored'],
    provenance: 'distilled' as const,
  }));
}

/**
 * Render a template's tool notes as per-tool description overrides.
 *
 * THIS IS THE REAL DESTINATION, and it is now reachable. A note about writing a
 * pull-request comment belongs on that tool, read at the moment its arguments
 * are written — not in a skill the model must first decide to retrieve, and not
 * in the system prompt, which is read on every turn including the ones that
 * never touch the tool. `toolNotesAsSkill` below was the interim while the
 * override machinery did not exist.
 *
 * The translation this does is the whole difficulty. Tool notes are keyed by
 * CAPABILITY, deliberately, so a rule about reviewing code survives a
 * GitHub-versus-GitLab rebinding. Overrides are keyed by TOOL NAME, because
 * that is what a catalog has. So the capability has to be resolved through
 * whatever is actually bound at this hire — which is why this takes the
 * integrations and the catalog rather than the template alone.
 *
 * A capability nothing satisfies yields no overrides, silently and correctly:
 * the note was about a tool this hire does not have, and there is nothing to
 * attach it to.
 */
export function toolNotesAsOverrides(
  template: AgentTemplate,
  integrations: ReadonlyArray<{ id?: string; integrationId?: string }>,
  catalog: ReadonlyMap<string, unknown>,
  connectorTypesForCapability: (capability: string) => string[],
): Record<string, string> {
  const notes = Object.entries(template.toolNotes ?? {});
  if (notes.length === 0 || catalog.size === 0) return {};

  const out: Record<string, string> = {};
  for (const [capability, text] of notes) {
    const types = new Set(connectorTypesForCapability(capability));
    if (types.size === 0) continue;
    // The bound connectors that provide this capability, as the ids the tool
    // names embed. Same `slice(0, 8)` convention the result-rule and
    // artifact-write fences use to tie a tool back to its binding.
    const prefixes = integrations
      .filter((i) => types.has(i.integrationId ?? ''))
      .map((i) => (i.id ?? '').slice(0, 8))
      .filter((p) => p.length > 0);
    if (prefixes.length === 0) continue;

    for (const toolName of catalog.keys()) {
      if (!prefixes.some((p) => toolName.includes(p))) continue;
      // Appended rather than overwritten: two capabilities can legitimately
      // resolve to one tool, and dropping the first note would make which one
      // survives depend on object key order.
      out[toolName] = out[toolName] ? `${out[toolName]}\n\n${text.trim()}` : text.trim();
    }
  }
  return out;
}

/**
 * Render a template's tool notes as one skill.
 *
 * THE INTERIM, retained only for a hire whose capability resolves to no bound
 * tool — where there is no tool name to hang an override on, but the material
 * is still worth the model having. Where overrides are possible they are
 * strictly better: read at the moment the arguments are written, with no
 * retrieval decision in front of them.
 *
 * One skill rather than one per capability, because they are all read at the
 * same moment — while a call is being written — and splitting them would make
 * retrieval pick between notes that do not compete.
 */
export function toolNotesAsSkill(template: AgentTemplate): Skill | null {
  const notes = Object.entries(template.toolNotes ?? {});
  if (notes.length === 0) return null;

  const body = notes
    .map(([capability, text]) => `### ${capability}\n\n${text.trim()}`)
    .join('\n\n');

  return {
    id: `${template.id}-tool-notes`,
    name: 'Tool-specific rules',
    description:
      'Use when: writing the arguments of a call to '
      + `${notes.map(([c]) => c).join(', ')}. `
      + 'Not needed for: deciding what to do — this is read while a call is being written, not before.',
    instruction: body,
    tags: ['tool-notes', 'authored'],
    provenance: 'distilled' as const,
  };
}

/**
 * Merge authored skills over generated ones.
 *
 * Authored wins on a key collision, and the generated one is DROPPED rather
 * than kept alongside: keeping both is what puts two skills answering the same
 * request into one agent's top-K, and one production agent already carries two
 * dedup skills that way.
 *
 * A collision is judged on the id and on the name, case-insensitively. The
 * distiller does not see the authored ids, so a generated skill that covers the
 * same ground usually announces itself by name rather than by id.
 */
export function mergeAuthoredSkills(generated: Skill[], authored: Skill[]): Skill[] {
  if (authored.length === 0) return generated;
  const claimed = new Set(
    authored.flatMap((s) => [s.id?.toLowerCase(), s.name.toLowerCase()])
      .filter((k): k is string => typeof k === 'string'),
  );
  const kept = generated.filter(
    (s) => !claimed.has((s.id ?? '').toLowerCase()) && !claimed.has(s.name.toLowerCase()),
  );
  return [...authored, ...kept];
}
