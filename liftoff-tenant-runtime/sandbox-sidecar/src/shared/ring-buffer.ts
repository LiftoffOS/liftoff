// Fixed-size ring buffer for byte streams.
// Used by PTY stdout history, browser network capture, bash output, event emitter.

export class RingBuffer<T> {
  private items: Array<{ ts: number; value: T }> = [];
  constructor(private readonly maxBytes: number) {}

  push(value: T): void {
    this.items.push({ ts: Date.now(), value });
    while (this.estimateBytes() > this.maxBytes && this.items.length > 0) {
      this.items.shift();
    }
  }

  /**
   * Drain items strictly newer than `since` (ms epoch).
   * Returns a copy; items remain in the buffer (use for poll-style readers).
   */
  read(since = 0): T[] {
    return this.items.filter(e => e.ts > since).map(e => e.value);
  }

  /** Number of items currently retained. */
  size(): number {
    return this.items.length;
  }

  clear(): void {
    this.items = [];
  }

  private estimateBytes(): number {
    let total = 0;
    for (const e of this.items) {
      if (typeof e.value === 'string') total += (e.value as string).length;
      else total += 100; // approximate object size
    }
    return total;
  }
}

/**
 * String-specific ring buffer used by PtySession.
 * Maintains a cumulative byte cursor so `view(offset)` returns the suffix after `offset`.
 */
export class ByteRingBuffer {
  private chunks: string[] = [];
  private cumulativeBytes = 0;
  private droppedBytes = 0;

  constructor(private readonly maxBytes: number) {}

  push(chunk: string): void {
    this.chunks.push(chunk);
    this.cumulativeBytes += chunk.length;
    while (this.currentSize() > this.maxBytes && this.chunks.length > 0) {
      const dropped = this.chunks.shift()!;
      this.droppedBytes += dropped.length;
    }
  }

  /** Total bytes ever written (monotonically increases). */
  get totalBytes(): number {
    return this.cumulativeBytes;
  }

  /** Returns content from byte offset `offset` onward (clamped to retained window). */
  read(offset = 0): string {
    const startInRetained = Math.max(0, offset - this.droppedBytes);
    const joined = this.chunks.join('');
    if (startInRetained >= joined.length) return '';
    return joined.slice(startInRetained);
  }

  private currentSize(): number {
    let total = 0;
    for (const c of this.chunks) total += c.length;
    return total;
  }
}
