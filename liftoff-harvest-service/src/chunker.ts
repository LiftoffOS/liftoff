export interface Chunk {
  text: string;
  chunkIndex: number;
}

export function chunkText(
  text: string,
  opts: { chunkSize?: number; overlap?: number; maxChunks?: number } = {}
): Chunk[] {
  const chunkSize = opts.chunkSize ?? 1600;   // ~400 tokens at 4 chars/token
  const overlap = opts.overlap ?? 400;         // ~100 tokens overlap
  const maxChunks = opts.maxChunks ?? 20;
  const minSize = 150;                         // discard trailing fragments below this

  if (text.length === 0) {
    return [];
  }

  if (text.length <= chunkSize) {
    return [{ text, chunkIndex: 0 }];
  }

  const chunks: Chunk[] = [];
  let start = 0;
  while (start < text.length && chunks.length < maxChunks) {
    const end = Math.min(start + chunkSize, text.length);
    const chunk = text.slice(start, end);
    if (chunk.length >= minSize || chunks.length === 0) {
      chunks.push({ text: chunk, chunkIndex: chunks.length });
    }
    start += chunkSize - overlap;
  }
  return chunks;
}
