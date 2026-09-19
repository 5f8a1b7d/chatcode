import type { IRealtimeSessionOptions } from '../api';

export interface IRealtimeBinding {
	readonly modelId: string;
	readonly baseUrl: string;
	readonly protocol: string;
	readonly providerId: string;
}

export function isMoshi(protocol: string): boolean {
	return protocol === 'moshi' || protocol === 'personaplex';
}

/** Provider credentials are used only by the extension-host transport. Never return this URL to a renderer. */
export function realtimeEndpoint(binding: IRealtimeBinding, secret?: string, options: IRealtimeSessionOptions = {}): string {
	const url = new URL(binding.baseUrl.replace(/^http/, 'ws'));
	if (url.username || url.password) { throw new Error('Use the provider credential field, not URL credentials.'); }
	if (isMoshi(binding.protocol)) {
		if (url.pathname === '/') { url.pathname = '/api/chat'; }
		if (binding.protocol === 'personaplex') {
			url.searchParams.set('text_prompt', options.instructions ?? '');
			url.searchParams.set('voice_prompt', options.voiceId ?? 'NATF2.pt');
		}
	} else if (binding.protocol === 'gemini-live') {
		if (url.pathname === '/') { url.pathname = '/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent'; }
		if (secret) { url.searchParams.set('key', secret); }
	} else {
		if (!url.pathname.endsWith('/realtime')) { url.pathname = `${url.pathname.replace(/\/$/, '')}/realtime`; }
		url.searchParams.set('model', binding.modelId);
	}
	return url.toString();
}

export function realtimeSetup(binding: IRealtimeBinding, options: IRealtimeSessionOptions): object | undefined {
	if (isMoshi(binding.protocol)) { return undefined; }
	if (binding.protocol === 'gemini-live') {
		return { setup: {
			model: binding.modelId.startsWith('models/') ? binding.modelId : `models/${binding.modelId}`,
			generationConfig: { responseModalities: ['AUDIO'], ...(options.voiceId ? { speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: options.voiceId } } } } : {}) },
			...(options.instructions ? { systemInstruction: { parts: [{ text: options.instructions }] } } : {}),
			inputAudioTranscription: {}, outputAudioTranscription: {},
		} };
	}
	if (binding.protocol === 'nemotron-voicechat') {
		return { type: 'session.update', session: { instructions: options.instructions, audio: { input: { format: { type: 'audio/pcm', rate: 24000 } }, output: { format: { type: 'audio/pcm', rate: 24000 } } } } };
	}
	return { type: 'session.update', session: {
		modalities: ['text', 'audio'], instructions: options.instructions, voice: options.voiceId,
		input_audio_format: 'pcm16', output_audio_format: 'pcm16',
		input_audio_transcription: { model: 'whisper-1', ...(options.language ? { language: options.language.split('-')[0] } : {}) },
		turn_detection: { type: 'server_vad', create_response: true, interrupt_response: true },
	} };
}

export interface IWireEvent {
	type?: string;
	delta?: string;
	transcript?: string;
	setupComplete?: object;
	error?: object;
	serverContent?: {
		modelTurn?: { parts?: { inlineData?: { data: string; mimeType?: string } }[] };
		inputTranscription?: { text?: string; finished?: boolean };
		outputTranscription?: { text?: string; finished?: boolean };
		interrupted?: boolean;
		turnComplete?: boolean;
	};
}

export type NormalizedVoiceEvent =
	| { type: 'ready' | 'interrupted' | 'done' | 'error' }
	| { type: 'audio'; data: string }
	| { type: 'transcript'; role: 'user' | 'assistant'; text: string; final: boolean; append: boolean };

export function normalizeVoiceEvent(event: IWireEvent): NormalizedVoiceEvent[] {
	const result: NormalizedVoiceEvent[] = [];
	if (event.error || event.type === 'error') { return [{ type: 'error' }]; }
	if (event.setupComplete || event.type === 'session.updated') { result.push({ type: 'ready' }); }
	const content = event.serverContent;
	if (content) {
		if (content.interrupted) { result.push({ type: 'interrupted' }); }
		for (const part of content.modelTurn?.parts ?? []) {
			if (part.inlineData?.mimeType?.startsWith('audio/pcm')) { result.push({ type: 'audio', data: part.inlineData.data }); }
		}
		for (const [role, transcription] of [['user', content.inputTranscription], ['assistant', content.outputTranscription]] as const) {
			if (transcription?.text) { result.push({ type: 'transcript', role, text: transcription.text, final: transcription.finished === true, append: true }); }
		}
		if (content.turnComplete) { result.push({ type: 'done' }); }
	}
	switch (event.type) {
		case 'response.audio.delta': case 'response.output_audio.delta':
			if (event.delta) { result.push({ type: 'audio', data: event.delta }); } break;
		case 'response.audio_transcript.delta': case 'response.output_audio_transcript.delta':
			result.push({ type: 'transcript', role: 'assistant', text: event.delta ?? '', final: false, append: true }); break;
		case 'response.audio_transcript.done': case 'response.output_audio_transcript.done':
			result.push({ type: 'transcript', role: 'assistant', text: event.transcript ?? '', final: true, append: false }); break;
		case 'conversation.item.input_audio_transcription.completed':
			result.push({ type: 'transcript', role: 'user', text: event.transcript ?? '', final: true, append: false }); break;
		case 'input_audio_buffer.speech_started': result.push({ type: 'interrupted' }); break;
		case 'response.done': result.push({ type: 'done' }); break;
	}
	return result;
}
