// A declared topic and the filter that lets it arrive are one fact.
//
// The failure this guards is silent by construction: the topic is declared, the
// webhook is delivered, the runtime's action filter discards it, and nothing
// reports a drop that was configured. The agent looks idle rather than
// misconfigured.

import {
  GITHUB_TOPIC_ACTIONS,
  RUNTIME_DEFAULT_ALLOWED_ACTIONS,
  applyDerivedGithubFilter,
  collectDeclaredTopics,
  deriveGithubAllowedActions,
  githubTopicsDroppedByFilter,
} from '../github-topic-actions';

describe('deriveGithubAllowedActions', () => {
  it('maps each PR topic to the action that makes it arrive', () => {
    expect(deriveGithubAllowedActions(['pr.updated'])).toContain('synchronize');
    expect(deriveGithubAllowedActions(['pr.merged'])).toContain('closed');
    // GitHub has no `merged` action — the runtime's requireMerged gate supplies
    // the other half, and `closed` alone would also admit a closed-unmerged PR.
  });

  it('NEVER derives narrower than the default it displaces', () => {
    // A derived filter replaces the runtime default. GitHub-bound event agents
    // commonly declare pr.opened alone while their responsibilities name reopen
    // and push handling, so a strict derivation would silently stop them
    // reviewing a reopened pull request.
    for (const topics of [['pr.opened'], ['pr.updated'], ['pr.merged'], ['pr.reopened']]) {
      const derived = deriveGithubAllowedActions(topics)!;
      for (const floor of RUNTIME_DEFAULT_ALLOWED_ACTIONS) expect(derived).toContain(floor);
    }
  });

  it('a declared review topic admits the whole review lifecycle', () => {
    // Delivery never depended on the declaration: resolveEventTopics resolves
    // entity-level, so a synchronize already matches an agent registered on
    // pr.opened. allowedActions was the only gate, so widening it is what makes
    // a review agent react to a push — without a prompt bump, a fleet cache
    // invalidation, or a fresh graph for every agent.
    for (const topic of ['pr.opened', 'pr.reopened', 'pr.ready_for_review', 'pr.updated']) {
      expect(deriveGithubAllowedActions([topic])!.sort())
        .toEqual(['opened', 'ready_for_review', 'reopened', 'synchronize']);
    }
  });

  it('a merge agent does NOT inherit the review lifecycle', () => {
    // Post-merge work is a different concern from reviewing, and a
    // merge-triggered agent has no business firing on a push.
    const merged = deriveGithubAllowedActions(['pr.merged'])!;
    expect(merged).toContain('closed');
    expect(merged).not.toContain('synchronize');
  });

  it('mirrors the tenant runtime default exactly', () => {
    // event-trigger.ts DEFAULT_GITHUB_ALLOWED_ACTIONS. Two repos, one value —
    // if that one changes, this fails and says so.
    expect([...RUNTIME_DEFAULT_ALLOWED_ACTIONS].sort())
      .toEqual(['opened', 'ready_for_review', 'reopened']);
  });

  it('unions the actions across every declared topic, stably ordered', () => {
    const a = deriveGithubAllowedActions(['pr.opened', 'pr.updated', 'pr.reopened']);
    const b = deriveGithubAllowedActions(['pr.reopened', 'pr.updated', 'pr.opened']);
    expect(a).toEqual(['opened', 'ready_for_review', 'reopened', 'synchronize']);
    // Stored config: an unstable order would show as a diff on every redistill.
    expect(a).toEqual(b);
  });

  it('says nothing when no declared topic is a GitHub PR topic', () => {
    // undefined leaves the runtime default in charge. An empty array would mean
    // "allow every action", which is a much wider statement.
    expect(deriveGithubAllowedActions(['issue.created', 'email.received'])).toBeUndefined();
    expect(deriveGithubAllowedActions([])).toBeUndefined();
  });

  it('covers every topic the catalog lists for a GitHub PullRequest row', () => {
    // The catalog advertises these six. A topic advertised but unmapped here
    // derives no action, so it would be declared and then dropped — the exact
    // defect, one topic down.
    for (const topic of ['pr.opened', 'pr.updated', 'pr.ready_for_review', 'pr.reopened', 'pr.merged', 'code.pushed']) {
      expect(GITHUB_TOPIC_ACTIONS[topic]).toBeDefined();
    }
  });
});

