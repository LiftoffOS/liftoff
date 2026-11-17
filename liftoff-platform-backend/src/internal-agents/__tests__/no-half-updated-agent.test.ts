// A save updates the agent or fails. It never half-updates one.
//
// `workflowSteps` is optional by design — the hybrid engine runs a prose-only
// agent, and a first distill that emits no graph is a valid outcome. So the
// model omitting it cannot be an error the way a missing `instructionsMd` is,
// and the guard cannot simply require it.
//
// It IS an error when the agent already has a graph. `service.update` treats
// `workflowSteps: undefined` as "leave unchanged", so omitting it does not drop
// the steps — it leaves them STALE against the freshly written instructionsMd.
// The agent then executes the old graph under the new instructions with nothing
// recording that the two disagree.
//
// For example: an agent's responsibilities are edited to post into a new channel
// and saved, which triggers a redistill. instructions_md comes back naming the
// new channel, but no workflowSteps come back, so the graph keeps a step that
// hardcodes the old channel and the agent keeps posting to the wrong place. The
// operator did exactly the right thing and no error is raised anywhere.
//
// The sibling guard for instructionsMd (fa65ae26) retries with feedback and
// then throws. This is the same treatment for the other half of the artifact.
import { rawWorkflowStepsPresent } from '../existing-graph';

describe('rawWorkflowStepsPresent', () => {
  it('accepts a real graph', () => {
    expect(rawWorkflowStepsPresent({ workflowSteps: [{ stepId: 's1' }] })).toBe(true);
  });

  it('rejects an omitted key', () => {
    expect(rawWorkflowStepsPresent({ instructionsMd: '# Agent' })).toBe(false);
  });

  it('rejects an empty array', () => {
    // The most likely way a model "answers" the retry feedback without doing
    // the work. service.update writes nothing for [] either, so it has to mean
    // the same thing here as an omission.
    expect(rawWorkflowStepsPresent({ workflowSteps: [] })).toBe(false);
  });

  it('rejects null and non-arrays', () => {
    expect(rawWorkflowStepsPresent({ workflowSteps: null })).toBe(false);
    expect(rawWorkflowStepsPresent({ workflowSteps: 'steps' })).toBe(false);
    expect(rawWorkflowStepsPresent({ workflowSteps: {} })).toBe(false);
  });

  it('survives a missing or non-object tool input', () => {
    expect(rawWorkflowStepsPresent(undefined)).toBe(false);
    expect(rawWorkflowStepsPresent(null)).toBe(false);
  });
});

describe('the drop-the-graph gate, as wired', () => {
  const src = require('fs').readFileSync(
    require('path').join(__dirname, '..', 'distill-service.ts'), 'utf8',
  ) as string;

  it('only fires when the agent already has steps', () => {
    // Without this clause a first distill of a prose-only agent would fail,
    // which the hybrid design explicitly allows.
    expect(src).toContain('existingStepCount > 0 && (!rawWorkflowStepsPresent(toolInput))');
  });

  it('retries with feedback before giving up, like the instructionsMd guard', () => {
    const gate = src.slice(src.indexOf('existingStepCount > 0 &&'), src.indexOf('existingStepCount > 0 &&') + 2400);
    expect(gate).toContain('attempt < MAX_RETRIES - 1');
    // The feedback string lives in a template literal, so its backticks are
    // escaped in the source. Match on the words, not the punctuation.
    expect(gate).toMatch(/omitted\s+\\?`?workflowSteps/);
    expect(gate).toContain('validationFeedback');
  });

  it('throws rather than persisting a half-update when retries are spent', () => {
    const gate = src.slice(src.indexOf('existingStepCount > 0 &&'));
    expect(gate.slice(0, 2200)).toContain('refusing to half-update agent');
  });

  it('tells the model that omitting does not preserve the old steps', () => {
    // The model's plausible assumption is that leaving the field out keeps what
    // is there. It is the opposite of harmless, so the feedback says so.
    const gate = src.slice(src.indexOf('existingStepCount > 0 &&'));
    expect(gate.slice(0, 1600)).toContain('does not keep the existing');
  });

  it('reads the step count once, before the attempt loop', () => {
    // Inside the loop it would be a per-attempt database round trip describing
    // something that cannot change during distillation.
    //
    // Anchored to the distillation entry point rather than to the file. There
    // is now more than one `for (let attempt...` retry loop in this module —
    // the waved strategy gives each branch its own — and a bare indexOf finds
    // whichever comes first in the file, not the one this test is about.
    const entry = src.indexOf('export async function distillInternalAgentWithProgress');
    expect(entry).toBeGreaterThan(-1);
    const outerLoop = src.indexOf('for (let attempt = 0; attempt < MAX_RETRIES', entry);
    expect(outerLoop).toBeGreaterThan(-1);
    expect(src.indexOf('let existingStepCount = 0')).toBeLessThan(outerLoop);
  });

  it('treats an unreadable count as 0 so a blip cannot fail a good save', () => {
    const hoist = src.slice(src.indexOf('let existingStepCount = 0'));
    expect(hoist.slice(0, 900)).toContain('the drop-the-graph gate is off for this distill');
  });
});
