import 'dotenv/config';

// Bypass SSL certificate errors (useful for local development behind proxies)
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

import express from 'express';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { WebSocketServer } from 'ws';

import { SystemAudioRecorder } from 'native-audio-node';

import { VADSegmenter } from './src/audio/vadSegmenter.js';
import { toWavPcm16LE } from './src/audio/wav.js';
import { openaiTranscribe } from './src/openai/openaiTranscribe.js';
import { deepgramTranscribe } from './src/deepgram/deepgramTranscribe.js';
import { openaiDetectAndTranslateToEnglish } from './src/openai/openaiTranslate.js';
import { translateToEnglishFallback } from './src/translate/googleTranslateFallback.js';
import { sleep } from './src/util/sleep.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = Number(process.env.PORT || 3000);
const TRANSCRIBE_PROVIDER = String(process.env.TRANSCRIBE_PROVIDER || 'deepgram').toLowerCase();
const DEEPGRAM_API_KEY = process.env.DEEPGRAM_API_KEY;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_BASE_URL = process.env.OPENAI_BASE_URL || undefined;
const UI_TEST_MODE = ['1', 'true', 'yes', 'on'].includes(String(process.env.UI_TEST_MODE || '').toLowerCase());

const TRANSCRIBE_API_AVAILABLE =
  !UI_TEST_MODE &&
  ((TRANSCRIBE_PROVIDER === 'deepgram' && Boolean(DEEPGRAM_API_KEY)) ||
    (TRANSCRIBE_PROVIDER === 'openai' && Boolean(OPENAI_API_KEY)));
const TRANSLATE_API_AVAILABLE = Boolean(OPENAI_API_KEY) && !UI_TEST_MODE;

if (!TRANSCRIBE_API_AVAILABLE) {
  if (UI_TEST_MODE) {
    console.warn('UI_TEST_MODE=1 enabled: skipping audio capture/transcription.');
  } else {
    console.error(`FATAL: Transcription provider '${TRANSCRIBE_PROVIDER}' selected, but its API key is missing in .env.`);
    console.error('Set DEEPGRAM_API_KEY or OPENAI_API_KEY, or run with UI_TEST_MODE=1 to bypass.');
    process.exit(1);
  }
}

const FRAME_MS = Number(process.env.VAD_FRAME_MS || 30);
const VAD_AGGRESSIVENESS = Number(process.env.VAD_AGGRESSIVENESS || 3);
const MIN_SPEECH_MS = Number(process.env.VAD_MIN_SPEECH_MS || 250);
const HANGOVER_MS = Number(process.env.VAD_HANGOVER_MS || 300);
const MAX_SEGMENT_MS = Number(process.env.VAD_MAX_SEGMENT_MS || 4500);
const DISABLE_VAD = ['1', 'true', 'yes', 'on'].includes(String(process.env.DISABLE_VAD || '').toLowerCase());
const RAW_SEGMENT_MS = Number(process.env.RAW_SEGMENT_MS || 4200);
const TAGALOG_RETRY_ENABLED = !['0', 'false', 'no', 'off'].includes(
  String(process.env.TAGALOG_RETRY_ENABLED || 'true').toLowerCase()
);

const TRANSCRIBE_MODEL = process.env.TRANSCRIBE_MODEL || 'nova-3';
const DEEPGRAM_LANGUAGE = process.env.DEEPGRAM_LANGUAGE || 'multi';
const DEEPGRAM_DETECT_LANGUAGE = !['0', 'false', 'no', 'off'].includes(
  String(process.env.DEEPGRAM_DETECT_LANGUAGE || 'true').toLowerCase()
);
const TRANSLATE_MODEL = process.env.TRANSLATE_MODEL || 'gpt-4o-mini';
const TRANSLATE_ALLOWED_LANGS = String(process.env.TRANSLATE_ALLOWED_LANGS || 'fr,es,tl,zh,km')
  .split(',')
  .map((s) => s.trim().toLowerCase())
  .filter(Boolean);
