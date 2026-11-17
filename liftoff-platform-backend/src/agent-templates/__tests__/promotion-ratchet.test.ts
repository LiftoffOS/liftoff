// The promoter, and the ratchet over what it can see.
//
// Two halves. The lifter is tested against prose built to exercise each rule:
// a header is lifted with its steps, an emphasised sentence is not a header,
// a clock resolves against the template's own triggers, a collision is
// refused rather than de-duplicated, and a stub is something the validator
// REFUSES — an unauthored stub that loaded would be a flow with no boundary.
//
// The ratchet half reads the catalog through the same lifter: a template the
// promoter can lift a flow from, that has none, fails unless it is frozen as
// debt. The flows baseline shrinks by the script's run and cannot grow back.

import { agentTemplateZodSchema } from '../validator';
import { getAllTemplates, initTemplateLoader } from '../loader';
import { KNOWN_TEMPLATES_WITHOUT_FLOWS } from './known-uncontracted-templates';
import {
  liftTemplate,
  canLiftFlows,
  applyLift,
  clockIn,
  cronFor,
  shapeOf,
  slugFor,
  FlowIdCollisionError,
  type LiftableTemplate,
} from '../../scripts/promote-template-flows';
import { join } from 'path';
import * as yaml from 'js-yaml';

const WORKFLOWS = `## Workflows
**Whenever a new invoice email arrives:**
1. Read the invoice.
2. Match it to a purchase order.

**Payment runs (weekly, every Thursday):**
1. Pull every approved unpaid bill.
2. Post the run summary.

**Your first run sends nothing. Report only.**

**Quarterly vendor review:**
1. Rank vendors by spend.`;

const EDGE_CASES = `## Edge cases
- Duplicate invoice: flag it and stop
- Vendor not in the system: ask before creating one`;

function template(over: Partial<LiftableTemplate> = {}): LiftableTemplate {
  return {
    id: 'fixture',
    responsibilities: `## Responsibilities\nPay bills.\n\n${WORKFLOWS}`,
    additionalContext: `## Rules\n- Be careful.\n\n${EDGE_CASES}`,
    defaultTriggerConfig: { type: 'event' },
    ...over,
  };
}

describe('the lifter', () => {
  it('lifts each header with the steps under it and leaves the keys empty', () => {
    const lift = liftTemplate(template());
    expect(lift.flows.map((f) => f.id)).toEqual([
      'whenever-a-new-invoice-email-arrives',
      'payment-runs',
      'quarterly-vendor-review',
    ]);
    expect(lift.flows[0].name).toBe('Whenever a new invoice email arrives');
    expect(lift.flows[0].body).toBe('1. Read the invoice.\n2. Match it to a purchase order.');
    // Left for a person. A stub with a key would be a boundary nobody wrote.
    for (const f of lift.flows) {
      expect(f.useWhen).toBe('');
      expect(f.notNeededFor).toBe('');
    }
  });

  it('does not take an emphasised sentence for a header', () => {
    // "**Your first run sends nothing. Report only.**" ends in a full stop,
    // not a colon; it stays in the body of the flow it sits under.
    const lift = liftTemplate(template());
    expect(lift.flows.map((f) => f.name)).not.toContain('Your first run sends nothing. Report only.');
    expect(lift.flows[1].body).toContain('Your first run sends nothing. Report only.');
  });

  it('reads the workflows from `sections` when the template is split', () => {
    const lift = liftTemplate(template({
      responsibilities: 'unrelated',
      sections: { '## Workflows': '**On request:**\n1. Do it.' },
    }));
    expect(lift.flows.map((f) => f.id)).toEqual(['on-request']);
  });

  it('turns each edge-case bullet into a named empty case', () => {
    const lift = liftTemplate(template());
    expect(lift.evals.map((e) => e.id)).toEqual([
      'duplicate-invoice-flag-it-and-stop',
      'vendor-not-in-the-system-ask-before-creating',
    ]);
  });

  it('fails visibly on an id collision rather than de-duplicating', () => {
    const t = template({
      responsibilities: '## Workflows\n**Weekly report (finance):**\n1. a\n\n**Weekly report (sales):**\n1. b',
    });
    expect(() => liftTemplate(t)).toThrow(FlowIdCollisionError);
    expect(() => liftTemplate(t)).toThrow(/"weekly-report" is produced by more than one header/);
  });

  it('does not re-lift a flow the template already has', () => {
    const lift = liftTemplate(template({ flows: [{ id: 'payment-runs' }] }));
    expect(lift.flows.map((f) => f.id)).not.toContain('payment-runs');
  });
});

