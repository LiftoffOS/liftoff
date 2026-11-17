// Recover a hire's destination picks from the bindings that outlived them.
//
// `templatePicks` is an INPUT to distillation, not a stored field. It reaches
// create() from the connectors step, gets substituted into the prose, and is
// gone. A redistill therefore has no picks to resolve, so a template's raw
// `{{pick:...}}` falls through to the object's fallback phrase and an agent
// told to post to "#deal-room" starts saying "your deal channel".
//
// The picks are not actually lost. The connectors step writes the same answer
// into the binding's own config, under `destinations`, keyed by object id and
// carrying the id, the display name and whether it is a file or a folder.
// Rebuilding from there makes the prose track the CURRENT binding, which also
// closes the quieter half of this: a hire whose destination was changed after
// the fact keeps prose naming the document it used to point at, and nothing
// reconciles the two: an agent can name one Google Doc in its instructions
// and a different one in its binding.

/** A destination as the connectors step recorded it on the binding. */
interface StoredDestination {
  id?: string;
  name?: string;
  title?: string;
  kind?: string;
}

interface BindingWithConfig {
  config?: { destinations?: Record<string, StoredDestination> } | null;
}

export interface RecoveredPick {
  id: string;
  title: string;
  kind?: 'folder' | 'file';
}

/**
 * The picks a template's prose can be resolved against, read off the bindings.
 *
 * Only `file` and `folder` are carried through as `kind`: that field exists so
 * a destination sentence reads correctly for either answer, and anything else
 * is a channel or a table, where the distinction does not apply.
 */
export function templatePicksFromBindings(
  integrations: readonly unknown[] | undefined,
): Record<string, RecoveredPick> {
  const out: Record<string, RecoveredPick> = {};
  for (const raw of integrations ?? []) {
    const destinations = (raw as BindingWithConfig)?.config?.destinations;
    if (!destinations || typeof destinations !== 'object') continue;
    for (const [objectId, dest] of Object.entries(destinations)) {
      const title = (dest?.title ?? dest?.name ?? '').trim();
      const id = (dest?.id ?? '').trim();
      // A pick with no name cannot be rendered into a sentence, and rendering
      // an empty string would read as "post the summary to ".
      if (!title) continue;
      out[objectId] = {
        id,
        title,
        ...(dest?.kind === 'file' || dest?.kind === 'folder' ? { kind: dest.kind } : {}),
      };
    }
  }
  return out;
}
