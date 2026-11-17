// Microphone capture for dictation: Float32 samples in, 16-bit PCM out.
//
// A real file rather than a blob: URL because the site's Content-Security-Policy
// allows scripts from 'self' only, and an AudioWorklet module is a script. A blob
// is refused before it loads, which takes the microphone down with it.
//
// Raw PCM is what the recogniser is configured for. It cannot take a container
// frame by frame — only a container's first chunk carries the headers a decoder
// needs, so everything after it would be undecodable on its own.

/**
 * Render quanta summarised into one loudness reading.
 *
 * Eight quanta is about 21ms at 48kHz, so a level arrives roughly 47 times a
 * second: often enough to time a 120ms speech onset, rarely enough that the
 * main thread is not woken for every 2.7ms block of audio.
 */
const LEVEL_QUANTA = 8

class PcmForwarder extends AudioWorkletProcessor {
  constructor() {
    super()
    this.energy = 0
    this.samples = 0
    this.quanta = 0
    this.peak = 0
  }

  process(inputs) {
    const channel = inputs[0] && inputs[0][0]
    if (!channel) return true

    const pcm = new Int16Array(channel.length)
    let energy = 0
    let peak = 0
    for (let i = 0; i < channel.length; i++) {
      // Clamp before scaling: a sample outside [-1, 1] wraps rather than clips,
      // which is heard as a click instead of distortion.
      const sample = Math.max(-1, Math.min(1, channel[i]))
      energy += sample * sample
      const magnitude = sample < 0 ? -sample : sample
      if (magnitude > peak) peak = magnitude
      pcm[i] = sample < 0 ? sample * 0x8000 : sample * 0x7fff
    }

    // Transferred, not copied: this runs on every render quantum.
    this.port.postMessage(pcm.buffer, [pcm.buffer])

    // Loudness for turn-taking, summed where the samples already are and
    // judged upstairs. Nothing here decides what counts as speech: a threshold
    // is a judgement, and a judgement inside an AudioWorklet is one no test can
    // reach. This adds up energy and reports it.
    this.energy += energy
    this.samples += channel.length
    this.quanta += 1
    if (peak > this.peak) this.peak = peak
    if (this.quanta >= LEVEL_QUANTA) {
      this.port.postMessage({
        type: 'level',
        rms: Math.sqrt(this.energy / this.samples),
        // The loudest single sample in the span, reported beside the average so
        // the listener can tell a bang from a voice. A key press or a trackpad
        // tap is nearly all peak and very little average; speech, which is a
        // sustained sound rather than a collision, is not.
        peak: this.peak,
        // The span this reading covers, so the listener can measure durations
        // in audio time rather than guessing from the arrival of messages.
        ms: (this.samples / sampleRate) * 1000,
      })
      this.energy = 0
      this.samples = 0
      this.quanta = 0
      this.peak = 0
    }
    return true
  }
}

registerProcessor('pcm-forwarder', PcmForwarder)