describe('collectDeclaredTopics', () => {
  it('reads the primary topic and the reactive subscriptions', () => {
    // An agent routinely names one primary topic and carries the rest on
    // subscriptions; deriving from the primary alone drops exactly the cases
    // the subscriptions exist to catch.
    expect(collectDeclaredTopics({
      type: 'event',
      eventTopic: 'pr.opened',
      reactiveSubscriptions: [
        { label: 'pushes', eventTopic: 'pr.updated' },
        { label: 'ready', topics: ['pr.ready_for_review', 'pr.reopened'] },
      ],
    }).sort()).toEqual(['pr.opened', 'pr.ready_for_review', 'pr.reopened', 'pr.updated']);
  });

  it('reads eventTopics — the declaration that carries no wiring with it', () => {
    // v41. The full set the agent handles, declared WITHOUT a subscription or a
    // schedule. Routing extra topics through reactiveSubscriptions was the
    // hazard: their connectorRef validation fails for these bindings and falls
    // back to companion crons, and a companion cron carries no event payload —
    // three failed fires auto-pause the agent and deregister the event trigger
    // that was working. Declaring more would have reinstated the polling.
    expect(collectDeclaredTopics({
      type: 'event',
      eventTopic: 'pr.opened',
      eventTopics: ['pr.opened', 'pr.updated', 'pr.ready_for_review', 'pr.reopened'],
    }).sort()).toEqual(['pr.opened', 'pr.ready_for_review', 'pr.reopened', 'pr.updated']);
  });

  it('is quiet on a cron config and on junk', () => {
    expect(collectDeclaredTopics({ type: 'cron', cronExpr: '*/5 * * * *' })).toEqual([]);
    expect(collectDeclaredTopics(undefined)).toEqual([]);
    expect(collectDeclaredTopics({ eventTopic: '   ' })).toEqual([]);
  });
});

describe('githubTopicsDroppedByFilter', () => {
  it('names the topic a filter cannot admit', () => {
    expect(githubTopicsDroppedByFilter(
      ['pr.opened', 'pr.updated'],
      ['opened', 'reopened', 'ready_for_review'],
    )).toEqual(['pr.updated']);
  });

  it('is quiet when the filter admits every declared topic', () => {
    expect(githubTopicsDroppedByFilter(['pr.opened', 'pr.updated'], ['opened', 'synchronize'])).toEqual([]);
  });

  it('treats an explicit empty array as allow-all', () => {
    expect(githubTopicsDroppedByFilter(['pr.updated'], [])).toEqual([]);
  });

  it('says nothing when there is no filter at all', () => {
    // No filter means the runtime default applies. That is the state the
    // derivation exists to replace, not a disagreement to report here.
    expect(githubTopicsDroppedByFilter(['pr.updated'], undefined)).toEqual([]);
  });

  it('ignores topics allowedActions does not govern', () => {
    expect(githubTopicsDroppedByFilter(['issue.created'], ['opened'])).toEqual([]);
  });
});