const TRANSLATE_SKIP_ENGLISH = !['0', 'false', 'no', 'off'].includes(
  String(process.env.TRANSLATE_SKIP_ENGLISH || 'true').toLowerCase()
);
const TRANSLATE_FALLBACK_ENABLED = !['0', 'false', 'no', 'off'].includes(
  String(process.env.TRANSLATE_FALLBACK_ENABLED || 'true').toLowerCase()
);
const ALLOWED_DETECTED_LANGS = new Set(['en', ...TRANSLATE_ALLOWED_LANGS]);

function normalizeLanguageTag(lang) {
  const base = String(lang || '')
    .toLowerCase()
    .split('-')[0]
    .trim();
  if (!base) return 'other';
  if (base === 'fil') return 'tl';
  return base;
}

function clampDetectedLanguage(lang) {
  const normalized = normalizeLanguageTag(lang);
  return ALLOWED_DETECTED_LANGS.has(normalized) ? normalized : 'other';
}

// Rough public pricing defaults (override via .env if OpenAI changes rates).
const TRANSCRIBE_USD_PER_MINUTE = Number(process.env.TRANSCRIBE_USD_PER_MINUTE || 0.003);
const TRANSLATE_INPUT_USD_PER_MTOK = Number(process.env.TRANSLATE_INPUT_USD_PER_MTOK || 0.15);
const TRANSLATE_OUTPUT_USD_PER_MTOK = Number(process.env.TRANSLATE_OUTPUT_USD_PER_MTOK || 0.6);

const recorderOptions = {
  // 16kHz mono is what webrtcvad expects.
  sampleRate: 16000,
  chunkDurationMs: FRAME_MS,
  stereo: false,
  // Windows: emit silent chunks so VAD can measure "end of speech".
  emitSilence: true
};

const app = express();
app.use(express.static(path.join(__dirname, '..', 'client')));

app.get('/health', (_req, res) => {
  res.json({ ok: true });
});

const server = http.createServer(app);
const wss = new WebSocketServer({ server });

// Per-connection UI settings (translation gating happens globally to save cost).
const clientSettings = new Map(); // ws -> settings
let translationWanted = false; // if at least one client wants translation enabled
let globalSourceLanguage = 'tl'; // the forced language for Deepgram, or 'multi' for auto-detect

function updateGlobalSettings() {
  translationWanted = Array.from(clientSettings.values()).some((s) => s.translateEnabled);
  
  // Just use the first connected client's source language preference, or 'tl' by default
  const firstClient = Array.from(clientSettings.values())[0];
  globalSourceLanguage = firstClient ? (firstClient.sourceLanguage || 'tl') : 'tl';
}

function safeSend(ws, payload) {
  if (ws.readyState !== ws.OPEN) return;
  ws.send(JSON.stringify(payload));
}

function broadcastApiBilling(active) {
  for (const ws of wss.clients) {
    safeSend(ws, { type: 'api_billing', active: Boolean(active) });
  }
}

function pricingPayload() {
  return {
    transcribeUsdPerMinute: TRANSCRIBE_USD_PER_MINUTE,
    translateInputUsdPerMtok: TRANSLATE_INPUT_USD_PER_MTOK,
    translateOutputUsdPerMtok: TRANSLATE_OUTPUT_USD_PER_MTOK,
    transcribeModel: TRANSCRIBE_MODEL,
    translateModel: TRANSLATE_MODEL
  };
}

/** Cumulative session counters (resets on server restart or client "copium reset"). */
let wallet = {
  transcribeAudioSeconds: 0,
  transcribeSegmentsOk: 0,
  transcribeSegmentsFailed: 0,
  transcribeApiAttempts: 0,
  transcribeWallMs: 0,
  translateCallsOk: 0,
  translateCallsFailed: 0,
  translateApiAttempts: 0,
  translateInputTokens: 0,
  translateOutputTokens: 0,
  translateWallMs: 0
};

