/**
 * loadOversightTriggers + composeTaskPrompt — verifies the web_task prompt
 * preamble composition from per-agent userInstructions + workspace oversight
 * toggles read from tenant_oversight_cache.
 */
const getOversightSettingsMock = jest.fn();
const findByIdMock = jest.fn();

jest.mock('../../../hitl-enforcement/service', () => ({
  hitlEnforcementService: {
    getOversightSettings: (...args: unknown[]) => getOversightSettingsMock(...args),
  },
}));

jest.mock('../../../agent-lifecycle/repository', () => ({
  AgentRepository: class {
    findById = (...args: unknown[]) => findByIdMock(...args);
  },
}));

import { loadOversightTriggers, composeTaskPrompt } from '../anchor-client';

beforeEach(() => jest.clearAllMocks());

describe('loadOversightTriggers', () => {
  it('returns empty array when neither agent nor oversight settings exist', async () => {
    getOversightSettingsMock.mockResolvedValueOnce(null);
    findByIdMock.mockResolvedValueOnce(null);
    expect(await loadOversightTriggers('t', 'a')).toEqual([]);
  });

  it('includes the agent userInstructions when present', async () => {
    getOversightSettingsMock.mockResolvedValueOnce(null);
    findByIdMock.mockResolvedValueOnce({ userInstructions: 'Be polite.' });
    const triggers = await loadOversightTriggers('t', 'a');
    expect(triggers).toEqual(['Be polite.']);
  });

  it('maps every sensitive-work toggle to a trigger sentence', async () => {
    getOversightSettingsMock.mockResolvedValueOnce({
      sensitiveWork: {
        customerCommunication: true,
        financialActions: true,
        dataChanges: true,
        externalPublishing: true,
        hiringDecisions: true,
        mergeToMain: true,
      },
      communication: 'review',
    });
    findByIdMock.mockResolvedValueOnce({ userInstructions: '' });
    const triggers = await loadOversightTriggers('t', 'a');
    expect(triggers).toEqual([
      'Ask the user before any payment, purchase, or money movement.',
      'Ask the user before sending anything to a customer.',
      'Ask the user before publishing anything externally.',
      'Ask the user before making destructive changes to data.',
      'Ask the user before any hiring or termination decision.',
      'Ask the user before merging any code to a main or protected branch.',
      'Ask the user to review any outbound message before sending.',
    ]);
  });

  it('emits the mergeToMain trigger only when the toggle is on', async () => {
    getOversightSettingsMock.mockResolvedValueOnce({
      sensitiveWork: {
        customerCommunication: false, financialActions: false, dataChanges: false,
        externalPublishing: false, hiringDecisions: false,
        mergeToMain: true,
      },
      communication: 'auto',
    });
    findByIdMock.mockResolvedValueOnce(null);
    const triggers = await loadOversightTriggers('t', 'a');
    expect(triggers).toEqual([
      'Ask the user before merging any code to a main or protected branch.',
    ]);
  });

  it('does NOT emit the mergeToMain trigger when the toggle is off (or absent)', async () => {
    getOversightSettingsMock.mockResolvedValueOnce({
      sensitiveWork: {
        customerCommunication: false, financialActions: false, dataChanges: false,
        externalPublishing: false, hiringDecisions: false,
        // mergeToMain intentionally omitted — mirrors a cache row written
        // before PB started syncing the key.
      },
      communication: 'auto',
    });
    findByIdMock.mockResolvedValueOnce(null);
    const triggers = await loadOversightTriggers('t', 'a');
    expect(triggers).toEqual([]);
  });

  it('skips toggles that are off', async () => {
    getOversightSettingsMock.mockResolvedValueOnce({
      sensitiveWork: {
        customerCommunication: false,
        financialActions: true,
        dataChanges: false,
        externalPublishing: false,
        hiringDecisions: false,
      },
      communication: 'auto',
    });
    findByIdMock.mockResolvedValueOnce(null);
    const triggers = await loadOversightTriggers('t', 'a');
    expect(triggers).toEqual([
      'Ask the user before any payment, purchase, or money movement.',
    ]);
  });
});

describe('composeTaskPrompt', () => {
  it('returns the task unchanged when no triggers are provided', () => {
    expect(composeTaskPrompt('Do the thing', [])).toBe('Do the thing');
  });

  it('prepends a labeled preamble in front of the task content', () => {
    const out = composeTaskPrompt('Do the thing', [
      'Ask first.',
      'Be polite.',
    ]);
    expect(out).toMatch(/^## Operator guidance/);
    expect(out).toContain('- Ask first.');
    expect(out).toContain('- Be polite.');
    expect(out).toContain('## Task:\nDo the thing');
  });
});
