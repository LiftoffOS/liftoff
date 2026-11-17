/**
 * The blinded pairwise judge.
 *
 * Shared by the dev A/B harness and by the production shadow sweep, for the same
 * reason the structural metrics are shared: two judges asking slightly different
 * questions would produce two verdicts that disagree, and the disagreement would
 * look like a finding about the split rather than about the judging.
 *
 * BLINDING IS THE WHOLE POINT. Told which configuration came from the new
 * approach, a model will find reasons to prefer it — the same way a human
 * reviewer does. So the two artifacts are shuffled, the judge is told nothing
 * about where either came from, and the shuffle is recorded so the verdict can
 * be un-blinded afterwards. `shownShadowFirst` across a batch is the check on
 * the blinding itself: a lopsided split means the coin is broken and every
 * verdict in the batch is suspect.
 */
import { llmClient } from '../llm/client';
import { log } from '../infrastructure/logging';
import type { DistillOutput } from './distill-service';

/** One blinded verdict, with the shuffle recorded so it can be un-blinded. */
export interface JudgeVerdict {
  entryId: string;
  /** Whether the CHALLENGER (waved / shadow) was shown first. */
  firstWasWaved: boolean;
  /** The judge's pick, in its own blinded terms. */
  picked: 'A' | 'B' | 'tie';
  /** The same pick, un-blinded. */
  winner: 'single' | 'waved' | 'tie';
  reasoning: string;
}

/**
 * Ask a model which of two artifacts better serves the role, without telling it
 * where either came from.
 *
 * Judges the parts a person would actually feel: whether the steps match the
 * responsibilities, whether the skills add anything beyond the steps, and
 * whether the instructions are usable. Explicitly told that longer is not
 * better, because the split arm writes each field in its own call and a judge
 * left to its own devices rewards volume.
 */
export async function judgePair(
  entryId: string,
  role: string,
  responsibilities: string,
  single: DistillOutput,
  waved: DistillOutput,
  tenantId: string,
): Promise<JudgeVerdict | null> {
  // Coin flip, so position carries no information about arm.
  const firstWasWaved = Math.random() < 0.5;
  const a = firstWasWaved ? waved : single;
  const b = firstWasWaved ? single : waved;

  const render = (o: DistillOutput) => JSON.stringify({
    summary: o.summary,
    systemPrompt: o.systemPrompt,
    userInstructions: o.userInstructions,
    instructionsMd: o.instructionsMd,
    skills: o.skills,
    workflowSteps: o.workflowSteps ?? null,
    triggerConfig: o.triggerConfig,
  }, null, 2);

  try {
    const response = await llmClient.complete({
      messages: [
        {
          role: 'system' as const,
          content:
            'You are comparing two configurations generated for the same agent member. '
            + 'You are NOT told how either was produced, and there is no expected answer. '
            + 'Judge only on fitness for the role: do the workflow steps carry out the stated '
            + 'responsibilities, do the skills add anything the steps do not already say, are the '
            + 'instructions specific enough to act on, and is the trigger the right one. '
            + 'Length is not quality. A shorter configuration that covers the responsibilities is '
            + 'better than a longer one that repeats itself. Answer "tie" when neither is clearly better.',
        },
        {
          role: 'user' as const,
          content: `ROLE:\n${role}\n\nRESPONSIBILITIES:\n${responsibilities}\n\n`
            + `CONFIGURATION A:\n${render(a)}\n\nCONFIGURATION B:\n${render(b)}`,
        },
      ],
      tier: 'large',
      maxTokens: 2048,
      tools: [{
        name: 'record_verdict',
        description: 'Record which configuration better serves the role.',
        input_schema: {
          type: 'object',
          properties: {
            picked: { type: 'string', enum: ['A', 'B', 'tie'], description: 'Which configuration is better, or tie.' },
            reasoning: { type: 'string', description: 'Two sentences naming the concrete difference that decided it.', maxLength: 600 },
          },
          required: ['picked', 'reasoning'],
        },
      }],
      toolChoice: 'required',
    }, undefined, { tenantId, purpose: 'distill_ab_judge' });

    const call = response.toolCalls?.[0];
    if (!call) return null;
    const picked = call.input.picked as 'A' | 'B' | 'tie';
    const winner: 'single' | 'waved' | 'tie' = picked === 'tie'
      ? 'tie'
      : (picked === 'A') === firstWasWaved ? 'waved' : 'single';
    return {
      entryId,
      firstWasWaved,
      picked,
      winner,
      reasoning: String(call.input.reasoning ?? ''),
    };
  } catch (error) {
    // A judge failure is not an experiment failure. It removes one data point.
    log.warn({ entryId, error: (error as Error).message }, 'pairwise judge failed for this entry');
    return null;
  }
}

