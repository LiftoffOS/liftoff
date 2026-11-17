// The canonical section structure for an agent's two authored prose fields.
//
// `responsibilities` and `additionalContext` are the free-text inputs the
// distiller reads. Both are markdown, and both use a fixed set of `## ` section
// headings so that a person reading an agent, the distiller reading it as
// input, and the template catalog all see the same shape.
//
// Shared rather than defined per service: the template validator, the catalog
// and any surface that composes these fields must agree on the section set, and
// two copies of a list like this drift.

/** Section headings, in order, for the `responsibilities` field. */
export const RESPONSIBILITIES_SECTIONS = [
  '## Responsibilities',
  '## Goals',
  '## Workflows',
  '## Instructions',
  '## Outcomes',
] as const;

/** Section headings, in order, for the `additionalContext` field. */
export const ADDITIONAL_CONTEXT_SECTIONS = [
  '## Specific instructions',
  '## Rules',
  '## Constraints',
  '## Edge cases',
  '## Anything to avoid',
  // Lane boundaries with the rest of the team: which findings are this role's
  // to raise and which belong to a teammate who may or may not be hired. Four
  // catalog templates wrote this section before it was vocabulary, which is
  // what makes it vocabulary rather than a one-off worth folding away.
  '## Working with teammates',
] as const;

export type ResponsibilitiesSection = (typeof RESPONSIBILITIES_SECTIONS)[number];
export type AdditionalContextSection = (typeof ADDITIONAL_CONTEXT_SECTIONS)[number];

/** The section body slots a composer fills, keyed by heading. */
export type ProseSections = Record<string, string | undefined>;

/**
 * Render `## Heading\n\n<body>` blocks in the canonical order, skipping any
 * section with no body.
 *
 * Composing from slots rather than asking a model to emit the markdown means a
 * malformed field is not possible: there is no format for a caller to get
 * wrong, and no heuristic repair pass that could mistake a paragraph beginning
 * with "Goals" for a heading.
 */
export function composeProseSections(
  order: readonly string[],
  sections: ProseSections,
): string {
  const blocks: string[] = [];
  for (const heading of order) {
    const body = sections[heading]?.trim();
    if (!body) continue;
    blocks.push(`${heading}\n\n${body}`);
  }
  return blocks.join('\n\n');
}
