// Tests for the write-time skill-embedding retry helper.
//
// Mocks generateEmbedding (the underlying call) and a no-op delay so
// retries are synchronous and we can assert on attempt counts.

import { jest } from '@jest/globals';

const generateEmbeddingMock = jest.fn();
const errorLogMock = jest.fn();

jest.mock('../../memory/embedding', () => ({
  generateEmbedding: generateEmbeddingMock,
}));

jest.mock('../../infrastructure/logging', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: errorLogMock },
}));

import {
  generateSkillEmbeddingWithRetry,
  EMBED_MAX_ATTEMPTS,
  EMBED_BACKOFF_MS,
} from '../skill-embedding';

const CTX = { tenantId: 't1', agentId: 'a1', skillName: 'test-skill' };

afterEach(() => {
  jest.clearAllMocks();
});

describe('generateSkillEmbeddingWithRetry', () => {
  it('returns the embedding on first attempt when generateEmbedding succeeds', async () => {
    generateEmbeddingMock.mockImplementationOnce(() => Promise.resolve([0.1, 0.2, 0.3]));

    const noopDelay = jest.fn(() => Promise.resolve());
    const result = await generateSkillEmbeddingWithRetry('text', CTX, { delay: noopDelay });

    expect(result).toEqual([0.1, 0.2, 0.3]);
    expect(generateEmbeddingMock).toHaveBeenCalledTimes(1);
    expect(noopDelay).not.toHaveBeenCalled();
    expect(errorLogMock).not.toHaveBeenCalled();
  });

  it('retries on transient failure and succeeds within budget', async () => {
    generateEmbeddingMock
      .mockImplementationOnce(() => Promise.reject(new Error('ECONNRESET')))
      .mockImplementationOnce(() => Promise.resolve([0.5, 0.5]));

    const noopDelay = jest.fn(() => Promise.resolve());
    const result = await generateSkillEmbeddingWithRetry('text', CTX, { delay: noopDelay });

    expect(result).toEqual([0.5, 0.5]);
    expect(generateEmbeddingMock).toHaveBeenCalledTimes(2);
    // First attempt skips delay; second attempt is preceded by delay(EMBED_BACKOFF_MS[1]).
    expect(noopDelay).toHaveBeenCalledTimes(1);
    expect(noopDelay).toHaveBeenCalledWith(EMBED_BACKOFF_MS[1]);
    expect(errorLogMock).not.toHaveBeenCalled();
  });

  it('returns null + logs ERROR after EMBED_MAX_ATTEMPTS failures', async () => {
    generateEmbeddingMock.mockImplementation(() => Promise.reject(new Error('quota exceeded')));

    const noopDelay = jest.fn(() => Promise.resolve());
    const result = await generateSkillEmbeddingWithRetry('text', CTX, { delay: noopDelay });

    expect(result).toBeNull();
    expect(generateEmbeddingMock).toHaveBeenCalledTimes(EMBED_MAX_ATTEMPTS);
    // Delays between attempts: attempt 0 has no preceding delay; attempts
    // 1 and 2 each get one. So MAX_ATTEMPTS-1 delays.
    expect(noopDelay).toHaveBeenCalledTimes(EMBED_MAX_ATTEMPTS - 1);
    expect(errorLogMock).toHaveBeenCalledTimes(1);
    const [logCtx, logMsg] = errorLogMock.mock.calls[0] as [{ err?: string; attempts?: number; skillName?: string }, string];
    expect(logCtx.attempts).toBe(EMBED_MAX_ATTEMPTS);
    expect(logCtx.err).toBe('quota exceeded');
    expect(logCtx.skillName).toBe('test-skill');
    expect(logMsg).toContain('skill-embedding-sweeper will recover');
  });

  it('default delay implementation does not throw when no override is supplied', async () => {
    // Real delay path — fast because retries succeed immediately.
    generateEmbeddingMock.mockImplementationOnce(() => Promise.resolve([0.9]));
    const result = await generateSkillEmbeddingWithRetry('text', CTX);
    expect(result).toEqual([0.9]);
  });
});
