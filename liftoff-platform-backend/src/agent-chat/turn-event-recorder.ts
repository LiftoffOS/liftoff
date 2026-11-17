// Records a turn's execution events so viewers other than the sender can watch
// it happen.
//
// Two things keep this from being expensive.
//
// It coalesces. Token deltas are not written individually — they accumulate in
// memory and flush as one chunk every FLUSH_INTERVAL_MS, so a two-minute turn
// costs a couple of writes a second instead of fifty. Discrete events (tool
// calls, status changes) flush with the text that preceded them, which keeps
// them correctly ordered relative to the output.
//
// It only records when somebody is watching. Presence already knows who is on
// the thread, so a turn with no audience — the overwhelming majority — writes
// nothing at all. The cost scales with actual collaboration rather than with
// traffic. The check is re-taken periodically so a viewer arriving mid-turn
// starts a recording, and cached in between so it does not add a query per
// flush.

import { log } from '../infrastructure/logging';
import { appendTurnEvents, pruneTurnEvents, type TurnEvent, type TurnEventKind } from './turn-events-repository';
import { countOtherViewers } from './presence-repository';
import { toolActivityLabel } from '../common/tool-activity-label';

const FLUSH_INTERVAL_MS = 400;
const AUDIENCE_RECHECK_MS = 5000;

export class TurnEventRecorder {
  private seq = 0;
  private pending: TurnEvent[] = [];
  private pendingText = '';
  // Seeded at construction, not zero: leaving it at zero made the very first
  // delta flush on its own, costing an extra write per turn to buy latency the
  // follower cannot use — it polls on its own interval regardless.
  private lastFlushAt = Date.now();
  private hasAudience = false;
  private audienceCheckedAt = 0;
  private failed = false;

  constructor(
    private readonly tenantId: string,
    private readonly threadId: string,
    private readonly turnId: string,
    /** The sender is excluded from the audience check — they have the SSE
     *  stream and do not need the written copy. */
    private readonly senderAccountId: string | null,
  ) {}

  /**
   * Tee one streamed event. Never throws: recording is an observability
   * nicety, and a turn must not fail because the audience copy did not land.
   */
  async record(event: { type: string; text?: string; tool?: string; [k: string]: unknown }): Promise<void> {
    if (this.failed) return;
    try {
      if (!(await this.audiencePresent())) return;

      if (event.type === 'text_delta' && typeof event.text === 'string') {
        this.pendingText += event.text;
      } else {
        const kind = mapKind(event.type);
        if (kind) {
          // Flush accumulated text first so a tool call cannot appear to
          // precede the sentence that introduced it.
          this.stageText();
          this.pending.push({ seq: ++this.seq, kind, payload: payloadFor(event) });
        }
      }

      if (Date.now() - this.lastFlushAt >= FLUSH_INTERVAL_MS) await this.flush();
    } catch (err) {
      this.fail(err);
    }
  }

  /** Flush whatever is left and mark the turn finished so followers stop. */
  async finish(): Promise<void> {
    if (this.failed) return;
    try {
      if (!this.hasAudience && this.seq === 0) return;
      this.stageText();
      this.pending.push({ seq: ++this.seq, kind: 'done', payload: null });
      await this.flush();
      // Opportunistic, on the one request per turn that is already finishing.
      await pruneTurnEvents(this.tenantId, this.threadId);
    } catch (err) {
      this.fail(err);
    }
  }

  private stageText(): void {
    if (!this.pendingText) return;
    this.pending.push({ seq: ++this.seq, kind: 'text', payload: { text: this.pendingText } });
    this.pendingText = '';
  }

  private async flush(): Promise<void> {
    this.stageText();
    if (this.pending.length === 0) return;
    const batch = this.pending;
    this.pending = [];
    this.lastFlushAt = Date.now();
    await appendTurnEvents(this.tenantId, this.threadId, this.turnId, batch);
  }

  private async audiencePresent(): Promise<boolean> {
    const now = Date.now();
    if (now - this.audienceCheckedAt < AUDIENCE_RECHECK_MS) return this.hasAudience;
    this.audienceCheckedAt = now;
    this.hasAudience =
      (await countOtherViewers(this.tenantId, this.threadId, this.senderAccountId)) > 0;
    return this.hasAudience;
  }

  private fail(err: unknown): void {
    this.failed = true;
    log.warn(
      { turnId: this.turnId, error: (err as Error).message },
      'turn event recording stopped; the turn itself is unaffected',
    );
  }
}

function mapKind(type: string): TurnEventKind | null {
  switch (type) {
    case 'thinking': return 'thinking';
    case 'tool_call': return 'tool_call';
    case 'tool_result': return 'tool_result';
    case 'awaiting_input': return 'awaiting_input';
    case 'hitl_required': return 'hitl_required';
    // Recorded so a second viewer sees the hand-over live — the chip and the
    // "Working with <name>" line — not only the persisted attribution after
    // the reply lands. payloadFor already forwards { author, authorLabel }.
    case 'delegation_started': return 'delegation_started';
    case 'error': return 'error';
    // 'complete' is deliberately not recorded: finish() writes 'done' after the
    // final flush, so followers never see the end before the last of the text.
    default: return null;
  }
}

function payloadFor(event: Record<string, unknown>): Record<string, unknown> | null {
  const { type: _type, ...rest } = event;
  // A follower reads this payload exactly as the sender's stream reads its SSE
  // frame, so the person-facing phrase is recorded beside the name for the same
  // reason it is sent: a name never reaches a person, on either path.
  if (_type === 'tool_call' && typeof rest['tool'] === 'string') {
    rest['label'] = toolActivityLabel(rest['tool']);
  }
  return Object.keys(rest).length > 0 ? (rest as Record<string, unknown>) : null;
}
