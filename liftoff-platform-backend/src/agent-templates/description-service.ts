// One sentence describing a team whose template prose has been rewritten.
//
// The line under the role name on the explore detail step is the template's own
// `description`, written by whoever authored the catalog entry. The moment
// somebody rewrites a responsibility inline it stops being true of the team
// they are about to hire, and a stale one-liner is worse than none: it is the
// shortest thing on that screen and the most likely to be read as a summary of
// what was just changed.
//
// Deliberately NOT the distiller. That runs on the large tier against the
// whole connector catalog and produces two to three sentences capped at 1500
// characters, because it is writing the agent's own stored summary. This is one
// sentence off `small` for a line of UI that is never persisted — the
// authoritative `summary` is still the one distillation produces on Continue.

import { llmClient } from '../llm';
import { log } from '../infrastructure/logging';

/** Measured against the catalog this replaces, not guessed.
 *
 *  The first cut was 200, chosen by eye. Real catalog descriptions run to a
 *  median of 256 characters and a p90 of 411 across the 65 templates, so 47 of
 *  them are already longer than that cap — meaning almost every faithful
 *  rewrite was being clipped mid-sentence with an ellipsis, and the ellipsis
 *  was the first thing anybody noticed.
 *
 *  400 covers ~90% of what the catalog itself considers a description. It is a
 *  runaway guard, not a style: a rewrite hitting it is a generation that went
 *  wrong, not a long description. */
export const DESCRIPTION_MAX_CHARS = 400;

/** Bounds on what will be read at all. The prose fields are a few thousand
 *  characters each in the catalog; anything far past that is not a template
 *  someone edited, it is something else. */
const MAX_INPUT_CHARS = 24_000;

export interface DescribeTemplateInput {
  role: string;
  responsibilities: string;
  additionalContext: string;
}

const SYSTEM = [
  'You write the one-line description that sits under a team\'s name in a hiring UI.',
  '',
  'Rules:',
  '- One sentence. Aim for 200 to 280 characters, the length of the line it replaces.',
  '- Describe what this team does, in the words of the person who would hire them.',
  '- Lead with the work, not with the team. "Reads vendor invoices and..." not "This team reads...".',
  '- Never use the words "agent", "AI", "bot", "automated", or "template".',
  '- Never use an em dash.',
  '- Do not mention that anything was edited, customised or changed.',
  '- Reply with the sentence alone. No quotes, no preamble, no trailing full stop beyond the sentence\'s own.',
].join('\n');

/**
 * Writes the description for an edited template.
 *
 * Throws on an LLM failure rather than returning a fallback: the caller renders
 * NOTHING when this fails, on purpose. Substituting the catalog's own line
 * would put a description of the unedited team under a team that has been
 * edited, which is the exact thing this exists to prevent.
 */
export async function describeEditedTemplate(
  templateId: string,
  input: DescribeTemplateInput,
  tenantId: string,
): Promise<string> {
  const body = [
    `Role: ${input.role}`,
    '',
    'What they do:',
    input.responsibilities,
    '',
    'How they operate:',
    input.additionalContext,
  ].join('\n').slice(0, MAX_INPUT_CHARS);

  const response = await llmClient.complete({
    messages: [
      { role: 'system', content: SYSTEM },
      { role: 'user', content: body },
    ],
    // Small tier, and it is the whole point of this route existing separately
    // from the distiller. One short sentence off a few thousand tokens of
    // input: roughly a fifth of a cent, against a large-tier distillation that
    // costs orders of magnitude more and produces something else.
    tier: 'small',
    // Well clear of the character budget on purpose: ~280 characters is about
    // 70 tokens, so this never truncates the answer itself. Length is shaped by
    // the prompt and guarded by tidy(), not enforced by cutting the stream off
    // mid-word.
    maxTokens: 200,
    temperature: 0.3,
  }, undefined, {
    tenantId,
    purpose: 'template_description',
  });

  const text = (response.content ?? '').trim();
  if (!text) {
    log.warn({ templateId, tenantId }, 'template description came back empty');
    throw new Error('Description generation returned nothing');
  }

  return tidy(text);
}

/**
 * The model is asked for a bare sentence and usually gives one. This handles
 * the ways it does not, rather than trusting the prompt: wrapping quotes, a
 * leading label, em dashes, and length.
 *
 * Length is handled by cutting back to the last COMPLETE sentence that fits, so
 * what survives reads as something somebody wrote. The ellipsis path is the last
 * resort for a single sentence longer than the entire budget, and with the cap
 * measured against the catalog it should effectively never be taken.
 */
export function tidy(raw: string): string {
  let text = raw.trim().replace(/\s+/g, ' ');

  // Wrapping quotes, straight or curly.
  text = text.replace(/^["'“‘]+/, '').replace(/["'”’]+$/, '');
  // A label the instructions asked it not to write.
  text = text.replace(/^(description|summary)\s*:\s*/i, '');
  // Em dashes are out of house style everywhere in this product.
  text = text.replace(/\s*—\s*/g, ', ');

  if (text.length <= DESCRIPTION_MAX_CHARS) return text;

  // Cut back to the last COMPLETE sentence that fits, so what survives reads as
  // something somebody wrote rather than as something that got cut off. An
  // ellipsis is the visible symptom of a description that overran, and with the
  // cap now measured against the catalog it should essentially never appear.
  const clipped = text.slice(0, DESCRIPTION_MAX_CHARS);
  const lastStop = Math.max(
    clipped.lastIndexOf('. '),
    clipped.lastIndexOf('! '),
    clipped.lastIndexOf('? '),
  );
  if (lastStop > 80) return clipped.slice(0, lastStop + 1);

  // One sentence longer than the whole budget. Trim at a word so nothing is cut
  // mid-word, and mark it, because there is no honest way to end it cleanly.
  const words = clipped.slice(0, DESCRIPTION_MAX_CHARS - 1);
  const lastSpace = words.lastIndexOf(' ');
  return `${(lastSpace > 40 ? words.slice(0, lastSpace) : words).replace(/[,;:.]$/, '')}…`;
}