describe('applyDerivedGithubFilter', () => {
  it('writes the derived actions onto every bound GitHub integration', () => {
    const toolInput: Record<string, unknown> = {
      triggerConfig: { type: 'event', eventTopic: 'pr.updated' },
    };
    const out = applyDerivedGithubFilter(toolInput, ['gh-1']);

    expect(out.appliedTo).toEqual(['gh-1']);
    expect(toolInput.integrationConfigs).toEqual({
      'gh-1': { githubFilter: { allowedActions: ['opened', 'ready_for_review', 'reopened', 'synchronize'] } },
    });
  });

  it('preserves other config on the same integration', () => {
    const toolInput: Record<string, unknown> = {
      triggerConfig: { type: 'event', eventTopic: 'pr.opened' },
      integrationConfigs: { 'gh-1': { githubFilter: { repos: ['acme/web-app'] } } },
    };
    applyDerivedGithubFilter(toolInput, ['gh-1']);
    expect(toolInput.integrationConfigs).toEqual({
      'gh-1': { githubFilter: { repos: ['acme/web-app'], allowedActions: ['opened', 'ready_for_review', 'reopened', 'synchronize'] } },
    });
  });

  it('REFRESHES a stale derivation, which is what a cache hit carries', () => {
    // githubFilter is not in the produce_agent schema, so the model cannot
    // author one — an existing value is always a previous derivation. Skipping
    // it would freeze the mapping of the day a cached result was written, and
    // every later correction would ship green and reach nobody.
    const toolInput: Record<string, unknown> = {
      triggerConfig: { type: 'event', eventTopic: 'pr.updated' },
      integrationConfigs: { 'gh-1': { githubFilter: { repos: ['acme/web-app'], allowedActions: ['opened'] } } },
    };
    const out = applyDerivedGithubFilter(toolInput, ['gh-1']);
    expect(out.appliedTo).toEqual(['gh-1']);
    const f = (toolInput.integrationConfigs as Record<string, { githubFilter: Record<string, unknown> }>)['gh-1'].githubFilter;
    expect(f.allowedActions).toContain('synchronize');
    // Everything the derivation does not own is preserved.
    expect(f.repos).toEqual(['acme/web-app']);
  });

  it('reports nothing when the derivation is already current', () => {
    const current = ['opened', 'ready_for_review', 'reopened', 'synchronize'];
    const toolInput: Record<string, unknown> = {
      triggerConfig: { type: 'event', eventTopic: 'pr.opened' },
      integrationConfigs: { 'gh-1': { githubFilter: { allowedActions: current } } },
    };
    expect(applyDerivedGithubFilter(toolInput, ['gh-1']).appliedTo).toEqual([]);
  });

  it('does nothing for a cron agent or when no GitHub integration is bound', () => {
    const cronInput: Record<string, unknown> = { triggerConfig: { type: 'cron', cronExpr: '*/5 * * * *' } };
    expect(applyDerivedGithubFilter(cronInput, ['gh-1']).appliedTo).toEqual([]);
    expect(cronInput.integrationConfigs).toBeUndefined();

    const noGithub: Record<string, unknown> = { triggerConfig: { type: 'event', eventTopic: 'pr.opened' } };
    expect(applyDerivedGithubFilter(noGithub, []).appliedTo).toEqual([]);
    expect(noGithub.integrationConfigs).toBeUndefined();
  });

  it('closes the gap: pr.updated declared, synchronize admitted', () => {
    // eventTopic pr.opened with pr.updated on the subscriptions and no
    // githubFilter: the runtime default drops every synchronize while the
    // trigger reasoning claims they route through the same graph.
    const toolInput: Record<string, unknown> = {
      triggerConfig: {
        type: 'event',
        eventTopic: 'pr.opened',
        reactiveSubscriptions: [{ label: 'pushes to an open PR', eventTopic: 'pr.updated' }],
      },
    };
    applyDerivedGithubFilter(toolInput, ['gh-1']);
    const actions = (toolInput.integrationConfigs as Record<string, { githubFilter: { allowedActions: string[] } }>)['gh-1']
      .githubFilter.allowedActions;
    expect(actions).toContain('synchronize');
    expect(actions).toContain('opened');
    expect(githubTopicsDroppedByFilter(collectDeclaredTopics(toolInput.triggerConfig), actions)).toEqual([]);
  });
});
