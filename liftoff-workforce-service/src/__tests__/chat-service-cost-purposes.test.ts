// PR 0.3 cost-attribution-purpose contract.
//
// The /insights LLM-usage view buckets workforce-planning costs by the
// `purpose` field on llm_usage_log rows. After the platform-agent migration,
// CAIO's main chat turn writes purpose='caio_workforce_planning' and the
// out-of-loop helpers keep their existing dedicated purposes:
//
//   - title generation       → caio_workforce_planning_title_generation
//   - summarization (future) → caio_workforce_planning_summarization
//
// Regression: if any of these strings drifts, getWorkforcePlanningCosts's
// IN-clause stops including the bucket and customer dashboards under-report.
// This test asserts the literals are present in chat-service.ts so an
// accidental rename surfaces at PR review time.

import { readFileSync } from 'fs';
import { join } from 'path';

const CHAT_SERVICE = readFileSync(
  join(__dirname, '..', 'workforce-plans', 'chat-service.ts'),
  'utf-8',
);

describe('PR 0.3 chat-service cost-attribution purposes', () => {
  it('main runPlatformAgent call uses usagePurpose="caio_workforce_planning"', () => {
    expect(CHAT_SERVICE).toMatch(/usagePurpose:\s*['"]caio_workforce_planning['"]/);
  });

  it('title generation preserves caio_workforce_planning_title_generation', () => {
    expect(CHAT_SERVICE).toContain('caio_workforce_planning_title_generation');
  });

  it('does NOT call any LLM with the generic "title_generation" or "summarization" buckets', () => {
    // Anything matching purpose: 'title_generation' or 'summarization' as a
    // bare bucket would land in the wrong /insights category.
    expect(CHAT_SERVICE).not.toMatch(/purpose:\s*['"]title_generation['"]/);
    expect(CHAT_SERVICE).not.toMatch(/purpose:\s*['"]summarization['"]/);
  });

  it('uses CAIO_AGENT_ID from the shared system-agent-ids module — no hardcoded literal', () => {
    expect(CHAT_SERVICE).toContain("from '../platform-agent/system-agent-ids.js'");
    // The bare UUID literal must not be re-introduced — the constant has to
    // come from the shared module.
    expect(CHAT_SERVICE).not.toMatch(/CAIO_AGENT_ID\s*=\s*['"]00000000-0000-0000-0000-000000000001['"]/);
  });
});
