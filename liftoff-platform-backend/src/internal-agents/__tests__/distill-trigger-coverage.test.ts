// Trigger/workflow coherence — an agent must be able to act on every connector
// it wakes for.
//
// The defect this exists to prevent: ONE distillation emits reactive
// subscriptions for both `pr-updated-github` and `pr-updated-gitlab`, and
// twelve tool steps that are ALL `gitlab-1924102e__*`. Both connectors are
// bound and both manifests enabled, so GitHub's tools are in the catalog and
// simply go unused.
//
// Every per-step check passes, because each one looks at a single step: the
// GitLab tools genuinely exist. Nothing else compares the trigger to the
// workflow.
//
// The consequence is not a crash. The agent wakes on a GitHub pull request,
// finds none of the fields its GitLab steps template on, and reports a reasoned
// explanation for giving up — which reads like the agent working rather than
// like the workflow being wrong. That is what makes it worth a hard gate.

import { distillInternalAgent } from '../distill-service';

// The validator is not exported (the module's surface is the distill entry
// points), so it is exercised through its observable contract: a distillation
// whose trigger and workflow disagree must not be accepted as-is.
//
// These tests assert on the validator in isolation via the same shape the
// service builds, using the module's internal function through a re-import.
 
const svc = require('../distill-service') as any;
const validate = svc.__validateTriggerCapabilityCoverageForTest as (
  steps: unknown[],
  triggerConfig: unknown,
  integrations: unknown[],
  catalog?: unknown,
) => Array<{ type: string; stepId: string; detail: string }>;

// The real catalog rows for the two hosts, copied from
// connector-service/src/catalog/connectors.ts — they are byte-identical there,
// deliberately, "so one software-delivery-team subscription matches events from
// both hosts". That identity is the whole reason the primary topic is unsafe.
const PR_TOPICS = ['pr.opened', 'pr.updated', 'pr.ready_for_review', 'pr.reopened', 'pr.merged', 'code.pushed'];
const CATALOG = {
  connectors: [
    { type: 'github', polling: [{ entityType: 'PullRequest', eventTopics: PR_TOPICS, listImplemented: true }] },
    { type: 'gitlab', polling: [{ entityType: 'PullRequest', eventTopics: PR_TOPICS, listImplemented: true }] },
    { type: 'slack', polling: [{ entityType: 'Message', eventTopics: ['message.posted'], listImplemented: true }] },
  ],
};

const GITHUB = { id: '7d07a896-89f6-4f5c-8a26-1186c9fcf270', type: 'github', selectedObjects: [] };
const GITLAB = { id: '1924102e-e75f-4d82-a23b-e6cdcb7f4a7a', type: 'gitlab', selectedObjects: [] };

const sub = (label: string, connectorRef: string) => ({
  label,
  source: { kind: 'connector_event', entityType: 'PullRequest', connectorRef },
});