function walletEstimates() {
  const transcribeUsd = (wallet.transcribeAudioSeconds / 60) * TRANSCRIBE_USD_PER_MINUTE;
  const translateUsd =
    (wallet.translateInputTokens / 1e6) * TRANSLATE_INPUT_USD_PER_MTOK +
    (wallet.translateOutputTokens / 1e6) * TRANSLATE_OUTPUT_USD_PER_MTOK;
  return {
    transcribeUsdEstimated: transcribeUsd,
    translateUsdEstimated: translateUsd,
    totalUsdEstimated: transcribeUsd + translateUsd,
    openAiWaitMs: wallet.transcribeWallMs + wallet.translateWallMs
  };
}

function usageSnapshotPayload() {
  return {
    type: 'usage_snapshot',
    apiLive: TRANSCRIBE_API_AVAILABLE,
    pricing: pricingPayload(),
    wallet: { ...wallet },
    estimates: walletEstimates()
  };
}

function broadcastUsageSnapshot() {
  const snap = usageSnapshotPayload();
  for (const ws of wss.clients) {
    safeSend(ws, snap);
  }
}

function resetWallet() {
  wallet = {
    transcribeAudioSeconds: 0,
    transcribeSegmentsOk: 0,
    transcribeSegmentsFailed: 0,
    transcribeApiAttempts: 0,
    transcribeWallMs: 0,
    translateCallsOk: 0,
    translateCallsFailed: 0,
    translateApiAttempts: 0,
    translateInputTokens: 0,
    translateOutputTokens: 0,
    translateWallMs: 0
  };
}

// Keep only one active segment processing at a time to reduce latency spikes.
let processing = false;
let pendingSegment = null;
let apiPaused = false;

