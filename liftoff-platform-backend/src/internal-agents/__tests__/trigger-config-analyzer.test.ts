// Unit tests for the distill-time structural analyzer.
//
// Pure-function tests — they construct synthetic DistillOutput +
// ConnectorCatalogResponse + boundConnectorTypes triples and assert the
// produced violation list. No LLM client, no HTTP, no DB.

import type { ConnectorCatalogResponse, ConnectorDef } from '@liftoffos/connector-types';
import {
  analyzeTriggerConfig,
  asCatalogResponse,
  boundConnectorTypesFromIntegrations,
  buildBoundEntitySchemas,
  DistillationStructuralError,
  extractFilterPaths,
  formatViolationsForRetry,
  hasBlockingViolations,
} from '../trigger-config-analyzer';
import type { DistillOutput } from '../distill-service';

// ── Fixtures ────────────────────────────────────────────────────────────────

function fakeConnector(type: string, entitySchemas: Record<string, Record<string, unknown>>): ConnectorDef {
  return {
    type,
    displayName: type,
    category: 'crm' as ConnectorDef['category'],
    status: 'available' as ConnectorDef['status'],
    auth: { kind: 'none' } as ConnectorDef['auth'],
    entitySchemas,
  };
}

const hubspotCatalogConnector = fakeConnector('hubspot', {
  Deal: {
    type: 'object',
    properties: {
      id: { type: 'string' },
      amount: { type: 'number' },
      stage: { type: 'string' },
      closeDate: {
        type: 'string',
        description: 'Deal close date — anchor for "alert N days before close" patterns.',
      },
    },
  },
});

const baseCatalog: ConnectorCatalogResponse = asCatalogResponse([hubspotCatalogConnector]);
const boundHubspot = new Set(['hubspot']);

function fakeAgentOutput(partial: Partial<{
  triggerConfig: Record<string, unknown>;
  skills: Array<{ name: string; description: string; instruction: string }>;
  systemPrompt: string;
  userInstructions: string;
}> = {}): DistillOutput {
  return {
    agentType: 'agent',
    summary: 'fixture summary',
    systemPrompt: partial.systemPrompt ?? 'fixture prompt',
    userInstructions: partial.userInstructions ?? 'fixture instructions',
    instructionsMd: null,
    triggerConfig: (partial.triggerConfig ?? {
      type: 'cron',
      cronExpr: '0 9 * * *',
      reasoning: 'fixture',
    }) as DistillOutput['triggerConfig'],
    skills: partial.skills ?? [],
    capabilityTier: 'connector_only',
  };
}

// ── Helper assertions ───────────────────────────────────────────────────────

describe('buildBoundEntitySchemas', () => {
  it('only includes bound connector types', () => {
    const other = fakeConnector('salesforce', { Account: { type: 'object' } });
    const catalog = asCatalogResponse([hubspotCatalogConnector, other]);
    const out = buildBoundEntitySchemas(catalog, new Set(['hubspot']));
    expect(Object.keys(out)).toEqual(['hubspot']);
    expect(out.hubspot.Deal).toBeDefined();
  });

  it('returns empty object for an unbound catalog', () => {
    const out = buildBoundEntitySchemas(baseCatalog, new Set());
    expect(out).toEqual({});
  });
});

describe('extractFilterPaths', () => {
  it('extracts leaf paths from a typed predicate AST', () => {
    const filter = {
      op: 'and',
      operands: [
        { op: 'eq', path: 'stage', value: 'closed_won' },
        { op: 'not', operand: { op: 'lt', path: 'amount', value: 0 } },
      ],
    };
    expect(extractFilterPaths(filter).sort()).toEqual(['amount', 'stage']);
  });

  it('returns [] for missing filter', () => {
    expect(extractFilterPaths(undefined)).toEqual([]);
    expect(extractFilterPaths(null)).toEqual([]);
  });
});

// ── Rule 2 — reactive predicate against undeclared field (REJECT) ───────────

