// Tests: fail-safe loader behavior
//   - Invalid YAML (schema-fatal) → throws on init
//   - Template with unbuilt required connectors → loads but isTemplateDisabled returns true
//   - Valid template → loads and getTemplate returns it

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  initTemplateLoader,
  getTemplate,
  getAllTemplates,
  getActiveTemplates,
  isTemplateDisabled,
  getDisabledReason,
  _resetLoaderForTesting,
} from '../loader';

// ── Helpers ────────────────────────────────────────────────────────────────

function writeTempCatalog(files: Record<string, string>): string {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-template-test-'));
  for (const [filename, content] of Object.entries(files)) {
    fs.writeFileSync(path.join(tmpDir, filename), content, 'utf-8');
  }
  return tmpDir;
}

const VALID_TEMPLATE = `
id: test-agent
displayName: Test Agent
departmentCategory: engineering
description: A test agent for unit testing.
schemaVersion: 1
role: Code Reviewer
roleSummary: Runs the test suite on every PR and reports failures with file + line context, so reviewers see regressions before merging.
responsibilities: |
  ## Responsibilities
  Run automated tests for {{company_name}} and report results.

  ## Goals
  Ensure code quality and catch regressions early.

  ## Workflows
  1. Pull latest changes from the repository
  2. Run the test suite
  3. Report results to the team

  ## Instructions
  Always report failures with file and line number context.

  ## Outcomes
  A clean test run with all issues flagged for review.
additionalContext: |
  ## Specific instructions
  Focus on the {{company_name}} coding standards.

  ## Rules
  - Never skip failing tests
  - Always report all failures

  ## Constraints
  - Only run tests in CI environments

  ## Edge cases
  - If test runner is unavailable, notify the team and abort

  ## Anything to avoid
  - Ignoring flaky tests
defaultAgentType: agent
defaultMemoryScope:
  readableLayers:
    - role
defaultTriggerConfig:
  type: manual
requiredConnectors:
  - id: github-tool
    connectorType: github
    role: tool
    requiredScopes:
      - repo
    description: GitHub tool access.
optionalConnectors: []
inputs:
  - id: company_name
    label: Company name
    type: text
    required: true
`;

const PENDING_TEMPLATE = `
id: pending-agent
displayName: Pending Agent
departmentCategory: operations
description: A template that depends on connectors not yet available.
schemaVersion: 1
role: Incident Triage Agent
roleSummary: Triages PagerDuty incidents, classifies severity, and routes to on-call so MTTR drops without a human babysitting the alert queue.
responsibilities: |
  ## Responsibilities
  Triage incidents for {{company_name}} when PagerDuty connector ships.

  ## Goals
  Automate incident triage to reduce mean time to resolution.

  ## Workflows
  1. Receive incident alert from PagerDuty
  2. Classify severity
  3. Route to on-call engineer

  ## Instructions
  Always include affected user count in the incident summary.

  ## Outcomes
  All incidents triaged and routed within minutes of alert.
additionalContext: |
  ## Specific instructions
  Company: {{company_name}}

  ## Rules
  - Never auto-resolve an incident without human confirmation

  ## Constraints
  - Only triage incidents from the connected PagerDuty service

  ## Edge cases
  - If no on-call engineer is available, escalate to team lead

  ## Anything to avoid
  - Auto-resolving incidents without investigation
defaultAgentType: agent
defaultMemoryScope:
  readableLayers:
    - role
defaultTriggerConfig:
  type: manual
requiredConnectors:
  - id: unbuilt-tool
    # A type no catalog will ever mark functional. The fixture used to borrow a
    # real coming_soon connector (salesloft), and the day that connector shipped
    # the failsafe tests failed on an unrelated change. The property under test
    # is the loader's handling of an unbuilt requirement, not any vendor's status.
    connectorType: never_built_fixture
    role: tool
    requiredScopes:
      - read
    description: A connector that does not exist, used as the unbuilt-connector fixture.
optionalConnectors: []
inputs:
  - id: company_name
    label: Company name
    type: text
    required: true
`;

// Schema-fatal: wrong type for a required field (defaultAgentType is not a valid enum value)
const SCHEMA_FATAL_TEMPLATE = `
id: broken-agent
displayName: Broken Agent
departmentCategory: sales
description: This template has an invalid type that should crash boot.
schemaVersion: 1
defaultAgentType: invalid_type
defaultMemoryScope: {}
defaultTriggerConfig:
  type: manual
requiredConnectors: []
optionalConnectors: []
roleVariables: []
role: Broken Agent
responsibilities: broken
additionalContext: broken
`;

// ── Tests ──────────────────────────────────────────────────────────────────

beforeEach(() => {
  _resetLoaderForTesting();
});

afterEach(() => {
  _resetLoaderForTesting();
});

