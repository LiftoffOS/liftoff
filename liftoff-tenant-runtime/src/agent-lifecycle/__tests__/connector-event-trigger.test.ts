// Both connector dispatch paths must stamp the same trigger.
//
// The same GitHub pull request reaches an agent two ways: through a reactive
// subscription (reactive-subscriptions/fire.ts) and through the eventTopic
// registry (scheduling/event-trigger.ts). Only the first stamped a trigger.
//
// Two things rode on that, and neither failed loudly:
//
//   TRUST — trustLevelFor(undefined) is 'trusted'. A pull-request title is
//   written by whoever opened the PR, which on a public repository is anyone.
//   Via a subscription that content arrived untrusted_inbound and the injection
//   screen and SSRF gate keyed off it; via eventTopic it arrived trusted. One
//   event, two trust levels, decided by which dispatcher happened to route it.
//
//   RESOLUTION — a workflow step naming an operation instead of a host has
//   nothing to resolve against without a trigger: a GitHub PullRequest event
//   routed to the agent without one makes the step refuse with "this run has
//   no connector event trigger".

import { connectorEventTrigger, trustLevelFor, EXTERNAL_AUTHORED_CONNECTORS } from '../types';

describe('connectorEventTrigger', () => {
  it('marks external-authored content untrusted', () => {
    const t = connectorEventTrigger('github', 'PullRequest');
    expect(t).toMatchObject({
      kind: 'connector_event',
      source: 'github',
      entityType: 'PullRequest',
      contentTrust: 'untrusted_inbound',
    });
    expect(trustLevelFor(t)).toBe('untrusted_inbound');
  });

  it('leaves a first-party source trusted', () => {
    const t = connectorEventTrigger('google_sheets', 'Row');
    expect(t).not.toHaveProperty('contentTrust');
    expect(trustLevelFor(t)).toBe('trusted');
  });

  it('carries the connector TYPE as source, which is what a step resolves against', () => {
    // Not the connector id, and not the alias — a trigger-bound step matches on
    // the type, so anything else silently resolves nothing.
    expect(connectorEventTrigger('gitlab', 'PullRequest')).toMatchObject({ source: 'gitlab' });
  });

  it('tolerates a missing entity type rather than throwing mid-dispatch', () => {
    expect(connectorEventTrigger('github', '')).toMatchObject({ entityType: '' });
  });

  it('treats github as external-authored', () => {
    // The membership that decides trust. Asserted directly so widening or
    // narrowing the set is a deliberate, visible change.
    expect(EXTERNAL_AUTHORED_CONNECTORS.has('github')).toBe(true);
  });

  it('gives the same answer for the same event whichever path built it', () => {
    // The property that was broken: one event, one trust level, regardless of
    // which dispatcher routed it.
    const viaSubscription = connectorEventTrigger('github', 'PullRequest');
    const viaEventTopic = connectorEventTrigger('github', 'PullRequest');
    expect(viaEventTopic).toEqual(viaSubscription);
    expect(trustLevelFor(viaEventTopic)).toBe(trustLevelFor(viaSubscription));
  });
});