describe('analyzeTriggerConfig — reactive predicate against undeclared field', () => {
  it('rejects a filter whose path is not declared in any bound entity schema', () => {
    const out = fakeAgentOutput({
      triggerConfig: {
        type: 'event',
        eventTopic: 'connector_event.hubspot.deal.updated',
        reasoning: 'react to deal updates',
        reactiveSubscriptions: [
          {
            label: 'high-value-deal',
            source: { kind: 'connector_event', connectorRef: 'hubspot', entityType: 'Deal' },
            filter: { op: 'gt', path: 'data.deal.bogusField', value: 100 },
            objective: 'when deal.bogusField > 100, alert',
          },
        ],
      },
    });
    const violations = analyzeTriggerConfig(out, boundHubspot, baseCatalog);
    expect(violations.length).toBeGreaterThan(0);
    expect(violations[0].rule).toBe('reactive_predicate_undeclared_field');
    expect(violations[0].severity).toBe('reject');
    expect(hasBlockingViolations(violations)).toBe(true);
  });

  it('accepts a filter referencing a declared field', () => {
    const out = fakeAgentOutput({
      triggerConfig: {
        type: 'event',
        eventTopic: 'connector_event.hubspot.deal.updated',
        reasoning: 'react',
        reactiveSubscriptions: [
          {
            label: 'high-value-deal',
            source: { kind: 'connector_event', connectorRef: 'hubspot', entityType: 'Deal' },
            filter: { op: 'eq', path: 'stage', value: 'closed_won' },
            objective: 'celebrate closed deals',
          },
        ],
      },
    });
    const violations = analyzeTriggerConfig(out, boundHubspot, baseCatalog);
    expect(violations.filter(v => v.rule === 'reactive_predicate_undeclared_field')).toHaveLength(0);
  });

  it('accepts a filter referencing a nested-path leaf that matches a declared field', () => {
    const out = fakeAgentOutput({
      triggerConfig: {
        type: 'event',
        eventTopic: 'connector_event.hubspot.deal.updated',
        reasoning: 'react',
        reactiveSubscriptions: [
          {
            label: 'close-date-watch',
            source: { kind: 'connector_event', connectorRef: 'hubspot', entityType: 'Deal' },
            filter: { op: 'exists', path: 'record.data.closeDate' },
            objective: 'fire whenever the deal has a closeDate',
          },
        ],
      },
    });
    const violations = analyzeTriggerConfig(out, boundHubspot, baseCatalog);
    expect(violations.filter(v => v.rule === 'reactive_predicate_undeclared_field')).toHaveLength(0);
  });

  it('rejects when the predicate path matches a field declared on a DIFFERENT bound connector', () => {
    // Salesforce declares `Opportunity.systemModstamp`. A HubSpot Deal
    // subscription referencing `systemModstamp` must reject — Salesforce's
    // surface doesn't grant HubSpot a free field.
    const salesforce = fakeConnector('salesforce', {
      Opportunity: {
        type: 'object',
        properties: { id: { type: 'string' }, systemModstamp: { type: 'string' } },
      },
    });
    const catalog = asCatalogResponse([hubspotCatalogConnector, salesforce]);
    const out = fakeAgentOutput({
      triggerConfig: {
        type: 'event',
        eventTopic: 'connector_event.hubspot.deal.updated',
        reasoning: 'react',
        reactiveSubscriptions: [
          {
            label: 'cross-connector-leak',
            source: { kind: 'connector_event', connectorRef: 'hubspot', entityType: 'Deal' },
            filter: { op: 'exists', path: 'systemModstamp' },
            objective: 'systemModstamp lives on salesforce, not hubspot deal',
          },
        ],
      },
    });
    const violations = analyzeTriggerConfig(out, new Set(['hubspot', 'salesforce']), catalog);
    const r2 = violations.find(v => v.rule === 'reactive_predicate_undeclared_field');
    expect(r2).toBeDefined();
    expect((r2!.detail as { connectorRef?: string }).connectorRef).toBe('hubspot');
  });

  it('rejects every path when the bound connector publishes an empty schema map (no fail-open)', () => {
    // An empty entitySchemas map means the connector has nothing to subscribe
    // against — tool-only connectors fall here, and any reactive subscription
    // against them is structurally invalid. Strict enforcement.
    const gmailEmpty = fakeConnector('google_mail', {});
    const catalog = asCatalogResponse([gmailEmpty]);
    const out = fakeAgentOutput({
      triggerConfig: {
        type: 'event',
        eventTopic: 'connector_event.google_mail.email.received',
        reasoning: 'react',
        reactiveSubscriptions: [
          {
            label: 'inbox-watch',
            source: { kind: 'connector_event', connectorRef: 'google_mail', entityType: 'Email' },
            filter: { op: 'eq', path: 'subject', value: 'urgent' },
            objective: 'react to urgent mail',
          },
        ],
      },
    });
    const violations = analyzeTriggerConfig(out, new Set(['google_mail']), catalog);
    const r2 = violations.find(v => v.rule === 'reactive_predicate_undeclared_field');
    expect(r2).toBeDefined();
  });

  it('rejects a subscription against a connector not in the agent\'s bound set', () => {
    // The LLM cannot subscribe to a connector the agent isn't bound to —
    // no catalog entry for it means no event surface exists.
    const out = fakeAgentOutput({
      triggerConfig: {
        type: 'event',
        eventTopic: 'connector_event.unbound.entity.changed',
        reasoning: 'react',
        reactiveSubscriptions: [
          {
            label: 'unbound',
            source: { kind: 'connector_event', connectorRef: 'unbound_connector', entityType: 'Foo' },
            filter: { op: 'eq', path: 'whatever', value: 'x' },
            objective: 'reach for something we don\'t have',
          },
        ],
      },
    });
    const violations = analyzeTriggerConfig(out, boundHubspot, baseCatalog);
    const r2 = violations.find(v => v.rule === 'reactive_predicate_undeclared_field');
    expect(r2).toBeDefined();
    expect((r2!.detail as { connectorRef?: string }).connectorRef).toBe('unbound_connector');
  });

  it('skips system_event subscriptions (no connectorRef)', () => {
    const out = fakeAgentOutput({
      triggerConfig: {
        type: 'cron',
        cronExpr: '0 9 * * *',
        reasoning: 'react to system event',
        reactiveSubscriptions: [
          {
            label: 'sys',
            source: { kind: 'system_event', topic: 'tenant.config.changed' },
            filter: { op: 'eq', path: 'tenantId', value: 't-1' },
            objective: 'react to config changes',
          },
        ],
      },
    });
    const violations = analyzeTriggerConfig(out, boundHubspot, baseCatalog);
    expect(violations.filter(v => v.rule === 'reactive_predicate_undeclared_field')).toHaveLength(0);
  });

  it('skips computed_metric subscriptions (filter is over fn result, not entity fields)', () => {
    const out = fakeAgentOutput({
      triggerConfig: {
        type: 'cron',
        cronExpr: '0 9 * * *',
        reasoning: 'computed metric',
        reactiveSubscriptions: [
          {
            label: 'rate',
            source: {
              kind: 'computed_metric',
              connectorRef: 'hubspot',
              fn: 'bounceRate',
              pollIntervalSeconds: 300,
            },
            filter: { op: 'gt', path: 'rate', value: 0.05 },
            objective: 'pause campaigns when bounce > 5%',
          },
        ],
      },
    });
    const violations = analyzeTriggerConfig(out, boundHubspot, baseCatalog);
    expect(violations.filter(v => v.rule === 'reactive_predicate_undeclared_field')).toHaveLength(0);
  });
});


