import OpenAI, { toFile } from 'openai';

export async function openaiTranscribe({ apiKey, baseURL, model, wavBuffer }) {
  const openai = new OpenAI({ apiKey, baseURL });

  const file = await toFile(wavBuffer, 'audio.wav', { type: 'audio/wav' });

  const resp = await openai.audio.transcriptions.create({
    model,
    file
  });

  return resp?.text ?? '';
}
