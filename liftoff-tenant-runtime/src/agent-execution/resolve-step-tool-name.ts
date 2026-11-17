// Give a workflow step's toolName the reconnect resolution that bindings
// already have.
//
// THE ASYMMETRY THIS CLOSES. A connector tool is named `<alias>__<fn>`, and the
// alias is per-INSTANCE: `google-mail-0105297e`, not `google_mail`. That is
// deliberate and load-bearing — with two Gmail accounts connected, the alias is
// the only thing distinguishing one inbox's tools from the other's, and
// `buildBindingsByType` refuses to populate a type-keyed entry precisely so a
// lookup can never silently route to the wrong account.
//
// Reconnecting a connector mints a NEW alias and disables the old manifest —
// for example `google-sheets-2b820bc9` enabled beside `google-sheets-d14f7fd5`
// disabled. Bindings
// survive this — `resolveCurrentId` maps a stale id to the current one when the
// mapping is one-to-one. Workflow step toolNames get none of that: they are
// plain strings compared against catalog entries, so a step written before a
// reconnect names an alias that no longer exists, and `validateWorkflowGraph`
// fails the WHOLE RUN on it rather than the step.
//
// THE RULE, and it is deliberately the same rule bindings use: resolve when
// unambiguous, refuse when not. One surviving candidate of the same connector
// family and the same function is a reconnect and is remapped. Two or more is
// two accounts, and guessing which the author meant is how a run posts to the
// wrong Slack channel or reads the wrong inbox — so that stays unresolved and
// surfaces as an error somebody has to fix by hand.
//
// It needs no manifest query: the catalog entries already carry the current
// aliases, so the current world is derivable from what the caller has in hand.

/** Trailing instance discriminator on an alias — `google-mail-0105297e`. Eight
 *  hex characters, the same shape the alias minting uses elsewhere (an id
 *  prefix). Stripping it yields the connector family the alias belongs to. */
const INSTANCE_SUFFIX = /-[0-9a-f]{8}$/;

export type StepToolResolution =
  /** Already correct — the catalog has this exact name. */
  | { kind: 'exact'; toolName: string }
  /** The alias moved and exactly one candidate survives. */
  | { kind: 'remapped'; toolName: string; from: string }
  /** Several accounts of this connector family offer the same function. Which
   *  one the author meant is unknowable, so nothing is chosen. */
  | { kind: 'ambiguous'; candidates: string[] }
  /** Nothing in the catalog can serve this step. */
  | { kind: 'unknown' };

function splitToolName(toolName: string): { alias: string; fn: string } | null {
  const i = toolName.indexOf('__');
  if (i <= 0 || i + 2 >= toolName.length) return null;
  return { alias: toolName.slice(0, i), fn: toolName.slice(i + 2) };
}

export function resolveStepToolName(
  toolName: string,
  catalog: ReadonlySet<string>,
): StepToolResolution {
  if (catalog.has(toolName)) return { kind: 'exact', toolName };

  const parts = splitToolName(toolName);
  if (!parts) return { kind: 'unknown' };

  const family = parts.alias.replace(INSTANCE_SUFFIX, '');
  // No instance suffix means this was never an instance-scoped alias, so there
  // is no reconnect to undo and nothing to search for.
  if (family === parts.alias) return { kind: 'unknown' };

  const candidates: string[] = [];
  for (const name of catalog) {
    const candidate = splitToolName(name);
    if (!candidate || candidate.fn !== parts.fn) continue;
    if (candidate.alias.replace(INSTANCE_SUFFIX, '') !== family) continue;
    candidates.push(name);
  }

  if (candidates.length === 1) {
    return { kind: 'remapped', toolName: candidates[0], from: toolName };
  }
  if (candidates.length > 1) {
    return { kind: 'ambiguous', candidates: candidates.sort() };
  }
  return { kind: 'unknown' };
}
