// Live dictation over a WebSocket.
//
// The composer shows words as they are spoken, so the audio has to be
// transcribed while it is still arriving rather than after it stops. That rules
// out an upload: a request cannot be answered before its body finishes, and
// waiting for the whole utterance is what made the first version feel broken —
// nothing at all, then a pause, then everything at once.
//
// So: raw PCM frames stream up, interim transcripts stream back, and the final
// one replaces them. Cloud Speech-to-Text keeps its own recognition stream open
// for the duration and returns results as it becomes confident.
//
// AUTH lives in ./ws-auth, shared with the speaking socket.
//
// STOPPING IS A HALF-CLOSE, NOT A HANG-UP. When someone stops speaking the
// client sends a `stop` frame and keeps listening; the recogniser usually emits
// the settled text for the last segment only once it knows no more audio is
// coming. Closing the socket at that moment throws that final away — the words
// someone just said would arrive nowhere. So the server ends the upstream, drains
// what it produces, and closes the socket itself when there is nothing left.
//
// COST. One ledger row per session, written once the upstream settles, from the
// duration Google reports for the stream. A session that hears nothing still
// writes its row — the vendor charged for listening either way.

import type { Server } from 'node:http';
import type { WebSocketServer, WebSocket } from 'ws';
import { log } from '../infrastructure/logging';
import { resolveSttProvider } from './registry';
import { recordDictationCost } from './cost';
import { attachVoiceSocket, CLOSE_UPSTREAM, type VoiceSessionContext } from './ws-auth';
import type { SttStreamHandlers } from './types';

/** Path this server owns. Anything else is left for other upgrade handlers. */
const LISTEN_PATH = '/api/voice/listen';

/**
 * Hard ceiling on one session, per mode.
 *
 * Dictation is one utterance, so four minutes is generous. A conversation is not
 * bounded by anything so tidy — capping it at four minutes is what made the
 * microphone die mid-conversation — so it gets a much longer ceiling and relies
 * on the silence guard below to stop billing when nobody is talking.
 *
 * The adapter now rotates the upstream underneath this, so neither number is
 * constrained by Cloud STT's own five-minute stream limit any more.
 */
const MAX_DICTATION_MS = 4 * 60 * 1000;
const MAX_CONVERSATION_MS = 30 * 60 * 1000;

/** No frames at all from the client — the tab is gone or the mic died. */
const IDLE_TIMEOUT_MS = 30 * 1000;

/**
 * No recognised SPEECH for this long, in conversation.
 *
 * The idle timer above cannot serve this purpose: an open microphone sends audio
 * frames continuously whether or not anyone is speaking, so it never fires. This
 * is the guard that actually stops an abandoned conversation from billing, and
 * it is measured in words heard rather than bytes received.
 */
const CONVERSATION_SILENCE_MS = 2 * 60 * 1000;

/**
 * What the browser is actually capturing at.
 *
 * DECLARED BY THE CLIENT, not assumed here. An AudioContext runs at whatever the
 * output device negotiated — 48 kHz on most desktops, 44.1 kHz on plenty of
 * Windows machines, 16 kHz on a Bluetooth headset in hands-free mode — and the
 * worklet forwards samples at that rate without resampling them. This was
 * hardcoded to 48000, so a headset's 16 kHz was read as three times too fast:
 * measured end to end, the recogniser returned an empty transcript and the
 * session reported that it heard no audio at all, on the very device somebody
 * reaches for to hold a conversation.
 *
 * Falls back to 48000 for a client that has not been updated to say, which is
 * the rate those clients were already assumed to be sending.
 */
const DEFAULT_CAPTURE_RATE = 48000;
const MIN_CAPTURE_RATE = 8000;
const MAX_CAPTURE_RATE = 96000;

export function _captureRateFrom(raw: string | null): number {
  const rate = Number(raw);
  if (!Number.isInteger(rate) || rate < MIN_CAPTURE_RATE || rate > MAX_CAPTURE_RATE) {
    return DEFAULT_CAPTURE_RATE;
  }
  return rate;
}

const captureRate = (ctx: VoiceSessionContext): number =>
  _captureRateFrom(ctx.params.get('sampleRate'));

/** Attach the dictation WebSocket server to the HTTP server. */
export function attachVoiceListenWebSocket(server: Server): WebSocketServer {
  return attachVoiceSocket(server, LISTEN_PATH, handleSession);
}