async function processSegment(pcm16leBuffer) {
  if (apiPaused) return;
  const now = Date.now();

  if (!TRANSCRIBE_API_AVAILABLE) {
    // Shouldn't happen because audio capture is disabled in UI test mode,
    // but keep a guard to avoid confusing runtime errors.
    return;
  }

  const audioSeconds = pcm16leBuffer.length / (2 * 16000);

  try {
    broadcastApiBilling(true);

    // Convert raw PCM frames to a WAV file for OpenAI.
    const wavBuffer = toWavPcm16LE(pcm16leBuffer, 16000);

    let transcript = '';
    let transcribeDetectedLanguage = null;
    let transcribeLanguageConfidence = null;
    try {
      const trStart = Date.now();
      const tr = await retryWithMeta(
        async () => {
          if (TRANSCRIBE_PROVIDER === 'deepgram') {
            return deepgramTranscribe({
              apiKey: DEEPGRAM_API_KEY,
              model: TRANSCRIBE_MODEL,
              language: globalSourceLanguage,
              detectLanguage: globalSourceLanguage === 'multi',
              wavBuffer
            });
          }

          return openaiTranscribe({
            apiKey: OPENAI_API_KEY,
            baseURL: OPENAI_BASE_URL,
            model: TRANSCRIBE_MODEL,
            wavBuffer
          });
        },
        3,
        750
      );
      if (typeof tr.value === 'string') {
        transcript = tr.value;
      } else {
        transcript = tr.value?.transcript ?? '';
        transcribeDetectedLanguage = tr.value?.detectedLanguage ?? (globalSourceLanguage !== 'multi' ? globalSourceLanguage : null);
        transcribeLanguageConfidence = Number(tr.value?.languageConfidence ?? 0) || 0;
      }

      const clampedLang = clampDetectedLanguage(transcribeDetectedLanguage);
      const isEnglishOrOther = clampedLang === 'en' || clampedLang === 'other';

      if (
        TRANSCRIBE_PROVIDER === 'deepgram' &&
        TAGALOG_RETRY_ENABLED &&
        globalSourceLanguage === 'multi' &&
        transcript &&
        (isEnglishOrOther || transcribeLanguageConfidence < 0.65)
      ) {
        const tlRetry = await deepgramTranscribe({
          apiKey: DEEPGRAM_API_KEY,
          model: TRANSCRIBE_MODEL,
          language: 'tl',
          detectLanguage: false,
          wavBuffer
        });
        const retryText = String(tlRetry?.transcript || '').trim();
        if (retryText && retryText.length >= transcript.trim().length * 1.1) {
          transcript = retryText;
          transcribeDetectedLanguage = 'tl';
        }
      }
      wallet.transcribeWallMs += Date.now() - trStart;
      wallet.transcribeApiAttempts += tr.attempts;
      wallet.transcribeSegmentsOk += 1;
      wallet.transcribeAudioSeconds += audioSeconds;
    } catch (err) {
      wallet.transcribeSegmentsFailed += 1;
      if (typeof err.attempts === 'number') wallet.transcribeApiAttempts += err.attempts;
      throw err.cause || err;
    }

    if (!transcript || !transcript.trim()) return;

    let detectedLanguage = clampDetectedLanguage(transcribeDetectedLanguage);
    let englishTranslation = null;

    if (translationWanted && TRANSLATE_API_AVAILABLE) {
      try {
        const tlStart = Date.now();
        const tl = await retryWithMeta(
          async () =>
            openaiDetectAndTranslateToEnglish({
              apiKey: OPENAI_API_KEY,
              baseURL: OPENAI_BASE_URL,
              model: TRANSLATE_MODEL,
              transcript,
              allowedLanguages: TRANSLATE_ALLOWED_LANGS,
              skipEnglish: TRANSLATE_SKIP_ENGLISH
            }),
          3,
          750
        );
        wallet.translateWallMs += Date.now() - tlStart;
        wallet.translateApiAttempts += tl.attempts;
        wallet.translateCallsOk += 1;

        const translated = tl.value;
        if (translated.detected_language) {
          detectedLanguage = clampDetectedLanguage(translated.detected_language);
        }
        englishTranslation = translated.translated_text ?? null;
        if (translated.usage) {
          wallet.translateInputTokens += translated.usage.input_tokens ?? 0;
          wallet.translateOutputTokens += translated.usage.output_tokens ?? 0;
        }
      } catch (err) {
        wallet.translateCallsFailed += 1;
        if (typeof err.attempts === 'number') wallet.translateApiAttempts += err.attempts;
        // Keep subtitles flowing even if translation provider/model is unavailable.
        // We still send the original transcript and mark translation as empty.
        console.warn('Translation failed; continuing with transcript only:', String(err?.message || err));
      }
    }

    if (TRANSLATE_SKIP_ENGLISH && detectedLanguage === 'en') {
      englishTranslation = '';
    }

    if (
      translationWanted &&
      !englishTranslation &&
      TRANSLATE_FALLBACK_ENABLED &&
      !TRANSLATE_API_AVAILABLE
    ) {
      // Hard language gate: only translate explicitly allowed languages.
      // Do not auto-detect in fallback, otherwise random languages can slip in.
      if (TRANSLATE_ALLOWED_LANGS.includes(detectedLanguage)) {
        try {
          const fallback = await translateToEnglishFallback({
            text: transcript,
            sourceLanguage: detectedLanguage
          });
          englishTranslation = fallback?.translatedText || '';
        } catch (err) {
          console.warn('Fallback translation failed:', String(err?.message || err));
        }
      }

    }

    // Final hard gate: translation text must only appear for explicitly allowed languages.
    if (!TRANSLATE_ALLOWED_LANGS.includes(detectedLanguage)) {
      englishTranslation = '';
    }

    // Broadcast subtitle payload to all clients.
    for (const ws of wss.clients) {
      const settings = clientSettings.get(ws);
      if (!settings) continue;

      const sendOriginal = settings.showOriginal;
      const sendTranslation = settings.translateEnabled;
      const onlyTranslated = settings.translatedOnly;

      safeSend(ws, {
        type: 'subtitle',
        id: `sub_${now}_${Math.random().toString(16).slice(2)}`,
        timestamp: now,
        originalText: sendOriginal && !onlyTranslated ? transcript : null,
        translatedText: sendTranslation && !onlyTranslated ? englishTranslation : (sendTranslation && onlyTranslated ? englishTranslation : null),
        detectedLanguage: detectedLanguage
      });
    }
  } finally {
    broadcastUsageSnapshot();
    broadcastApiBilling(false);
  }
}

