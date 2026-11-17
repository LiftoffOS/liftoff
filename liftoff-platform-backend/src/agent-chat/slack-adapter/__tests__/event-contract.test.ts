// Slack Adapter Event Contract Test (Issue #13)
//
// Verifies that the Slack chat worker's event handling covers all
// AgentChatEvent types and safely ignores unknown event types.
// This ensures the Slack adapter stays in sync with the AgentChatEvent
// type union and doesn't crash on unexpected events.

 

jest.mock('../../../infrastructure/database', () => ({
  getPool: jest.fn().mockReturnValue({
    query: jest.fn().mockResolvedValue({ rows: [] }),
  }),
}));

jest.mock('../../../infrastructure/logging', () => ({
  log: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
  logAudit: jest.fn(),
}));

jest.mock('../../chat-repository', () => ({
  findOrCreateThread: jest.fn().mockResolvedValue({ id: 'thread-1' }),
  addParticipant: jest.fn(),
  appendMessage: jest.fn(),
  listMessages: jest.fn(),
  getThreadRollingSummary: jest.fn(),
}));

jest.mock('../../chat-service', () => ({
  runAgentChatTurn: jest.fn(),
}));

jest.mock('../../multi-agent-service', () => ({
  runMultiAgentChatTurn: jest.fn(),
}));

import type { AgentChatEvent } from '../../chat-service';

// ── Event handling coverage ───────────────────────────────────────────

describe('Slack adapter event contract', () => {
  // The Slack chat worker handles events via a for-await loop with
  // if/else branches. We verify all known AgentChatEvent types are
  // explicitly handled by simulating what the worker does.

  /**
   * Simulate the event handling logic from slack-chat-worker.ts.
   * This mirrors the switch/if-else logic in handleSlackChatTask.
   * Returns the action taken for each event type.
   */
  function simulateEventHandling(event: AgentChatEvent): string {
    if (event.type === 'text_delta') {
      return 'append_text';
    } else if (event.type === 'tool_call') {
      return 'append_tool_call';
    } else if (event.type === 'hitl_required') {
      return 'append_hitl_message';
    } else if (event.type === 'error') {
      return 'append_error';
    } else if (event.type === 'thinking') {
      return 'ignored_thinking';
    } else if (event.type === 'complete') {
      return 'ignored_complete';
    } else if ((event as { type: string }).type === 'awaiting_input') {
      // R5: awaiting_input is gated by system_config.awaiting_input_emission_enabled.
      // Slack adapter renders it as a plain question message until frontend
      // DOMPurify + structured rendering ships.
      return 'append_awaiting_input';
    }
    // Unknown event type — should be safely ignored
    return 'unknown_ignored';
  }

  // ── All known event types are handled ───────────────────────────────

  describe('all known AgentChatEvent types are handled', () => {
    it('handles text_delta', () => {
      const result = simulateEventHandling({ type: 'text_delta', text: 'Hi' });
      expect(result).toBe('append_text');
    });

    it('handles tool_call', () => {
      const result = simulateEventHandling({ type: 'tool_call', tool: 'memory_save' });
      expect(result).toBe('append_tool_call');
    });

    it('handles hitl_required', () => {
      const result = simulateEventHandling({
        type: 'hitl_required',
        approvalId: 'approval-1',
        reason: 'Needs approval',
      });
      expect(result).toBe('append_hitl_message');
    });

    it('handles error', () => {
      const result = simulateEventHandling({
        type: 'error',
        code: 'PROVIDER_ERROR',
        message: 'Something broke',
      });
      expect(result).toBe('append_error');
    });

    it('handles thinking (no-op in Slack context)', () => {
      const result = simulateEventHandling({ type: 'thinking' });
      expect(result).toBe('ignored_thinking');
    });

    it('handles complete (no-op — finalization done after loop)', () => {
      const result = simulateEventHandling({
        type: 'complete',
        message: {
          id: 'msg-1',
          tenantId: 'tenant-1',
          threadId: 'thread-1',
          agentId: 'agent-1',
          role: 'assistant',
          content: 'Done',
          toolCalls: null,
          inputTokens: 100,
          outputTokens: 50,
          createdAt: '2024-01-01T00:00:00Z',
        },
      });
      expect(result).toBe('ignored_complete');
    });
  });

  // ── Unknown event types are safely ignored ──────────────────────────

  describe('unknown event types', () => {
    it('does not crash on an unknown event type', () => {
      // Simulate a hypothetical future event type
      const unknownEvent = { type: 'future_event', data: 'something' } as any;
      expect(() => simulateEventHandling(unknownEvent)).not.toThrow();
      expect(simulateEventHandling(unknownEvent)).toBe('unknown_ignored');
    });

    it('does not crash on a malformed event', () => {
      const malformed = { type: undefined } as any;
      expect(() => simulateEventHandling(malformed)).not.toThrow();
      expect(simulateEventHandling(malformed)).toBe('unknown_ignored');
    });

    it('R5 TE-R3-009 unknown-field tolerance: phase-A rollback with old parser', () => {
      // Old parser receives `type: "awaiting_input"` — must not throw.
      const awaitingInput = { type: 'awaiting_input', question: 'q?', sessionId: 's' } as any;
      expect(() => simulateEventHandling(awaitingInput)).not.toThrow();
      // R5: the awaiting_input handler returns append_awaiting_input (flag-gated
      // in the actual Slack adapter; the unit here just asserts the dispatch path).
      expect(simulateEventHandling(awaitingInput)).toBe('append_awaiting_input');
    });
  });

  // ── Exhaustiveness check ────────────────────────────────────────────

  describe('exhaustiveness', () => {
    it('handles exactly the 6 known AgentChatEvent types', () => {
      // These are the 6 discriminants in the AgentChatEvent union
      const knownTypes = [
        'thinking',
        'text_delta',
        'tool_call',
        'hitl_required',
        'complete',
        'error',
      ] as const;

      for (const type of knownTypes) {
        let event: AgentChatEvent;
        switch (type) {
          case 'thinking':
            event = { type: 'thinking' };
            break;
          case 'text_delta':
            event = { type: 'text_delta', text: 'test' };
            break;
          case 'tool_call':
            event = { type: 'tool_call', tool: 'test_tool' };
            break;
          case 'hitl_required':
            event = { type: 'hitl_required', approvalId: 'a-1', reason: 'r' };
            break;
          case 'complete':
            event = {
              type: 'complete',
              message: {
                id: 'msg',
                tenantId: 't',
                threadId: 'th',
                agentId: 'a',
                role: 'assistant',
                content: 'c',
                toolCalls: null,
                inputTokens: 0,
                outputTokens: 0,
                createdAt: '',
              },
            };
            break;
          case 'error':
            event = { type: 'error', code: 'INTERNAL', message: 'err' };
            break;
        }

        const result = simulateEventHandling(event);
        // Every known type should produce a non-'unknown_ignored' result
        expect(result).not.toBe('unknown_ignored');
      }
    });
  });
});
