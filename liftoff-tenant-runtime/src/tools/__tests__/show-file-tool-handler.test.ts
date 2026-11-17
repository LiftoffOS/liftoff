/**
 * Showing a file is a separate act from storing one.
 *
 * A custom API answers with a PDF; the bytes go to the workspace store,
 * attributed to the agent that fetched them, and nothing could ever put them
 * in front of a person — the card was only ever written by the same request
 * that created the file. This tool is that second act, and the properties
 * below are the ones that make it honest: the conversation comes from the
 * call, the attribution is real, and a card that was not appended never reads
 * as one.
 */
const mockPresent = jest.fn();
const mockResolve = jest.fn();

jest.mock('../../clients/generated-files-client', () => ({
  presentGeneratedFile: (...a: unknown[]) => mockPresent(...a),
}));
jest.mock('../../agent-lifecycle/resolve-runtime-agent-id', () => ({
  resolveInternalAgentId: (...a: unknown[]) => mockResolve(...a),
}));

import { handleShowFile } from '../show-file-tool-handler';
import type { StandardToolContext } from '../standard-tool-handler';

const CTX = {
  tenantId: 't1',
  agentId: 'runtime-agent-1',
  threadId: 'thread-1',
  turnId: 'turn-1',
  memoryScope: 'agent',
} as unknown as StandardToolContext;

beforeEach(() => {
  jest.clearAllMocks();
  mockResolve.mockResolvedValue('internal-agent-1');
  mockPresent.mockResolvedValue({ filename: 'invoice_v1.pdf', outputType: 'pdf', version: 1 });
});

it('shows the file in the conversation the CALL is in, never one carried by the file', async () => {
  const out = await handleShowFile({ file_id: 'file-1' }, CTX);

  expect(out.success).toBe(true);
  expect(mockPresent).toHaveBeenCalledWith(expect.objectContaining({
    tenantId: 't1',
    generatedFileId: 'file-1',
    conversationId: 'thread-1',
    turnId: 'turn-1',
  }));
});

it('attributes the card to the control-plane id, not the runtime one', async () => {
  // A wrong-space id matches no row and the card belongs to nobody (ADR-039).
  await handleShowFile({ file_id: 'file-1' }, CTX);
  expect(mockResolve).toHaveBeenCalledWith('t1', 'runtime-agent-1', 'show-file');
  expect(mockPresent.mock.calls[0][0].internalAgentId).toBe('internal-agent-1');
});

it('refuses when there is no conversation to show it in', async () => {
  // An autonomous run has no chat, and a card with no thread is one nobody sees.
  const out = await handleShowFile({ file_id: 'file-1' }, { ...CTX, threadId: undefined } as StandardToolContext);
  expect(out.success).toBe(false);
  expect(out.error).toMatch(/no conversation/i);
  expect(mockPresent).not.toHaveBeenCalled();
});

it('refuses when the agent has no control-plane id', async () => {
  mockResolve.mockResolvedValue(null);
  const out = await handleShowFile({ file_id: 'file-1' }, CTX);
  expect(out.success).toBe(false);
  expect(mockPresent).not.toHaveBeenCalled();
});

it('asks for an id rather than guessing one', async () => {
  for (const input of [{}, { file_id: '' }, { file_id: '   ' }]) {
    const out = await handleShowFile(input, CTX);
    expect(out.success).toBe(false);
    expect(out.error).toMatch(/file_id/);
  }
  expect(mockPresent).not.toHaveBeenCalled();
});

it('reports a failure as a failure, never as a card that was appended', async () => {
  // A fabricated success here becomes a reply saying "attached below" over
  // nothing at all.
  mockPresent.mockRejectedValue(new Error('404 no file in this workspace'));
  const out = await handleShowFile({ file_id: 'file-1' }, CTX);
  expect(out.success).toBe(false);
  expect(out.error).toMatch(/could not be shown/i);
  expect(out.result).toBeUndefined();
});
