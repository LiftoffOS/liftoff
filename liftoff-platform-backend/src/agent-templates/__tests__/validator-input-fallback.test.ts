// An input placeholder that can be blank has to read as something.
//
// `{{company_website}}` substitutes to what the person typed. An OPTIONAL
// input can be left blank, and blank substitutes to an empty string, so the
// sentence loses its object and the team reads "argue from what  says". The
// same hole an unpicked object used to leave ("Post the summary to .") and the
// same fix: a fallback phrase declared beside the input, required whenever
// the prose names an optional one. A required input cannot be blank and needs
// none; a placeholder no input declares is caught the way an undeclared pick
// is.

jest.mock('../../connectors/connector-service-client', () => ({}));
jest.mock('../../connectors/connector-service-cache', () => ({}));

import { agentTemplateZodSchema } from '../validator';

type Input = { id: string; label: string; type: 'text' | 'url'; required: boolean; fallback?: string };

function withInputs(inputs: Input[], responsibilities: string) {
  return {
    id: 'input-fallback-test',
    displayName: 'X',
    departmentCategory: 'marketing',
    description: 'description',
    roleSummary: 'roleSummary',
    role: 'role',
    responsibilities,
    additionalContext: '## Rules\nbar',
    requiredConnectors: [],
    optionalConnectors: [],
    defaultAgentType: 'agent',
    defaultMemoryScope: {},
    defaultTriggerConfig: { type: 'manual' },
    schemaVersion: 1,
    inputs,
  };
}

const messages = (result: { success: boolean; error?: { issues: Array<{ message: string }> } }) =>
  result.success ? [] : result.error!.issues.map((i) => i.message);

const website = (extra: Partial<Input> = {}): Input =>
  ({ id: 'company_website', label: 'Website', type: 'url', required: false, ...extra });

describe('an optional input named in the prose', () => {
  it('must declare the phrase its placeholder reads as when left blank', () => {
    const result = agentTemplateZodSchema.safeParse(
      withInputs([website()], '## Workflows\nArgue from what {{company_website}} says'),
    );
    expect(messages(result)).toEqual(
      expect.arrayContaining([expect.stringContaining('Input "company_website" is optional and appears in prose as {{company_website}} but declares no fallback phrase')]),
    );
  });

  it('passes once it does', () => {
    const result = agentTemplateZodSchema.safeParse(
      withInputs([website({ fallback: "the company's own website" })], '## Workflows\nArgue from what {{company_website}} says'),
    );
    expect(messages(result)).toEqual([]);
  });

  it('needs none when the prose never names it', () => {
    const result = agentTemplateZodSchema.safeParse(
      withInputs([website()], '## Workflows\nSweep the competitors'),
    );
    expect(messages(result)).toEqual([]);
  });
});

describe('a required input named in the prose', () => {
  it('needs no fallback, since it cannot be blank', () => {
    const result = agentTemplateZodSchema.safeParse(
      withInputs(
        [{ id: 'company_name', label: 'Company name', type: 'text', required: true }],
        '## Workflows\nTrack {{company_name}} competitors',
      ),
    );
    expect(messages(result)).toEqual([]);
  });
});

describe('a placeholder no input declares', () => {
  it('is refused, since it would substitute to nothing', () => {
    const result = agentTemplateZodSchema.safeParse(
      withInputs([], '## Workflows\nVisit {{company_website}}'),
    );
    expect(messages(result)).toEqual(
      expect.arrayContaining([expect.stringContaining('Prose refers to {{company_website}}, which no input declares')]),
    );
  });

  it('does not mistake a pick or a connector clause for an input', () => {
    // Those carry a prefix and a colon, which an input id cannot.
    const result = agentTemplateZodSchema.safeParse({
      ...withInputs([], '## Workflows\nSave to {{pick:working-folder}}'),
      requiredConnectors: [{
        id: 'req-docs', connectorType: 'google_drive', role: 'tool', description: 'd',
        objects: [{ id: 'working-folder', kind: 'destination', direction: 'write', label: 'where', required: true, fallback: 'your working folder' }],
      }],
    });
    expect(messages(result).filter((m) => m.includes('no input declares'))).toEqual([]);
  });
});
