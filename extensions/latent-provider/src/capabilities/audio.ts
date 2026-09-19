import { ensureSuccess } from './text';

export interface IAudioBinding {
	readonly modelId: string;
	readonly baseUrl: string;
	readonly protocol: string;
}

/** Batch speech-to-text over the OpenAI-compatible `/audio/transcriptions` endpoint. */
export async function transcribeAudio(binding: IAudioBinding, secret: string | undefined, audio: Uint8Array, mimeType: string, language: string | undefined, signal: AbortSignal): Promise<string> {
	const endpoint = `${binding.baseUrl.replace(/\/$/, '')}/audio/transcriptions`;
	const form = new FormData();
	form.append('model', binding.modelId);
	form.append('file', new Blob([audio], { type: mimeType }), mimeType.includes('wav') ? 'audio.wav' : mimeType.includes('webm') ? 'audio.webm' : 'audio.bin');
	if (language) {
		form.append('language', language.split('-')[0]);
	}
	form.append('response_format', 'json');
	const headers: Record<string, string> = {};
	if (secret) {
		headers.authorization = `Bearer ${secret}`;
	}
	const response = await fetch(endpoint, { method: 'POST', headers, body: form, signal });
	await ensureSuccess(response);
	const payload = await response.json() as { text?: string };
	return payload.text ?? '';
}

/** Text-to-speech over the OpenAI-compatible `/audio/speech` endpoint; yields the audio in chunks. */
export async function* synthesizeSpeech(binding: IAudioBinding, secret: string | undefined, text: string, voiceId: string | undefined, format: string | undefined, signal: AbortSignal): AsyncIterable<Uint8Array> {
	const endpoint = `${binding.baseUrl.replace(/\/$/, '')}/audio/speech`;
	const headers: Record<string, string> = { 'content-type': 'application/json' };
	if (secret) {
		headers.authorization = `Bearer ${secret}`;
	}
	const response = await fetch(endpoint, {
		method: 'POST',
		headers,
		body: JSON.stringify({ model: binding.modelId, input: text, voice: voiceId ?? 'alloy', response_format: format === 'pcm16' ? 'pcm' : format ?? 'mp3' }),
		signal,
	});
	await ensureSuccess(response);
	if (!response.body) {
		return;
	}
	const reader = response.body.getReader();
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) {
				break;
			}
			if (value?.length) {
				yield value;
			}
		}
	} finally {
		reader.releaseLock();
	}
}