// ── Rule 4 — schedule_followup on declared anchor field (WARN) ──────────────

describe('analyzeTriggerConfig — schedule_followup on anchored field', () => {
  it('warns when a skill calls schedule_followup against a catalog-declared anchor field', () => {
    const out = fakeAgentOutput({
      skills: [
        {
          name: 'follow-up-near-close',
          description: 'Use when a deal is approaching close.',
          instruction: 'On match, schedule_followup({ context_ref: `deal_${id}_closeDate`, at: closeDate })',
        },
      ],
    });
    const violations = analyzeTriggerConfig(out, boundHubspot, baseCatalog);
    const r4 = violations.find(v => v.rule === 'schedule_followup_on_anchored_field');
    expect(r4).toBeDefined();
    expect(r4?.severity).toBe('warn');
    expect(hasBlockingViolations([r4!])).toBe(false);
  });

  it('does not flag schedule_followup against non-anchor fields', () => {
    const out = fakeAgentOutput({
      skills: [
        {
          name: 'gentle-followup',
          description: 'Use after sending a reply.',
          instruction: 'schedule_followup({ context_ref: `thread_${threadId}`, delay_seconds: 172800 })',
        },
      ],
    });
    const violations = analyzeTriggerConfig(out, boundHubspot, baseCatalog);
    expect(violations.filter(v => v.rule === 'schedule_followup_on_anchored_field')).toHaveLength(0);
  });
});

// ── Rule 1 — mixed primitives (WARN, freeform) ──────────────────────────────

describe('analyzeTriggerConfig — case (c) mixed primitives', () => {
  it('warns when a companionCron objective + schedule_followup target the same entity-deadline', () => {
    const out = fakeAgentOutput({
      triggerConfig: {
        type: 'cron',
        cronExpr: '0 9 * * *',
        reasoning: 'sweep deals daily and follow up',
        companionCrons: [
          {
            label: 'deals-sweep',
            cronExpr: '0 9 * * *',
            objective: 'Sweep deals nearing close: act on any deal in N days before due window',
          },
        ],
      },
      skills: [
        {
          name: 'followup',
          description: 'Use when deal is near close.',
          instruction: 'schedule_followup({ context_ref: `deal_${id}_close` })',
        },
      ],
    });
    const violations = analyzeTriggerConfig(out, boundHubspot, baseCatalog);
    expect(violations.find(v => v.rule === 'case_c_mixed_primitives')).toBeDefined();
  });

  it('does not flag when only a companion cron is present', () => {
    const out = fakeAgentOutput({
      triggerConfig: {
        type: 'cron',
        cronExpr: '0 9 * * *',
        reasoning: 'sweep deals daily',
        companionCrons: [
          { label: 'deals-sweep', cronExpr: '0 9 * * *', objective: 'Sweep deals near close N days before due' },
        ],
      },
    });
    const violations = analyzeTriggerConfig(out, boundHubspot, baseCatalog);
    expect(violations.find(v => v.rule === 'case_c_mixed_primitives')).toBeUndefined();
  });
});

// ── Rule 3 — companion objective references undeclared field (WARN) ─────────

describe('analyzeTriggerConfig — companion ghost fields', () => {
  it('warns on a token-shaped identifier in companion objective that is undeclared', () => {
    const out = fakeAgentOutput({
      triggerConfig: {
        type: 'cron',
        cronExpr: '0 9 * * *',
        reasoning: 'ghost field',
        companionCrons: [
          {
            label: 'sweep',
            cronExpr: '0 9 * * *',
            // mixes a declared field (closeDate) with a ghost token (custom_field_bogus)
            objective: 'For each deal where closeDate is within 7 days and custom_field_bogus is true, escalate.',
          },
        ],
      },
    });
    const violations = analyzeTriggerConfig(out, boundHubspot, baseCatalog);
    expect(violations.find(v => v.rule === 'companion_predicate_undeclared_field')).toBeDefined();
  });
});

// ── DistillationStructuralError ─────────────────────────────────────────────

describe('DistillationStructuralError', () => {
  it('preserves the violation list on the thrown error', () => {
    const violations = [
      {
        rule: 'reactive_predicate_undeclared_field' as const,
        severity: 'reject' as const,
        message: 'sample',
      },
    ];
    const err = new DistillationStructuralError(violations);
    expect(err.violations).toBe(violations);
    expect(err.message).toContain('sample');
  });
});

// ── boundConnectorTypesFromIntegrations / asCatalogResponse smoke ───────────

