// Captured activities from the mocked adapter.
const sent: Array<Record<string, unknown>> = [];

jest.mock('../teams-bot-adapter', () => ({
  getBotAppId: () => 'bot-app-id',
  getTeamsAdapter: () => ({
    continueConversationAsync: async (
      _appId: string,
      _ref: unknown,
      cb: (ctx: unknown) => Promise<void>,
    ) => {
      let seq = 0;
      const ctx = {
        sendActivity: async (a: Record<string, unknown>) => {
          sent.push(a);
          return { id: `act-${++seq}` };
        },
        updateActivity: async (a: Record<string, unknown>) => {
          sent.push({ ...a, _update: true });
          return undefined;
        },
      };
      await cb(ctx);
    },
  }),
}));

import { makeTeamsStreamer } from '../teams-streamer';

const REF = { conversation: { id: '19:abc@thread.tacv2' } };

beforeEach(() => {
  sent.length = 0;
  jest.useFakeTimers();
});

afterEach(() => {
  jest.clearAllTimers();
  jest.useRealTimers();
});

describe('TeamsStreamer (typing indicator → final card)', () => {
  it('begin shows a typing indicator', async () => {
    const s = makeTeamsStreamer({ conversationReference: REF, scope: 'personal', agentName: 'Aria' });
    await s.begin();
    expect(sent.some((a) => a.type === 'typing')).toBe(true);
    await s.finalize(); // stop the refresh timer
  });

  it('finalize stops typing and sends the final message card', async () => {
    const s = makeTeamsStreamer({ conversationReference: REF, scope: 'personal', agentName: 'Aria' });
    await s.begin();
    s.append('Hello world');
    await s.finalize();
    const final = sent[sent.length - 1];
    expect(final.type).toBe('message');
    expect((final.attachments as unknown[]).length).toBe(1);
  });

  it('refreshes the typing indicator while the agent works', async () => {
    const s = makeTeamsStreamer({ conversationReference: REF, scope: 'personal', agentName: 'Aria' });
    await s.begin();
    await jest.advanceTimersByTimeAsync(9000); // ~2 refresh ticks
    await s.finalize();
    expect(sent.filter((a) => a.type === 'typing').length).toBeGreaterThanOrEqual(2);
  });
});
