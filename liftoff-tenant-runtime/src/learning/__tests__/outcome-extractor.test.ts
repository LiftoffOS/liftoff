// Outcome Extractor Tests

import { extractAndSaveLearnings } from '../outcome-extractor';

// Mock memoryService
jest.mock('../../memory/service', () => ({
  memoryService: {
    saveMemory: jest.fn().mockResolvedValue('memory-id'),
  },
}));

// Mock logger
jest.mock('../../infrastructure/logging', () => ({
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  },
}));

const { memoryService } = require('../../memory/service');

beforeEach(() => {
  jest.clearAllMocks();
});

describe('extractAndSaveLearnings', () => {
  const tenantId = 'tenant-1';
  const agentId = 'agent-1';

  it('extracts error pattern when tool call fails', async () => {
    await extractAndSaveLearnings(tenantId, agentId, {
      invocationId: 'inv-1',
      agentId,
      objective: 'Send email',
      outcome: 'error',
      errorMessage: 'Tool failed',
      toolCalls: [
        { id: 'tc-1', name: 'gmail__send_email', input: {}, error: 'Rate limit exceeded' },
      ],
    });

    expect(memoryService.saveMemory).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId,
        agentId,
        layer: 'individual',
        scopeKey: 'error-pattern-gmail__send_email',
        content: expect.stringContaining('gmail__send_email'),
        tags: expect.arrayContaining(['error-pattern', 'auto-extracted']),
      })
    );
  });

  it('does NOT store raw tool input in error memory (REVIEW FIX DE-011)', async () => {
    await extractAndSaveLearnings(tenantId, agentId, {
      invocationId: 'inv-1',
      agentId,
      objective: 'Send email',
      outcome: 'error',
      toolCalls: [
        { id: 'tc-1', name: 'gmail__send_email', input: { to: 'secret@email.com' }, error: 'Failed' },
      ],
    });

    const savedContent = (memoryService.saveMemory as jest.Mock).mock.calls[0][0].content;
    expect(savedContent).not.toContain('secret@email.com');
    expect(savedContent).toContain('gmail__send_email');
  });

  it('extracts escalation context', async () => {
    await extractAndSaveLearnings(tenantId, agentId, {
      invocationId: 'inv-2',
      agentId,
      objective: 'Complex task requiring approval',
      outcome: 'escalated',
      errorMessage: 'Need human help',
      toolCalls: [],
    });

    expect(memoryService.saveMemory).toHaveBeenCalledWith(
      expect.objectContaining({
        layer: 'individual',
        content: expect.stringContaining('Escalated to human'),
        tags: expect.arrayContaining(['escalation', 'auto-extracted']),
      })
    );
  });

  it('extracts retry-success pattern', async () => {
    await extractAndSaveLearnings(tenantId, agentId, {
      invocationId: 'inv-3',
      agentId,
      objective: 'Update CRM',
      outcome: 'error',
      toolCalls: [
        { id: 'tc-1', name: 'hubspot__update', input: {}, error: 'Invalid format' },
        { id: 'tc-2', name: 'hubspot__update', input: {}, output: { success: true } },
      ],
    });

    // Should have both error pattern AND retry-success
    expect(memoryService.saveMemory).toHaveBeenCalledTimes(2);
    const calls = (memoryService.saveMemory as jest.Mock).mock.calls;
    const scopeKeys = calls.map((c: [{ scopeKey: string }]) => c[0].scopeKey);
    expect(scopeKeys).toContain('error-pattern-hubspot__update');
    expect(scopeKeys).toContain('retry-success-hubspot__update');
  });

  it('does nothing when invocation is clean success with fewer than 3 tool calls', async () => {
    await extractAndSaveLearnings(tenantId, agentId, {
      invocationId: 'inv-4',
      agentId,
      objective: 'Simple task',
      outcome: 'success',
      toolCalls: [
        { id: 'tc-1', name: 'gmail__read', input: {}, output: { data: [] } },
      ],
    });

    // 1-2 clean tool calls: no success memory
    expect(memoryService.saveMemory).not.toHaveBeenCalled();
  });

  it('extracts success-sequence for 3+ clean tool calls', async () => {
    await extractAndSaveLearnings(tenantId, agentId, {
      invocationId: 'inv-success',
      agentId,
      objective: 'Complex CRM task',
      outcome: 'success',
      toolCalls: [
        { id: 'tc-1', name: 'hubspot__search', input: {}, output: {} },
        { id: 'tc-2', name: 'hubspot__update', input: {}, output: {} },
        { id: 'tc-3', name: 'slack__send', input: {}, output: {} },
      ],
    });

    expect(memoryService.saveMemory).toHaveBeenCalledWith(
      expect.objectContaining({
        scopeKey: 'success-sequence-hubspot__search',
        content: expect.stringContaining('hubspot__search → hubspot__update → slack__send'),
        tags: expect.arrayContaining(['success-pattern', 'auto-extracted', 'hubspot__search']),
      })
    );
  });

  it('does NOT extract success-sequence when some calls have errors', async () => {
    await extractAndSaveLearnings(tenantId, agentId, {
      invocationId: 'inv-mixed',
      agentId,
      objective: 'Mixed task',
      outcome: 'success',
      toolCalls: [
        { id: 'tc-1', name: 'tool1', input: {}, output: {} },
        { id: 'tc-2', name: 'tool2', input: {}, error: 'Failed' },
        { id: 'tc-3', name: 'tool3', input: {}, output: {} },
      ],
    });

    const calls = (memoryService.saveMemory as jest.Mock).mock.calls;
    const scopeKeys = calls.map((c: [{ scopeKey: string }]) => c[0].scopeKey);
    expect(scopeKeys).not.toContain(expect.stringContaining('success-sequence'));
  });

  it('extracts success-sequence with exactly 3 calls (boundary)', async () => {
    await extractAndSaveLearnings(tenantId, agentId, {
      invocationId: 'inv-boundary',
      agentId,
      objective: 'Task',
      outcome: 'success',
      toolCalls: [
        { id: 'tc-1', name: 'a', input: {}, output: {} },
        { id: 'tc-2', name: 'b', input: {}, output: {} },
        { id: 'tc-3', name: 'c', input: {}, output: {} },
      ],
    });

    const calls = (memoryService.saveMemory as jest.Mock).mock.calls;
    const scopeKeys = calls.map((c: [{ scopeKey: string }]) => c[0].scopeKey);
    expect(scopeKeys).toContain('success-sequence-a');
  });

  it('uses 30-day TTL for success memories', async () => {
    await extractAndSaveLearnings(tenantId, agentId, {
      invocationId: 'inv-ttl',
      agentId,
      objective: 'Task',
      outcome: 'success',
      toolCalls: [
        { id: 'tc-1', name: 'a', input: {}, output: {} },
        { id: 'tc-2', name: 'b', input: {}, output: {} },
        { id: 'tc-3', name: 'c', input: {}, output: {} },
      ],
    });

    const opts = (memoryService.saveMemory as jest.Mock).mock.calls[0][0];
    const ttlDays = (opts.expiresAt.getTime() - Date.now()) / (24 * 60 * 60 * 1000);
    expect(ttlDays).toBeGreaterThan(29);
    expect(ttlDays).toBeLessThan(31);
  });

  describe('Gap 8 — volume dedup for success sequences', () => {
    it('same 3-tool sequence 100 times → identical scopeKey + content (content_hash dedup)', async () => {
      const toolCalls = [
        { id: 'tc-1', name: 'hubspot__search', input: {}, output: {} },
        { id: 'tc-2', name: 'hubspot__update', input: {}, output: {} },
        { id: 'tc-3', name: 'slack__send', input: {}, output: {} },
      ];

      // Run 100 times
      for (let i = 0; i < 100; i++) {
        jest.clearAllMocks();
        await extractAndSaveLearnings(tenantId, agentId, {
          invocationId: `inv-vol-${i}`,
          agentId,
          objective: 'CRM update',
          outcome: 'success',
          toolCalls,
        });
      }

      // Collect all scopeKey + content pairs from the last 100 runs
      // (we cleared mocks each iteration, so re-run once more to capture)
      jest.clearAllMocks();
      const pairs: Array<{ scopeKey: string; content: string }> = [];

      for (let i = 0; i < 100; i++) {
        (memoryService.saveMemory as jest.Mock).mockClear();
        await extractAndSaveLearnings(tenantId, agentId, {
          invocationId: `inv-verify-${i}`,
          agentId,
          objective: 'CRM update',
          outcome: 'success',
          toolCalls,
        });
        const call = (memoryService.saveMemory as jest.Mock).mock.calls[0]?.[0];
        if (call && call.scopeKey.startsWith('success-sequence')) {
          pairs.push({ scopeKey: call.scopeKey, content: call.content });
        }
      }

      // All 100 should produce the exact same scopeKey and content
      expect(pairs.length).toBe(100);
      const uniqueScopeKeys = new Set(pairs.map(p => p.scopeKey));
      const uniqueContents = new Set(pairs.map(p => p.content));
      expect(uniqueScopeKeys.size).toBe(1); // only 1 unique scopeKey
      expect(uniqueContents.size).toBe(1);  // only 1 unique content
      // ON CONFLICT (tenant_id, layer, scope_key, content_hash) guarantees only 1 row
    });

    it('10 different 3-tool sequences → 10 distinct memories (different scope_keys)', async () => {
      const sequences = [
        ['alpha__a', 'alpha__b', 'alpha__c'],
        ['bravo__a', 'bravo__b', 'bravo__c'],
        ['charlie__a', 'charlie__b', 'charlie__c'],
        ['delta__a', 'delta__b', 'delta__c'],
        ['echo__a', 'echo__b', 'echo__c'],
        ['foxtrot__a', 'foxtrot__b', 'foxtrot__c'],
        ['golf__a', 'golf__b', 'golf__c'],
        ['hotel__a', 'hotel__b', 'hotel__c'],
        ['india__a', 'india__b', 'india__c'],
        ['juliet__a', 'juliet__b', 'juliet__c'],
      ];

      const pairs: Array<{ scopeKey: string; content: string }> = [];

      for (const seq of sequences) {
        (memoryService.saveMemory as jest.Mock).mockClear();
        await extractAndSaveLearnings(tenantId, agentId, {
          invocationId: `inv-seq-${seq[0]}`,
          agentId,
          objective: 'Task',
          outcome: 'success',
          toolCalls: seq.map((name, i) => ({ id: `tc-${i}`, name, input: {}, output: {} })),
        });
        const call = (memoryService.saveMemory as jest.Mock).mock.calls[0]?.[0];
        if (call && call.scopeKey.startsWith('success-sequence')) {
          pairs.push({ scopeKey: call.scopeKey, content: call.content });
        }
      }

      expect(pairs.length).toBe(10);
      const uniqueScopeKeys = new Set(pairs.map(p => p.scopeKey));
      const uniqueContents = new Set(pairs.map(p => p.content));
      // 10 different first-tool names → 10 different scope_keys
      expect(uniqueScopeKeys.size).toBe(10);
      // 10 different tool sequences → 10 different content hashes
      expect(uniqueContents.size).toBe(10);
    });
  });

  it('sets 30-day expiry on auto-generated memories', async () => {
    await extractAndSaveLearnings(tenantId, agentId, {
      invocationId: 'inv-5',
      agentId,
      objective: 'Task',
      outcome: 'error',
      toolCalls: [
        { id: 'tc-1', name: 'tool', input: {}, error: 'Failed' },
      ],
    });

    const expiresAt = (memoryService.saveMemory as jest.Mock).mock.calls[0][0].expiresAt;
    expect(expiresAt).toBeDefined();
    // Should be approximately 30 days from now
    const thirtyDaysMs = 30 * 24 * 60 * 60 * 1000;
    const delta = expiresAt.getTime() - Date.now();
    expect(delta).toBeGreaterThan(thirtyDaysMs - 60000); // within 1 minute
    expect(delta).toBeLessThan(thirtyDaysMs + 60000);
  });

  it('handles memoryService failure gracefully', async () => {
    (memoryService.saveMemory as jest.Mock).mockRejectedValueOnce(new Error('DB down'));

    // Should not throw
    await expect(extractAndSaveLearnings(tenantId, agentId, {
      invocationId: 'inv-6',
      agentId,
      objective: 'Task',
      outcome: 'error',
      toolCalls: [
        { id: 'tc-1', name: 'tool', input: {}, error: 'Failed' },
      ],
    })).resolves.toBeUndefined();
  });

  describe('provenance source wiring', () => {
    it('passes source with system_event nodeType and invocationId as refId', async () => {
      await extractAndSaveLearnings(tenantId, agentId, {
        invocationId: 'inv-prov-1',
        agentId,
        objective: 'Send email',
        outcome: 'error',
        toolCalls: [{ id: 'tc-1', name: 'gmail__send_email', input: {}, error: 'Rate limit' }],
      });

      expect(memoryService.saveMemory).toHaveBeenCalledWith(
        expect.objectContaining({
          source: expect.objectContaining({
            nodeType: 'system_event',
            refId: 'inv-prov-1',
            agentId,
            metadata: expect.objectContaining({
              triggerType: 'outcome_extract',
              outcome: 'error',
            }),
          }),
        })
      );
    });

    it('all saveMemory calls for the same invocation share the same refId', async () => {
      await extractAndSaveLearnings(tenantId, agentId, {
        invocationId: 'inv-prov-2',
        agentId,
        objective: 'Update CRM',
        outcome: 'error',
        toolCalls: [
          { id: 'tc-1', name: 'hubspot__update', input: {}, error: 'Invalid format' },
          { id: 'tc-2', name: 'hubspot__update', input: {}, output: { success: true } },
        ],
      });

      expect(memoryService.saveMemory).toHaveBeenCalledTimes(2);
      const refIds = (memoryService.saveMemory as jest.Mock).mock.calls.map(
        (c: [{ source: { refId: string } }]) => c[0].source.refId
      );
      expect(refIds[0]).toBe('inv-prov-2');
      expect(refIds[1]).toBe('inv-prov-2');
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Phase 1A: dedupScopeHint passed per memory category
// ═══════════════════════════════════════════════════════════════════════════

describe('Phase 1A: dedupScopeHint passed per memory category', () => {
  it('forwards dedupScopeHint with the right scopeKeyPrefix + requireTags', async () => {
    await extractAndSaveLearnings('tenant-1', 'agent-1', {
      invocationId: 'inv-dedup-1',
      agentId: 'agent-1',
      objective: 'Send email',
      outcome: 'error',
      errorMessage: 'Tool failed',
      toolCalls: [
        { id: 'tc-1', name: 'gmail__send_email', input: {}, error: 'Rate limit exceeded' },
      ],
    });

    expect(memoryService.saveMemory).toHaveBeenCalledWith(expect.objectContaining({
      scopeKey: 'error-pattern-gmail__send_email',
      semanticDedup: true,
      dedupScopeHint: expect.objectContaining({
        scopeKeyPrefix: 'error-pattern-',
        requireTags: expect.arrayContaining(['error-pattern']),
      }),
    }));
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Unresolved tool-name guard + objective threading
// ═══════════════════════════════════════════════════════════════════════════

describe('skips memories with unresolved (unknown) tool names', () => {
  const tenantId = 'tenant-1';
  const agentId = 'agent-1';

  it('does NOT mint an error-pattern memory for an unknown-named failed call', async () => {
    await extractAndSaveLearnings(tenantId, agentId, {
      invocationId: 'inv-unk-1',
      agentId,
      objective: 'Task',
      outcome: 'error',
      toolCalls: [{ id: 'tc-1', name: 'unknown', input: {}, error: 'Boom' }],
    });
    expect(memoryService.saveMemory).not.toHaveBeenCalled();
  });

  it('does NOT mint a retry-success memory when the name is unknown', async () => {
    await extractAndSaveLearnings(tenantId, agentId, {
      invocationId: 'inv-unk-2',
      agentId,
      objective: 'Task',
      outcome: 'error',
      toolCalls: [
        { id: 'tc-1', name: 'unknown', input: {}, error: 'Fail' },
        { id: 'tc-2', name: 'unknown', input: {}, output: { ok: true } },
      ],
    });
    const scopeKeys = (memoryService.saveMemory as jest.Mock).mock.calls.map((c: [{ scopeKey: string }]) => c[0].scopeKey);
    expect(scopeKeys).not.toContain('retry-success-unknown');
    expect(scopeKeys).not.toContain('error-pattern-unknown');
  });

  it('does NOT mint a success-sequence when any tool name is unknown', async () => {
    await extractAndSaveLearnings(tenantId, agentId, {
      invocationId: 'inv-unk-3',
      agentId,
      objective: 'Task',
      outcome: 'success',
      toolCalls: [
        { id: 'tc-1', name: 'a', input: {}, output: {} },
        { id: 'tc-2', name: 'unknown', input: {}, output: {} },
        { id: 'tc-3', name: 'c', input: {}, output: {} },
      ],
    });
    expect(memoryService.saveMemory).not.toHaveBeenCalled();
  });

  it('still extracts normally when names are all resolved', async () => {
    await extractAndSaveLearnings(tenantId, agentId, {
      invocationId: 'inv-unk-4',
      agentId,
      objective: 'Task',
      outcome: 'success',
      toolCalls: [
        { id: 'tc-1', name: 'a', input: {}, output: {} },
        { id: 'tc-2', name: 'b', input: {}, output: {} },
        { id: 'tc-3', name: 'c', input: {}, output: {} },
      ],
    });
    expect(memoryService.saveMemory).toHaveBeenCalledTimes(1);
    expect((memoryService.saveMemory as jest.Mock).mock.calls[0][0].scopeKey).toBe('success-sequence-a');
  });
});

describe('escalation memory carries the real objective', () => {
  it('embeds the passed objective text in the escalation content', async () => {
    await extractAndSaveLearnings('tenant-1', 'agent-1', {
      invocationId: 'inv-esc-obj',
      agentId: 'agent-1',
      objective: 'Draft the Q3 board report',
      outcome: 'escalated',
      errorMessage: 'Needs sign-off',
      toolCalls: [{ id: 'tc-1', name: 'gmail__send_email', input: {}, error: 'blocked' }],
    });
    const escalationCall = (memoryService.saveMemory as jest.Mock).mock.calls
      .map((c: [{ content: string; tags: string[] }]) => c[0])
      .find((o: { tags: string[] }) => o.tags.includes('escalation'));
    expect(escalationCall).toBeDefined();
    expect(escalationCall.content).toContain('Draft the Q3 board report');
  });
});
