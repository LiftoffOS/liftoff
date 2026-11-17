// Voice provider layer — shared contracts.
//
// The narrow seam every voice vendor plugs into. Two rules shape it:
//
//   1. The dispatcher branches on declared CAPABILITIES, never on a vendor key.
//      A vendor name appears in its own adapter and in the vendor map
//      (./vendors.ts) and nowhere else, so switching vendors is a config edit.
//   2. Each adapter reports usage in its OWN native unit and owns the
//      unit -> USD conversion. The shared cost path only ever sees USD, which is
//      what keeps a per-character vendor and a per-token vendor from needing
//      different ledger code.
//
// Both halves are defined here now. The TTS half was deliberately absent while
// only dictation shipped, because src/__tests__/reachability.test.ts fails any
// export without a production caller; it arrives with the speaking path that
// calls it.

/** The four places a voice provider can be selected, independently of each other. */
export type VoiceLane =
  | 'dictation_stt'
  | 'conversation_stt'
  | 'conversation_tts'
  | 'memo_tts';

/**
 * The unit a vendor actually bills in. Not cosmetic: ElevenLabs and the
 * Chirp/Standard/WaveNet Cloud TTS voices bill characters, Gemini-TTS and
 * gpt-4o-mini-tts bill audio tokens, and every STT vendor bills audio duration.
 * Mirrors the closed vocabulary of cost_attribution_events.usage_unit
 * (migration 331).
 */
export type VoiceBillingUnit = 'characters' | 'audio_tokens' | 'audio_seconds';

/** What an adapter reports about its own consumption for one call. */
export interface VoiceUsage {
  /** Amount consumed, expressed in `unit`. */
  quantity: number;
  unit: VoiceBillingUnit;
  /** Vendor model actually used, recorded on the ledger row for reconciliation. */
  model: string;
  /** What the vendor will charge us for this call, converted by the adapter. */
  costUsd: number;
}

/** What a provider can do. The dispatcher reads this instead of switching on a name. */
export interface SttCapabilities {
  batch: boolean;
  streaming: boolean;
  /** Capture rates the vendor accepts. Empty means "any rate". */
  sampleRates: number[];
}

/** Callbacks a streaming session pushes results into, as they arrive. */
export interface SttStreamHandlers {
  /** Best guess so far. Replaced by the next interim or by a final. */
  onInterim(transcript: string): void;
  /** Settled text for a segment. Interims for that segment are superseded. */
  onFinal(transcript: string): void;
  /**
   * The speaker stopped talking, as judged by the vendor.
   *
   * Only fires when the session asked for endpointing. This is what lets a
   * conversation send a turn without the person pressing anything, and it is
   * server-side on purpose: a client-side silence timer has to guess, and the
   * guess is what makes a voice assistant either interrupt people or sit there.
   *
   * ORDERING IS PART OF THE CONTRACT, AND ADAPTERS MUST ENFORCE IT. This fires
   * only AFTER the words of that utterance have been delivered through
   * `onFinal`, and NEVER for a sound that produced none. Callers treat it as
   * "the turn is complete, send it", and they read the transcript they have
   * already accumulated — so a signal that arrives first completes a turn with
   * an empty buffer, resets it, and strands the sentence that lands afterwards.
   *
   * Not hypothetical, and not the same on every vendor: Cloud STT transcribes
   * while the person speaks, so its speech-end naturally trails the words, while
   * gpt-transcribe transcribes only once the turn is committed and reports the
   * end of speech 0.9-1.2 s before the first word exists. The OpenAI adapter
   * holds the signal back to satisfy this; a future vendor may have to as well.
   */
  onSpeechEnd(): void;
  onError(error: Error): void;
}

/** Audio going up, results coming back through the handlers. */
export interface SttStream {
  /** One frame of raw audio, in the encoding declared when the stream opened. */
  write(chunk: Buffer): void;
  /**
   * Stop sending and settle. Resolves with what the vendor billed for the
   * session — reported even when nothing was recognised, because listening is
   * what was charged for.
   */
  end(): Promise<VoiceUsage>;
}

/** A complete recording handed over for transcription. */
export interface SttFileInput {
  audio: Buffer;
  /** The container the platform delivered, e.g. 'audio/mp4' or 'audio/ogg'. */
  mimeType: string;
  language?: string | undefined;
}

