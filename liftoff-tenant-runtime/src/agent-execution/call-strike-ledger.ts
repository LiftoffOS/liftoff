// Strike accounting for tool calls the model gets wrong in the same way twice.
//
// Two rules the anomaly handler relies on, and this module is where they hold:
//
// 1. A strike is a repeat of the SAME CALL. "A permanent error will not succeed
//    on retry" is a statement about one call with one set of arguments; two
//    different URLs both returning not_found are two facts about two pages, not
//    a tool that is broken. So the key is the tool name plus its canonical
//    arguments, never the tool name alone.
//
// 2. A model turn is one decision. When the model issues four calls in one
//    message and every one is rejected, it has made one mistake and has not
//    yet been told about it; counting four strikes there escalates a run
//    before the first correction is even delivered. So rejections accumulate
//    in an OPEN set and only become strikes when the batch that produced them
//    CLOSES — and a batch is identified by the model's own call ids, because
//    nothing else the runtime observes is ordered against the hooks that
//    report the rejections. A close names the ids it closes; a close that
//    arrives late can only merge two batches into one strike, never split one.
//
// 3. A code that does not change when the ARGUMENTS change is a fact about the
//    TOOL. Rule 1 is right about not_found — two missing pages are two facts —
//    and blind to the opposite case: twelve `web_finance_search` calls over six
//    different queries all returned the same code, no argument set repeated, so
//    no per-call key ever reached its cap and the run spent its whole clock
//    rediscovering that the connector was refusing. `distinctPermanentFailures`
//    counts DISTINCT calls per (tool, code) so that is reachable, and leaves
//    rule 1's accounting exactly as it is.
//
// Engines that cannot supply a call id (the HTTP MCP engines) run in per-call
// mode: every rejection folds immediately, which is the accounting the handler
// always had, on the narrower key.

import { canonicalJson } from './sideeffect-idempotency';

/** What a rejection counts toward. `recovery` entries are folded for batch
 *  bookkeeping only and never reach a cap; their strike count is not read. */
export type StrikeKind = 'malformed' | 'permanent' | 'recovery';

export interface RejectInput {
  key: string;
  /** The model's id for this call. Absent on engines that cannot supply one. */
  callId?: string;
  kind: StrikeKind;
  /** Carried through to the fold so a reason written there can name what
   *  failed (the error code); the ledger does not read it. */
  detail?: string;
}

export interface RejectOutcome {
  /** No entry for this key was open when the rejection arrived. The caller
   *  delivers its correction (or runs its recovery) exactly when this is true,
   *  so a batch of identical rejections produces one correction. */
  firstInBatch: boolean;
  /** The strike count after folding, or null while the batch is still open. */
  strikes: number | null;
}

export interface FoldedStrike {
  key: string;
  kind: StrikeKind;
  strikes: number;
  detail?: string;
}

interface OpenEntry {
  kind: StrikeKind;
  /** Ids of the calls that produced this entry. Empty when no engine id was
   *  available, in which case the entry folds on any close. */
  callIds: Set<string>;
  detail?: string;
}

/** One canonical key per (tool, arguments). Key order in the arguments does
 *  not change the call, so it does not change the key. */
export function callSignature(toolName: string | undefined, args: unknown): string {
  return `${toolName ?? 'unknown_tool'}|${canonicalJson(args ?? {})}`;
}

export class CallStrikeLedger {
  private readonly open = new Map<string, OpenEntry>();
  private readonly strikes = new Map<string, number>();
  /** (tool, code) -> the distinct call keys that failed permanently under it.
   *  A set, not a count: the question is how many DIFFERENT calls the tool
   *  refused, and a call that fails twice is already rule 1's business. */
  private readonly permanentByTool = new Map<string, Set<string>>();
  private readonly identified: boolean;

  /** `identified` — the engine names the calls it closes, so rejections wait
   *  for their batch. Otherwise every rejection is its own batch. */
  constructor(identified: boolean) {
    this.identified = identified;
  }

  reject(input: RejectInput): RejectOutcome {
    const existing = this.open.get(input.key);
    if (existing) {
      if (input.callId) existing.callIds.add(input.callId);
      return { firstInBatch: false, strikes: null };
    }
    this.open.set(input.key, {
      kind: input.kind,
      callIds: new Set(input.callId ? [input.callId] : []),
      detail: input.detail,
    });
    if (this.identified) return { firstInBatch: true, strikes: null };
    const [folded] = this.close(input.callId ? [input.callId] : []);
    return { firstInBatch: true, strikes: folded?.strikes ?? null };
  }

  /** Fold every open entry that one of `callIds` produced, plus any entry that
   *  carries no id at all. Returns the folded keys with their strike counts so
   *  the caller can apply its caps. Ids that match nothing fold nothing. */
  close(callIds: Iterable<string>): FoldedStrike[] {
    const closing = new Set(callIds);
    const folded: FoldedStrike[] = [];
    for (const [key, entry] of this.open) {
      const matches = entry.callIds.size === 0
        || [...entry.callIds].some((id) => closing.has(id));
      if (!matches) continue;
      this.open.delete(key);
      const strikes = (this.strikes.get(key) ?? 0) + 1;
      this.strikes.set(key, strikes);
      if (entry.kind === 'permanent') {
        const byTool = toolCodeKey(key, entry.detail);
        const seen = this.permanentByTool.get(byTool) ?? new Set<string>();
        seen.add(key);
        this.permanentByTool.set(byTool, seen);
      }
      folded.push({ key, kind: entry.kind, strikes, detail: entry.detail });
    }
    return folded;
  }

  /** How many DISTINCT calls of `toolName` have failed permanently with
   *  `code`. Counted only for folded strikes, so a batch still open has not
   *  been counted yet and the same call failing twice counts once. */
  distinctPermanentFailures(toolName: string | undefined, code: string | undefined): number {
    return this.permanentByTool.get(`${toolName ?? 'unknown_tool'}|${code ?? ''}`)?.size ?? 0;
  }

  /** Entries still waiting for their batch to close. Non-zero at the end of a
   *  run means a boundary never arrived. */
  get openCount(): number {
    return this.open.size;
  }
}

/** The (tool, code) a per-call key belongs to. The key's own shape is
 *  `tool|canonicalArgs` (see `callSignature`), so the tool is everything up to
 *  the first separator — arguments cannot introduce one, because they arrive
 *  already JSON-encoded. */
function toolCodeKey(callKey: string, detail: string | undefined): string {
  const tool = callKey.slice(0, callKey.indexOf('|') === -1 ? undefined : callKey.indexOf('|'));
  return `${tool}|${detail ?? ''}`;
}
