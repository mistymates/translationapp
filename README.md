# VLX-Overlay

A real-time, low-latency voice translation overlay for Roblox, Discord calls, VRChat, or any application running on your PC. It captures your system audio, transcribes foreign speech, and translates it to English instantly using a sleek browser-based overlay.

## Features
- **Universal Capture:** Captures system audio output (WASAPI loopback). If you can hear it on your PC, VLX-Overlay can translate it.
- **Low Latency:** Uses Voice Activity Detection (VAD) to instantly chunk speech and Deepgram (`nova-3`) for incredibly fast transcription.
- **Language Forcing:** Explicitly set the language you are listening for (French, Japanese, Mandarin, Tagalog, Spanish) to eliminate AI hallucinations common with short audio segments.
- **Cost Controls:** Includes a real-time API token burn estimator and a "Stop Listening" button to instantly pause API usage when you don't need translations.
- **Text-to-Speech:** Can optionally read the translated text out loud using your browser's built-in synthesis.

## Prerequisites (Windows)
1. Node.js **20+**
2. Install dependencies:
   ```bash
   cd server
   npm install
   ```
3. Set your API keys:
   - Create a `.env` file in the `server/` directory:
     ```env
     TRANSCRIBE_PROVIDER=deepgram
     DEEPGRAM_API_KEY=your_deepgram_api_key_here
     ```

## Run
1. Start the backend server:
   ```bash
   cd server
   npm start
   ```
2. Open the UI:
   - Navigate to `http://localhost:3000` in your browser.
   - For an overlay experience, you can use browser extensions or tools like OBS/Discord to pin this window over your game.

## UI Controls
- **Listen For (Source Language):** Force the transcriber to expect a specific language (Tagalog, French, Japanese, Mandarin, Spanish) or use "Chaos Mode" (Auto-Detect).
- **API Listening / Paused:** Instantly toggle audio processing to save API tokens.
- **Translate to English:** Toggles the translation step.
- **Show Original Text:** Displays the original transcription above the translation.
- **Text-to-speech:** Uses browser speech synthesis to read translations aloud.

## Advanced Configuration
You can customize the underlying behavior by editing `server/.env`:
- `VAD_FRAME_MS`, `VAD_AGGRESSIVENESS`, `VAD_MIN_SPEECH_MS`, `VAD_MAX_SEGMENT_MS`: Tune the Voice Activity Detection.
- `TRANSLATE_ALLOWED_LANGS`: Comma-separated list of languages allowed through the translation gate.
- `UI_TEST_MODE=1`: Run the UI without initializing the audio capture engine (useful for debugging styling).