/** What a streaming session needs to know before the first frame. */
export interface SttStreamInput {
  /** Rate of the PCM frames the client will send. */
  sampleRateHertz: number;
  language?: string | undefined;
  /**
   * Ask the vendor to detect when the speaker stops, and report it through
   * `onSpeechEnd`.
   *
   * Off for dictation, where the person decides when they are finished and
   * pressing the button again is unambiguous. On for conversation, where waiting
   * for a button press would defeat the point.
   */
  endpointing?: boolean | undefined;
}

/** A finished recording, and what transcribing it cost. */
export interface SttFileResult {
  transcript: string;
  usage: VoiceUsage;
}

export interface SttProvider {
  readonly key: string;
  readonly capabilities: SttCapabilities;
  /**
   * Transcribe a complete recording.
   *
   * For audio that was already finished when it reached us — a Slack or Teams
   * voice memo — where streaming would mean pacing a file through a socket to
   * simulate someone speaking it. The container is declared rather than guessed,
   * since the platform that delivered it already knows.
   */
  recognizeFile(input: SttFileInput): Promise<SttFileResult>;
  /**
   * Open a live session. Live is the only mode dictation has: a composer that
   * shows nothing until the speaker stops is the thing this replaced.
   */
  openStream(input: SttStreamInput, handlers: SttStreamHandlers): SttStream;
}

/** What a speaking provider can do. Read instead of switching on a vendor key. */
export interface TtsCapabilities {
  /** Emits audio while still synthesising, rather than one buffer at the end. */
  streaming: boolean;
  /**
   * Rate of the PCM this adapter emits. The browser is told once per stream and
   * resamples if its output device differs, so adapters at different rates can
   * back the same lane without the client caring.
   */
  outputSampleRateHertz: number;
}

/** One synthesis request. */
export interface TtsSynthesisInput {
  /** Already normalised for speech — adapters synthesise verbatim (./spoken-text). */
  text: string;
  /** Vendor-specific voice id, resolved from the agent's voice slot (./voice-identity). */
  voice: string;
  language?: string | undefined;
  /**
   * Aborts synthesis in flight. Ignored by the whole-file path, which nobody is
   * listening to yet and so nobody can interrupt. Barge-in fires this: the listener stops caring
   * about the audio the moment the person speaks, so the request should stop
   * too rather than run to completion unheard.
   */
  signal: AbortSignal;
  /**
   * What the vendor actually charged for this call, once it is known.
   *
   * Needed because not every vendor's cost is knowable from the text. Characters
   * are — Chirp reports them the moment the request is formed. Audio tokens are
   * not: gpt-4o-mini-tts only says how many it produced once it has finished
   * producing them. A caller that billed from the text would be estimating, and
   * an estimate cannot reconcile against an invoice.
   *
   * Called once per synthesis. Adapters that know up front call it immediately;
   * adapters that learn at the end call it then.
   */
  onUsage?: ((usage: VoiceUsage) => void) | undefined;
  /**
   * How to say it, for vendors that can be steered — tone, pace, delivery.
   *
   * Ignored by vendors that cannot. It is the reason gpt-4o-mini-tts was chosen
   * over the cheaper OpenAI models, and it stays optional so that choosing a
   * vendor without steering costs nothing above this layer.
   */
  instructions?: string | undefined;
}

/** What a whole-file synthesis produced, and what it cost. */
export interface TtsFileResult {
  /** Encoded audio in `mimeType`, ready to upload. */
  audio: Buffer;
  mimeType: string;
  usage: VoiceUsage;
}

export interface TtsProvider {
  readonly key: string;
  readonly capabilities: TtsCapabilities;
  /**
   * Synthesise a whole reply into one playable file.
   *
   * Raw PCM is right for the browser, which schedules it as it arrives, and
   * useless as an attachment — a chat client needs a container it can play. The
   * caller is responsible for having already shortened the text (see
   * ../voice/spoken-text): a long written answer makes an audio file nobody
   * listens to.
   */
  synthesizeFile(input: TtsSynthesisInput): Promise<TtsFileResult>;
  /** PCM chunks as the vendor produces them, at `capabilities.outputSampleRateHertz`. */
  synthesize(input: TtsSynthesisInput): AsyncIterable<Buffer>;
  /**
   * The model and unit this vendor bills in, and its best estimate for `text`.
   *
   * Exact for a character-billed vendor, where the text IS the quantity. A
   * token-billed vendor cannot know before it runs, and reports the truth through
   * `onUsage` instead — so callers accumulating real spend must use that, and use
   * this only for the model and unit that label the ledger row.
   */
  usageFor(text: string): VoiceUsage;
}