describe('helpers', () => {
  it('boundConnectorTypesFromIntegrations dedupes integration list to type set', () => {
    const out = boundConnectorTypesFromIntegrations([
      { type: 'hubspot' },
      { type: 'hubspot' },
      { type: 'google_calendar' },
    ]);
    expect(out.has('hubspot')).toBe(true);
    expect(out.has('google_calendar')).toBe(true);
    expect(out.size).toBe(2);
  });

  it('formatViolationsForRetry includes every rule and message', () => {
    const text = formatViolationsForRetry([
      { rule: 'reactive_predicate_undeclared_field', severity: 'reject', message: 'A' },
      { rule: 'case_c_mixed_primitives', severity: 'warn', message: 'B' },
    ]);
    expect(text).toContain('reactive_predicate_undeclared_field');
    expect(text).toContain('A');
    expect(text).toContain('case_c_mixed_primitives');
    expect(text).toContain('B');
  });
});

describe('analyzeTriggerConfig — manual trigger with reactive responsibilities', () => {
  const REACTIVE_RESPONSIBILITIES = `
    You are a customer support representative. Monitor the support@ inbox and
    respond to new emails as they arrive. Triage urgent escalations.
  `;
  const PURELY_ONDEMAND_RESPONSIBILITIES = `
    You are an on-demand release manager. The user asks for a release summary
    covering a specific time window. There is no fixed schedule or event trigger;
    the user decides when to produce a deck.
  `;

  it('rejects type=manual when responsibilities contain "monitor"', () => {
    const out = fakeAgentOutput({
      triggerConfig: { type: 'manual', reasoning: 'no event topics for Gmail' } as Record<string, unknown>,
    });
    const violations = analyzeTriggerConfig(out, boundHubspot, baseCatalog, REACTIVE_RESPONSIBILITIES);
    const rule5 = violations.find(v => v.rule === 'manual_trigger_with_reactive_responsibilities');
    expect(rule5).toBeTruthy();
    expect(rule5!.severity).toBe('reject');
    expect(rule5!.detail).toMatchObject({ matchedKeyword: expect.stringMatching(/monitor/i) });
  });

  it('rejects type=manual when responsibilities contain "respond to new"', () => {
    const out = fakeAgentOutput({
      triggerConfig: { type: 'manual', reasoning: 'no event topics' } as Record<string, unknown>,
    });
    const violations = analyzeTriggerConfig(
      out,
      boundHubspot,
      baseCatalog,
      'Respond to new emails as soon as they arrive in the inbox.',
    );
    expect(violations.find(v => v.rule === 'manual_trigger_with_reactive_responsibilities')).toBeTruthy();
  });

  it('rejects type=manual on workflows with reactive responsibilities (rule applies to both agent types)', () => {
    const out: DistillOutput = {
      agentType: 'workflow',
      summary: 's',
      systemPrompt: 'sp',
      userInstructions: 'ui',
      instructionsMd: 'md',
      triggerConfig: { type: 'manual', reasoning: 'r' } as DistillOutput['triggerConfig'],
      workflowSteps: [],
      skills: [],
    };
    const violations = analyzeTriggerConfig(out, boundHubspot, baseCatalog, REACTIVE_RESPONSIBILITIES);
    expect(violations.find(v => v.rule === 'manual_trigger_with_reactive_responsibilities')).toBeTruthy();
  });

  it('does NOT reject type=manual when responsibilities are purely on-demand', () => {
    const out = fakeAgentOutput({
      triggerConfig: { type: 'manual', reasoning: 'user-initiated' } as Record<string, unknown>,
    });
    const violations = analyzeTriggerConfig(out, boundHubspot, baseCatalog, PURELY_ONDEMAND_RESPONSIBILITIES);
    expect(violations.find(v => v.rule === 'manual_trigger_with_reactive_responsibilities')).toBeUndefined();
  });

  it('does NOT reject type=cron with reactive responsibilities (cron is the correct choice)', () => {
    const out = fakeAgentOutput({
      triggerConfig: { type: 'cron', cronExpr: '*/1 * * * *', reasoning: 'poll inbox' } as Record<string, unknown>,
    });
    const violations = analyzeTriggerConfig(out, boundHubspot, baseCatalog, REACTIVE_RESPONSIBILITIES);
    expect(violations.find(v => v.rule === 'manual_trigger_with_reactive_responsibilities')).toBeUndefined();
  });

  it('does NOT reject type=event with reactive responsibilities (event is the correct choice when topic available)', () => {
    const out = fakeAgentOutput({
      triggerConfig: { type: 'event', eventTopic: 'gmail.message', reasoning: 'event-driven' } as Record<string, unknown>,
    });
    const violations = analyzeTriggerConfig(out, boundHubspot, baseCatalog, REACTIVE_RESPONSIBILITIES);
    expect(violations.find(v => v.rule === 'manual_trigger_with_reactive_responsibilities')).toBeUndefined();
  });

  it('matches a broad set of reactive verbs (monitor, watch, poll, respond to, when new, alert when, incoming, inbox, newly)', () => {
    const phrases = [
      'Monitor the inbox',
      'Watch for new commits',
      'Poll the API for changes',
      'Respond to incoming webhooks',
      'When a new ticket arrives, triage it',
      'Alert when bounce rate exceeds 5%',
      'Process incoming Slack messages',
      'Triage the inbox',
      'Handle newly opened PRs',
    ];
    for (const text of phrases) {
      const out = fakeAgentOutput({
        triggerConfig: { type: 'manual', reasoning: 'r' } as Record<string, unknown>,
      });
      const violations = analyzeTriggerConfig(out, boundHubspot, baseCatalog, text);
      expect(
        violations.find(v => v.rule === 'manual_trigger_with_reactive_responsibilities'),
      ).toBeTruthy();
    }
  });

  it('skips the rule entirely when responsibilities are empty (default param)', () => {
    const out = fakeAgentOutput({
      triggerConfig: { type: 'manual', reasoning: 'r' } as Record<string, unknown>,
    });
    const violations = analyzeTriggerConfig(out, boundHubspot, baseCatalog);
    expect(violations.find(v => v.rule === 'manual_trigger_with_reactive_responsibilities')).toBeUndefined();
  });
});

