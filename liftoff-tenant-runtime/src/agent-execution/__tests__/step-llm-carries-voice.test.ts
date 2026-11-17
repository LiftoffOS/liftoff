// A workflow step writes text a customer reads, so it must carry the voice rules.
//
// `llm_reason` steps compose the reply body, the escalation summary and the
// acknowledgement; the very next `tool_call` step sends them. That is the path
// that most reliably reaches a real person, so its system prompt must carry
// the same shared block that interactive chat (interactive-chat/
// system-prompt.ts), the autonomous loop (buildSystemPrompt) and the recovery
// advisor (engine/recovery-prompts.ts) all push.
//
// Without it, the reply that goes to the customer can open
//
//   "Thanks for reaching out — I've received your message about ..."
//
// with an em dash, which the voice rules forbid outright. Covering the
// recovery advisor does not cover this: it is a different call site with the
// same need.

import { readFileSync } from 'fs';
import { join } from 'path';

const SRC = readFileSync(join(__dirname, '..', 'service.ts'), 'utf8');

const stepPrompt = SRC.slice(
  SRC.indexOf('const systemPrompt = [\n      `You are executing step'),
  SRC.indexOf("    ].join('\\n');", SRC.indexOf('const systemPrompt = [\n      `You are executing step')),
);

describe('the step prompt', () => {
  it('has a block to assert against', () => {
    expect(stepPrompt.length).toBeGreaterThan(400);
  });

  it('includes the shared voice block', () => {
    expect(stepPrompt).toContain('AGENT_VOICE_BLOCK');
  });

  it('uses the SAME shared constant every other surface uses', () => {
    // Not a local restatement. A copy drifts, and the copy that drifts is the
    // one nobody is reading when the rules change.
    expect(SRC).toMatch(/import \{ AGENT_VOICE_BLOCK \} from '\.\.\/interactive-chat\/agent-voice'/);
  });

  it('states why a workflow step is customer-facing', () => {
    expect(stepPrompt).toMatch(/customer reads/i);
    expect(stepPrompt).toMatch(/em dash/i);
  });

  it('still carries the step contract it already had', () => {
    // The voice block is an addition, not a replacement — these are what make
    // the step do its job at all.
    expect(stepPrompt).toContain('Step objective:');
    expect(stepPrompt).toContain('Request being served:');
    expect(stepPrompt).toContain("Prior step's output:");
    expect(stepPrompt).toContain('Workflow input:');
  });
});

describe('the voice block itself still forbids what was violated', () => {
  it('names the em dash', async () => {
    const { AGENT_VOICE_BLOCK } = await import('../../interactive-chat/agent-voice');
    expect(AGENT_VOICE_BLOCK.toLowerCase()).toMatch(/em dash|—/);
  });
});
