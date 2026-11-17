// A declared step that acts somewhere OTHER than the trigger is still declared.
//
// Take a reviewer agent whose step s11 is `slack_resolve_channel_by_name` with
// the literal template `{"name": "code-reviewer"}`, and whose own description
// reads "Resolve the #code-reviewer Slack channel so the notification can be
// posted to the correct channel id." Without these fixes the card says:
//
//   Acting on outside content
//   Outside the approved workflow (step s11)
//
// Both halves wrong in different ways. The step IS the approved workflow, and
// the action is a channel LOOKUP — a read.
//
// Three defects meet there, and each of these tests holds one of them shut.

import { inDeclaredScope, stepArgumentsAreAuthored } from '../declared-scope';

const PR_TARGET = { source: 'github', repository: 'acme/webapp', number: 42 };

const s11 = {
  stepId: 's11',
  toolName: 'agent_slack__slack_resolve_channel_by_name',
  description: 'Resolve the #code-reviewer Slack channel so the notification can be posted.',
  argumentsAuthored: true,
};
const lookup = {
  name: 'agent_slack__slack_resolve_channel_by_name',
  input: { name: 'code-reviewer' },
};

describe('a declared notification step is in scope', () => {
  it('is in scope even though it names a Slack channel, not the pull request', () => {
    // The defect. `targetsTriggerEntity` answers "is this the thing that woke
    // me", which is right for replying on a PR and simply false for telling
    // Slack about it — so every fan-out step in every workflow read as a
    // deviation.
    expect(inDeclaredScope(lookup, s11, PR_TARGET)).toBe(true);
  });

  it('is NOT in scope when the arguments came from the run', () => {
    // A step interpolating run-derived text carries content written after
    // reading the untrusted diff, so it keeps its gate.
    expect(inDeclaredScope(lookup, { ...s11, argumentsAuthored: false }, PR_TARGET)).toBe(false);
  });

  it('still requires the step to be dispatching ITS tool', () => {
    expect(inDeclaredScope(
      { name: 'agent_slack__slack_send_message', input: { channel: 'C1', text: 'hi' } },
      s11, PR_TARGET,
    )).toBe(false);
  });

  it('still refuses when nothing declared the call', () => {
    // The conversational path, where the model chose the tool itself.
    expect(inDeclaredScope(lookup, undefined, PR_TARGET)).toBe(false);
  });

  it('keeps the trigger-entity leg working for review comments', () => {
    // The original case must not regress: a trigger-bound step acting on the PR
    // is in scope through the OTHER leg, with no authored flag at all.
    const comment = {
      name: 'github-dd4c4689__add_comment_to_pending_review',
      input: { owner: 'acme', repo: 'webapp', pullNumber: 42, body: 'nit' },
    };
    expect(inDeclaredScope(
      comment,
      { stepId: 's9', toolName: 'github-dd4c4689__add_comment_to_pending_review' },
      PR_TARGET,
    )).toBe(true);
  });
});

describe('what counts as authored', () => {
  it('a literal template is authored', () => {
    expect(stepArgumentsAreAuthored({ toolInputTemplate: '{"name": "code-reviewer"}' })).toBe(true);
  });

  it('any interpolation is not — including from another STEP', () => {
    // `{{steps.s5.summary}}` is content written after reading the untrusted
    // diff. Only `{{input.*}}` being untrusted would be too narrow a reading.
    expect(stepArgumentsAreAuthored({ toolInputTemplate: '{"text": "{{steps.s5.summary}}"}' })).toBe(false);
    expect(stepArgumentsAreAuthored({ toolInputTemplate: '{"text": "{{input.message.body}}"}' })).toBe(false);
  });

  it('checks the resolved input too, not just the template', () => {
    expect(stepArgumentsAreAuthored({ toolInput: { body: '{{input.title}}' } })).toBe(false);
    expect(stepArgumentsAreAuthored({ toolInput: { channel: 'code-reviewer' } })).toBe(true);
  });

  it('treats a step with no arguments at all as authored', () => {
    expect(stepArgumentsAreAuthored({})).toBe(true);
  });
});
