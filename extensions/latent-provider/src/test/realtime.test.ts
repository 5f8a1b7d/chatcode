import * as assert from 'node:assert/strict';
import { once } from 'node:events';
import { describe, test } from 'node:test';
import WebSocket from 'ws';
import { createRealtimeBridge } from '../capabilities/realtimeBridge';
import { normalizeVoiceEvent, realtimeEndpoint, realtimeSetup } from '../capabilities/realtimeWire';
import type { IRealtimeTranscript, IRealtimeVoiceSession } from '../api';

const binding = { providerId: 'fixture', modelId: 'voice-model', protocol: 'openai-realtime', baseUrl: 'https://example.test/v1' };

describe('Realtime voice protocols', () => {
	test('selects native endpoints and PersonaPlex voice/persona parameters', () => {
		assert.deepStrictEqual([
			realtimeEndpoint(binding),
			realtimeEndpoint({ ...binding, protocol: 'moshi', baseUrl: 'http://localhost:8998' }),
			realtimeEndpoint({ ...binding, protocol: 'personaplex', baseUrl: 'ws://localhost:8998' }, undefined, { voiceId: 'NATM1.pt', instructions: 'Be concise.' }),
		], ['wss://example.test/v1/realtime?model=voice-model', 'ws://localhost:8998/api/chat', 'ws://localhost:8998/api/chat?text_prompt=Be+concise.&voice_prompt=NATM1.pt']);
	});

	test('Gemini setup and authentication are distinct from OpenAI', () => {
		const gemini = { ...binding, protocol: 'gemini-live', baseUrl: 'https://generativelanguage.googleapis.com' };
		const endpoint = new URL(realtimeEndpoint(gemini, 'fixture-secret'));
		assert.deepStrictEqual({ path: endpoint.pathname, key: endpoint.searchParams.get('key'), setup: realtimeSetup(gemini, {}) }, {
			path: '/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent', key: 'fixture-secret',
			setup: { setup: { model: 'models/voice-model', generationConfig: { responseModalities: ['AUDIO'] }, inputAudioTranscription: {}, outputAudioTranscription: {} } },
		});
	});

	test('Nemotron uses its documented audio configuration and output event names', () => {
		assert.deepStrictEqual({ setup: realtimeSetup({ ...binding, protocol: 'nemotron-voicechat' }, {}), audio: normalizeVoiceEvent({ type: 'response.output_audio.delta', delta: 'AA==' }), text: normalizeVoiceEvent({ type: 'response.output_audio_transcript.done', transcript: 'Hello' }) }, {
			setup: { type: 'session.update', session: { instructions: undefined, audio: { input: { format: { type: 'audio/pcm', rate: 24000 } }, output: { format: { type: 'audio/pcm', rate: 24000 } } } } },
			audio: [{ type: 'audio', data: 'AA==' }], text: [{ type: 'transcript', role: 'assistant', text: 'Hello', final: true, append: false }],
		});
	});

	test('normalizes Gemini audio, both transcripts, interruption and completion', () => {
		assert.deepStrictEqual(normalizeVoiceEvent({ serverContent: { interrupted: true, modelTurn: { parts: [{ inlineData: { data: 'AA==', mimeType: 'audio/pcm;rate=24000' } }] }, inputTranscription: { text: 'Hi' }, outputTranscription: { text: 'Hello' }, turnComplete: true } }), [
			{ type: 'interrupted' }, { type: 'audio', data: 'AA==' },
			{ type: 'transcript', role: 'user', text: 'Hi', final: false, append: true },
			{ type: 'transcript', role: 'assistant', text: 'Hello', final: false, append: true }, { type: 'done' },
		]);
	});

	test('loopback bridge rejects an invalid token and forwards audio through an authenticated session', async () => {
		const received: number[][] = [];
		let resolveInput!: () => void;
		const inputReceived = new Promise<void>(resolve => { resolveInput = resolve; });
		let audioListener: ((data: Uint8Array) => void) | undefined;
		let transcriptListener: ((data: IRealtimeTranscript) => void) | undefined;
		let disposed = false;
		const noopEvent = () => ({ dispose() { } });
		const session: IRealtimeVoiceSession = {
			onAudio: listener => { audioListener = listener; return { dispose() { } }; },
			onTranscript: listener => { transcriptListener = listener; return { dispose() { } }; },
			onDidClose: noopEvent,
			finish: async () => { transcriptListener?.({ role: 'user', text: 'Final words', final: true }); },
			sendAudio: data => { received.push([...data]); resolveInput(); }, commitAudio() { }, interrupt() { }, dispose: () => { disposed = true; },
		};
		const bridge = await createRealtimeBridge('voice-model', 'fixture', async () => session);
		const bad = new WebSocket(new URL('/wrong', bridge.connection.url));
		await once(bad, 'close');
		const client = new WebSocket(bridge.connection.url);
		try {
			await once(client, 'open');
			const ready = once(client, 'message');
			client.send(JSON.stringify({ type: 'session.update', session: {} }));
			assert.equal(JSON.parse(String((await ready)[0])).type, 'session.updated');
			const output = once(client, 'message');
			audioListener!(Uint8Array.from([1, 2]));
			assert.deepStrictEqual(JSON.parse(String((await output)[0])), { type: 'response.audio.delta', delta: 'AQI=' });
			const transcript = once(client, 'message');
			transcriptListener!({ role: 'user', text: 'Hi', final: true });
			assert.equal(JSON.parse(String((await transcript)[0])).text, 'Hi');
			client.send(JSON.stringify({ type: 'input_audio_buffer.append', audio: 'AwQ=' }));
			await inputReceived;
			assert.deepStrictEqual(received, [[3, 4]]);
			const finished: string[] = [];
			const drained = new Promise<void>(resolve => client.on('message', data => {
				const event = JSON.parse(data.toString());
				if (event.type === 'latent.transcript') { finished.push(event.text); }
				if (event.type === 'latent.finished') { finished.push('finished'); resolve(); }
			}));
			client.send(JSON.stringify({ type: 'latent.finish' }));
			await drained;
			assert.deepStrictEqual(finished, ['Final words', 'finished']);
		} finally { client.close(); bridge.dispose(); }
		assert.equal(disposed, true);
	});
});