describe('Loader — valid template', () => {
  it('loads a valid template and makes it available', () => {
    const tmpDir = writeTempCatalog({ 'test-agent.yaml': VALID_TEMPLATE });
    initTemplateLoader(tmpDir);

    const template = getTemplate('test-agent');
    expect(template).toBeDefined();
    expect(template?.id).toBe('test-agent');
    expect(template?.displayName).toBe('Test Agent');
  });

  it('valid template is not disabled', () => {
    const tmpDir = writeTempCatalog({ 'test-agent.yaml': VALID_TEMPLATE });
    initTemplateLoader(tmpDir);

    expect(isTemplateDisabled('test-agent')).toBe(false);
    expect(getDisabledReason('test-agent')).toBeUndefined();
  });

  it('valid template appears in getAllTemplates() and getActiveTemplates()', () => {
    const tmpDir = writeTempCatalog({ 'test-agent.yaml': VALID_TEMPLATE });
    initTemplateLoader(tmpDir);

    const all = getAllTemplates();
    const active = getActiveTemplates();
    expect(all.length).toBe(1);
    expect(active.length).toBe(1);
    expect(active[0].id).toBe('test-agent');
  });
});

describe('Loader — template with unbuilt required connectors', () => {
  it('loads but marks template as disabled', () => {
    const tmpDir = writeTempCatalog({ 'pending-agent.yaml': PENDING_TEMPLATE });
    initTemplateLoader(tmpDir);

    const template = getTemplate('pending-agent');
    expect(template).toBeDefined(); // stored in templates map
    expect(isTemplateDisabled('pending-agent')).toBe(true);
  });

  it('disabled reason names the unbuilt connector type', () => {
    const tmpDir = writeTempCatalog({ 'pending-agent.yaml': PENDING_TEMPLATE });
    initTemplateLoader(tmpDir);

    const reason = getDisabledReason('pending-agent');
    expect(reason).toBeDefined();
    expect(reason).toContain('never_built_fixture');
  });

  it('template with unbuilt connectors does NOT appear in getActiveTemplates()', () => {
    const tmpDir = writeTempCatalog({ 'pending-agent.yaml': PENDING_TEMPLATE });
    initTemplateLoader(tmpDir);

    const active = getActiveTemplates();
    expect(active.find(t => t.id === 'pending-agent')).toBeUndefined();
  });

  it('template with unbuilt connectors appears in getAllTemplates()', () => {
    const tmpDir = writeTempCatalog({ 'pending-agent.yaml': PENDING_TEMPLATE });
    initTemplateLoader(tmpDir);

    const all = getAllTemplates();
    expect(all.find(t => t.id === 'pending-agent')).toBeDefined();
  });
});

describe('Loader — schema-fatal template', () => {
  it('throws on init when a schema-fatal template is present', () => {
    const tmpDir = writeTempCatalog({ 'broken-agent.yaml': SCHEMA_FATAL_TEMPLATE });

    expect(() => {
      initTemplateLoader(tmpDir);
    }).toThrow();
  });

  it('throws with a descriptive error message', () => {
    const tmpDir = writeTempCatalog({ 'broken-agent.yaml': SCHEMA_FATAL_TEMPLATE });

    expect(() => {
      initTemplateLoader(tmpDir);
    }).toThrow(/broken-agent|invalid_type|validation/i);
  });
});

describe('Loader — mixed catalog', () => {
  it('valid template is accessible when catalog has both valid and pending templates', () => {
    const tmpDir = writeTempCatalog({
      'test-agent.yaml': VALID_TEMPLATE,
      'pending-agent.yaml': PENDING_TEMPLATE,
    });
    initTemplateLoader(tmpDir);

    expect(getTemplate('test-agent')).toBeDefined();
    expect(getTemplate('pending-agent')).toBeDefined();
    expect(isTemplateDisabled('test-agent')).toBe(false);
    expect(isTemplateDisabled('pending-agent')).toBe(true);

    const active = getActiveTemplates();
    expect(active.length).toBe(1);
    expect(active[0].id).toBe('test-agent');
  });
});

describe('Loader — idempotency', () => {
  it('calling initTemplateLoader twice is a no-op', () => {
    const tmpDir = writeTempCatalog({ 'test-agent.yaml': VALID_TEMPLATE });
    initTemplateLoader(tmpDir);
    initTemplateLoader(tmpDir); // second call should be no-op

    expect(getAllTemplates().length).toBe(1);
  });
});

describe('Loader — real catalog', () => {
  it('loads the real catalog without throwing', () => {
    expect(() => initTemplateLoader()).not.toThrow();
  });

  it('real catalog has at least one active template', () => {
    initTemplateLoader();
    expect(getActiveTemplates().length).toBeGreaterThan(0);
  });
});