describe('validateTriggerCapabilityCoverage', () => {
  it('flags an agent that subscribes to github and acts only on gitlab', () => {
    const errors = validate(
      [
        { stepId: 's1', type: 'tool_call', toolName: 'gitlab-1924102e__get_merge_request', description: 'x' },
        { stepId: 's5', type: 'tool_call', toolName: 'gitlab-1924102e__get_merge_request_diffs', description: 'x' },
      ],
      { type: 'event', reactiveSubscriptions: [sub('pr-updated-gitlab', 'gitlab'), sub('pr-updated-github', 'github')] },
      [GITLAB, GITHUB],
    );

    expect(errors).toHaveLength(1);
    expect(errors[0].type).toBe('trigger_without_capability');
    expect(errors[0].stepId).toContain('pr-updated-github');
    // The feedback must name the provider AND what the steps can actually do,
    // or the model cannot tell which way to resolve it.
    expect(errors[0].detail).toContain('"github"');
    expect(errors[0].detail).toContain('gitlab');
  });

  it('passes once the workflow also acts on github', () => {
    const errors = validate(
      [
        { stepId: 's1', type: 'tool_call', toolName: 'gitlab-1924102e__get_merge_request', description: 'x' },
        { stepId: 's2', type: 'tool_call', toolName: 'github-7d07a896__get_pull_request', description: 'x' },
      ],
      { type: 'event', reactiveSubscriptions: [sub('pr-updated-gitlab', 'gitlab'), sub('pr-updated-github', 'github')] },
      [GITLAB, GITHUB],
    );
    expect(errors).toEqual([]);
  });

  it('exempts a pure-judgement workflow, which constrains no provider', () => {
    const errors = validate(
      [{ stepId: 's1', type: 'llm_reason', description: 'decide what to do' }],
      { type: 'event', reactiveSubscriptions: [sub('pr-updated-github', 'github')] },
      [GITHUB],
    );
    expect(errors).toEqual([]);
  });

  it('ignores sources that name no provider', () => {
    const errors = validate(
      [{ stepId: 's1', type: 'tool_call', toolName: 'gitlab-1924102e__get_merge_request', description: 'x' }],
      {
        type: 'event',
        reactiveSubscriptions: [
          { label: 'metric', source: { kind: 'computed_metric', connectorRef: 'github' } },
          { label: 'sys', source: { kind: 'system_event' } },
        ],
      },
      [GITLAB, GITHUB],
    );
    expect(errors).toEqual([]);
  });

  it('reports each missing provider once, not once per subscription', () => {
    const errors = validate(
      [{ stepId: 's1', type: 'tool_call', toolName: 'gitlab-1924102e__get_merge_request', description: 'x' }],
      {
        type: 'event',
        reactiveSubscriptions: [
          sub('pr-opened-github', 'github'),
          sub('pr-updated-github', 'github'),
          sub('pr-closed-github', 'github'),
        ],
      },
      [GITLAB, GITHUB],
    );
    expect(errors).toHaveLength(1);
  });

  it('resolves a connector type that contains an underscore', () => {
    // google_sheets aliases as `google-sheets-<id8>`, so reading the type back
    // out of the alias text would yield 'google-sheets' and never match. The
    // id prefix is what identifies the connector.
    const sheets = { id: '2b820bc9-e8b8-4f47-8a96-7702dada56e4', type: 'google_sheets', selectedObjects: [] };
    const errors = validate(
      [{ stepId: 's1', type: 'tool_call', toolName: 'google-sheets-2b820bc9__read_values', description: 'x' }],
      { type: 'event', reactiveSubscriptions: [sub('sheet-changed', 'google_sheets')] },
      [sheets],
    );
    expect(errors).toEqual([]);
  });

  it('reads the type from integrationId when a stored row uses that alias', () => {
    // A stored agent row carries `integrationId`, not `type` — the shape that
    // reaches a re-distill. Reading only `type` matches nothing and would make
    // every provider look unactionable.
    const stored = { id: '7d07a896-89f6-4f5c-8a26-1186c9fcf270', integrationId: 'github', selectedObjects: [] };
    const errors = validate(
      [{ stepId: 's1', type: 'tool_call', toolName: 'github-7d07a896__get_pull_request', description: 'x' }],
      { type: 'event', reactiveSubscriptions: [sub('pr-updated-github', 'github')] },
      [stored],
    );
    expect(errors).toEqual([]);
  });

  it('exempts a workflow whose only tool step binds no connector', () => {
    // A valid reviewer shape: llm_reason steps and one
    // `slack_resolve_channel_by_name`, against a `github` connector_event
    // subscription. It does its GitHub work by improvisation through the bound
    // connector at run time, which is legitimate.
    //
    // A rule that exempted only "no tool_call steps at all" would flag it.
    // That is not cosmetic: three retries later the caller DROPS the steps,
    // silently degrading a working workflow to a pure-LLM loop.
    const errors = validate(
      [
        { stepId: 's1', type: 'llm_reason', description: 'read the diff' },
        { stepId: 's8', type: 'llm_reason', description: 'decide severity' },
        { stepId: 's9', type: 'tool_call', toolName: 'slack_resolve_channel_by_name', description: 'find channel' },
      ],
      { type: 'event', reactiveSubscriptions: [sub('pr-updated-or-reopened', 'github')] },
      [GITHUB],
    );
    expect(errors).toEqual([]);
  });

  it('still flags a workflow that acts on ONE connector but wakes for another', () => {
    // The exemption above must not swallow the case the rule exists for.
    const errors = validate(
      [
        { stepId: 's1', type: 'tool_call', toolName: 'gitlab-1924102e__get_merge_request', description: 'x' },
        { stepId: 's9', type: 'tool_call', toolName: 'slack_resolve_channel_by_name', description: 'find channel' },
      ],
      { type: 'event', reactiveSubscriptions: [sub('pr-updated-github', 'github')] },
      [GITLAB, GITHUB],
    );
    expect(errors).toHaveLength(1);
    expect(errors[0].type).toBe('trigger_without_capability');
  });

  describe('the PRIMARY eventTopic, which names no host at all', () => {
    it('flags a GitHub topic over GitLab-only steps and subscriptions', () => {
      // eventTopic pr.opened, GitLab-only steps, and gitlab-only
      // subscriptions. The subscription check passes cleanly — gitlab is
      // subscribed and gitlab is actionable — so this agent looks correct
      // while still waking on GitHub pull requests and calling GitLab.
      const errors = validate(
        [
          { stepId: 's1', type: 'tool_call', toolName: 'gitlab-1924102e__get_merge_request', description: 'x' },
          { stepId: 's9', type: 'tool_call', toolName: 'slack_resolve_channel_by_name', description: 'x' },
        ],
        { type: 'event', eventTopic: 'pr.opened', reactiveSubscriptions: [sub('pr-updated-gitlab', 'gitlab')] },
        [GITLAB, GITHUB],
        CATALOG,
      );

      expect(errors).toHaveLength(1);
      expect(errors[0].type).toBe('trigger_without_capability');
      expect(errors[0].stepId).toContain('pr.opened');
      expect(errors[0].detail).toContain('github');
    });

    it('passes when the workflow acts on every host that publishes the topic', () => {
      const errors = validate(
        [
          { stepId: 's1', type: 'tool_call', toolName: 'gitlab-1924102e__get_merge_request', description: 'x' },
          { stepId: 's2', type: 'tool_call', toolName: 'github-7d07a896__get_pull_request', description: 'x' },
        ],
        { type: 'event', eventTopic: 'pr.opened' },
        [GITLAB, GITHUB],
        CATALOG,
      );
      expect(errors).toEqual([]);
    });

    it('ignores a host the agent is not bound to', () => {
      // bitbucket also publishes pr.opened, but an unbound connector can never
      // wake this agent, so holding the workflow to it would be noise.
      const errors = validate(
        [{ stepId: 's1', type: 'tool_call', toolName: 'github-7d07a896__get_pull_request', description: 'x' }],
        { type: 'event', eventTopic: 'pr.opened' },
        [GITHUB],
        {
          connectors: [
            ...CATALOG.connectors,
            { type: 'bitbucket', polling: [{ entityType: 'PullRequest', eventTopics: PR_TOPICS, listImplemented: true }] },
          ],
        },
      );
      expect(errors).toEqual([]);
    });

    it('does not flag a topic only one bound host publishes', () => {
      const errors = validate(
        [{ stepId: 's1', type: 'tool_call', toolName: 'slack-d77db9a0__send_message', description: 'x' }],
        { type: 'event', eventTopic: 'message.posted' },
        [{ id: 'd77db9a0-67ff-49c3-8843-7454972d263e', type: 'slack', selectedObjects: [] }],
        CATALOG,
      );
      expect(errors).toEqual([]);
    });

    it('is inert without a catalog rather than guessing who publishes a topic', () => {
      const errors = validate(
        [{ stepId: 's1', type: 'tool_call', toolName: 'gitlab-1924102e__get_merge_request', description: 'x' }],
        { type: 'event', eventTopic: 'pr.opened' },
        [GITLAB, GITHUB],
        undefined,
      );
      expect(errors).toEqual([]);
    });
  });

  it('is inert when there are no reactive subscriptions', () => {
    expect(validate([{ stepId: 's1', type: 'tool_call', toolName: 'x__y', description: 'x' }], { type: 'cron' }, [])).toEqual([]);
    expect(validate([], undefined, [])).toEqual([]);
  });
});

// Keep the import referenced so the module's real entry point is type-checked
// alongside the seam above.
void distillInternalAgent;
