// Part 6 §F — GCS writer + quality filter + index-row write.
//
// Quality filter: trajectories with no thinking / redacted_thinking blocks
// skip GCS write but still write an index row (for accounting). For OpenAI
// runs without reasoning_item (e.g. GPT-4 not o-series) this means
// trajectories are filtered out — by design; SFT training rarely benefits
// from non-reasoning OpenAI runs.

import { Storage } from '@google-cloud/storage';
import type { CanonicalTrajectory, CanonicalContentBlock } from './types';
import { insertTrajectoryIndex } from './repository';
import { redactSensitiveContent } from '../memory/content-sanitizer';
import {
  trajectory_sink_written_total,
  trajectory_sink_skipped_total,
  trajectory_sink_payload_bytes,
  trajectory_thinking_block_count,
} from '../observability/runtime-extensions-metrics';

interface SinkResult {
  written: boolean;
  skipped?: 'no_reasoning' | 'disabled' | 'too_large';
  bytesWritten?: number;
}

function redactBlock(b: CanonicalContentBlock): CanonicalContentBlock {
  switch (b.type) {
    case 'text':
      return { ...b, text: redactSensitiveContent(b.text) };
    // A refusal quotes back what it is refusing, so it can carry the user's
    // PII. This switch ends in `default: return b`, so without this case the
    // refusal block would be persisted to GCS UNREDACTED.
    case 'refusal':
      return { ...b, text: redactSensitiveContent(b.text) };
    case 'thinking':
      return { ...b, thinking: redactSensitiveContent(b.thinking) };
    case 'tool_use':
    case 'server_tool_use':
      return { ...b, input: redactValue(b.input) as Record<string, unknown> };
    case 'tool_result':
      return {
        ...b,
        content: typeof b.content === 'string' ? redactSensitiveContent(b.content) : b.content.map(redactBlock),
      };
    case 'web_search_tool_result':
    case 'web_fetch_tool_result':
      return { ...b, content: redactValue(b.content) };
    // redacted_thinking is provider-encrypted (opaque ciphertext) — leave as-is.
    default:
      return b;
  }
}

function redactValue(v: unknown): unknown {
  if (typeof v === 'string') return redactSensitiveContent(v);
  if (Array.isArray(v)) return v.map(redactValue);
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) out[k] = redactValue(val);
    return out;
  }
  return v;
}

/** Deep-redact credentials + PII from all trajectory content via the canonical
 *  content-sanitizer, preserving block structure/ids/meta. Applied before the
 *  GCS save so the durable copy is never raw. Exported for unit testing. */
export function redactTrajectoryContent(t: CanonicalTrajectory): CanonicalTrajectory {
  return {
    ...t,
    system: t.system.map((s) => ({ ...s, text: redactSensitiveContent(s.text) })),
    messages: t.messages.map((m) => ({ ...m, content: m.content.map(redactBlock) })),
  };
}

interface WriteOptions {
  /** Skip the no-reasoning quality filter. Set by nested code_session
   *  captures whose runners can't surface thinking blocks (Codex / Gemini
   *  CLI subprocess) but where the trajectory still has training value
   *  (text + tool_use sequence). */
  bypassQualityFilter?: boolean;
}

export class TrajectorySink {
  constructor(private bucketName: string, private storage: Storage) {}

  async write(trajectory: CanonicalTrajectory, options: WriteOptions = {}): Promise<SinkResult> {
    // Quality filter — see header note.
    const hasReasoning = trajectory.messages
      .filter((m) => m.role === 'assistant')
      .flatMap((m) => m.content)
      .some(
        (b) =>
          (b.type === 'thinking' && b.thinking.trim().length > 0) ||
          b.type === 'redacted_thinking',
      );
    const shouldWrite = hasReasoning || options.bypassQualityFilter === true;

    const path = `${trajectory.trajectory_meta.tenant_id}/${trajectory.trajectory_meta.agent_id}/${trajectory.trajectory_meta.invocation_id}.jsonl`;
    let bytesWritten = 0;

    if (shouldWrite) {
      // Redact credentials + PII at the persistence boundary — the GCS object
      // is the durable copy of the full run content, so nothing unredacted is
      // ever written. The index row below carries only metadata (no content).
      const payload = JSON.stringify(redactTrajectoryContent(trajectory)) + '\n';
      await this.storage.bucket(this.bucketName).file(path).save(payload, {
        contentType: 'application/jsonl',
        resumable: false,
      });
      bytesWritten = Buffer.byteLength(payload);
    }

    await insertTrajectoryIndex({
      tenantId: trajectory.trajectory_meta.tenant_id,
      agentId: trajectory.trajectory_meta.agent_id,
      invocationId: trajectory.trajectory_meta.invocation_id,
      ...(trajectory.trajectory_meta.parent_invocation_id
        ? { parentInvocationId: trajectory.trajectory_meta.parent_invocation_id }
        : {}),
      ...(trajectory.trajectory_meta.nested_kind
        ? { nestedKind: trajectory.trajectory_meta.nested_kind }
        : {}),
      gcsPath: shouldWrite ? `gs://${this.bucketName}/${path}` : null,
      bytes: bytesWritten,
      turnCount: trajectory.messages.length,
      completed: trajectory.trajectory_meta.completed,
      provider: trajectory.trajectory_meta.provider,
      model: trajectory.trajectory_meta.model,
      hasReasoning,
      schemaVersion: trajectory.schema_version,
      // The index row identifies provider, model, AND engine.
      executionEngine: trajectory.trajectory_meta.execution_engine ?? null,
      nestedEngine: trajectory.trajectory_meta.nested_engine ?? null,
    });

    // Part 7 §A — sink metrics. Provider label on written + payload size
    // histogram; reason label on skip.
    const provider = trajectory.trajectory_meta.provider;
    if (shouldWrite) {
      trajectory_sink_written_total.inc({ provider });
      trajectory_sink_payload_bytes.observe(bytesWritten, { provider });
      // Count thinking blocks for the regression-guard metric. Only present
      // for hasReasoning runs; the bypass path (nested code_session
      // text-only captures) skips this observation by design.
      if (hasReasoning) {
        const thinkingCount = trajectory.messages
          .filter(m => m.role === 'assistant')
          .flatMap(m => m.content)
          .filter(b => b.type === 'thinking' || b.type === 'redacted_thinking').length;
        if (thinkingCount > 0) trajectory_thinking_block_count.observe(thinkingCount, { provider });
      }
    } else {
      trajectory_sink_skipped_total.inc({ reason: 'no_reasoning', provider });
    }

    return shouldWrite ? { written: true, bytesWritten } : { written: false, skipped: 'no_reasoning' };
  }
}
