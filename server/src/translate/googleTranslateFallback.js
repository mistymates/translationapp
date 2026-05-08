const SUPPORTED_SOURCE_LANGS = new Set(['fr', 'es', 'tl', 'zh', 'km']);

function normalizeLang(lang) {
  if (!lang) return null;
  const base = String(lang).toLowerCase().split('-')[0];
  if (base === 'fil') return 'tl';
  return base;
}

export async function translateToEnglishFallback({ text, sourceLanguage }) {
  const q = String(text || '').trim();
  if (!q) return '';

  const src = normalizeLang(sourceLanguage);
  const sl = src && SUPPORTED_SOURCE_LANGS.has(src) ? src : 'auto';

  const url = new URL('https://translate.googleapis.com/translate_a/single');
  url.searchParams.set('client', 'gtx');
  url.searchParams.set('sl', sl);
  url.searchParams.set('tl', 'en');
  url.searchParams.set('dt', 't');
  url.searchParams.set('q', q);

  const resp = await fetch(url);
  if (!resp.ok) {
    const errText = await resp.text().catch(() => '');
    throw new Error(`Fallback translation failed (${resp.status}): ${errText || 'unknown error'}`);
  }

  const data = await resp.json();
  const chunks = Array.isArray(data?.[0]) ? data[0] : [];
  const translated = chunks.map((c) => c?.[0] || '').join('').trim();
  const detectedRaw = String(data?.[2] || '').trim().toLowerCase();
  const detectedSource = normalizeLang(detectedRaw);
  return {
    translatedText: translated,
    detectedSource
  };
}
