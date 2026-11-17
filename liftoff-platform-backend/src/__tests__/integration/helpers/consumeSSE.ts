// Consumes a Server-Sent Events stream and returns the parsed events.
// Used by the agent-creation-pipeline integration test to verify chat-turn
// produces real messages rather than the NO_INSTRUCTION error event.

export interface SSEEvent {
  event?: string;
  data: unknown;
}

export async function consumeSSE(body: ReadableStream<Uint8Array>): Promise<SSEEvent[]> {
  const events: SSEEvent[] = [];
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let idx: number;
    while ((idx = buf.indexOf('\n\n')) >= 0) {
      const chunk = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      const lines = chunk.split('\n');
      let evtName: string | undefined;
      let evtData = '';
      for (const line of lines) {
        if (line.startsWith('event:')) evtName = line.slice(6).trim();
        else if (line.startsWith('data:')) evtData += line.slice(5).trim();
      }
      if (evtData) {
        try {
          events.push({ event: evtName, data: JSON.parse(evtData) });
        } catch {
          events.push({ event: evtName, data: evtData });
        }
      }
    }
  }
  return events;
}
