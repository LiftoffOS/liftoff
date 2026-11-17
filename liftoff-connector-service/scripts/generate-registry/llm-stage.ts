// Registry generation — the LLM normalization stage.
//
// The ONLY model-touching stage of the generator, and strictly a REFINER:
// names, schemas, dispatch routes, and prices are all decided by the
// mechanical stages and are not the model's to change. What it improves is
// the part machines write badly — the one-line description an agent reads
// when choosing between tools — and it may ESCALATE (never relax) a
// function's categories when the description reveals a side effect the HTTP
// method hid.
//
// Runs only when --llm is passed AND ANTHROPIC_API_KEY is set; every failure
// falls back to the deterministic text for that chunk, so a flaky model run
// degrades polish, never correctness. Descriptions follow the product voice:
// no contractions, no em dashes, plain not marketing.

import type { GeneratedFunction } from './normalize';

const MODEL = 'claude-haiku-4-5-20251001';
const CHUNK_SIZE = 40;
const API_URL = 'https://api.anthropic.com/v1/messages';

const SYSTEM_PROMPT = `You polish machine-generated tool registry entries. For each entry, rewrite the description as ONE plain sentence (max 140 characters) that says what the tool returns or does, keeping any price annotation exactly as given. No contractions, no em dashes, no marketing language, never the word "agent". If a description reveals that the tool sends, posts, deletes, or otherwise changes something in an external system, add the matching escalation categories; NEVER remove a category. Return entries for every index you were given.`;

interface RefinedEntry {
  index?: number;
  description?: string;
  addCategories?: string[];
}

const ESCALATABLE = new Set(['write', 'destructive', 'outbound', 'sensitive']);

async function callModel(apiKey: string, payload: string): Promise<RefinedEntry[]> {
  const resp = await fetch(API_URL, {
    method: 'POST',
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 4000,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: payload }],
    }),
  });
  if (!resp.ok) throw new Error(`anthropic ${resp.status}`);
  const body = (await resp.json()) as { content?: Array<{ type: string; text?: string }> };
  const text = (body.content ?? []).map((c) => c.text ?? '').join('');
  const match = text.match(/\[[\s\S]*\]/);
  if (!match) throw new Error('no JSON array in model output');
  return JSON.parse(match[0]) as RefinedEntry[];
}

export async function refineWithModel(
  functions: GeneratedFunction[],
): Promise<{ refined: GeneratedFunction[]; refinedCount: number }> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey || !apiKey.trim()) {
    return { refined: functions, refinedCount: 0 };
  }

  const out = [...functions];
  let refinedCount = 0;
  for (let start = 0; start < out.length; start += CHUNK_SIZE) {
    const chunk = out.slice(start, start + CHUNK_SIZE);
    const payload =
      'Entries (JSON, one per line):\n' +
      chunk
        .map((f, i) =>
          JSON.stringify({
            index: i,
            name: f.name,
            description: f.description,
            categories: f.categories,
          }),
        )
        .join('\n') +
      '\n\nReturn a JSON array of {index, description, addCategories?}.';
    try {
      const refined = await callModel(apiKey, payload);
      for (const r of refined) {
        if (typeof r.index !== 'number' || !chunk[r.index]) continue;
        const target = out[start + r.index];
        if (r.description && r.description.trim()) {
          target.description = r.description.trim().slice(0, 300);
          refinedCount += 1;
        }
        for (const c of r.addCategories ?? []) {
          if (ESCALATABLE.has(c) && !target.categories.includes(c as GeneratedFunction['categories'][number])) {
            target.categories.push(c as GeneratedFunction['categories'][number]);
          }
        }
      }
    } catch (err) {
      // This chunk keeps its deterministic text; the run continues.
      console.warn(
        `llm-stage: chunk at ${start} failed (${(err as Error).message}); deterministic text kept`,
      );
    }
  }
  return { refined: out, refinedCount };
}
