const $ = (id) => document.getElementById(id);

const elSubtitles = $('subtitles');
const elStatus = $('status');
const elApiBillingLed = $('apiBillingLed');
const elApiBanner = $('apiBanner');
const elTranslateEnabled = $('translateEnabled');
const elShowOriginal = $('showOriginal');
const elTranslatedOnly = $('translatedOnly');
const elTtsEnabled = $('ttsEnabled');
const elSourceLanguage = $('sourceLanguage');
const elToggleApiBtn = $('toggleApiBtn');
const elManualInput = $('manualInput');
const elManualSend = $('manualSend');

const elWalletTotalUsd = $('walletTotalUsd');
const elWalletHeroSub = $('walletHeroSub');
const elStatAudioTime = $('statAudioTime');
const elStatWaitTime = $('statWaitTime');
const elStatSegments = $('statSegments');
const elStatAttempts = $('statAttempts');
const elStatTokens = $('statTokens');
const elLineTranscribeUsd = $('lineTranscribeUsd');
const elLineTranslateUsd = $('lineTranslateUsd');
const elRateTransModel = $('rateTransModel');
const elRateTranscribeMin = $('rateTranscribeMin');
const elRateTranslateIn = $('rateTranslateIn');
const elRateTranslateOut = $('rateTranslateOut');
const elWalletReset = $('walletReset');
const elWalletMeme = $('walletMeme');
const elFooterMeme = $('footerMeme');

const LS_RATE_TR = 'dtranslate_rate_transcribe_min';
const LS_RATE_IN = 'dtranslate_rate_translate_in';
const LS_RATE_OUT = 'dtranslate_rate_translate_out';

const WALLET_MEMES = [
  'doing math so you can panic accurately',
  'your silence is free · your words are item shop prices',
  'VAD said no · your wallet thanked it',
  'this panel has seen things (mostly receipts)',
  'sigma grindset: checking transcribe per-minute like taxes'
];

const FOOTER_MEMES = [
  'websocket gobbles captions · you provide trauma',
  'built with spite + stackoverflow',
  'if it lags blame windows audio · not me trust',
  'green dot = money velocity · embrace it',
  'peak UX is fiscal transparency + dumb jokes'
];

const state = {
  translateEnabled: elTranslateEnabled.checked,
  showOriginal: elShowOriginal.checked,
  translatedOnly: elTranslatedOnly.checked,
  ttsEnabled: elTtsEnabled.checked,
  sourceLanguage: elSourceLanguage ? elSourceLanguage.value : 'tl'
};

let lastUsageSnap = null;
let ratesBootstrapped = false;

let ws = null;
let lastSpoken = '';
let apiPaused = false;

if (elToggleApiBtn) {
  elToggleApiBtn.addEventListener('click', () => {
    if (ws && ws.readyState === ws.OPEN) {
      ws.send(JSON.stringify({ type: 'toggle_api', paused: !apiPaused }));
    }
  });
}

function formatUsd(n) {
  const x = Number(n) || 0;
  if (x < 0.01 && x > 0) return `$${x.toFixed(4)}`;
  if (x < 1) return `$${x.toFixed(3)}`;
  return `$${x.toFixed(2)}`;
}

function formatAudioSeconds(sec) {
  const s = Math.max(0, Number(sec) || 0);
  const m = Math.floor(s / 60);
  const r = s - m * 60;
  return `${m}:${String(Math.floor(r)).padStart(2, '0')}`;
}

