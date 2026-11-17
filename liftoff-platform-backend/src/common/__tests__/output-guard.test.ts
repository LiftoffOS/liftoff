// The guard is the last reader before a person: a rewrite is what the
// person gets, an unchanged paragraph is byte-identical, and every failure
// fails open with the scrubbed text (a small-model outage must not silence
// the platform). What was rewritten is audited by kind, never by content.

jest.mock('../../llm', () => ({
  llmClient: { complete: jest.fn() },
}));

jest.mock('../../infrastructure/logging', () => ({
  log: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
  logAudit: jest.fn(),
}));

import { llmClient } from '../../llm';
import { log, logAudit } from '../../infrastructure/logging';
import { _resetOutputGuardState, guardOutgoingText, outputGuardEnabled } from '../output-guard';

const mockComplete = llmClient.complete as jest.Mock;
const mockAudit = logAudit as jest.Mock;
const mockLogError = log.error as jest.Mock;

const CTX = { tenantId: 'tenant-1', speaker: 'caio', threadId: 'thread-1' };

function reply(body: unknown) {
  mockComplete.mockResolvedValueOnce({
    content: typeof body === 'string' ? body : JSON.stringify(body),
    model: 'claude-haiku-4-5',
    provider: 'anthropic',
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  delete process.env['OUTPUT_GUARD'];
  _resetOutputGuardState();
});

afterEach(() => {
  jest.useRealTimers();
});

describe('guardOutgoingText', () => {
  it('returns the rewrite, and audits its kinds without its content', async () => {
    const leaked = 'I will add the note to the additional context field, per the request. Let Alex know when to apply it.';
    const clean = 'I will add the note under the team\'s instructions. Tell me when you want it applied.';
    reply({ changed: true, kinds: ['tool_or_field_name', 'mechanics', 'third_person'], text: clean });

    const result = await guardOutgoingText(leaked, CTX);

    expect(result).toEqual({ text: clean, changed: true, kinds: ['tool_or_field_name', 'mechanics', 'third_person'] });
    expect(mockAudit).toHaveBeenCalledTimes(1);
    const [action, ctx, details] = mockAudit.mock.calls[0];
    expect(action).toBe('output_guard.rewrote');
    expect(ctx).toEqual({ tenantId: 'tenant-1' });
    expect(details).toEqual({
      speaker: 'caio',
      threadId: 'thread-1',
      kinds: ['tool_or_field_name', 'mechanics', 'third_person'],
      inputLength: leaked.length,
      outputLength: clean.length,
    });
    expect(JSON.stringify(details)).not.toContain('additional context');
    expect(JSON.stringify(details)).not.toContain('Alex');
  });

  it('reads with the small tier at temperature 0, the rubric cached, the paragraph as the user turn', async () => {
    reply({ changed: false, kinds: [], text: 'Three teams ran this week.' });
    await guardOutgoingText('Three teams ran this week.', CTX);

    const [request, , usage] = mockComplete.mock.calls[0];
    expect(request.tier).toBe('small');
    expect(request.temperature).toBe(0);
    expect(request.messages[0]).toMatchObject({ role: 'system', cacheControl: { type: 'ephemeral' } });
    expect(request.messages[1]).toEqual({ role: 'user', content: 'Three teams ran this week.' });
    expect(request.responseSchema.schema.required).toEqual(['changed', 'kinds', 'text']);
    expect(usage).toEqual({ tenantId: 'tenant-1', purpose: 'output_guard', speaker: 'caio', threadId: 'thread-1' });
  });

  it('returns the text byte-identical when nothing was rewritten, and audits nothing', async () => {
    const text = 'The Support Triage team (paused, 48 tasks) ran the most.';
    reply({ changed: false, kinds: [], text });
    expect(await guardOutgoingText(text, CTX)).toEqual({ text, changed: false, kinds: [] });
    expect(mockAudit).not.toHaveBeenCalled();
  });

  it('keeps the scrubbed text when the model says changed but returned the same text, an empty text, or no text', async () => {
    const text = 'Nothing to see.';
    reply({ changed: true, kinds: ['mechanics'], text });
    expect(await guardOutgoingText(text, CTX)).toEqual({ text, changed: false, kinds: [] });
    reply({ changed: true, kinds: ['mechanics'], text: '   ' });
    expect(await guardOutgoingText(text, CTX)).toEqual({ text, changed: false, kinds: [] });
    reply({ changed: true, kinds: ['mechanics'] });
    expect(await guardOutgoingText(text, CTX)).toEqual({ text, changed: false, kinds: [] });
    expect(mockAudit).not.toHaveBeenCalled();
  });

  // A connection's capture link carries a token, rule 1 calls a token an
  // identifier, and the reader is a model: it can keep the link whole when it
  // mints one and cut the token off the same link minutes later, leaving the
  // person ".../connections/capture/" to open. Dropping a link is
  // still allowed; handing back a different one is not.
  it('keeps the scrubbed text when a rewrite cuts the token off a link', async () => {
    const text = 'Enter the key at https://dev.example.com/connections/capture/liftoff_cap_lSjhqDeK4IXeQ9cb before 03:21 UTC.';
    reply({ changed: true, kinds: ['identifier'], text: 'Enter the key at https://dev.example.com/connections/capture/ before 03:21 UTC.' });

    expect(await guardOutgoingText(text, CTX)).toEqual({ text, changed: false, kinds: [] });
    expect(mockAudit).not.toHaveBeenCalled();
  });

  it('takes a rewrite that leaves every link it kept byte-identical', async () => {
    const text = 'Per the request, enter the key at https://dev.example.com/connections/capture/liftoff_cap_9cbEhWZV8Z.';
    const clean = 'Enter the key at https://dev.example.com/connections/capture/liftoff_cap_9cbEhWZV8Z.';
    reply({ changed: true, kinds: ['mechanics'], text: clean });

    expect(await guardOutgoingText(text, CTX)).toEqual({ text: clean, changed: true, kinds: ['mechanics'] });
  });

  it('lets a rewrite drop a link entirely', async () => {
    const text = 'The run is at https://internal.example.com/runs/abc, and two teams are paused.';
    const clean = 'Two teams are paused.';
    reply({ changed: true, kinds: ['identifier'], text: clean });

    expect(await guardOutgoingText(text, CTX)).toEqual({ text: clean, changed: true, kinds: ['identifier'] });
  });

  it('drops a kind the rubric does not define', async () => {
    reply({ changed: true, kinds: ['identifier', 'made_up'], text: 'Rewritten.' });
    expect((await guardOutgoingText('Original (id abc).', CTX)).kinds).toEqual(['identifier']);
  });

  it('fails open on a classifier error or malformed reply, logging the failure', async () => {
    mockComplete.mockRejectedValueOnce(new Error('rate limited'));
    expect(await guardOutgoingText('Some text.', CTX)).toEqual({ text: 'Some text.', changed: false, kinds: [] });
    reply('not json');
    expect(await guardOutgoingText('Some text.', CTX)).toEqual({ text: 'Some text.', changed: false, kinds: [] });
    expect(mockLogError).toHaveBeenCalledTimes(2);
    expect(mockLogError.mock.calls[0][0]).toMatchObject({ tenantId: 'tenant-1', speaker: 'caio', error: 'rate limited' });
  });

  it('does not read whitespace, and does not read at all when switched off', async () => {
    expect(await guardOutgoingText('  \n\n', CTX)).toEqual({ text: '  \n\n', changed: false, kinds: [] });
    process.env['OUTPUT_GUARD'] = 'off';
    expect(outputGuardEnabled()).toBe(false);
    expect(await guardOutgoingText('Call team_update now.', CTX)).toEqual({ text: 'Call team_update now.', changed: false, kinds: [] });
    expect(mockComplete).not.toHaveBeenCalled();
  });

  it('fails open at the deadline when the provider hangs, and hands the call a signal it aborts', async () => {
    jest.useFakeTimers();
    let seenSignal: AbortSignal | undefined;
    mockComplete.mockImplementationOnce((request: { abortSignal?: AbortSignal }) => {
      seenSignal = request.abortSignal;
      return new Promise(() => undefined);
    });

    const pending = guardOutgoingText('A paragraph the provider never answers.', CTX);
    await jest.advanceTimersByTimeAsync(6_500);

    expect(await pending).toEqual({ text: 'A paragraph the provider never answers.', changed: false, kinds: [] });
    expect(seenSignal?.aborted).toBe(true);
    expect(mockLogError).toHaveBeenCalledTimes(1);
    expect(mockLogError.mock.calls[0][0].error).toMatch(/exceeded 6000ms/);
  });

  it('stands aside after three failed reads in a row, and comes back once the time is up', async () => {
    jest.useFakeTimers();
    for (let i = 0; i < 3; i++) mockComplete.mockRejectedValueOnce(new Error('down'));
    for (let i = 0; i < 3; i++) await guardOutgoingText('Some text.', CTX);
    expect(mockComplete).toHaveBeenCalledTimes(3);

    // Standing aside: no read at all, the scrubbed text goes straight out.
    expect(await guardOutgoingText('Call team_update.', CTX)).toEqual({ text: 'Call team_update.', changed: false, kinds: [] });
    expect(mockComplete).toHaveBeenCalledTimes(3);

    await jest.advanceTimersByTimeAsync(30_500);
    reply({ changed: false, kinds: [], text: 'Back.' });
    expect(await guardOutgoingText('Back.', CTX)).toEqual({ text: 'Back.', changed: false, kinds: [] });
    expect(mockComplete).toHaveBeenCalledTimes(4);
  });

  it('a read that succeeds clears the failures counted so far', async () => {
    mockComplete.mockRejectedValueOnce(new Error('down'));
    mockComplete.mockRejectedValueOnce(new Error('down'));
    await guardOutgoingText('One.', CTX);
    await guardOutgoingText('Two.', CTX);
    reply({ changed: false, kinds: [], text: 'Three.' });
    await guardOutgoingText('Three.', CTX);
    mockComplete.mockRejectedValueOnce(new Error('down'));
    await guardOutgoingText('Four.', CTX);
    // Still reading: four failures, but never three in a row.
    reply({ changed: false, kinds: [], text: 'Five.' });
    await guardOutgoingText('Five.', CTX);
    expect(mockComplete).toHaveBeenCalledTimes(5);
  });

  it('is on unless the switch says off, whatever else it says', () => {
    expect(outputGuardEnabled()).toBe(true);
    process.env['OUTPUT_GUARD'] = 'shadow';
    expect(outputGuardEnabled()).toBe(true);
    process.env['OUTPUT_GUARD'] = 'OFF';
    expect(outputGuardEnabled()).toBe(false);
  });
});
