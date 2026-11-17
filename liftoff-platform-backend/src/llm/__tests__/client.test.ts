// purposeToGroup — which Anthropic key group a call purpose lands on.
//
// The group is the line the spend shows up under in the vendor's console. The
// distiller's patch rung is one call inside a distillation and stands in for
// the distill call it replaces, so it has to land on the same key: a patch on
// a different group would move that spend to another line, and the two could
// then drift apart on a later change to the default.

jest.mock('../../infrastructure/logging', () => ({
  log: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.mock('../providers', () => ({
  AnthropicProvider: { create: jest.fn().mockResolvedValue(null), createPool: jest.fn().mockResolvedValue(null) },
  GoogleProvider: { create: jest.fn().mockResolvedValue(null) },
  OpenRouterProvider: { createOpenRouter: jest.fn().mockResolvedValue(null) },
  OpenAIProvider: { create: jest.fn().mockResolvedValue(null), createPool: jest.fn().mockResolvedValue(null) },
}));

import { llmClient, purposeToGroup } from '../client';

describe('purposeToGroup', () => {
  it("routes distill_patch to the group 'distill' takes", () => {
    expect(purposeToGroup('distill_patch')).toBe(purposeToGroup('distill'));
  });

  it('names that group explicitly rather than through the default', () => {
    // Pinned so a later change to the default cannot move one without the
    // other. Today both are the agent-execution key.
    expect(purposeToGroup('distill')).toBe('agent-execution');
    expect(purposeToGroup('distill_patch')).toBe('agent-execution');
  });

  it('leaves the other groups where they were', () => {
    expect(purposeToGroup(undefined)).toBe('agent-execution');
    expect(purposeToGroup('reflection')).toBe('reflective-services');
    expect(purposeToGroup('caio_workforce_planning')).toBe('platform-analytics');
    expect(purposeToGroup('title_generation')).toBe('background-services');
    expect(purposeToGroup('agent_execution')).toBe('agent-execution');
  });
});

// The window a chat loop guards against: the registry's, or 128k when the
// registry holds none for the model.
import {
  _setRegistryContextWindowsForTests,
  DEFAULT_CONTEXT_WINDOW,
} from '../registry-tier-loader';

describe('llmClient.contextWindowFor', () => {
  it('reads the registry cache and falls back to the default window', () => {
    _setRegistryContextWindowsForTests({ 'anthropic:claude-x': 1_000_000 });
    expect(llmClient.contextWindowFor('anthropic', 'claude-x')).toBe(1_000_000);
    expect(llmClient.contextWindowFor('anthropic', 'claude-unsized')).toBe(DEFAULT_CONTEXT_WINDOW);
    expect(llmClient.contextWindowFor('anthropic', undefined)).toBe(DEFAULT_CONTEXT_WINDOW);
    expect(DEFAULT_CONTEXT_WINDOW).toBe(128_000);
  });
});
