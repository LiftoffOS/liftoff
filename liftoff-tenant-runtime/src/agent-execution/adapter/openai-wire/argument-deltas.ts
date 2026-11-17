// Tool-argument deltas on the OpenAI wire, correlated to the call they belong to.
//
// The Agents SDK's TYPED stream union carries no argument delta — text deltas
// only — but it forwards every raw provider event through its generic `model`
// member, and both wire shapes this adapter serves stream arguments there:
//
//   Responses API (OpenAI, xAI)   `response.output_item.added` announces a
//                                 function call once, with its `call_id`, its
//                                 name and its `output_index`; the
//                                 `response.function_call_arguments.delta`
//                                 events that follow carry the index and a
//                                 fragment, and nothing else that names the
//                                 call.
//   Chat Completions (OpenRouter) each chunk's `choices[0].delta.tool_calls[]`
//                                 entry carries an `index`; the first for a
//                                 call carries its `id` and `function.name`,
//                                 the rest only `function.arguments` fragments.
//
// Either way the fragment names the call by INDEX, and the index was bound to
// a call id by an earlier event: the state this class holds. It is the same
// correlation the Claude adapter keeps between `content_block_start` and
// `input_json_delta`, for the same reason — a fragment that names no call
// cannot be emitted — and the event it produces is the same `tool_call_partial`,
// so a consumer reassembles the arguments identically whichever engine ran.
//
// A fragment for an index nothing announced is dropped rather than emitted
// nameless; `reset` at each response start clears the bindings, since indexes
// restart per response.

import type { InvocationEvent } from '../types';

type Announced = { callId: string; name: string };

/** The Responses API events this reads. Every other event type passes through untouched. */
interface ResponsesOutputItemAdded {
  type: 'response.output_item.added';
  output_index?: number;
  item?: { type?: string; id?: string; call_id?: string; name?: string; arguments?: string };
}
interface ResponsesArgumentsDelta {
  type: 'response.function_call_arguments.delta';
  output_index?: number;
  item_id?: string;
  delta?: string;
}
interface ResponsesOutputItemDone {
  type: 'response.output_item.done';
  output_index?: number;
}

/** The Chat Completions chunk shape this reads. */
interface ChatCompletionsChunk {
  choices?: Array<{
    delta?: {
      tool_calls?: Array<{ index?: number; id?: string; function?: { name?: string; arguments?: string } }>;
    };
  }>;
}

export class ArgumentDeltaCorrelator {
  /** Responses: output_index → the call announced at it. */
  private readonly responsesByIndex = new Map<number, Announced>();
  /** Responses: item id → the same, for a delta that carries the id and not the index. */
  private readonly responsesByItemId = new Map<string, Announced>();
  /** Chat Completions: tool_calls[].index → the call announced at it. */
  private readonly chatByIndex = new Map<number, Announced>();

  /** Indexes restart with every response. */
  reset(): void {
    this.responsesByIndex.clear();
    this.responsesByItemId.clear();
    this.chatByIndex.clear();
  }

  /** The `tool_call_partial` events one raw provider event yields: none for
   *  anything but an argument fragment of an announced call. */
  onRawEvent(event: unknown): InvocationEvent[] {
    if (!event || typeof event !== 'object') return [];
    const type = (event as { type?: unknown }).type;
    if (typeof type === 'string') return this.onResponsesEvent(event as { type: string });
    if (Array.isArray((event as ChatCompletionsChunk).choices)) return this.onChatChunk(event as ChatCompletionsChunk);
    return [];
  }

  private onResponsesEvent(event: { type: string }): InvocationEvent[] {
    if (event.type === 'response.output_item.added') {
      const e = event as ResponsesOutputItemAdded;
      if (e.item?.type !== 'function_call' || typeof e.output_index !== 'number') return [];
      const announced: Announced = { callId: e.item.call_id ?? e.item.id ?? '', name: e.item.name ?? '' };
      this.responsesByIndex.set(e.output_index, announced);
      if (e.item.id) this.responsesByItemId.set(e.item.id, announced);
      // A provider may announce the item with the first fragment already in it.
      return e.item.arguments ? [partial(announced, e.item.arguments)] : [];
    }
    if (event.type === 'response.function_call_arguments.delta') {
      const e = event as ResponsesArgumentsDelta;
      const announced = (typeof e.output_index === 'number' ? this.responsesByIndex.get(e.output_index) : undefined)
        ?? (e.item_id ? this.responsesByItemId.get(e.item_id) : undefined);
      if (!announced || typeof e.delta !== 'string' || e.delta.length === 0) return [];
      return [partial(announced, e.delta)];
    }
    if (event.type === 'response.output_item.done') {
      const e = event as ResponsesOutputItemDone;
      if (typeof e.output_index === 'number') {
        const announced = this.responsesByIndex.get(e.output_index);
        this.responsesByIndex.delete(e.output_index);
        for (const [id, a] of this.responsesByItemId) if (a === announced) this.responsesByItemId.delete(id);
      }
      return [];
    }
    return [];
  }

  private onChatChunk(chunk: ChatCompletionsChunk): InvocationEvent[] {
    const out: InvocationEvent[] = [];
    for (const tc of chunk.choices?.[0]?.delta?.tool_calls ?? []) {
      if (typeof tc.index !== 'number') continue;
      const known = this.chatByIndex.get(tc.index);
      // The first chunk for a call names it; later chunks carry only the index.
      const announced: Announced | undefined = tc.id || tc.function?.name
        ? { callId: tc.id ?? known?.callId ?? '', name: tc.function?.name ?? known?.name ?? '' }
        : known;
      if (!announced) continue;
      this.chatByIndex.set(tc.index, announced);
      const fragment = tc.function?.arguments;
      if (typeof fragment === 'string' && fragment.length > 0) out.push(partial(announced, fragment));
    }
    return out;
  }
}

function partial(announced: Announced, partialJson: string): InvocationEvent {
  return { type: 'tool_call_partial', callId: announced.callId, toolName: announced.name, partialJson };
}
