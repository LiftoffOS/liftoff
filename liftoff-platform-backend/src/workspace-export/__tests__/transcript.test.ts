// The one transcript rule, and the From / With resolution around it.

import {
  toTranscript,
  renderConversation,
  speakerName,
  type TranscriptRow,
  type CollectedConversation,
  type NameResolvers,
} from '../conversations';

const at = (s: string) => new Date(s);
const resolveFile: NameResolvers['resolveFile'] = (ref) =>
  ref.fileId === 'gone' ? { Name: ref.filename }
    : ref.webViewUrl ? { Name: ref.filename, Link: ref.webViewUrl }
      : { Name: ref.filename, Path: `files/x/${ref.filename}` };

function row(overrides: Partial<TranscriptRow>): TranscriptRow {
  return {
    role: 'user', content: 'hello', messageType: null, attachments: null, media: null,
    createdAt: at('2026-09-12T14:02:00.000Z'), from: 'Alex Rivera', withHelpFrom: [], turnId: null, producedInTurnId: null,
    ...overrides,
  };
}

describe('toTranscript', () => {
  it('keeps speech from a person and from a team, oldest first, with From and Sent', () => {
    expect(toTranscript([
      row({ content: 'Can you review PR 482 before I merge it?' }),
      row({ role: 'assistant', content: 'Two findings.', from: 'Code Reviewer', createdAt: at('2026-09-12T14:03:00.000Z') }),
    ], resolveFile)).toEqual([
      { From: 'Alex Rivera', Sent: '2026-09-12T14:02:00.000Z', Message: 'Can you review PR 482 before I merge it?' },
      { From: 'Code Reviewer', Sent: '2026-09-12T14:03:00.000Z', Message: 'Two findings.' },
    ]);
  });

  it('keeps a Files line for a file_output row and for a media row', () => {
    const out = toTranscript([
      row({ role: 'assistant', content: '', messageType: 'file_output', from: 'Code Reviewer',
        attachments: [{ generatedFileId: 'f1', filename: 'pr-482-review.md', outputType: 'docx', downloadUrl: 'https://signed' }] }),
      row({ role: 'assistant', content: '', messageType: 'media', from: 'Code Reviewer',
        media: [{ mediaId: 'm1', mimeType: 'image/png', filename: 'chart.png' }] }),
    ], resolveFile);
    expect(out).toEqual([
      { From: 'Code Reviewer', Sent: '2026-09-12T14:02:00.000Z', Files: [{ Name: 'pr-482-review.md', Path: 'files/x/pr-482-review.md' }] },
      { From: 'Code Reviewer', Sent: '2026-09-12T14:02:00.000Z', Files: [{ Name: 'chart.png', Path: 'files/x/chart.png' }] },
    ]);
    // The signed download URL on the card never reaches the archive.
    expect(JSON.stringify(out)).not.toContain('signed');
  });

  it('folds a produced file onto the reply of the turn that produced it, the way the person saw it', () => {
    const out = toTranscript([
      row({ content: 'Review PR 482' }),
      row({ role: 'assistant', content: '', messageType: 'file_output', from: 'Code Reviewer', producedInTurnId: 'turn-7',
        createdAt: at('2026-09-12T14:02:30.000Z'),
        attachments: [{ generatedFileId: 'f1', filename: 'pr-482-review.md' }] }),
      row({ role: 'assistant', content: 'Two findings.', from: 'Code Reviewer', turnId: 'turn-7', createdAt: at('2026-09-12T14:03:00.000Z') }),
      // A card from a turn that left no reply keeps its own entry.
      row({ role: 'assistant', content: '', messageType: 'file_output', from: 'Code Reviewer', producedInTurnId: 'turn-8',
        createdAt: at('2026-09-12T14:04:00.000Z'),
        attachments: [{ generatedFileId: 'f2', filename: 'notes.docx' }] }),
      // A card with no producing turn is never guessed onto a reply by timing.
      row({ role: 'assistant', content: '', messageType: 'file_output', from: 'Code Reviewer',
        createdAt: at('2026-09-12T14:05:00.000Z'),
        attachments: [{ generatedFileId: 'f3', filename: 'old.xlsx' }] }),
      row({ role: 'assistant', content: 'Done.', from: 'Code Reviewer', turnId: 'turn-9', createdAt: at('2026-09-12T14:06:00.000Z') }),
    ], resolveFile);
    expect(out).toEqual([
      { From: 'Alex Rivera', Sent: '2026-09-12T14:02:00.000Z', Message: 'Review PR 482' },
      { From: 'Code Reviewer', Sent: '2026-09-12T14:03:00.000Z', Message: 'Two findings.',
        Files: [{ Name: 'pr-482-review.md', Path: 'files/x/pr-482-review.md' }] },
      { From: 'Code Reviewer', Sent: '2026-09-12T14:04:00.000Z', Files: [{ Name: 'notes.docx', Path: 'files/x/notes.docx' }] },
      { From: 'Code Reviewer', Sent: '2026-09-12T14:05:00.000Z', Files: [{ Name: 'old.xlsx', Path: 'files/x/old.xlsx' }] },
      { From: 'Code Reviewer', Sent: '2026-09-12T14:06:00.000Z', Message: 'Done.' },
    ]);
  });

  it("carries a connector-written document's own link, which the page renders and no stored row holds", () => {
    expect(toTranscript([
      row({ role: 'assistant', content: '', messageType: 'file_output', from: 'Competitive Intelligence Analyst',
        attachments: [{ generatedFileId: 'no-such-row', filename: 'Updated document', outputType: 'document', webViewUrl: 'https://docs.google.com/document/d/abc/edit' }] }),
    ], resolveFile)).toEqual([{
      From: 'Competitive Intelligence Analyst', Sent: '2026-09-12T14:02:00.000Z',
      Files: [{ Name: 'Updated document', Link: 'https://docs.google.com/document/d/abc/edit' }],
    }]);
  });

  it('names a file whose object is gone, with no Path', () => {
    expect(toTranscript([
      row({ role: 'assistant', content: '', messageType: 'file_output', from: 'T',
        attachments: [{ generatedFileId: 'gone', filename: 'old.xlsx' }] }),
    ], resolveFile)).toEqual([{ From: 'T', Sent: '2026-09-12T14:02:00.000Z', Files: [{ Name: 'old.xlsx' }] }]);
  });

  it("keeps the person's own attachments as names only", () => {
    const [entry] = toTranscript([
      row({ attachments: [
        { kind: 'upload', name: 'contract.pdf' },
        { kind: 'connector', name: 'Q3 plan', connectorType: 'google_drive', connectorId: 'c-1', externalId: 'x', sourceUrl: 'https://docs' },
      ], media: [{ mediaId: 'up-1', mimeType: 'image/png', filename: 'screenshot.png' }] }),
    ], resolveFile);
    expect(entry).toEqual({
      From: 'Alex Rivera', Sent: '2026-09-12T14:02:00.000Z', Message: 'hello',
      Attachments: ['contract.pdf', 'Q3 plan', 'screenshot.png'],
    });
    expect(JSON.stringify(entry)).not.toContain('c-1');
    expect(JSON.stringify(entry)).not.toContain('up-1');
  });

  it('names the teammates a reply was written with, after From, and only when there were any', () => {
    expect(toTranscript([
      row({ role: 'assistant', content: 'Reviewed with both teams.', from: 'Code Reviewer',
        withHelpFrom: ['Security Review', 'Legal Counsel'] }),
      row({ role: 'assistant', content: 'Anything else?', from: 'Code Reviewer',
        createdAt: at('2026-09-12T14:03:00.000Z') }),
    ], resolveFile)).toEqual([
      { From: 'Code Reviewer', 'With help from': ['Security Review', 'Legal Counsel'],
        Sent: '2026-09-12T14:02:00.000Z', Message: 'Reviewed with both teams.' },
      { From: 'Code Reviewer', Sent: '2026-09-12T14:03:00.000Z', Message: 'Anything else?' },
    ]);
  });

  // A platform assistant that answers inside a team's chat is speech in that
  // conversation, and the person read it there. It used to be dropped with
  // the status rows, so the export lost half of an exchange the person had.
  it('keeps a colleague row as speech, from the colleague', () => {
    expect(toTranscript([
      row({ role: 'assistant', content: 'Here is what would change. Apply it?', messageType: 'colleague',
        from: 'Chief AI Officer' }),
    ], resolveFile)).toEqual([
      { From: 'Chief AI Officer', Sent: '2026-09-12T14:02:00.000Z', Message: 'Here is what would change. Apply it?' },
    ]);
  });

  it('drops tool rows and every non-speech message type, and never carries tool_calls', () => {
    const excluded = ['hitl_status', 'delegation_status', 'run_progress', 'suggestion',
      'learning_confirmation', 'forwarded_context', 'system_note'];
    const rows: TranscriptRow[] = [
      row({ role: 'tool', content: '{"result":"x"}' }),
      ...excluded.map((t) => row({ role: 'assistant', content: `type ${t}`, messageType: t })),
      row({ role: 'assistant', content: 'kept', from: 'T', ...({ toolCalls: [{ id: 'tc-1' }] } as object) }),
    ];
    const out = toTranscript(rows, resolveFile);
    expect(out).toEqual([{ From: 'T', Sent: '2026-09-12T14:02:00.000Z', Message: 'kept' }]);
    expect(JSON.stringify(out)).not.toContain('tc-1');
  });
});

