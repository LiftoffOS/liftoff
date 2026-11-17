// Capability discovery — the fit judge.
//
// ONE batched structured call over the whole candidate set. A judge rather
// than embedding cosine because the failure this stage exists to catch is
// semantic: "follower scraper" and "post scheduler" embed nearly identically
// and do opposite jobs. The judge scores ONLY from the provided metadata and
// must name the missing fields it penalises, which is what makes its verdicts
// reviewable during calibration.
//
// Degrade contract: any failure (call, parse, shape) returns neutral verdicts
// with degraded=true — candidates pass through un-judged rather than the
// whole discovery failing. The scorer treats neutral verdicts conservatively.

import { llmClient } from '../llm/client';
import { log } from '../infrastructure/logging';
import type { Candidate, CapabilitySpec, JudgeVerdict } from './types';

const JUDGE_SYSTEM_PROMPT = `You judge whether candidate tools fit a structured capability need. Score ONLY from the metadata provided — never assume undocumented behaviour.

For each candidate return:
- capabilityMatch: 0 (unrelated) to 3 (does exactly the needed operation on the needed entity for the needed system).
- inputSupplyable: can the caller supply this candidate's required inputs from availableInputs? "no" when a required input is clearly absent (name the missing field in reason).
- outputCovers: does the candidate's output plausibly carry requiredOutputFields? "no" when a required field clearly cannot be present (name it).
- shapeMatch: does the candidate's deliverable shape (list vs monitor vs enrichment vs generation) match the operation verb?
- reason: ONE sentence naming the decisive factor, including any missing field.

Return a verdict for EVERY candidate, in the same order, keyed by its index.`;

interface RawVerdict {
  index?: number;
  capabilityMatch?: number;
  inputSupplyable?: string;
  outputCovers?: string;
  shapeMatch?: boolean;
  reason?: string;
}

const NEUTRAL: JudgeVerdict = {
  capabilityMatch: 1,
  inputSupplyable: 'partial',
  outputCovers: 'partial',
  shapeMatch: true,
  reason: 'judge unavailable; neutral verdict',
};

function clampMatch(n: unknown): 0 | 1 | 2 | 3 {
  const v = typeof n === 'number' ? Math.round(n) : 1;
  return (v < 0 ? 0 : v > 3 ? 3 : v) as 0 | 1 | 2 | 3;
}

function tri(v: unknown): 'yes' | 'partial' | 'no' {
  return v === 'yes' || v === 'no' ? v : 'partial';
}

export interface JudgeOutcome {
  verdicts: JudgeVerdict[];
  degraded: boolean;
}

export async function judgeCandidates(
  spec: CapabilitySpec,
  candidates: Candidate[],
  opts: { tenantId?: string } = {},
): Promise<JudgeOutcome> {
  if (candidates.length === 0) return { verdicts: [], degraded: false };

  const specBlock = JSON.stringify({
    targetSystem: spec.targetSystem ?? null,
    operation: spec.operation,
    entity: spec.entity,
    mode: spec.mode,
    availableInputs: spec.availableInputs,
    requiredOutputFields: spec.requiredOutputFields,
  });
  const candidateBlock = candidates
    .map((c, i) =>
      JSON.stringify({
        index: i,
        title: c.title,
        description: c.description.slice(0, 500),
        inputSchema: c.inputSchema ?? null,
        outputSchema: c.outputSchema ?? null,
      }),
    )
    .join('\n');

  try {
    const response = await llmClient.complete(
      {
        messages: [
          { role: 'system', content: JUDGE_SYSTEM_PROMPT },
          {
            role: 'user',
            content: `CAPABILITY NEED:\n${specBlock}\n\nCANDIDATES (one JSON per line):\n${candidateBlock}`,
          },
        ],
        temperature: 0.1,
        responseSchema: {
          name: 'judge_candidates',
          schema: {
            type: 'object',
            properties: {
              verdicts: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    index: { type: 'number' },
                    capabilityMatch: { type: 'number' },
                    inputSupplyable: { type: 'string', enum: ['yes', 'partial', 'no'] },
                    outputCovers: { type: 'string', enum: ['yes', 'partial', 'no'] },
                    shapeMatch: { type: 'boolean' },
                    reason: { type: 'string' },
                  },
                  required: ['index', 'capabilityMatch', 'inputSupplyable', 'outputCovers', 'shapeMatch', 'reason'],
                },
              },
            },
            required: ['verdicts'],
          },
        },
      },
      undefined,
      { tenantId: opts.tenantId ?? spec.tenantId, purpose: 'capability_discovery_judge' },
    );

    const parsed = JSON.parse(response.content) as { verdicts?: RawVerdict[] };
    const byIndex = new Map<number, RawVerdict>();
    for (const v of parsed.verdicts ?? []) {
      if (typeof v.index === 'number') byIndex.set(v.index, v);
    }
    const verdicts = candidates.map((_, i) => {
      const raw = byIndex.get(i);
      if (!raw) return NEUTRAL;
      return {
        capabilityMatch: clampMatch(raw.capabilityMatch),
        inputSupplyable: tri(raw.inputSupplyable),
        outputCovers: tri(raw.outputCovers),
        shapeMatch: raw.shapeMatch !== false,
        reason: (raw.reason ?? '').slice(0, 300) || 'no reason given',
      };
    });
    const missing = candidates.length - byIndex.size;
    return { verdicts, degraded: missing > 0 };
  } catch (error) {
    log.warn({ error, candidateCount: candidates.length }, 'capability-discovery: judge failed; neutral verdicts');
    return { verdicts: candidates.map(() => NEUTRAL), degraded: true };
  }
}