function formatWaitMs(ms) {
  const x = Math.max(0, Number(ms) || 0);
  if (x < 1500) return `${Math.round(x)}ms`;
  const s = Math.round(x / 1000);
  if (s < 120) return `${s}s`;
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m}m ${String(r).padStart(2, '0')}s`;
}

function readSavedRate(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    if (raw == null || raw === '') return fallback;
    const n = Number(raw);
    return Number.isFinite(n) ? n : fallback;
  } catch {
    return fallback;
  }
}

function persistRate(key, value) {
  try {
    localStorage.setItem(key, String(value));
  } catch {
    /* ignore */
  }
}

function bootstrapRatesFromServer(pricing) {
  if (!pricing || ratesBootstrapped) return;
  const tr = readSavedRate(LS_RATE_TR, pricing.transcribeUsdPerMinute);
  const tin = readSavedRate(LS_RATE_IN, pricing.translateInputUsdPerMtok);
  const tout = readSavedRate(LS_RATE_OUT, pricing.translateOutputUsdPerMtok);
  elRateTranscribeMin.value = String(tr);
  elRateTranslateIn.value = String(tin);
  elRateTranslateOut.value = String(tout);
  ratesBootstrapped = true;
}

function getCalculatorRates() {
  return {
    transcribeUsdPerMinute: Math.max(0, Number(elRateTranscribeMin.value) || 0),
    translateInputUsdPerMtok: Math.max(0, Number(elRateTranslateIn.value) || 0),
    translateOutputUsdPerMtok: Math.max(0, Number(elRateTranslateOut.value) || 0)
  };
}

function recalcWalletUi() {
  const w = lastUsageSnap?.wallet;
  if (!w) {
    elWalletTotalUsd.textContent = '$0.0000';
    elWalletHeroSub.textContent = 'waiting for server snapshot…';
    return;
  }

  const r = getCalculatorRates();
  const transcribeUsd = (w.transcribeAudioSeconds / 60) * r.transcribeUsdPerMinute;
  const translateUsd =
    (w.translateInputTokens / 1e6) * r.translateInputUsdPerMtok +
    (w.translateOutputTokens / 1e6) * r.translateOutputUsdPerMtok;
  const total = transcribeUsd + translateUsd;

  elWalletTotalUsd.textContent = formatUsd(total);
  elLineTranscribeUsd.textContent = formatUsd(transcribeUsd);
  elLineTranslateUsd.textContent = formatUsd(translateUsd);

  const waitMs = w.transcribeWallMs + w.translateWallMs;
  elStatAudioTime.textContent = formatAudioSeconds(w.transcribeAudioSeconds);
  elStatWaitTime.textContent = formatWaitMs(waitMs);
  elStatSegments.textContent = `${w.transcribeSegmentsOk} / ${w.transcribeSegmentsFailed}`;
  elStatAttempts.textContent = `tr ${w.transcribeApiAttempts} · tl ${w.translateApiAttempts}`;
  elStatTokens.textContent = `${w.translateInputTokens} / ${w.translateOutputTokens}`;

  const avgWait = w.transcribeSegmentsOk > 0 ? (waitMs / w.transcribeSegmentsOk) : 0;
  elWalletHeroSub.textContent = `${formatAudioSeconds(w.transcribeAudioSeconds)} transcribed · ~${formatWaitMs(avgWait)} avg API wait`;
}

function applyUsageSnapshot(msg) {
  lastUsageSnap = msg;
  if (msg.pricing && elRateTransModel) {
    elRateTransModel.textContent = msg.pricing.transcribeModel || 'gpt-4o-mini-transcribe';
  }
  bootstrapRatesFromServer(msg.pricing);
  recalcWalletUi();

  if (elApiBanner) {
    if (!msg.apiLive) {
      elApiBanner.classList.remove('hidden');
      elApiBanner.textContent =
        'API offline (no key or UI_TEST_MODE) · wallet frozen at zeros · manual subtitles still work tho';
    } else {
      elApiBanner.classList.add('hidden');
    }
  }
}

function pickMeme(arr, el) {
  if (!el) return;
  el.textContent = arr[Math.floor(Math.random() * arr.length)];
}

function applyTtsDefaults() {
  if (!state.ttsEnabled && 'speechSynthesis' in window) {
    window.speechSynthesis.cancel();
  }
}

function sendSettings() {
  if (!ws || ws.readyState !== ws.OPEN) return;
  ws.send(
    JSON.stringify({
      type: 'settings',
      translateEnabled: state.translateEnabled,
      showOriginal: state.showOriginal,
      translatedOnly: state.translatedOnly,
      sourceLanguage: state.sourceLanguage
    })
  );
}

function addSubtitle({ originalText, translatedText }) {
  const wrapper = document.createElement('div');
  wrapper.className = 'subtitle';

  if (originalText && state.showOriginal && !state.translatedOnly) {
    const original = document.createElement('div');
    original.className = 'original line';
    original.textContent = originalText;
    wrapper.appendChild(original);
  }

  if (translatedText) {
    const translated = document.createElement('div');
    translated.className = 'translated line';
    translated.textContent = translatedText;
    wrapper.appendChild(translated);
  }

  elSubtitles.appendChild(wrapper);
  elSubtitles.scrollTop = elSubtitles.scrollHeight;
}

function maybeSpeak(text) {
  if (!state.ttsEnabled) return;
  if (!('speechSynthesis' in window)) return;
  const t = (text || '').trim();
  if (!t || t === lastSpoken) return;

  lastSpoken = t;
  window.speechSynthesis.cancel();
  const utter = new SpeechSynthesisUtterance(t);
  utter.rate = 1.0;
  utter.pitch = 1.0;
  utter.lang = 'en-US';
  window.speechSynthesis.speak(utter);
}

function connect() {
  const url = `ws://${location.host}`;
  ws = new WebSocket(url);

  ws.addEventListener('open', () => {
    sendSettings();
    if (elStatus) elStatus.textContent = 'Connected · loopback go brrr';
    pickMeme(WALLET_MEMES, elWalletMeme);
    pickMeme(FOOTER_MEMES, elFooterMeme);
  });

  ws.addEventListener('message', (ev) => {
    let msg = null;
    try {
      msg = JSON.parse(ev.data);
    } catch {
      return;
    }

    if (msg.type === 'usage_snapshot') {
      applyUsageSnapshot(msg);
    }

    if (msg.type === 'api_paused_state') {
      apiPaused = msg.paused;
      if (elToggleApiBtn) {
        if (apiPaused) {
          elToggleApiBtn.innerHTML = '<span>🔴 API Paused</span><span style="font-size: 0.65em; opacity: 0.8; font-weight: normal;">Click to Resume Listening</span>';
          elToggleApiBtn.classList.add('is-paused');
        } else {
          elToggleApiBtn.innerHTML = '<span>🟢 API Listening</span><span style="font-size: 0.65em; opacity: 0.8; font-weight: normal;">Click to Stop & Save Tokens</span>';
          elToggleApiBtn.classList.remove('is-paused');
        }
      }
    }

    if (msg.type === 'api_billing') {
      if (elApiBillingLed) elApiBillingLed.classList.toggle('is-active', Boolean(msg.active));
    }

    if (msg.type === 'subtitle') {
      const originalText = msg.originalText;
      const translatedText = msg.translatedText || null;
      if (!originalText && !translatedText) return;
      addSubtitle({ originalText, translatedText: translatedText || '' });
      maybeSpeak(translatedText || '');
    }

    if (msg.type === 'error') {
      const err = document.createElement('div');
      err.className = 'subtitle';
      err.style.borderLeftColor = 'var(--accent-hot)';
      err.textContent = `Error: ${msg.message || 'unknown'}`;
      elSubtitles.appendChild(err);
    }
  });

  ws.addEventListener('close', () => {
    if (elApiBillingLed) elApiBillingLed.classList.remove('is-active');
    if (elStatus) elStatus.textContent = 'Disconnected · reconnect gamblers rise up…';
    setTimeout(connect, 1000);
  });
}

