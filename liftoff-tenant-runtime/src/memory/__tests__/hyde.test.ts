// HyDE (Hypothetical Document Embeddings) Tests

const mockGetModelForTask = jest.fn();
jest.mock('../../entitlements-client/service', () => ({
  getEntitlementsClient: () => ({ getModelForTask: mockGetModelForTask }),
}));

jest.mock('../../llm/client', () => ({
  llmClient: {
    modelSelectionFor: (pair: { model?: string; provider?: string } | null | undefined) =>
      (pair?.model
        ? { provider: pair.provider ?? 'anthropic', model: pair.model }
        : (pair?.provider ? { provider: pair.provider } : {})),
    complete: jest.fn(),
  },
}));

import { generateHypotheticalDocument } from '../hyde';
import { llmClient } from '../../llm/client';

const mockComplete = llmClient.complete as jest.Mock;

describe('generateHypotheticalDocument', () => {
  beforeEach(() => {
    mockComplete.mockReset();
    mockGetModelForTask.mockReset();
    mockGetModelForTask.mockResolvedValue(null);
  });

  it('uses model from entitlements when configured', async () => {
    mockGetModelForTask.mockResolvedValue({ model: 'claude-haiku-4-5-20251001', provider: 'anthropic' });
    mockComplete.mockResolvedValue({ content: 'Hypothetical document text.' });
    await generateHypotheticalDocument('test query', 'tenant-1');
    expect(mockComplete).toHaveBeenCalledTimes(1);
    const [request, selection] = mockComplete.mock.calls[0];
    // The model and the provider it belongs to arrive as ONE value. They used
    // to be a `model` inside the request and a separate provider argument,
    // which let three call sites pair them from different sources — a provider
    // pinned to the platform default receiving another provider's model.
    expect(selection).toEqual({ provider: 'anthropic', model: 'claude-haiku-4-5-20251001' });
    // And the request is no longer a channel for it, so a stale model cannot
    // reach a provider by the back door.
    expect(request.model).toBeUndefined();
  });

  it('omits model when entitlements returns null (provider picks default)', async () => {
    mockGetModelForTask.mockResolvedValue(null);
    mockComplete.mockResolvedValue({ content: 'Hypothetical document text.' });
    await generateHypotheticalDocument('test query', 'tenant-1');
    const [request] = mockComplete.mock.calls[0];
    expect(request.model).toBeUndefined();
  });

  it('passes purpose=retrieval_hyde in usageContext', async () => {
    mockComplete.mockResolvedValue({ content: 'Hypothetical doc.' });
    await generateHypotheticalDocument('test query', 'tenant-1');
    const [, , usageContext] = mockComplete.mock.calls[0];
    expect(usageContext.purpose).toBe('retrieval_hyde');
  });

  it('includes agentId in usageContext when provided', async () => {
    mockComplete.mockResolvedValue({ content: 'Hypothetical doc.' });
    await generateHypotheticalDocument('test query', 'tenant-1', 'agent-42');
    const [, , usageContext] = mockComplete.mock.calls[0];
    expect(usageContext.agentId).toBe('agent-42');
  });

  it('does not include agentId key when not provided', async () => {
    mockComplete.mockResolvedValue({ content: 'Hypothetical doc.' });
    await generateHypotheticalDocument('test query', 'tenant-1');
    const [, , usageContext] = mockComplete.mock.calls[0];
    expect(Object.keys(usageContext)).not.toContain('agentId');
  });

  it('returns the hypothetical document text', async () => {
    mockComplete.mockResolvedValue({ content: 'The answer is 42.' });
    const result = await generateHypotheticalDocument('What is the answer?', 'tenant-1');
    expect(result).toBe('The answer is 42.');
  });

  it('falls back to original query string when llmClient throws', async () => {
    mockComplete.mockRejectedValue(new Error('LLM unavailable'));
    const result = await generateHypotheticalDocument('my query', 'tenant-1');
    expect(result).toBe('my query');
  });

  it('does not throw when llmClient throws', async () => {
    mockComplete.mockRejectedValue(new Error('LLM error'));
    await expect(generateHypotheticalDocument('query', 'tenant-1')).resolves.toBeDefined();
  });

  it('uses the returned text as embedding input (not raw query)', async () => {
    const hydeText = 'This is the hypothetical document that answers the question.';
    mockComplete.mockResolvedValue({ content: hydeText });
    const result = await generateHypotheticalDocument('what is the question?', 'tenant-1');
    // The result should be the hypothetical doc, not the query
    expect(result).toBe(hydeText);
    expect(result).not.toBe('what is the question?');
  });
});