async function retryWithMeta(fn, maxAttempts, baseDelayMs) {
  let lastErr = null;
  let attempts = 0;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      attempts++;
      const value = await fn();
      return { value, attempts };
    } catch (err) {
      lastErr = err;
      const delay = baseDelayMs * Math.pow(2, attempt - 1) + Math.random() * 150;
      await sleep(delay);
    }
  }
  const wrapped = new Error(String(lastErr?.message || lastErr || 'retry failed'));
  wrapped.attempts = attempts;
  wrapped.cause = lastErr;
  throw wrapped;
}

// ---- WebSocket connections ----
wss.on('connection', (ws) => {
  clientSettings.set(ws, {
    translateEnabled: true,
    showOriginal: true,
    translatedOnly: false,
    sourceLanguage: 'tl'
  });
  updateGlobalSettings();

  ws.on('message', (raw) => {
    let msg = null;
    try {
      msg = JSON.parse(raw.toString('utf8'));
    } catch {
      return;
    }

    if (msg.type === 'toggle_api') {
      apiPaused = Boolean(msg.paused);
      for (const clientWs of wss.clients) {
        safeSend(clientWs, { type: 'api_paused_state', paused: apiPaused });
      }
      return;
    }

    if (msg.type === 'manual_subtitle') {
      const originalText = String(msg.originalText || '').trim();
      if (!originalText) return;

      const translatedText = String(msg.translatedText || originalText).trim();
      const detectedLanguage = msg.detectedLanguage ? String(msg.detectedLanguage) : null;

      const now = Date.now();
      for (const clientWs of wss.clients) {
        const settings = clientSettings.get(clientWs);
        if (!settings) continue;

        const onlyTranslated = settings.translatedOnly;
        const sendOriginal = settings.showOriginal && !onlyTranslated;
        const sendTranslation = settings.translateEnabled;

        safeSend(clientWs, {
          type: 'subtitle',
          id: `manual_${now}_${Math.random().toString(16).slice(2)}`,
          timestamp: now,
          originalText: sendOriginal ? originalText : null,
          translatedText: sendTranslation ? translatedText : null,
          detectedLanguage
        });
      }
      return;
    }

    if (msg.type === 'settings') {
      const cur = clientSettings.get(ws);
      if (!cur) return;

      if (typeof msg.translateEnabled === 'boolean') cur.translateEnabled = msg.translateEnabled;
      if (typeof msg.showOriginal === 'boolean') cur.showOriginal = msg.showOriginal;
      if (typeof msg.translatedOnly === 'boolean') cur.translatedOnly = msg.translatedOnly;
      if (typeof msg.sourceLanguage === 'string') cur.sourceLanguage = msg.sourceLanguage;
      updateGlobalSettings();
    }

    if (msg.type === 'wallet_reset') {
      resetWallet();
      broadcastUsageSnapshot();
    }
  });

  ws.on('close', () => {
    clientSettings.delete(ws);
    updateGlobalSettings();
  });

  safeSend(ws, { type: 'ready', at: Date.now() });
  safeSend(ws, { type: 'api_billing', active: false });
  safeSend(ws, { type: 'api_paused_state', paused: apiPaused });
  safeSend(ws, usageSnapshotPayload());
});

