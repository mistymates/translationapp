import OpenAI from 'openai';

export async function openaiDetectAndTranslateToEnglish({
  apiKey,
  baseURL,
  model,
  transcript,
  allowedLanguages = ['fr', 'es', 'tl'],
  skipEnglish = true
}) {
  const openai = new OpenAI({ apiKey, baseURL });
  const allowed = Array.from(new Set((allowedLanguages || []).map((x) => String(x).trim().toLowerCase()).filter(Boolean)));
  const allowedList = allowed.join('|') || 'fr|es|tl';
  const englishRule = skipEnglish ? 'Do not translate English.' : 'If input is English, keep it in natural English.';

  const prompt = [
    'You are an expert conversation editor.',
    'You are given a noisy transcript from live speech recognition. The speech is primarily in Tagalog/Filipino (often mixed with English).',
    'Your task:',
    '1. Reconstruct into clear, natural sentences.',
    '2. Remove filler words, stutters, and obvious transcription errors.',
    '3. Output natural English only.',
    '',
    'STRICT RULES:',
    '- Do NOT translate word-for-word.',
    '- Do NOT hallucinate new content.',
    `- Only process when detected language is one of: ${allowedList}.`,
    `- If detected language is not one of ${allowedList}, output empty translated_text.`,
    `- ${englishRule}`,
    '',
    'Return VALID JSON ONLY with exactly these keys:',
    `{ "detected_language": "<${allowedList}|en|other>", "translated_text": "<clean natural English or empty string>" }`,
    '',
    'Transcription:',
    transcript
  ].join('\n');

  try {
    const resp = await openai.chat.completions.create({
      model,
      messages: [{ role: 'user', content: prompt }],
      temperature: 0,
      response_format: { type: 'json_object' }
    });

    const outputText = resp.choices[0]?.message?.content || '{}';
    const parsed = JSON.parse(outputText);

    const usage = resp.usage
      ? {
          input_tokens: resp.usage.prompt_tokens ?? 0,
          output_tokens: resp.usage.completion_tokens ?? 0,
          total_tokens: resp.usage.total_tokens ?? 0
        }
      : null;

    if (typeof parsed.translated_text === 'string') {
      return { ...parsed, usage };
    }

    return {
      detected_language: 'other',
      translated_text: outputText,
      usage
    };
  } catch (err) {
    console.error('Translation error:', err);
    throw err;
  }
}