// ── Rule 6 — cron primary trigger when an event topic is available ────────

describe('analyzeTriggerConfig — cron trigger with event topic available', () => {
  const gmailConnector: ConnectorDef = {
    ...fakeConnector('google_mail', {}),
    polling: [
      // eventTrigger, not just listImplemented — the real Gmail catalog row
      // carries GMAIL_NEW_GMAIL_MESSAGE, and that field is what makes a topic
      // deliverable. Rule 6 used to key on listImplemented, which is a
      // different axis (the list/poll METHOD exists), so this fixture passed
      // while disagreeing with what the distill prompt showed the model.
      { entityType: 'Email', eventTopics: ['email.received', 'mail.received'], listImplemented: true, eventTrigger: { slug: 'GMAIL_NEW_GMAIL_MESSAGE' } },
    ],
  };
  const gmailCatalog = asCatalogResponse([gmailConnector]);
  const boundGmail = new Set(['google_mail']);

  const REACTIVE_INBOX = `
    Customer Support Representative — monitor the support inbox and triage every
    new email that arrives. Respond to incoming customer questions.
  `;
  const REACTIVE_INBOX_BUT_EXPLICITLY_SCHEDULED = `
    Customer Support digest — every 15 minutes, sweep the support inbox and post
    a Slack summary of newly arrived messages.
  `;
  const NON_REACTIVE = `
    On-demand release notes assistant. Produces a markdown release-notes summary
    when the user asks for one.
  `;

  it('rejects type=cron when an event topic is available and responsibilities are reactive', () => {
    const out = fakeAgentOutput({
      triggerConfig: { type: 'cron', cronExpr: '*/1 * * * *', reasoning: 'poll inbox' } as Record<string, unknown>,
    });
    const violations = analyzeTriggerConfig(out, boundGmail, gmailCatalog, REACTIVE_INBOX);
    const rule6 = violations.find(v => v.rule === 'cron_trigger_with_event_topic_available');
    expect(rule6).toBeTruthy();
    expect(rule6!.severity).toBe('reject');
    expect(rule6!.message).toMatch(/email\.received/);
    expect(rule6!.detail).toMatchObject({
      currentCronExpr: '*/1 * * * *',
      matchedKeyword: expect.stringMatching(/monitor|incoming|inbox|new/i),
    });
  });

  // A 15-minute DIGEST keeps its cron: the interval is the batching window, and
  // an event trigger would post one Slack message per email instead of the one
  // summary that was asked for. The cadence rule below is about immediacy
  // wearing a schedule's clothes, and a digest is not that.
  it('does NOT reject a sub-hourly cadence whose output is a batched digest', () => {
    const out = fakeAgentOutput({
      triggerConfig: { type: 'cron', cronExpr: '*/15 * * * *', reasoning: 'user pinned 15m' } as Record<string, unknown>,
    });
    const violations = analyzeTriggerConfig(out, boundGmail, gmailCatalog, REACTIVE_INBOX_BUT_EXPLICITLY_SCHEDULED);
    expect(violations.find(v => v.rule === 'cron_trigger_with_event_topic_available')).toBeUndefined();
  });

  // Real responsibilities text, verbatim rather than paraphrased: the other
  // fixtures here were written to exercise the rule, so they match the reactive
  // patterns by construction. This one matched none of them.
  const CODE_REVIEWER_TEXT = [
    '## Responsibilities',
    '',
    "Reviews open pull requests in GitHub against the team's coding standards, flags code quality",
    'issues, verifies test coverage, posts structured inline review comments with specific file and',
    'line references, and routes non-trivial changes to senior engineers for human review.',
    '',
    '## Workflows',
    '',
    '1. Check for new pull requests every 5 minutes. List the open pull requests across the connected',
    'repositories and take the oldest one that does not already carry a review from you on its current',
    'head commit. Review that one properly and completely; the next run takes the next one.',
    '',
    '5. Leave a top-level PR summary comment with an overall assessment',
  ].join('\n');

  it('sees a polling code-review description as reactive at all', () => {
    const out = fakeAgentOutput({
      triggerConfig: { type: 'cron', cronExpr: '*/5 * * * *', reasoning: 'poll' } as Record<string, unknown>,
    });
    const violations = analyzeTriggerConfig(out, boundGmail, gmailCatalog, CODE_REVIEWER_TEXT);
    const rule6 = violations.find(v => v.rule === 'cron_trigger_with_event_topic_available');
    expect(rule6).toBeTruthy();
    expect(rule6!.severity).toBe('reject');
    // Its "top-level PR summary comment" must not read as a batched digest.
    expect(rule6!.detail).toMatchObject({ subHourlyCadencePinned: true });
  });

  // A cadence written when polling was the only option must not outrank a topic
  // that now exists.
  it('rejects a sub-hourly cadence on per-record work when a topic is available', () => {
    const out = fakeAgentOutput({
      triggerConfig: { type: 'cron', cronExpr: '*/5 * * * *', reasoning: 'poll every 5m' } as Record<string, unknown>,
    });
    const violations = analyzeTriggerConfig(
      out, boundGmail, gmailCatalog,
      'Check for new emails every 5 minutes. Respond to each incoming customer question individually.',
    );
    const rule6 = violations.find(v => v.rule === 'cron_trigger_with_event_topic_available');
    expect(rule6).toBeTruthy();
    expect(rule6!.severity).toBe('reject');
    expect(rule6!.detail).toMatchObject({ subHourlyCadencePinned: true });
    // The stated cadence is preserved, not discarded.
    expect(rule6!.message).toMatch(/companionCrons/);
    expect(rule6!.message).toMatch(/catch-up sweep/);
  });

  it('keeps standing down for an hourly-or-slower cadence on per-record work', () => {
    const out = fakeAgentOutput({
      triggerConfig: { type: 'cron', cronExpr: '0 * * * *', reasoning: 'hourly' } as Record<string, unknown>,
    });
    const violations = analyzeTriggerConfig(
      out, boundGmail, gmailCatalog,
      'Every hour, monitor the support inbox and respond to each incoming customer question.',
    );
    expect(violations.find(v => v.rule === 'cron_trigger_with_event_topic_available')).toBeUndefined();
  });

  // A bare /summar/ match would read "leave a top-level summary comment" as a
  // digest and switch the rule off for ordinary per-record roles.
  it('does not read a per-record "summary comment" as a batched digest', () => {
    const out = fakeAgentOutput({
      triggerConfig: { type: 'cron', cronExpr: '*/5 * * * *', reasoning: 'poll every 5m' } as Record<string, unknown>,
    });
    const violations = analyzeTriggerConfig(
      out, boundGmail, gmailCatalog,
      'Check for new emails every 5 minutes. Respond to each incoming question and leave a top-level summary comment on the thread.',
    );
    expect(violations.find(v => v.rule === 'cron_trigger_with_event_topic_available')).toBeTruthy();
  });

  it('does NOT reject when user pinned a daily schedule ("daily at 9am")', () => {
    const out = fakeAgentOutput({
      triggerConfig: { type: 'cron', cronExpr: '0 9 * * *', reasoning: 'morning briefing' } as Record<string, unknown>,
    });
    const violations = analyzeTriggerConfig(
      out, boundGmail, gmailCatalog,
      'Morning customer-support briefing. Every day at 9am, summarize newly arrived emails.',
    );
    expect(violations.find(v => v.rule === 'cron_trigger_with_event_topic_available')).toBeUndefined();
  });

  it('does NOT reject when responsibilities are not reactive', () => {
    const out = fakeAgentOutput({
      triggerConfig: { type: 'cron', cronExpr: '0 9 * * *', reasoning: 'on demand' } as Record<string, unknown>,
    });
    const violations = analyzeTriggerConfig(out, boundGmail, gmailCatalog, NON_REACTIVE);
    expect(violations.find(v => v.rule === 'cron_trigger_with_event_topic_available')).toBeUndefined();
  });

  it('does NOT reject when no bound connector publishes an event topic', () => {
    const out = fakeAgentOutput({
      triggerConfig: { type: 'cron', cronExpr: '*/1 * * * *', reasoning: 'no topics' } as Record<string, unknown>,
    });
    // baseCatalog = hubspot only, no polling rows configured on that fixture.
    const violations = analyzeTriggerConfig(out, boundHubspot, baseCatalog, REACTIVE_INBOX);
    expect(violations.find(v => v.rule === 'cron_trigger_with_event_topic_available')).toBeUndefined();
  });

  it('does NOT reject when type=event (correct choice already)', () => {
    const out = fakeAgentOutput({
      triggerConfig: { type: 'event', eventTopic: 'email.received', reasoning: 'event-driven' } as Record<string, unknown>,
    });
    const violations = analyzeTriggerConfig(out, boundGmail, gmailCatalog, REACTIVE_INBOX);
    expect(violations.find(v => v.rule === 'cron_trigger_with_event_topic_available')).toBeUndefined();
  });

  it('does NOT reject when polling row is declared but listImplemented=false', () => {
    const placeholderConnector: ConnectorDef = {
      ...fakeConnector('placeholder_mail', {}),
      polling: [
        { entityType: 'Email', eventTopics: ['placeholder.received'], listImplemented: false },
      ],
    };
    const placeholderCatalog = asCatalogResponse([placeholderConnector]);
    const out = fakeAgentOutput({
      triggerConfig: { type: 'cron', cronExpr: '*/1 * * * *', reasoning: 'no live topics' } as Record<string, unknown>,
    });
    const violations = analyzeTriggerConfig(
      out, new Set(['placeholder_mail']), placeholderCatalog, REACTIVE_INBOX,
    );
    expect(violations.find(v => v.rule === 'cron_trigger_with_event_topic_available')).toBeUndefined();
  });

  it('lists every available topic across multiple bound connectors in the offering string', () => {
    const slackConnector: ConnectorDef = {
      ...fakeConnector('slack', {}),
      polling: [
        { entityType: 'Message', eventTopics: ['message.received'], listImplemented: true, eventTrigger: { slug: 'SLACK_RECEIVE_MESSAGE' } },
      ],
    };
    const multiCatalog = asCatalogResponse([gmailConnector, slackConnector]);
    const out = fakeAgentOutput({
      triggerConfig: { type: 'cron', cronExpr: '*/1 * * * *', reasoning: 'poll all' } as Record<string, unknown>,
    });
    const violations = analyzeTriggerConfig(
      out, new Set(['google_mail', 'slack']), multiCatalog, REACTIVE_INBOX,
    );
    const rule6 = violations.find(v => v.rule === 'cron_trigger_with_event_topic_available');
    expect(rule6).toBeTruthy();
    expect(rule6!.message).toMatch(/google_mail/);
    expect(rule6!.message).toMatch(/slack/);
    expect(rule6!.message).toMatch(/email\.received/);
    expect(rule6!.message).toMatch(/message\.received/);
  });

  it('explicit-cron detection matches a literal cron expression in responsibilities', () => {
    const out = fakeAgentOutput({
      triggerConfig: { type: 'cron', cronExpr: '*/5 * * * *', reasoning: 'user wrote it' } as Record<string, unknown>,
    });
    const violations = analyzeTriggerConfig(
      out, boundGmail, gmailCatalog,
      'Watch the inbox and run on the schedule */5 * * * * to avoid hammering the API.',
    );
    expect(violations.find(v => v.rule === 'cron_trigger_with_event_topic_available')).toBeUndefined();
  });
});