describe('speakerName', () => {
  const names: NameResolvers = {
    accountName: (id) => (id === 'acc-1' ? 'Alex Rivera' : undefined),
    teamName: (id) => (id === 'agent-1' ? 'Code Reviewer' : undefined),
    resolveFile,
  };

  it('names a team-chat sender, then the Slack/Teams guest label, then the generic word', () => {
    expect(speakerName({ kind: 'account', accountId: 'acc-1', label: null }, names)).toBe('Alex Rivera');
    expect(speakerName({ kind: 'account', accountId: null, label: 'Priya (Slack)' }, names)).toBe('Priya (Slack)');
    expect(speakerName({ kind: 'account', accountId: null, label: null }, names)).toBe('Workspace member');
  });

  it('names a recorded sender on the assistant surfaces, and "Workspace member" before the column', () => {
    expect(speakerName({ kind: 'account', accountId: 'acc-1', label: null }, names)).toBe('Alex Rivera');
    expect(speakerName({ kind: 'account', accountId: null, label: null }, names)).toBe('Workspace member');
  });

  it("names each AI message's own team, archived or not, and degrades to the page's word", () => {
    expect(speakerName({ kind: 'team', agentId: 'agent-1' }, names)).toBe('Code Reviewer');
    expect(speakerName({ kind: 'team', agentId: 'agent-gone' }, names)).toBe('Unknown agent');
    expect(speakerName({ kind: 'named', name: 'Liftoff' }, names)).toBe('Liftoff');
  });
});

