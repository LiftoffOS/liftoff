// Speaking a reply, sentence by sentence, over a WebSocket.
//
// The browser already receives the agent's reply as text over the existing SSE
// stream and renders it. It feeds that same text in here as it arrives, and
// plays the PCM that comes back. One stream drives both, which is what keeps the
// words on screen and the words in the air from drifting apart.
//
// WHY THE CLIENT DRIVES THIS, rather than the server teeing the token stream
// into a synthesiser: platform-backend runs with CPU throttling and scales to
// zero, and a listener who closes the tab must stop the synthesis with them.
// A server-side tee would happily narrate to an empty room and bill for it.
//
// PROTOCOL, deliberately small:
//   up    {"type":"say","text":"..."}   more reply text; sentences are cut here
//         {"type":"stop"}                barge-in — abandon audio immediately
//         {"type":"end"}                 the reply is complete; flush and settle
//   down  binary                         PCM at the rate given in `ready`
//         {"type":"ready","sampleRate":24000}
//         {"type":"spoken","text":"..."} what was just synthesised, for the caller
//         {"type":"done"}                everything queued has been sent
//
// COST is one row per session covering every sentence spoken, written when the
// socket settles. Per-sentence rows would multiply ledger writes by the length of
// a reply for no analytical gain, since they all share a turn.

import type { Server } from 'node:http';
import type { WebSocketServer, WebSocket } from 'ws';
import { log } from '../infrastructure/logging';
import { resolveTtsProvider, vendorForLane } from './registry';
import { recordSynthesisCost } from './cost';
import { SentenceChunker } from './sentence-chunker';
import { toSpokenText } from './spoken-text';
import { voiceFor } from './voice-identity';
import { attachVoiceSocket, CLOSE_UPSTREAM, type VoiceSessionContext } from './ws-auth';
import type { TtsProvider } from './types';

/** Path this server owns. */
const SPEAK_PATH = '/api/voice/speak';

/**
 * Hard ceiling on one spoken reply, and on silence within it.
 *
 * A reply that runs this long has stopped being a conversation, and an armed
 * socket that nobody is feeding still holds a synthesiser open.
 */
const MAX_SESSION_MS = 5 * 60 * 1000;
const IDLE_TIMEOUT_MS = 60 * 1000;

/**
 * Ceiling on one sentence handed to a vendor.
 *
 * The chunker already bounds what it emits; this bounds what a hostile or broken
 * client can submit directly, since every character is billed.
 */
const MAX_SENTENCE_CHARS = 2000;

/** Attach the speaking WebSocket server to the HTTP server. */
export function attachVoiceSpeakWebSocket(server: Server): WebSocketServer {
  return attachVoiceSocket(server, SPEAK_PATH, handleSession);
}

function handleSession(ws: WebSocket, ctx: VoiceSessionContext): void {
  let provider: TtsProvider;
  let voice: string;
  try {
    provider = resolveTtsProvider('conversation_tts', ctx.tenantId);
    voice = voiceFor(vendorForLane('conversation_tts'), ctx.agentId);
  } catch (err) {
    log.error({ error: (err as Error).message, tenantId: ctx.tenantId }, 'Voice speak: no provider');
    ws.close(CLOSE_UPSTREAM, 'no speaking provider');
    return;
  }

  const chunker = new SentenceChunker();
  const controller = new AbortController();

  let socketClosed = false;
  let settled = false;
  /**
   * Usage accumulated across the sentences of this reply.
   *
   * Summed from what each synthesis REPORTED, not from what was sent. A
   * character-billed vendor reports the moment it accepts the request; a
   * token-billed one only knows once it has finished producing audio. Billing
   * from the text would have been an estimate for half the vendors here, and an
   * estimate cannot reconcile against an invoice.
   */
  let spokenQuantity = 0;
  let spokenCostUsd = 0;
  /** Sentences wait their turn: audio has to arrive in the order it is read. */
  let queue: Promise<void> = Promise.resolve();
  let ended = false;
  let idleTimer: NodeJS.Timeout | undefined;

  const send = (message: unknown): void => {
    if (!socketClosed) ws.send(JSON.stringify(message));
  };

  const resetIdle = (): void => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => ws.close(1000, 'idle'), IDLE_TIMEOUT_MS);
  };
  resetIdle();
  const sessionCap = setTimeout(() => ws.close(1000, 'session limit'), MAX_SESSION_MS);

  /** Bill everything spoken, once, whatever ended the session. */
  const settle = (closeSocket: boolean): void => {
    if (settled) return;
    settled = true;
    if (idleTimer) clearTimeout(idleTimer);
    clearTimeout(sessionCap);
    controller.abort();

    if (spokenQuantity > 0) {
      const { model, unit } = provider.usageFor('');
      void recordSynthesisCost({
        tenantId: ctx.tenantId,
        surface: ctx.surface,
        agentId: ctx.agentId,
        provider: provider.key,
        usage: { quantity: spokenQuantity, unit, model, costUsd: spokenCostUsd },
        sourceId: `voice-tts:${ctx.requestId}`,
        occurredAt: new Date(),
      });
    }
    if (closeSocket && !socketClosed) ws.close(1000, 'complete');
  };

  /** Synthesise one sentence and stream it down, in order. */
  const speak = (sentence: string): void => {
    queue = queue.then(async () => {
      if (controller.signal.aborted || socketClosed) return;
      send({ type: 'spoken', text: sentence });
      try {
        for await (const chunk of provider.synthesize({
          text: sentence,
          voice,
          language: undefined,
          signal: controller.signal,
          onUsage: (usage) => {
            spokenQuantity += usage.quantity;
            spokenCostUsd += usage.costUsd;
          },
        })) {
          if (controller.signal.aborted || socketClosed) return;
          ws.send(chunk);
        }
      } catch (err) {
        if (controller.signal.aborted) return;
        log.error(
          { error: (err as Error).message, tenantId: ctx.tenantId, provider: provider.key },
          'Voice speak: synthesis failed',
        );
        if (!socketClosed) ws.close(CLOSE_UPSTREAM, 'synthesis failed');
      }
    });
  };

  send({ type: 'ready', sampleRate: provider.capabilities.outputSampleRateHertz });

  ws.on('message', (data: Buffer) => {
    resetIdle();
    let message: { type?: string; text?: string };
    try {
      message = JSON.parse(data.toString()) as { type?: string; text?: string };
    } catch {
      // A frame we cannot parse is not worth killing a live session over.
      return;
    }

    if (message.type === 'say' && typeof message.text === 'string') {
      if (ended) return;
      // Normalise before chunking: dropping markup first means sentence
      // boundaries are found in the text that will actually be read, not in
      // punctuation that is about to disappear.
      for (const sentence of chunker.push(toSpokenText(message.text))) {
        speak(sentence.slice(0, MAX_SENTENCE_CHARS));
      }
      return;
    }

    if (message.type === 'end') {
      if (ended) return;
      ended = true;
      // A last sentence with no full stop is still the end of what was said.
      for (const sentence of chunker.flush()) {
        speak(sentence.slice(0, MAX_SENTENCE_CHARS));
      }
      void queue.then(() => {
        send({ type: 'done' });
        settle(true);
      });
      return;
    }

    if (message.type === 'stop') {
      // Barge-in. Stop synthesising immediately — the person is talking, and
      // finishing the sentence would only bill for audio nobody hears.
      settle(true);
    }
  });

  ws.on('close', () => {
    socketClosed = true;
    settle(false);
  });

  ws.on('error', (err: Error) => {
    log.error({ error: err.message, tenantId: ctx.tenantId }, 'Voice speak socket error');
  });
}