// ── Rule 7 — soft / uncheckable behavioral directive (WARN, never blocks) ───
//
// Calibration corpus: the entire src/agent-templates/catalog/*.yaml gold set
// (~6.5k lines) yields only 2 idiom hits, both genuine. The false-positive
// guards below use real-style, checkable "laws not tips" copy drawn from that
// corpus and assert it does NOT flag.

describe('analyzeTriggerConfig — soft_directive_uncheckable (Rule 7)', () => {
  const softCases: Array<{ name: string; text: string }> = [
    { name: 'be professional', text: 'Always be professional when talking to customers.' },
    { name: 'be responsive/helpful', text: 'Be responsive and be helpful to every requester.' },
    { name: 'act professionally', text: 'Act professionally at all times.' },
    { name: 'respond promptly', text: 'Respond promptly to inbound messages.' },
    { name: 'in a timely manner', text: 'Resolve tickets in a timely manner.' },
    { name: 'use good judgment', text: 'Use good judgment when deciding whether to escalate.' },
    { name: 'exercise discretion', text: 'Exercise discretion with sensitive data.' },
    { name: 'strive to', text: 'Strive to keep customers happy.' },
    { name: 'do your best', text: 'Do your best to close every loop.' },
    { name: 'keep stakeholders informed', text: 'Keep stakeholders informed throughout the process.' },
    { name: 'keep the team updated', text: 'Keep the team updated as things change.' },
    { name: 'provide excellent service', text: 'Provide excellent service on every interaction.' },
    { name: 'maintain a high standard', text: 'Maintain a high standard of quality.' },
    { name: 'communicate effectively', text: 'Communicate effectively with the account owner.' },
    { name: 'handle appropriately', text: 'Handle issues appropriately as they arise.' },
    { name: 'where possible', text: 'Automate the reply where possible.' },
  ];

  it.each(softCases)('flags soft directive as warn: $name', ({ text }) => {
    const out = fakeAgentOutput({ systemPrompt: text });
    const violations = analyzeTriggerConfig(out, boundHubspot, baseCatalog);
    const r7 = violations.find(v => v.rule === 'soft_directive_uncheckable');
    expect(r7).toBeDefined();
    expect(r7!.severity).toBe('warn');
    // Never blocks distillation.
    expect(hasBlockingViolations(violations)).toBe(false);
  });

  it('surfaces the matched phrase(s) in message + detail', () => {
    const out = fakeAgentOutput({
      systemPrompt: 'Be professional and respond promptly.',
      userInstructions: 'Keep stakeholders informed of progress.',
    });
    const violations = analyzeTriggerConfig(out, boundHubspot, baseCatalog);
    const r7 = violations.find(v => v.rule === 'soft_directive_uncheckable');
    expect(r7).toBeDefined();
    const detail = r7!.detail as { matchedPhrases: string[]; count: number };
    // Scans both systemPrompt and userInstructions.
    expect(detail.matchedPhrases.map(p => p.toLowerCase())).toEqual(
      expect.arrayContaining(['be professional', 'respond promptly', 'keep stakeholders informed']),
    );
    expect(detail.count).toBe(3);
    expect(r7!.message).toMatch(/checkable/i);
  });

  it('emits exactly ONE aggregated violation even with multiple soft phrases', () => {
    const out = fakeAgentOutput({
      systemPrompt: 'Be professional. Be helpful. Respond promptly. Use good judgment.',
    });
    const violations = analyzeTriggerConfig(out, boundHubspot, baseCatalog);
    expect(violations.filter(v => v.rule === 'soft_directive_uncheckable')).toHaveLength(1);
  });

  it('dedupes repeated identical phrases', () => {
    const out = fakeAgentOutput({
      systemPrompt: 'Be professional. Be professional. Be professional again — be professional.',
    });
    const violations = analyzeTriggerConfig(out, boundHubspot, baseCatalog);
    const r7 = violations.find(v => v.rule === 'soft_directive_uncheckable')!;
    const detail = r7.detail as { matchedPhrases: string[] };
    expect(detail.matchedPhrases).toEqual(['Be professional']);
  });

  // ── False-positive guards: real-style CHECKABLE copy must NOT flag ─────────
  const checkableCases: Array<{ name: string; text: string }> = [
    {
      name: 'numeric SLA + attempt cap (customer-support voice)',
      text:
        'Maximum 3 automated reply attempts per issue thread before escalating. ' +
        'If no customer response within 48 hours of a resolution reply, send one follow-up. ' +
        'Never close an issue without customer confirmation of resolution or expiry of the follow-up window.',
    },
    {
      name: 'done-condition + hard never',
      text:
        'Follow up until the customer confirms resolution or the SLA window closes. ' +
        'Never attempt to resolve billing, payment, or account security issues autonomously; ' +
        'always escalate those to a human.',
    },
    {
      name: 'checkable "current with every release" (technical-writer voice)',
      text: 'Keep the technical documentation current with every release.',
    },
    {
      name: 'descriptive conditional "as needed" (hr-policy voice)',
      text:
        'Look up personal data (PTO balance, accrual rate) in the HR system as needed, ' +
        'as appropriate, and only as necessary for the question asked.',
    },
    {
      name: 'plain role description with quality nouns',
      text:
        'Drafts and sends accurate replies through the originating channel and logs ' +
        'correspondence in the connected ticketing system. Provides a resolution or a clear ' +
        'escalation path for every email.',
    },
    {
      name: 'concrete confidence threshold',
      text:
        'If a matching article is found with over 80 percent confidence, draft a reply grounded ' +
        'in that article and cite it; if not, escalate to a human.',
    },
    {
      name: 'benefit-style terse product copy',
      text:
        'Resolve the majority of inbound support emails autonomously within SLA using documented ' +
        'knowledge and consistent follow-through. Nothing goes unanswered.',
    },
  ];

  it.each(checkableCases)('does NOT flag checkable / normal copy: $name', ({ text }) => {
    const out = fakeAgentOutput({ systemPrompt: text, userInstructions: text });
    const violations = analyzeTriggerConfig(out, boundHubspot, baseCatalog);
    expect(violations.find(v => v.rule === 'soft_directive_uncheckable')).toBeUndefined();
  });

  it('does not flag the default fixture text', () => {
    const out = fakeAgentOutput();
    const violations = analyzeTriggerConfig(out, boundHubspot, baseCatalog);
    expect(violations.find(v => v.rule === 'soft_directive_uncheckable')).toBeUndefined();
  });

  it('does not treat "the patient" (homograph) as "be patient"', () => {
    const out = fakeAgentOutput({
      systemPrompt: 'Update the patient record and notify the patient of the appointment.',
    });
    const violations = analyzeTriggerConfig(out, boundHubspot, baseCatalog);
    expect(violations.find(v => v.rule === 'soft_directive_uncheckable')).toBeUndefined();
  });
});

