// The waved arm must never be able to cost the person their agent.
//
// Six calls have six independent ways to exhaust their retries where one call
// had one, and everything downstream of distillation depends on an agent
// existing at the end of it: a distillation that throws leaves the person on a
// dead screen with nothing to launch. So the split is a challenger, not a
// replacement — when it cannot converge, the proven single call finishes the
// job. The person waits longer. They are never left empty-handed.

jest.mock('../../llm/client', () => ({
  llmClient: { complete: jest.fn() },
}));

jest.mock('../../connectors/tenant-runtime-client', () => ({
  tenantRuntimeClient: {
    getTenantManifests: jest.fn(),
    getToolCatalog: jest.fn(),
    getDataLandscape: jest.fn().mockResolvedValue(null),
  },
}));

jest.mock('../../infrastructure/logging', () => ({
  log: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

jest.mock('../distill-cache', () => ({
  computePriorArtHash: jest.fn().mockReturnValue(''),
  computeCatalogHash: jest.fn().mockReturnValue('mock-catalog-hash'),
  computeFingerprint: jest.fn().mockReturnValue('mock-fingerprint'),
  getCachedDistillation: jest.fn().mockResolvedValue(null),
  setCachedDistillation: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../../connectors/connector-service-client', () => ({
  getCatalog: jest.fn().mockResolvedValue({ connectors: [], version: 'v1', categoryLabels: {} }),
  resetCatalogCache: jest.fn(),
}));

jest.mock('../../agent-chat/slack-adapter/repository', () => ({
  getInstalledSlackAppCount: jest.fn().mockResolvedValue(0),
}));

import { distillInternalAgentWithProgress } from '../distill-service';
import { llmClient } from '../../llm/client';
import { tenantRuntimeClient } from '../../connectors/tenant-runtime-client';
import { log } from '../../infrastructure/logging';
import type { LLMCompletionResponse, LLMMessage } from '../../llm/types';

const mockComplete = llmClient.complete as jest.MockedFunction<typeof llmClient.complete>;
const mockGetManifests = tenantRuntimeClient.getTenantManifests as jest.MockedFunction<
  typeof tenantRuntimeClient.getTenantManifests>;
const mockGetCatalog = tenantRuntimeClient.getToolCatalog as jest.MockedFunction<
  typeof tenantRuntimeClient.getToolCatalog>;

const INPUT = {
  role: 'Open internet researcher',
  responsibilities: 'Browse the internet as instructed.',
  integrations: [],
  tenantId: 'tenant-1',
};

/** The marker every branch call carries and the single call never does. */
const BRANCH_MARKER = 'THIS CALL PRODUCES ONE PART OF THE DEFINITION';

const isBranchCall = (args: { messages: LLMMessage[] }) =>
  args.messages.some(m => typeof m.content === 'string' && m.content.includes(BRANCH_MARKER));

function singleArtifact(): LLMCompletionResponse {
  return {
    content: '',
    model: 'test-model',
    provider: 'anthropic',
    stopReason: 'tool_use',
    toolCalls: [{
      id: 'call-single',
      name: 'produce_agent',
      input: {
        summary: 'Researches questions on the open web and reports sourced answers.',
        systemPrompt: 'You are the Open Internet Researcher.',
        userInstructions: 'Answer research questions with sources.',
        instructionsMd: '## Role\n## Tool-use guidance\n## Escalation rules\n'
          + '## Output format\n## Pitfalls and gotchas\nPlaceholder.',
        triggerConfig: { type: 'manual', reasoning: 'Requests arrive by hand.' },
        skills: [{
          name: 'Answering a research question',
          description: 'Use when asked to research something.',
          instruction: 'Search, verify, then write it up with sources.',
        }],
        capabilityNeeds: { workspace: false, reasoning: 'Web reading needs no filesystem.' },
      },
    }],
  };
}

describe('waved distill falls back rather than failing', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetManifests.mockResolvedValue({ manifests: [] } as never);
    mockGetCatalog.mockResolvedValue({ aliasedTools: {} } as never);
  });

  it('returns the single call\'s agent when every branch call fails', async () => {
    // Total branch failure — the worst case the split can produce.
    mockComplete.mockImplementation(async (args) => {
      if (isBranchCall(args as { messages: LLMMessage[] })) {
        throw new Error('branch call failed');
      }
      return singleArtifact();
    });

    const out = await distillInternalAgentWithProgress({ ...INPUT, strategy: 'waved' });

    // The person gets a usable agent, which is the only acceptable outcome.
    expect(out.agentType).toBe('agent');
    expect(out.summary).toContain('open web');
    expect(mockComplete.mock.calls.some(c => !isBranchCall(c[0] as { messages: LLMMessage[] })))
      .toBe(true);
  });

  it('records the fallback rather than swallowing it', async () => {
    // A silent fallback would let the split look healthy in production while
    // never actually running, which is how a failed experiment survives.
    mockComplete.mockImplementation(async (args) => {
      if (isBranchCall(args as { messages: LLMMessage[] })) throw new Error('branch call failed');
      return singleArtifact();
    });

    await distillInternalAgentWithProgress({ ...INPUT, strategy: 'waved' });

    const logged = (log.error as jest.Mock).mock.calls.some(
      ([fields]) => (fields as { metric?: string })?.metric === 'distill.waved.fell_back_to_single');
    expect(logged).toBe(true);
  });

  it('does not fall back when the waved arm succeeds', async () => {
    // The fallback is a floor, not a shortcut: if branches are working, the
    // single call must not run at all, or the split costs double for nothing.
    let branchCalls = 0;
    mockComplete.mockImplementation(async (args) => {
      if (!isBranchCall(args as { messages: LLMMessage[] })) {
        throw new Error('single call should not have run');
      }
      branchCalls += 1;
      return singleArtifact();
    });

    await distillInternalAgentWithProgress({ ...INPUT, strategy: 'waved' });

    expect(branchCalls).toBeGreaterThan(0);
    const fellBack = (log.error as jest.Mock).mock.calls.some(
      ([fields]) => (fields as { metric?: string })?.metric === 'distill.waved.fell_back_to_single');
    expect(fellBack).toBe(false);
  });
});
