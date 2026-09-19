import * as vscode from 'vscode';
import WebSocket from 'ws';
import { ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import type { IRealtimeSessionOptions, IRealtimeTranscript, IRealtimeVoiceSession } from '../api';
import { IRealtimeBinding, IWireEvent, isMoshi, normalizeVoiceEvent, realtimeEndpoint, realtimeSetup } from './realtimeWire';

/** Protocol-specific transport. The public audio contract is always PCM16 mono at 24 kHz. */
export class RealtimeVoiceSession implements IRealtimeVoiceSession {
	private readonly socket: WebSocket;
	private readonly audioEmitter = new vscode.EventEmitter<Uint8Array>();
	private readonly transcriptEmitter = new vscode.EventEmitter<IRealtimeTranscript>();
	private readonly closeEmitter = new vscode.EventEmitter<{ readonly reason: string }>();
	private readonly interruptEmitter = new vscode.EventEmitter<void>();
	private readonly ready: Promise<void>;
	private resolveReady!: () => void;
	private rejectReady!: (error: Error) => void;
	private readonly timeout: ReturnType<typeof setTimeout>;
	private encoder?: ChildProcessWithoutNullStreams;
	private decoder?: ChildProcessWithoutNullStreams;
	private readonly text = { user: '', assistant: '' };
	private closed = false;
	private initialized = false;
	readonly onAudio = this.audioEmitter.event;
	readonly onTranscript = this.transcriptEmitter.event;
	readonly onDidClose = this.closeEmitter.event;
	readonly onInterrupted = this.interruptEmitter.event;

	constructor(private readonly binding: IRealtimeBinding, secret: string | undefined, options: IRealtimeSessionOptions) {
		this.ready = new Promise<void>((resolve, reject) => { this.resolveReady = resolve; this.rejectReady = reject; });
		this.timeout = setTimeout(() => this.fail('Voice server did not finish its handshake within 30 seconds.'), 30_000);
		this.socket = new WebSocket(realtimeEndpoint(binding, secret, options), {
			headers: secret && binding.protocol !== 'gemini-live' ? { Authorization: `Bearer ${secret}`, ...(binding.protocol === 'openai-realtime' ? { 'OpenAI-Beta': 'realtime=v1' } : {}) } : {},
			maxPayload: 8 * 1024 * 1024,
		});
		this.socket.on('open', () => {
			if (isMoshi(binding.protocol)) { this.startOpus(); }
			const setup = realtimeSetup(binding, options);
			if (setup) { this.send(setup); }
		});
		this.socket.on('message', (data, binary) => {
			const bytes = Buffer.isBuffer(data) ? data : data instanceof ArrayBuffer ? Buffer.from(data) : Buffer.concat(data);
			if (isMoshi(binding.protocol)) {
				if (!binary || !bytes.length) { return; }
				if (bytes[0] === 0) { this.markReady(); }
				else if (bytes[0] === 1) { this.decoder?.stdin.write(bytes.subarray(1)); }
				else if (bytes[0] === 2) {
					this.text.assistant += bytes.subarray(1).toString('utf8');
					this.transcriptEmitter.fire({ role: 'assistant', text: this.text.assistant, final: false });
				}
				return;
			}
			let event: IWireEvent;
			try { event = JSON.parse(bytes.toString()); } catch { this.fail('Voice server sent an invalid event.'); return; }
			for (const normalized of normalizeVoiceEvent(event)) {
				switch (normalized.type) {
					case 'ready': this.markReady(); break;
					case 'audio': this.audioEmitter.fire(Buffer.from(normalized.data, 'base64')); break;
					case 'interrupted': this.interruptEmitter.fire(); break;
					case 'error': this.fail('Voice provider rejected the session. Check the model and provider configuration.'); break;
					case 'transcript': {
						const role = normalized.role;
						this.text[role] = normalized.append ? this.text[role] + normalized.text : normalized.text || this.text[role];
						this.transcriptEmitter.fire({ role, text: this.text[role], final: normalized.final });
						if (normalized.final) { this.text[role] = ''; }
						break;
					}
					case 'done': this.finishTranscripts(); break;
				}
			}
		});
		// Do not expose raw websocket errors: they can contain credential-bearing URLs.
		this.socket.on('error', () => this.fail('Realtime voice connection failed. Check the endpoint and credentials.'));
		this.socket.on('close', () => {
			if (!this.closed) { this.fail('Voice connection closed.'); }
		});
	}

	private markReady(): void {
		if (this.closed) { return; }
		this.initialized = true;
		clearTimeout(this.timeout);
		this.resolveReady();
	}

	/** Moshi's binary type 1 carries an Ogg Opus stream, not PCM or OpenAI JSON. */
	private startOpus(): void {
		this.encoder = spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 's16le', '-ar', '24000', '-ac', '1', '-i', 'pipe:0', '-c:a', 'libopus', '-application', 'lowdelay', '-frame_duration', '20', '-page_duration', '20000', '-flush_packets', '1', '-f', 'ogg', 'pipe:1']);
		this.decoder = spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-probesize', '32', '-analyzeduration', '0', '-f', 'ogg', '-i', 'pipe:0', '-f', 's16le', '-ar', '24000', '-ac', '1', '-flush_packets', '1', 'pipe:1']);
		for (const process of [this.encoder, this.decoder]) {
			process.on('error', () => this.fail('Moshi and PersonaPlex require FFmpeg with libopus on PATH.'));
			process.stdin.on('error', () => this.fail('The local Opus audio codec stopped.'));
			process.stderr.resume();
			process.on('exit', () => { if (!this.closed) { this.fail('The local Opus audio codec stopped.'); } });
		}
		this.encoder.stdout.on('data', (chunk: Buffer) => { if (this.socket.readyState === WebSocket.OPEN) { this.socket.send(Buffer.concat([Buffer.from([1]), chunk])); } });
		this.decoder.stdout.on('data', (chunk: Buffer) => this.audioEmitter.fire(chunk));
	}

	whenReady(): Promise<void> { return this.ready; }

	sendAudio(chunk: Uint8Array): void {
		if (!this.initialized || this.closed) { return; }
		if (isMoshi(this.binding.protocol)) { this.encoder?.stdin.write(chunk); return; }
		if (this.binding.protocol === 'gemini-live') {
			// Live accepts the sample rate in the MIME type and resamples input audio.
			this.send({ realtimeInput: { audio: { data: Buffer.from(chunk).toString('base64'), mimeType: 'audio/pcm;rate=24000' } } });
		} else { this.send({ type: 'input_audio_buffer.append', audio: Buffer.from(chunk).toString('base64') }); }
	}

	commitAudio(): void {
		if (this.binding.protocol === 'gemini-live') { this.send({ realtimeInput: { audioStreamEnd: true } }); }
		else if (!isMoshi(this.binding.protocol)) { this.send({ type: 'input_audio_buffer.commit' }); }
	}

	interrupt(): void {
		if (isMoshi(this.binding.protocol) || this.binding.protocol === 'gemini-live') {
			// These servers listen continuously; do not send fabricated cancellation events.
			this.finishTranscripts();
		} else { this.send({ type: 'response.cancel' }); }
	}

	private send(payload: object): void {
		if (this.socket.readyState === WebSocket.OPEN) { this.socket.send(JSON.stringify(payload)); }
	}

	private finishTranscripts(): void {
		for (const role of ['user', 'assistant'] as const) {
			if (this.text[role]) { this.transcriptEmitter.fire({ role, text: this.text[role], final: true }); this.text[role] = ''; }
		}
	}

	private fail(reason: string): void {
		if (this.closed) { return; }
		this.rejectReady(new Error(reason));
		this.closeEmitter.fire({ reason });
		this.dispose();
	}

	dispose(): void {
		if (this.closed) { return; }
		this.closed = true;
		clearTimeout(this.timeout);
		this.finishTranscripts();
		this.encoder?.kill(); this.decoder?.kill();
		this.socket.close();
		this.audioEmitter.dispose(); this.transcriptEmitter.dispose(); this.closeEmitter.dispose(); this.interruptEmitter.dispose();
	}
}
