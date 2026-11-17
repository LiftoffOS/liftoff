// F5 — a routine must not switch off the team member that runs it.
//
// The two halves of the contract matter equally: the rule has to catch genuine
// self-disabling prose, and it must NOT fire on ordinary work that happens to
// use the same verbs ("pause the campaign", "archive the deal"). A false
// positive here blocks a legitimate agent from being created at all.

import { analyzeTriggerConfig, hasBlockingViolations } from '../trigger-config-analyzer';
import type { DistillOutput } from '../distill-service';
import type { ConnectorCatalogResponse } from '@liftoffos/connector-types';

const emptyCatalog = { connectors: [] } as unknown as ConnectorCatalogResponse;

function outputWithObjective(objective: string): DistillOutput {
  return {
    agentType: 'agent',
    summary: 's',
    systemPrompt: 'p',
    userInstructions: 'u',
    instructionsMd: null,
    skills: [],
    triggerConfig: {
      type: 'cron',
      cronExpr: '0 9 * * *',
      companionCrons: [{ label: 'daily', cronExpr: '0 9 * * *', objective }],
    },
  } as unknown as DistillOutput;
}

function violationsFor(objective: string) {
  return analyzeTriggerConfig(outputWithObjective(objective), new Set(), emptyCatalog, '')
    .filter((v) => v.rule === 'self_disabling_routine');
}

describe('self-disabling routine rule', () => {
  it.each([
    'Each morning, check the queue and then pause yourself until Monday.',
    'When the migration finishes, disable yourself.',
    'Once complete, delete this team member.',
    'After the launch, turn off this agent.',
    'At month end, cancel your schedule.',
    'When the backlog is empty, remove your triggers.',
    'Stop your own routine once the audit closes.',
  ])('rejects: %s', (objective) => {
    const found = violationsFor(objective);
    expect(found).toHaveLength(1);
    expect(found[0].severity).toBe('reject');
    expect(hasBlockingViolations(found)).toBe(true);
  });

  it.each([
    'Each weekday morning, pause any campaign that is overspending.',
    'Archive deals that have been closed for more than 90 days.',
    'Delete draft invoices that were never sent.',
    'Turn off email alerts for customers who have unsubscribed.',
    'Cancel the meeting when every attendee declines.',
    'Stop reporting on a project once its status is marked complete.',
    'Remove stale records from the reporting sheet each Friday.',
    'Disable the promotional banner after the sale ends.',
  ])('allows ordinary work: %s', (objective) => {
    expect(violationsFor(objective)).toHaveLength(0);
  });

  it('says nothing when there are no companion routines at all', () => {
    const out = {
      agentType: 'agent',
      summary: 's',
      systemPrompt: 'p',
      userInstructions: 'u',
      instructionsMd: null,
      skills: [],
      triggerConfig: { type: 'manual' },
    } as unknown as DistillOutput;
    const found = analyzeTriggerConfig(out, new Set(), emptyCatalog, '')
      .filter((v) => v.rule === 'self_disabling_routine');
    expect(found).toHaveLength(0);
  });

  it('reports the offending objective so the retry has something to fix', () => {
    const objective = 'When the migration finishes, disable yourself.';
    const found = violationsFor(objective);
    expect(found[0].detail).toMatchObject({ objectives: [objective] });
  });
});
