/* eslint-disable header/header */
import { Emitter, Event } from '../../../../../base/common/event.js';
import { Disposable } from '../../../../../base/common/lifecycle.js';
import { mainWindow } from '../../../../../base/browser/window.js';

export interface IVoiceConnection {
	readonly url: string;
	readonly protocols: readonly string[];
	readonly model: string;
}

export interface IVoiceTranscript {
	readonly role: 'user' | 'assistant';
	readonly text: string;
	readonly final: boolean;
}

export type VoiceSessionState = 'connecting' | 'listening' | 'speaking' | 'error' | 'closed';

const SAMPLE_RATE = 24000;

/**
 * Full-duplex voice in the renderer (P2-FR-063): microphone PCM16 goes to an
 * OpenAI-realtime-compatible endpoint, synthesized audio plays back, and user
 * speech interrupts playback (barge-in). Connection details come from the
 * Provider extension so no credential lives in this file.
 */
export class LatentVoiceSession extends Disposable {

	private readonly _onDidChangeState = this._register(new Emitter<VoiceSessionState>());
	readonly onDidChangeState: Event<VoiceSessionState> = this._onDidChangeState.event;
	private readonly _onDidTranscript = this._register(new Emitter<IVoiceTranscript>());
	readonly onDidTranscript: Event<IVoiceTranscript> = this._onDidTranscript.event;

	private socket: WebSocket | undefined;
	private context: AudioContext | undefined;
	private stream: MediaStream | undefined;
	private processor: ScriptProcessorNode | undefined;
	private playhead = 0;
	private readonly playback = new Set<AudioBufferSourceNode>();
	private assistantText = '';
	private stopping: Promise<void> | undefined;
	private _state: VoiceSessionState = 'connecting';

	get state(): VoiceSessionState {
		return this._state;
	}

	constructor(private readonly connection: IVoiceConnection, private readonly options: { language?: string; instructions?: string }) {
		super();
	}

