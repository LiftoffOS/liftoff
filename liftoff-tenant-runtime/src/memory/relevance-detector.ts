export interface ToolCallRecord {
  name: string;
  input: Record<string, unknown>;
}

export function detectUsedMemories(
  memories: Array<{ id: string; content: string; tags: string[] }>,
  toolCalls: ToolCallRecord[],
  outputText: string,
): string[] {
  const usedIds: string[] = [];
  const toolCallText = toolCalls
    .map(tc => `${tc.name} ${JSON.stringify(tc.input)}`)
    .join(' ')
    .toLowerCase();
  const outputLower = outputText.toLowerCase();

  for (const m of memories) {
    if (
      heuristicTagToolOverlap(m.tags, toolCallText) ||
      heuristicKeywordMatch(m.content, outputLower) ||
      heuristicTagInOutput(m.tags, outputLower)
    ) {
      usedIds.push(m.id);
    }
  }
  return [...new Set(usedIds)];
}

// H1: any tag (len > 2) appears as substring in any tool call name or serialized input
function heuristicTagToolOverlap(tags: string[], toolCallText: string): boolean {
  return tags.some(tag => tag.length > 2 && toolCallText.includes(tag.toLowerCase()));
}

// H2: >= 40% of significant words (> 4 chars) from memory content appear in output
function heuristicKeywordMatch(content: string, outputLower: string): boolean {
  const words = content.toLowerCase().match(/\b\w{5,}\b/g) ?? [];
  if (words.length === 0) return false;
  return words.filter(w => outputLower.includes(w)).length / words.length >= 0.40;
}

// H3: any tag (len > 2) appears verbatim in the output
function heuristicTagInOutput(tags: string[], outputLower: string): boolean {
  return tags.some(tag => tag.length > 2 && outputLower.includes(tag.toLowerCase()));
}