describe('clocks', () => {
  it('decides the shapes cron can state without a guess', () => {
    expect(clockIn('Payment runs (weekly, every Thursday)')).toEqual({ kind: 'weekly', dow: 4 });
    expect(clockIn('Monthly policy gap report (first Monday of each month)')).toEqual({ kind: 'monthly_first_dow', dow: 1 });
    expect(clockIn('Daily open-escalation review (every weekday)')).toEqual({ kind: 'weekdays' });
    expect(clockIn('At the end of each day, close the digest')).toEqual({ kind: 'daily' });
    expect(cronFor({ kind: 'weekly', dow: 4 })).toBe('0 9 * * 4');
    expect(cronFor({ kind: 'monthly_first_dow', dow: 1 })).toBe('0 9 1-7 * 1');
  });

  it('does not decide a cadence with no day', () => {
    expect(clockIn('Quarterly vendor review')).toEqual({ kind: 'undecidable', phrase: 'quarterly' });
    expect(clockIn('Expansion identification (weekly)')).toEqual({ kind: 'undecidable', phrase: 'weekly' });
    expect(clockIn('Interviewer preparation brief (24 hours before each interview)')).toBeNull();
  });

  it('reads a declared cron back to the same shape', () => {
    expect(shapeOf('0 9 * * 4')).toEqual({ kind: 'weekly', dow: 4 });
    expect(shapeOf('0 7 1-7 * 1')).toEqual({ kind: 'monthly_first_dow', dow: 1 });
    expect(shapeOf('30 17 * * 1-5')).toEqual({ kind: 'weekdays' });
  });

  it('a clock that matches the primary trigger promotes nothing', () => {
    const lift = liftTemplate(template({
      responsibilities: '## Workflows\n**Every Monday morning, run the sweep:**\n1. Sweep.',
      defaultTriggerConfig: { type: 'cron', cronExpr: '0 8 * * 1' },
    }));
    expect(lift.flows[0].companionCron).toBeUndefined();
    expect(lift.flows[0].clock).toEqual({ kind: 'primary', cronExpr: '0 8 * * 1' });
    expect(lift.companionStubs).toEqual([]);
  });

  it('a clock that matches a declared companion names its label', () => {
    const lift = liftTemplate(template({
      defaultTriggerConfig: {
        type: 'event',
        companionCrons: [{ label: 'weekly-payment-run', cronExpr: '0 9 * * 4' }],
      },
    }));
    expect(lift.flows[1].companionCron).toBe('weekly-payment-run');
    expect(lift.companionStubs).toEqual([]);
  });

  it('a decidable clock with no declared companion becomes a companion stub', () => {
    const lift = liftTemplate(template());
    expect(lift.companionStubs).toEqual([
      expect.objectContaining({ label: 'payment-runs', cronExpr: '0 9 * * 4' }),
    ]);
    expect(lift.flows[1].companionCron).toBe('payment-runs');
  });

  it('an undecidable clock is written as the phrase, which the validator refuses', () => {
    const lift = liftTemplate(template());
    expect(lift.flows[2].companionCron).toBe('quarterly');
    const r = agentTemplateZodSchema.safeParse({
      ...BASE_FOR_VALIDATION,
      flows: [{ ...lift.flows[2], useWhen: 'x', notNeededFor: 'Not unless asked.' }],
    });
    expect(r.success).toBe(false);
    expect(r.success ? '' : r.error.issues.map((i) => i.message).join('\n')).toContain('names no label in defaultTriggerConfig.companionCrons');
  });
});

const BASE_FOR_VALIDATION = {
  id: 'fixture',
  displayName: 'Fixture',
  departmentCategory: 'finance' as const,
  description: 'A fixture.',
  roleSummary: 'A fixture role.',
  role: 'Fixture',
  responsibilities: `## Responsibilities\nPay bills.\n\n${WORKFLOWS}`,
  additionalContext: `## Rules\n- Be careful.\n\n${EDGE_CASES}`,
  requiredConnectors: [
    { id: 'req-ap', capability: 'accounting', role: 'tool' as const, description: 'Bills' },
  ],
  optionalConnectors: [],
  defaultAgentType: 'agent' as const,
  defaultMemoryScope: { readableLayers: ['individual'], writableLayers: ['individual'] },
  defaultTriggerConfig: { type: 'event' as const, eventTopic: 'email.received' },
  schemaVersion: 1,
};