describe('renderConversation', () => {
  const names: NameResolvers = {
    accountName: (id) => ({ 'acc-1': 'Alex Rivera' } as Record<string, string>)[id],
    teamName: (id) => ({ 'agent-1': 'Code Reviewer', 'agent-2': 'Release Coordinator' } as Record<string, string>)[id],
    resolveFile,
  };

  it('lists every team that replied in a multi-team thread and names each reply by its own team', () => {
    const conversation: CollectedConversation = {
      id: 'thread-1', surface: 'agent_chat', channel: 'slack', title: 'Review of PR 482',
      startedByAccountId: 'acc-1', createdAt: at('2026-09-12T14:02:00.000Z'),
      messages: [
        { role: 'user', content: 'Review please', messageType: null, attachments: null, media: null,
          createdAt: at('2026-09-12T14:02:00.000Z'), speaker: { kind: 'account', accountId: 'acc-1', label: null }, withHelpFrom: [], turnId: null, producedInTurnId: null },
        { role: 'assistant', content: 'Two findings.', messageType: null, attachments: null, media: null,
          createdAt: at('2026-09-12T14:03:00.000Z'), speaker: { kind: 'team', agentId: 'agent-1' }, withHelpFrom: [], turnId: null, producedInTurnId: null },
        { role: 'assistant', content: 'Release note drafted.', messageType: null, attachments: null, media: null,
          createdAt: at('2026-09-12T14:04:00.000Z'), speaker: { kind: 'team', agentId: 'agent-2' }, withHelpFrom: [], turnId: null, producedInTurnId: null },
      ],
    };
    expect(renderConversation(conversation, names)).toEqual({
      With: ['Code Reviewer', 'Release Coordinator'],
      Surface: 'Agent',
      Channel: 'Slack',
      Title: 'Review of PR 482',
      'Started by': 'Alex Rivera',
      Started: '2026-09-12T14:02:00.000Z',
      'Last message': '2026-09-12T14:04:00.000Z',
      Messages: [
        { From: 'Alex Rivera', Sent: '2026-09-12T14:02:00.000Z', Message: 'Review please' },
        { From: 'Code Reviewer', Sent: '2026-09-12T14:03:00.000Z', Message: 'Two findings.' },
        { From: 'Release Coordinator', Sent: '2026-09-12T14:04:00.000Z', Message: 'Release note drafted.' },
      ],
    });
  });

  it('omits Started by for a guest-started thread, Channel off team chat, and titles an untitled thread', () => {
    const out = renderConversation({
      id: 'thread-2', surface: 'liftoff', channel: null, title: null, startedByAccountId: null,
      createdAt: at('2026-09-01T00:00:00.000Z'), messages: [],
    }, names);
    expect(out).toEqual({
      With: ['Liftoff'], Surface: 'Liftoff', Title: 'Untitled chat', Started: '2026-09-01T00:00:00.000Z', Messages: [],
    });
    expect(Object.keys(out)).not.toContain('Started by');
    expect(Object.keys(out)).not.toContain('Channel');
    expect(Object.keys(out)).not.toContain('Last message');
  });

  it('renders a team reply with its helpers, and a colleague row in a team chat from the colleague', () => {
    const out = renderConversation({
      id: 'thread-4', surface: 'agent_chat', channel: 'web', title: 'Contract review', startedByAccountId: 'acc-1',
      createdAt: at('2026-09-01T00:00:00.000Z'),
      messages: [
        { role: 'assistant', content: 'Reviewed with both teams.', messageType: null, attachments: null, media: null,
          createdAt: at('2026-09-01T00:01:00.000Z'), speaker: { kind: 'team', agentId: 'agent-1' },
          withHelpFrom: ['Security Review', 'Legal Counsel'], turnId: null, producedInTurnId: null },
        { role: 'assistant', content: 'Here is what would change. Apply it?', messageType: 'colleague', attachments: null, media: null,
          createdAt: at('2026-09-01T00:02:00.000Z'), speaker: { kind: 'named', name: 'Chief AI Officer' },
          withHelpFrom: [], turnId: null, producedInTurnId: null },
      ],
    }, names);
    // With lists who spoke; the helpers are on the row they helped with.
    expect(out.With).toEqual(['Code Reviewer', 'Chief AI Officer']);
    expect(out.Messages).toEqual([
      { From: 'Code Reviewer', 'With help from': ['Security Review', 'Legal Counsel'],
        Sent: '2026-09-01T00:01:00.000Z', Message: 'Reviewed with both teams.' },
      { From: 'Chief AI Officer', Sent: '2026-09-01T00:02:00.000Z', Message: 'Here is what would change. Apply it?' },
    ]);
  });

  it('on Liftoff, an AI reply is the colleague that wrote it, else Liftoff', () => {
    const out = renderConversation({
      id: 'thread-3', surface: 'liftoff', channel: null, title: 'Plan', startedByAccountId: 'acc-1',
      createdAt: at('2026-09-01T00:00:00.000Z'),
      messages: [
        { role: 'assistant', content: 'Sure.', messageType: null, attachments: null, media: null,
          createdAt: at('2026-09-01T00:01:00.000Z'), speaker: { kind: 'named', name: 'Liftoff' }, withHelpFrom: [], turnId: null, producedInTurnId: null },
        { role: 'assistant', content: 'From the plan side.', messageType: null, attachments: null, media: null,
          createdAt: at('2026-09-01T00:02:00.000Z'), speaker: { kind: 'named', name: 'Chief AI Officer' }, withHelpFrom: [], turnId: null, producedInTurnId: null },
      ],
    }, names);
    expect(out.With).toEqual(['Liftoff', 'Chief AI Officer']);
    expect(out.Messages.map((m) => m.From)).toEqual(['Liftoff', 'Chief AI Officer']);
  });
});
