import { EventEmitter } from 'events';
import * as webrtcvad from 'webrtcvad';

// `webrtcvad` is published as CommonJS with a `default` export.
// Under ESM, some Node versions import the module namespace instead of the constructor.
const VADImport = webrtcvad.default ?? webrtcvad;
// For ESM namespace imports, `VADImport` can itself be an object like:
// { __esModule: true, default: [Function: VAD] }
const VAD = typeof VADImport === 'function' ? VADImport : VADImport?.default;

// WebRTC VAD emits speech/non-speech per frame.
// We use a small "pre-speech" buffer and an ~800ms hangover so we don't cut sentences.
export class VADSegmenter extends EventEmitter {
  constructor({
    sampleRate,
    frameMs,
    aggressiveness,
    minSpeechMs,
    hangoverMs,
    maxSegmentMs
  }) {
    super();

    this.sampleRate = sampleRate;
    this.frameMs = frameMs;
    this.frameBytes = Math.round(sampleRate * (frameMs / 1000) * 2); // 16-bit => 2 bytes/sample

    this.vad = new VAD(sampleRate, aggressiveness);

    this.minSpeechFrames = Math.ceil(minSpeechMs / frameMs);
    this.hangoverFrames = Math.ceil(hangoverMs / frameMs);
    this.maxSegmentFrames = Math.ceil(maxSegmentMs / frameMs);

    // Capture a bit of audio before VAD triggers, to avoid clipping the first phonemes.
    this.preSpeechFrames = Math.ceil(300 / frameMs);

    this.inSpeech = false;
    this.trailingSilence = 0;

    this.currentFrames = [];
    this.preFrames = [];
  }

  push(pcm16leFrameBuffer) {
    if (!pcm16leFrameBuffer || pcm16leFrameBuffer.length < this.frameBytes) return;

    const frame = pcm16leFrameBuffer.subarray
      ? pcm16leFrameBuffer.subarray(0, this.frameBytes)
      : pcm16leFrameBuffer.slice(0, this.frameBytes);

    const isSpeech = this.vad.process(frame);

    if (this.inSpeech) {
      this.currentFrames.push(frame);

      if (isSpeech) {
        this.trailingSilence = 0;
      } else {
        this.trailingSilence += 1;
        if (this.trailingSilence >= this.hangoverFrames) {
          this.flush();
        }
      }

      if (this.currentFrames.length >= this.maxSegmentFrames) {
        this.flush();
      }
      return;
    }

    // Not in speech yet: maintain a rolling pre-speech buffer.
    this.preFrames.push(frame);
    if (this.preFrames.length > this.preSpeechFrames) this.preFrames.shift();

    if (isSpeech) {
      this.inSpeech = true;
      this.trailingSilence = 0;
      this.currentFrames = this.preFrames.slice();
      this.preFrames = [];
      // currentFrames already includes this frame via pre-buffer
    }
  }

  flush() {
    const frames = this.currentFrames;
    this.inSpeech = false;
    this.trailingSilence = 0;
    this.currentFrames = [];

    if (frames.length < this.minSpeechFrames) return;

    const pcm = Buffer.concat(frames);
    this.emit('segment', pcm);
  }
}

