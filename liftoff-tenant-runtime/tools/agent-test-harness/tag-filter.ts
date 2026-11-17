// `--tag` accepts a CSV list (e.g. `--tag=memory,web,delegation`): a scenario matches when it
// carries ANY of the requested tags. Extracted as a pure, side-effect-free helper so it is
// unit-testable (tr-runner.ts runs main() on import).
export function matchesTagFilter(scenarioTags: readonly string[], cliTag: string | undefined): boolean {
  if (!cliTag) return true; // no --tag filter → everything matches
  const wanted = cliTag.split(',').map((t) => t.trim()).filter(Boolean);
  if (wanted.length === 0) return true;
  return wanted.some((t) => scenarioTags.includes(t));
}
