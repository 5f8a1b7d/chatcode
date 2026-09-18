import * as vscode from 'vscode';
import type { IRealtimeConnection, IRealtimeSessionOptions, IRealtimeTranscript, IRealtimeVoiceSession } from '../api';

export interface IRealtimeBinding {
	readonly modelId: string;
	readonly baseUrl: string;
	readonly protocol: string;
	readonly providerId: string;
}

/** Builds the WebSocket URL and subprotocols for an OpenAI-realtime-compatible provider. */
export function realtimeConnection(binding: IRealtimeBinding, secret: string | undefined): IRealtimeConnection {
	const base = binding.baseUrl.replace(/^http/, 'ws').replace(/\/$/, '');
	const url = `${base}/realtime?model=${encodeURIComponent(binding.modelId)}`;
	const protocols = ['realtime', 'openai-beta.realtime-v1'];
	if (secret) {
		protocols.push(`openai-insecure-api-key.${secret}`);
	}
	return { url, protocols, model: binding.modelId, providerId: binding.providerId };
}

interface IWebSocketLike {
	readonly readyState: number;
	send(data: string): void;
	close(code?: number, reason?: string): void;
	addEventListener(type: 'open' | 'message' | 'close' | 'error', listener: (event: { data?: unknown; reason?: string; code?: number }) => void): void;
}

type WebSocketCtor = new (url: string, protocols?: string[]) => IWebSocketLike;

function webSocketCtor(): WebSocketCtor {
	const ctor = (globalThis as { WebSocket?: WebSocketCtor }).WebSocket;
	if (!ctor) {
		throw new Error('Realtime voice needs a WebSocket implementation in the extension host.');
	}
	return ctor;
}

/**
 * Full-duplex session over the OpenAI realtime event protocol: PCM16 audio in,
 * audio deltas and transcripts out, `interrupt` cancels the current response (barge-in).
 */
export class RealtimeVoiceSession implements IRealtimeVoiceSession {
	private readonly socket: IWebSocketLike;
	private readonly audioEmitter = new vscode.EventEmitter<Uint8Array>();
	private readonly transcriptEmitter = new vscode.EventEmitter<IRealtimeTranscript>();
	private readonly closeEmitter = new vscode.EventEmitter<{ readonly reason: string }>();
	private readonly ready: Promise<void>;
	private assistantText = '';
	readonly onAudio = this.audioEmitter.event;
	readonly onTranscript = this.transcriptEmitter.event;
	readonly onDidClose = this.closeEmitter.event;

	constructor(binding: IRealtimeBinding, secret: string | undefined, options: IRealtimeSessionOptions) {
		const connection = realtimeConnection(binding, secret);
		const Ctor = webSocketCtor();
		this.socket = new Ctor(connection.url, [...connection.protocols]);
		this.ready = new Promise<void>((resolve, reject) => {
			this.socket.addEventListener('open', () => {
				this.send({
					type: 'session.update',
					session: {
						modalities: ['text', 'audio'],
						instructions: options.instructions,
						voice: options.voiceId,
						input_audio_format: 'pcm16',
						output_audio_format: 'pcm16',
						input_audio_transcription: { model: 'whisper-1', ...(options.language ? { language: options.language.split('-')[0] } : {}) },
						turn_detection: { type: 'server_vad', create_response: true, interrupt_response: true },
					},
				});
				resolve();
			});
			this.socket.addEventListener('error', () => reject(new Error('Realtime voice connection failed.')));
		});
		this.socket.addEventListener('message', event => this.receive(String(event.data)));
		this.socket.addEventListener('close', event => this.closeEmitter.fire({ reason: event.reason || `closed (${event.code ?? 'unknown'})` }));
	}

	whenReady(): Promise<void> {
		return this.ready;
	}

	sendAudio(chunk: Uint8Array): void {
		this.send({ type: 'input_audio_buffer.append', audio: Buffer.from(chunk).toString('base64') });
	}

	commitAudio(): void {
		this.send({ type: 'input_audio_buffer.commit' });
	}

	interrupt(): void {
		this.send({ type: 'response.cancel' });
		this.send({ type: 'output_audio_buffer.clear' });
	}

	private send(payload: object): void {
		if (this.socket.readyState === 1) {
			this.socket.send(JSON.stringify(payload));
		}
	}

	private receive(raw: string): void {
		let event: { type?: string; delta?: string; transcript?: string; text?: string };
		try {
			event = JSON.parse(raw);
		} catch {
			return;
		}
		switch (event.type) {
			case 'response.audio.delta':
				if (event.delta) {
					this.audioEmitter.fire(new Uint8Array(Buffer.from(event.delta, 'base64')));
				}
				break;
			case 'response.audio_transcript.delta':
				this.assistantText += event.delta ?? '';
				this.transcriptEmitter.fire({ role: 'assistant', text: this.assistantText, final: false });
				break;
			case 'response.audio_transcript.done':
				this.transcriptEmitter.fire({ role: 'assistant', text: event.transcript ?? this.assistantText, final: true });
				this.assistantText = '';
				break;
			case 'conversation.item.input_audio_transcription.completed':
				this.transcriptEmitter.fire({ role: 'user', text: event.transcript ?? '', final: true });
				break;
			case 'input_audio_buffer.speech_started':
				this.interrupt();
				break;
			case 'error':
				this.closeEmitter.fire({ reason: event.text ?? 'realtime error' });
				break;
		}
	}

	dispose(): void {
		try {
			this.socket.close(1000, 'disposed');
		} catch {
			// already closed
		}
		this.audioEmitter.dispose();
		this.transcriptEmitter.dispose();
		this.closeEmitter.dispose();
	}
}
