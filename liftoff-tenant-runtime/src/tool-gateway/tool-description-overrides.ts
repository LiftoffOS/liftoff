// Per-tool description overrides, applied wherever a tool description is put in
// front of a model.
//
// The layer table's first row: a rule that governs one call belongs on that
// call. The model reads a tool's description at the moment it writes that
// tool's arguments, which is when the rule helps — and is exactly where a rule
// in the system prompt is not, having been read once, thousands of tokens ago,
// on a turn that may never touch the tool.
//
// THIS MODULE EXISTS BECAUSE THERE ARE THREE SUCH PLACES, NOT ONE. That is the
// whole reason it is not a private function next to the first one:
//
//   1. buildToolGatewayAndCatalog -> registerToolCatalog — the adapter catalog,
//      which most engines read.
//   2. createToolGatewayMcpServer — the tool-gateway MCP server. The Claude
//      Agent SDK engine mounts this DIRECTLY via `mcpServers`, so its tools
//      never come through the adapter catalog at all. That is the default
//      engine.
//   3. buildToolsForAgent — the sandbox's own MCP surface.
//
// A guarantee wired into one of the three is INV-TR-019's failure exactly:
// correct-looking in review, silently absent on whichever engine a tenant
// happens to be using. `tool-description-override-coverage.test.ts` enumerates
// the call sites so a fourth cannot be added without one.

/** The shape every path shares: something with a name and a description. */
export interface DescribedTool {
  name: string;
  description?: string;
}

/**
 * Append each override to the tool it names.
 *
 * APPENDED, never replacing. The vendor's own description says what the tool
 * DOES; the override says how this agent must use it. Replacing would trade a
 * tool's meaning for a rule about it, and a model that no longer knows what a
 * tool does cannot follow a rule about it correctly.
 *
 * An override naming a tool not in the catalog is dropped silently HERE and
 * loudly at distillation. That division is deliberate: the distiller knows the
 * name was invented and can say so, while by this point a missing tool is
 * ordinary — the agent's bindings changed since it was distilled.
 *
 * Returns the input array unchanged when there is nothing to apply, so a caller
 * on the hot path pays nothing for a feature it is not using.
 */
export function applyToolDescriptionOverrides<T extends DescribedTool>(
  tools: T[],
  overrides: Record<string, string> | undefined,
): T[] {
  const map = overrides ?? {};
  if (Object.keys(map).length === 0) return tools;
  return tools.map((t) => {
    const extra = map[t.name];
    if (!extra) return t;
    return { ...t, description: describeWith(t.description, extra) };
  });
}

/**
 * One tool's description with its override appended.
 *
 * Separate from the array form because two of the three paths build their
 * descriptions one tool at a time, inside a loop that already decorates them
 * (a destructive-tool warning, a draft-mode swap). Those cannot use the array
 * form without being restructured, and restructuring a dispatch path to suit a
 * helper is how the helper ends up applied in only two of them.
 */
export function describeWith(
  description: string | undefined,
  override: string | undefined,
): string {
  const base = (description ?? '').trim();
  const extra = (override ?? '').trim();
  if (!extra) return base;
  return base ? `${base}\n\n${extra}` : extra;
}