// ---- Audio capture + VAD segmentation ----
const segmenter = new VADSegmenter({
  sampleRate: 16000,
  frameMs: FRAME_MS,
  aggressiveness: VAD_AGGRESSIVENESS,
  minSpeechMs: MIN_SPEECH_MS,
  hangoverMs: HANGOVER_MS,
  maxSegmentMs: MAX_SEGMENT_MS
});

segmenter.on('segment', (pcm16leBuffer) => {
  // Simple backpressure: if we're busy, keep only the latest segment.
  pendingSegment = pcm16leBuffer;
});

async function start() {
  server.listen(PORT, () => {
    console.log(`Server running: http://localhost:${PORT}`);
  });

  if (!TRANSCRIBE_API_AVAILABLE) {
    // UI-only mode: server + websocket runs, but audio capture/transcription is disabled.
    // Use the UI's "Send test subtitle" to validate subtitles/overlay.
    return;
  }

  const recorder = new SystemAudioRecorder(recorderOptions);
  recorder.on('error', (err) => {
    console.error('Audio recorder error:', err);
  });

  let audioFormat = null;
  recorder.on('metadata', (meta) => {
    audioFormat = meta;
  });

  await recorder.start();

  console.log('System audio capture started (loopback).');
  if (DISABLE_VAD) {
    console.warn(`DISABLE_VAD enabled: sending fixed ${RAW_SEGMENT_MS}ms audio chunks to API.`);
  }

  let rawFrames = [];
  let rawBufferedMs = 0;

  recorder.on('data', (chunk) => {
    // native-audio-node can emit either int16 or float PCM.
    // webrtcvad only accepts int16 signed linear PCM.
    if (!audioFormat) return;

    if (audioFormat.isFloat) {
      // Convert float32 [-1..1] PCM to int16 PCM.
      const frameInt16 = floatTo16BitPCM(chunk.data);
      if (DISABLE_VAD) {
        rawFrames.push(frameInt16);
        rawBufferedMs += FRAME_MS;
      } else {
        segmenter.push(frameInt16);
      }
    } else {
      if (DISABLE_VAD) {
        rawFrames.push(chunk.data);
        rawBufferedMs += FRAME_MS;
      } else {
        segmenter.push(chunk.data);
      }
    }

    if (DISABLE_VAD && rawBufferedMs >= RAW_SEGMENT_MS) {
      pendingSegment = Buffer.concat(rawFrames);
      rawFrames = [];
      rawBufferedMs = 0;
    }

    // Keep processing loop responsive.
    // If we aren't processing, start with the newest pending segment.
    void pump();
  });

  async function pump() {
    if (processing) return;
    if (!pendingSegment) return;

    processing = true;
    const seg = pendingSegment;
    pendingSegment = null;

    try {
      await processSegment(seg);
    } catch (err) {
      console.error('Segment processing error:', err);
      for (const ws of wss.clients) {
        safeSend(ws, { type: 'error', message: String(err?.message || err) });
      }
    } finally {
      processing = false;
      // If a new segment arrived during processing, handle it next.
      if (pendingSegment) void pump();
    }
  }
}

function floatTo16BitPCM(floatBuffer) {
  // native-audio-node emits 32-bit float PCM when `isFloat === true`.
  // Convert to signed int16 PCM expected by webrtcvad.
  const out = Buffer.alloc(floatBuffer.length / 2);
  // floatBuffer is a Buffer; interpret as Float32Array
  const samples = new Float32Array(floatBuffer.buffer, floatBuffer.byteOffset, floatBuffer.byteLength / 4);
  for (let i = 0; i < samples.length; i++) {
    let s = samples[i];
    if (s > 1) s = 1;
    if (s < -1) s = -1;
    const v = s < 0 ? s * 0x8000 : s * 0x7fff;
    out.writeInt16LE(v, i * 2);
  }
  return out;
}

start().catch((err) => {
  console.error(err);
  process.exit(1);
});