describe('a stub is refused until authored', () => {
  it('the validator rejects the flows and the eval skeletons the promoter writes', () => {
    const lift = liftTemplate(template());
    const written = applyLift(
      `${yaml.dump(BASE_FOR_VALIDATION, { lineWidth: -1 })}sections:\n  '## Responsibilities': Pay bills.\n`,
      lift,
    );
    const parsed = yaml.load(written) as Record<string, unknown>;
    const r = agentTemplateZodSchema.safeParse(parsed);
    expect(r.success).toBe(false);
    const messages = r.success ? '' : r.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('\n');
    // The keys a person has to write.
    expect(messages).toMatch(/flows\.0\.useWhen/);
    expect(messages).toMatch(/flows\.0\.notNeededFor/);
    // The case a person has to fill.
    expect(messages).toMatch(/evals\.0\.turns/);
    expect(messages).toMatch(/evals\.0\.expected/);
  });

  it('writes by insertion, leaving the rest of the file byte-for-byte', () => {
    const raw = `id: fixture\ndefaultTriggerConfig:\n  type: event\n  eventTopic: email.received\nsections:\n  '## Responsibilities': Pay bills.\n`;
    const lift = liftTemplate(template());
    const out = applyLift(raw, lift);
    expect(out.startsWith('id: fixture\n')).toBe(true);
    expect(out).toContain("sections:\n  '## Responsibilities': Pay bills.\n");
    expect(out).toContain('\nflows:\n  - id: whenever-a-new-invoice-email-arrives\n');
    expect(out).toContain('\nevals:\n  # Edge case: Duplicate invoice: flag it and stop\n  - id: duplicate-invoice-flag-it-and-stop\n    turns: []\n    expected: {}\n');
    expect(out).toContain('  companionCrons:\n    - label: payment-runs\n      cronExpr: "0 9 * * 4"\n');
    // Loads as YAML with the fields where they belong.
    const parsed = yaml.load(out) as { flows: unknown[]; evals: unknown[]; defaultTriggerConfig: { companionCrons: unknown[] } };
    expect(parsed.flows).toHaveLength(3);
    expect(parsed.evals).toHaveLength(2);
    expect(parsed.defaultTriggerConfig.companionCrons).toHaveLength(1);
  });
});

describe('the ratchet over what the promoter can see', () => {
  initTemplateLoader(join(__dirname, '..', 'catalog'));
  const templates = getAllTemplates() as unknown as LiftableTemplate[];

  it('a template the promoter can lift a flow from, with none, is frozen as debt or fails', () => {
    const missing = templates
      .filter((t) => canLiftFlows(t) && (t.flows ?? []).length === 0)
      .map((t) => t.id)
      .filter((id) => !KNOWN_TEMPLATES_WITHOUT_FLOWS.includes(id));
    expect(missing).toEqual([]);
  });

  it('the promoter can lift from most of the catalog, so the baseline shrinks by its run', () => {
    // The mechanism this lane rests on: if this were a handful, the flows would
    // be authoring rather than promotion.
    const liftable = templates.filter((t) => canLiftFlows(t)).length;
    expect(liftable).toBeGreaterThan(40);
  });

  it('no template produces a colliding flow id or eval id from its own prose', () => {
    const collisions: string[] = [];
    for (const t of templates) {
      try {
        liftTemplate(t);
      } catch (err) {
        if (err instanceof FlowIdCollisionError) collisions.push(err.message);
        else throw err;
      }
    }
    expect(collisions).toEqual([]);
  });

  it('slugs are stable and kebab', () => {
    expect(slugFor('Whenever a new pull request is opened, updated, marked ready-for-review or reopened (events `pr.opened`)'))
      .toBe('whenever-a-new-pull-request-is-opened-updated');
    expect(slugFor('{{connector:opt-team-chat}}: post the summary')).toBe('post-the-summary');
  });
});
