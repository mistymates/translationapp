# d-Translate (MVP)

Near real-time voice translation overlay for Roblox voice chat (via system audio loopback).

This MVP:
- Captures **system audio output** (WASAPI loopback via `native-audio-node`)
- Runs **WebRTC VAD** to avoid sending silent audio
- Transcribes speech with Deepgram (`nova-3`)
- Detects language and translates to English
- Pushes subtitles to a clean overlay GUI in your browser

## Prerequisites (Windows)
1. Node.js **20+**
2. Install dependencies:
   - `cd server`
   - `npm install`
3. Set your Deepgram key:
   - Create `.env` in `server/` (recommended) with:
     - `TRANSCRIBE_PROVIDER=deepgram`
     - `DEEPGRAM_API_KEY=your_key_here`

## Run
1. Start the server:
   - `cd server`
   - `npm start`
2. Open the UI:
   - `http://localhost:3000`

## Controls
- `Translate to English`: enables/disables translation (also gates whether the server calls the translation model to save cost)
- `Show original text`: displays the original transcription line
- `Show translated only`: hides original text (translated line remains)
- `Text-to-speech (optional)`: uses your browser speech synthesis

## Environment Variables (optional)
In `server/.env`:
- `PORT` (default `3000`)
- `TRANSCRIBE_PROVIDER` (`deepgram` or `openai`, default `deepgram`)
- `DEEPGRAM_API_KEY` (required for Deepgram transcription unless `UI_TEST_MODE=1`)
- `OPENAI_API_KEY` (optional; used for translation)
- `OPENAI_BASE_URL` (optional). Use this for OpenAI-compatible gateways.
- `UI_TEST_MODE` (default `0`). Set to `1` to skip audio capture/transcription and test the overlay using the built-in manual subtitle box.
- `VAD_FRAME_MS` (default `30`)
- `VAD_AGGRESSIVENESS` (0-3, default `3`)
- `VAD_MIN_SPEECH_MS` (default `250`)
- `VAD_HANGOVER_MS` (default `300`)
- `VAD_MAX_SEGMENT_MS` (default `4500`)
- `DISABLE_VAD` (default `false`; when `true`, sends fixed audio chunks without speech gating)
- `RAW_SEGMENT_MS` (default `4200`; chunk size used when `DISABLE_VAD=true`)
- `TAGALOG_RETRY_ENABLED` (default `true`; retries transcription with forced `tl` when multi-detect looks wrong)
- `TRANSCRIBE_MODEL` (default `nova-3`)
- `DEEPGRAM_LANGUAGE` (default `multi`; set e.g. `es`, `fr`, `ja` to force one language)
- `DEEPGRAM_DETECT_LANGUAGE` (default `true`)
- `TRANSLATE_MODEL` (default `gpt-4o-mini`)
- `TRANSLATE_ALLOWED_LANGS` (default `fr,es,tl,zh,km`; only these are translated)
- `TRANSLATE_SKIP_ENGLISH` (default `true`; English lines are not translated)
- `TRANSLATE_FALLBACK_ENABLED` (default `true`; uses a no-key fallback translator when `OPENAI_API_KEY` is empty)

## Notes / Limitations
- Roblox audio is captured as **system output**. Ensure Roblox voice chat audio is routed through your system output device.
- The VAD segmentation is designed to be low-cost and low-latency, but it may split or merge utterances depending on noise/volume.