describe('a routine that needs no model but has nothing to run', () => {
  const analyze = (crons: unknown[]): string[] => analyzeTriggerConfig(
    { triggerConfig: { type: 'cron', companionCrons: crons } } as unknown as Parameters<typeof analyzeTriggerConfig>[0],
    new Set<string>(),
    asCatalogResponse([]),
  ).map((v) => v.rule);

  const violationsFor = (crons: unknown[]) => analyzeTriggerConfig(
    { triggerConfig: { type: 'cron', companionCrons: crons } } as unknown as Parameters<typeof analyzeTriggerConfig>[0],
    new Set<string>(),
    asCatalogResponse([]),
  );

  it('rejects noAgent with no script', () => {
    // noAgent means "the command is the whole job". Without a command there is
    // no job: the routine fires forever and does nothing, and because it never
    // errors, nothing surfaces it.
    const out = violationsFor([{ label: 'disk-check', cronExpr: '0 * * * *', noAgent: true }]);
    expect(out.map((v) => v.rule)).toContain('no_agent_without_script');
    expect(out.find((v) => v.rule === 'no_agent_without_script')?.severity).toBe('reject');
  });

  it('rejects noAgent with an empty script', () => {
    expect(analyze([{ label: 'x', cronExpr: '0 * * * *', noAgent: true, script: ['   '] }]))
      .toContain('no_agent_without_script');
  });

  it('accepts noAgent with a real command', () => {
    expect(analyze([{ label: 'disk-check', cronExpr: '0 * * * *', noAgent: true, script: ['df', '-h'] }]))
      .not.toContain('no_agent_without_script');
  });

  it('accepts a script without noAgent, which is the gather-then-reason shape', () => {
    expect(analyze([{ label: 'build-report', cronExpr: '0 9 * * *', script: ['npm', 'test'] }]))
      .not.toContain('no_agent_without_script');
  });

  it('says nothing about an ordinary routine', () => {
    expect(analyze([{ label: 'weekly', cronExpr: '0 16 * * 5', objective: 'Write the weekly summary.' }]))
      .not.toContain('no_agent_without_script');
  });
});
