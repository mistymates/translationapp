export async function deepgramTranscribe({
  apiKey,
  model,
  wavBuffer,
  language = 'multi',
  detectLanguage = true
}) {
  const url = new URL('https://api.deepgram.com/v1/listen');
  url.searchParams.set('model', model || 'nova-3');
  url.searchParams.set('language', language);
  url.searchParams.set('detect_language', String(Boolean(detectLanguage)));
  url.searchParams.set('smart_format', 'true');
  url.searchParams.set('punctuate', 'true');

  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Token ${apiKey}`,
      'Content-Type': 'audio/wav'
    },
    body: new Blob([wavBuffer], { type: 'audio/wav' })
  });

  if (!resp.ok) {
    const errText = await resp.text().catch(() => '');
    throw new Error(`Deepgram transcription failed (${resp.status}): ${errText || 'unknown error'}`);
  }

  const data = await resp.json();
  const ch0 = data?.results?.channels?.[0];
  return {
    transcript: ch0?.alternatives?.[0]?.transcript ?? '',
    detectedLanguage: ch0?.detected_language ?? null,
    languageConfidence: ch0?.language_confidence ?? null
  };
}