function handleSession(ws: WebSocket, ctx: VoiceSessionContext): void {
  // Two modes over one socket, because they differ only in who decides the
  // utterance is over. Dictation: the person, by pressing the button again.
  // Conversation: the vendor, by hearing them stop.
  const conversation = ctx.params.get('mode') === 'conversation';
  const lane = conversation ? 'conversation_stt' : 'dictation_stt';

  const provider = resolveSttProvider(lane, ctx.tenantId);
  if (!provider.capabilities.streaming) {
    ws.close(CLOSE_UPSTREAM, 'provider cannot stream');
    return;
  }

  let socketClosed = false;
  let costRecorded = false;
  let idleTimer: NodeJS.Timeout | undefined;
  let silenceTimer: NodeJS.Timeout | undefined;

  /** Somebody said something. Only speech resets the conversation's silence guard. */
  const heard = (): void => {
    if (!conversation) return;
    if (silenceTimer) clearTimeout(silenceTimer);
    silenceTimer = setTimeout(() => ws.close(1000, 'silent'), CONVERSATION_SILENCE_MS);
  };

  const handlers: SttStreamHandlers = {
    onInterim: (text) => {
      heard();
      if (!socketClosed && text) ws.send(JSON.stringify({ type: 'interim', transcript: text }));
    },
    onFinal: (text) => {
      heard();
      if (!socketClosed && text) ws.send(JSON.stringify({ type: 'final', transcript: text }));
    },
    onSpeechEnd: () => {
      heard();
      // Advisory. The client decides what to do with it — dispatch the turn —
      // and the socket stays open, because the person may keep talking.
      if (!socketClosed) ws.send(JSON.stringify({ type: 'speech_end' }));
    },
    onError: (err) => {
      log.error(
        { error: err.message, tenantId: ctx.tenantId, surface: ctx.surface, mode: lane },
        'Voice listening stream failed',
      );
      if (!socketClosed) ws.close(CLOSE_UPSTREAM, 'transcription failed');
    },
  };

  const stream = provider.openStream(
    { sampleRateHertz: captureRate(ctx), language: undefined, endpointing: conversation },
    handlers,
  );

  const resetIdle = (): void => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => ws.close(1000, 'idle'), IDLE_TIMEOUT_MS);
  };
  resetIdle();

  const sessionCap = setTimeout(
    () => ws.close(1000, 'session limit'),
    conversation ? MAX_CONVERSATION_MS : MAX_DICTATION_MS,
  );
  heard();

  /**
   * End the upstream, let it drain, bill it, then close.
   *
   * Idempotent: the client's `stop` and an abrupt disconnect both land here, and
   * only the first writes a ledger row.
   */
  const settle = (closeSocket: boolean): void => {
    if (costRecorded) return;
    costRecorded = true;
    if (idleTimer) clearTimeout(idleTimer);
    if (silenceTimer) clearTimeout(silenceTimer);
    clearTimeout(sessionCap);
    void stream
      .end()
      .then(async (usage) => {
        await recordDictationCost({
          tenantId: ctx.tenantId,
          surface: ctx.surface,
          agentId: ctx.agentId,
          provider: provider.key,
          usage,
          // Unique per session and stable for a retry of the same one.
          sourceId: `voice-stt:${ctx.requestId}`,
          occurredAt: new Date(),
        });
        // Closed last, so any final the recogniser produced while draining has
        // already been sent.
        if (closeSocket && !socketClosed) ws.close(1000, 'complete');
      })
      .catch((err: Error) => {
        log.error(
          { error: err.message, tenantId: ctx.tenantId },
          'Voice dictation ended but cost attribution failed',
        );
        if (closeSocket && !socketClosed) ws.close(1000, 'complete');
      });
  };

  ws.on('message', (data: Buffer, isBinary: boolean) => {
    resetIdle();
    if (isBinary) {
      stream.write(data);
      return;
    }
    // The one control frame this protocol has: "I have stopped talking."
    try {
      const message = JSON.parse(data.toString()) as { type?: string };
      if (message.type === 'stop') settle(true);
    } catch {
      // A frame we cannot parse is not worth killing a live session over.
    }
  });

  ws.on('close', () => {
    socketClosed = true;
    // An abrupt disconnect still has to bill; nothing is left to deliver.
    settle(false);
  });

  ws.on('error', (err: Error) => {
    log.error({ error: err.message, tenantId: ctx.tenantId }, 'Voice dictation socket error');
  });
}
