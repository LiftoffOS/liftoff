/**
 * Where a hire's work goes, decided once from what the person picked.
 *
 * A destination picker takes either answer and they mean opposite things: a
 * folder is a place to work in, a file is the deliverable itself. No authored
 * template sentence can carry both — the templates say "in {{pick:...}}",
 * written when a folder was the only possible answer — so the rule is stated
 * here, once, for whichever answer was given.
 *
 * WHY THIS IS ITS OWN MODULE. The rule has two readers and they run at
 * different times. `template-placeholders.ts` appends it to the prose an agent
 * STORES, at create time; `distill-service.ts` puts it in the distillation
 * prompt, BEFORE the graph is generated. It used to exist only in the first,
 * which is why a file destination reached no step: the distiller never saw the
 * distinction, authored a graph that resolved every document by title, and the
 * picked document was never written to. One copy, so the stored prose and the
 * graph cannot be told different things.
 */

/**
 * One thing the person named in their own workspace, keyed in `templatePicks` by
 * the template object id it answers.
 *
 * Declared HERE and aliased everywhere else (`TemplatePick` in distill-service
 * and in template-placeholders) because `kind` is the field this module reads and
 * three independent copies of a shape is three places for one of them to lose it
 * — which is the whole of the defect this module exists for: two zod schemas
 * omitted `kind`, so it was stripped and the rule resolved to nothing.
 */
export interface DestinationPick {
  /** The identifier the connector works in: a Slack channel id, a Drive folder
   *  id, a document id. This is what reaches a tool call. */
  id: string;
  /** What it is called where they picked it: "#eng-alerts", "Marketing". */
  title: string;
  /** Present only for a DESTINATION, which accepts either a folder or a file and
   *  means something different by each: a folder is a place to work in, a file is
   *  the deliverable itself. The sentence around the placeholder reads
   *  differently for the two, so the answer has to say which it was. */
  kind?: 'folder' | 'file';
}

/**
 * The destination among the picks, or null when none was named.
 *
 * `kind` is the whole test, and it is a narrow one by construction: the picker
 * stamps a kind ONLY on the answer to a `kind: 'destination'` object
 * (ObjectPicker's destination branch), so a read-only file pick and a channel
 * pick arrive without one and are never mistaken for the deliverable. A
 * destination with no title cannot be written into a sentence either, since
 * rendering one would read as "your work goes in ".
 *
 * KEYS ARE SORTED so the answer does not depend on object insertion order. No
 * catalog template declares two destination objects — `catalog-validates` holds
 * that, so the sort has nothing to arbitrate today — and a stable choice is what
 * keeps the rule, the prompt and the fence saying the same thing about the same
 * pick on the day one does.
 */
export function namedDestination(
  picks: Record<string, DestinationPick> | undefined,
): DestinationPick | null {
  const named = Object.entries(picks ?? {})
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([, p]) => p)
    .find((p) => (p.kind === 'file' || p.kind === 'folder') && p.title?.trim());
  return named ?? null;
}

/**
 * The rule itself, in the agent's own second person.
 *
 * A FOLDER answer means work inside it, and that instruction is safe: a
 * connector that let a person pick a folder can address folders.
 *
 * A FILE answer used to say the working files went in a NEW folder created
 * beside the document. That was unfollowable and it is gone. Google Docs
 * exposes nine actions and not one of them creates a folder or moves a file;
 * the same is true of Notion, Coda and every other document surface where a
 * page is the unit. An instruction a connector cannot perform is not a standard
 * the work is held to, it is a sentence the model works around, and what it
 * worked around to was leaving thirteen documents loose in a customer's Drive.
 *
 * So the deliverable is named and everything else is LINKED FROM IT. Findable
 * beats tidy: a person opens the document they chose and sees what else was
 * made, whatever folder it happens to sit in. The agent finds its own prior
 * work from the ledger block the runtime injects, not by knowing where it put
 * things (see prior-work.ts in the tenant runtime).
 *
 * Returns the empty string with no destination picked, so a caller can
 * concatenate it unconditionally.
 */
export function destinationRule(picks: Record<string, DestinationPick> | undefined): string {
  const named = namedDestination(picks);
  if (!named) return '';
  const where = `"${named.title}"${named.id ? ` (id ${named.id})` : ''}`;

  if (named.kind === 'folder') {
    return '\n\n## Where your work goes\n'
      + `Everything you produce goes in ${where}. Create the documents you need inside it and `
      + 'link them, rather than leaving anything in whatever folder happens to be default. '
      + 'That folder is the place the person expects to find this work.\n';
  }
  return '\n\n## Where your work goes\n'
    + `The document ${where} is your deliverable. UPDATE that document rather than creating a `
    + 'new one for it, every run, so the person always finds this work where they asked for it. '
    + 'Anything else you produce, such as working notes, snapshots or per-item write-ups, LINK from that '
    + 'document, under a heading that says what each one is. Do not try to file them into a '
    + 'folder: most document tools cannot create or move one, and the link is what makes them '
    + 'findable anyway. Do not paste their contents into the deliverable either.\n';
}