	async start(): Promise<void> {
		this.setState('connecting');
		this.stream = await mainWindow.navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true } });
		this.context = new mainWindow.AudioContext({ sampleRate: SAMPLE_RATE });
		const source = this.context.createMediaStreamSource(this.stream);
		this.processor = this.context.createScriptProcessor(4096, 1, 1);
		source.connect(this.processor);
		this.processor.connect(this.context.destination);
		await new Promise<void>((resolve, reject) => {
			const socket = this.socket = new mainWindow.WebSocket(this.connection.url, [...this.connection.protocols]);
			socket.addEventListener('open', () => {
				this.send({
					type: 'session.update',
					session: {
						modalities: ['text', 'audio'],
						instructions: this.options.instructions,
						input_audio_format: 'pcm16',
						output_audio_format: 'pcm16',
						input_audio_transcription: { model: 'whisper-1', ...(this.options.language ? { language: this.options.language.split('-')[0] } : {}) },
						turn_detection: { type: 'server_vad', create_response: true, interrupt_response: true },
					},
				});

			});
			socket.addEventListener('error', () => { this.setState('error'); reject(new Error('Realtime voice connection failed.')); });
			socket.addEventListener('close', () => { this.setState('closed'); reject(new Error('Voice connection closed before it was ready.')); });
			socket.addEventListener('message', event => {
				const raw = String(event.data);
				let type: string | undefined;
				try { type = JSON.parse(raw).type; } catch { return; }
				if (type === 'session.updated') { this.setState('listening'); resolve(); }
				else if (type === 'error') { reject(new Error('Voice provider could not start. Check its endpoint, model, credentials, and local codec requirements.')); }
				this.receive(raw);
			});
		});
		this.processor.onaudioprocess = event => {
			if (this.socket?.readyState !== 1) {
				return;
			}
			const input = event.inputBuffer.getChannelData(0);
			const pcm = new Int16Array(input.length);
			for (let i = 0; i < input.length; i++) {
				const sample = Math.max(-1, Math.min(1, input[i]));
				pcm[i] = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
			}
			this.send({ type: 'input_audio_buffer.append', audio: toBase64(new Uint8Array(pcm.buffer)) });
		};
	}

	private send(payload: object): void {
		if (this.socket?.readyState === 1) {
			this.socket.send(JSON.stringify(payload));
		}
	}

	private receive(raw: string): void {
		let event: { type?: string; delta?: string; transcript?: string; role?: 'user' | 'assistant'; text?: string; final?: boolean; error?: { message?: string } };
		try {
			event = JSON.parse(raw);
		} catch {
			return;
		}
		switch (event.type) {
			case 'latent.transcript':
				if (event.role && event.text !== undefined) { this._onDidTranscript.fire({ role: event.role, text: event.text, final: event.final === true }); }
				break;
			case 'response.audio.delta':
				if (event.delta) {
					this.play(fromBase64(event.delta));
					this.setState('speaking');
				}
				break;
			case 'response.audio.done':
			case 'response.done':
				this.setState('listening');
				break;
			case 'response.audio_transcript.delta':
				this.assistantText += event.delta ?? '';
				this._onDidTranscript.fire({ role: 'assistant', text: this.assistantText, final: false });
				break;
			case 'response.audio_transcript.done':
				this._onDidTranscript.fire({ role: 'assistant', text: event.transcript ?? this.assistantText, final: true });
				this.assistantText = '';
				break;
			case 'conversation.item.input_audio_transcription.completed':
				this._onDidTranscript.fire({ role: 'user', text: event.transcript ?? '', final: true });
				break;
			case 'input_audio_buffer.speech_started':
				this.interrupt();
				break;
			case 'error':
				this.setState('error');
				break;
		}
	}

	/** Barge-in: cancel the response and drop queued playback. */
	interrupt(): void {
		this.send({ type: 'response.cancel' });
		this.send({ type: 'output_audio_buffer.clear' });
		for (const node of this.playback) { node.stop(); node.disconnect(); }
		this.playback.clear();
		this.playhead = 0;
		if (this.context) {
			this.playhead = this.context.currentTime;
		}
	}

	private play(pcm: Uint8Array): void {
		if (!this.context) {
			return;
		}
		const samples = new Int16Array(pcm.buffer, pcm.byteOffset, Math.floor(pcm.byteLength / 2));
		const buffer = this.context.createBuffer(1, samples.length, SAMPLE_RATE);
		const channel = buffer.getChannelData(0);
		for (let i = 0; i < samples.length; i++) {
			channel[i] = samples[i] / 0x8000;
		}
		const node = this.context.createBufferSource();
		this.playback.add(node);
		node.onended = () => { this.playback.delete(node); node.disconnect(); if (!this.playback.size) { this.setState('listening'); } };
		node.buffer = buffer;
		node.connect(this.context.destination);
		const startAt = Math.max(this.context.currentTime, this.playhead);
		node.start(startAt);
		this.playhead = startAt + buffer.duration;
	}

	private setState(state: VoiceSessionState): void {
		if (this._state !== state) {
			this._state = state;
			this._onDidChangeState.fire(state);
		}
	}

	stop(): Promise<void> {
		return this.stopping ??= this.finish();
	}

	private async finish(): Promise<void> {
		if (this.processor) { this.processor.onaudioprocess = null; }
		this.stream?.getTracks().forEach(track => track.stop());
		const socket = this.socket;
		if (socket?.readyState === WebSocket.OPEN) {
			await new Promise<void>(resolve => {
				const complete = () => { clearTimeout(timeout); socket.removeEventListener('message', receive); socket.removeEventListener('close', complete); resolve(); };
				const receive = (event: MessageEvent) => {
					try { if (JSON.parse(event.data).type === 'latent.finished') { complete(); } } catch { /* handled by the main receiver */ }
				};
				const timeout = setTimeout(complete, 10_000);
				socket.addEventListener('message', receive);
				socket.addEventListener('close', complete);
				socket.send(JSON.stringify({ type: 'latent.finish' }));
			});
		}
		this.dispose();
	}

	override dispose(): void {
		if (this.processor) { this.processor.onaudioprocess = null; }
		this.processor?.disconnect();
		for (const node of this.playback) { node.onended = null; node.stop(); node.disconnect(); }
		this.playback.clear();
		this.stream?.getTracks().forEach(track => track.stop());
		void this.context?.close();
		try {
			this.socket?.close(1000, 'stopped');
		} catch {
			// already closed
		}
		this.setState('closed');
		super.dispose();
	}
}

function toBase64(bytes: Uint8Array): string {
	let binary = '';
	for (let i = 0; i < bytes.length; i += 0x8000) {
		binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
	}
	return btoa(binary);
}

function fromBase64(value: string): Uint8Array {
	const binary = atob(value);
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) {
		bytes[i] = binary.charCodeAt(i);
	}
	return bytes;
}