elTranslateEnabled.addEventListener('change', () => {
  state.translateEnabled = elTranslateEnabled.checked;
  sendSettings();
});

if (elSourceLanguage) {
  elSourceLanguage.addEventListener('change', () => {
    state.sourceLanguage = elSourceLanguage.value;
    sendSettings();
  });
}

elShowOriginal.addEventListener('change', () => {
  state.showOriginal = elShowOriginal.checked;
});

elTranslatedOnly.addEventListener('change', () => {
  state.translatedOnly = elTranslatedOnly.checked;
});

elTtsEnabled.addEventListener('change', () => {
  state.ttsEnabled = elTtsEnabled.checked;
  applyTtsDefaults();
});

function wireRateInput(el, storageKey) {
  if (!el) return;
  el.addEventListener('change', () => {
    persistRate(storageKey, el.value);
    recalcWalletUi();
  });
  el.addEventListener('input', () => recalcWalletUi());
}

wireRateInput(elRateTranscribeMin, LS_RATE_TR);
wireRateInput(elRateTranslateIn, LS_RATE_IN);
wireRateInput(elRateTranslateOut, LS_RATE_OUT);

if (elWalletReset) {
  elWalletReset.addEventListener('click', () => {
    if (ws && ws.readyState === ws.OPEN) {
      ws.send(JSON.stringify({ type: 'wallet_reset' }));
    }
  });
}

if (elManualSend && elManualInput) {
  elManualSend.addEventListener('click', () => {
    const text = String(elManualInput.value || '').trim();
    if (!text) return;
    if (elStatus) elStatus.textContent = 'shipping fake subtitle…';

    if (ws && ws.readyState === ws.OPEN) {
      ws.send(
        JSON.stringify({
          type: 'manual_subtitle',
          originalText: text,
          translatedText: text
        })
      );
    } else if (elStatus) {
      elStatus.textContent = 'WebSocket not ready yet.';
    }

    elManualInput.value = '';
  });
}

setInterval(() => pickMeme(WALLET_MEMES, elWalletMeme), 14000);
setInterval(() => pickMeme(FOOTER_MEMES, elFooterMeme), 19000);

connect();
