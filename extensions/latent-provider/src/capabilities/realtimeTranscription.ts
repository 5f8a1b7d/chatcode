import * as vscode from 'vscode';
import type { IRealtimeTranscript, IRealtimeVoiceSession } from '../api';

/** Companion ASR for local duplex models that do not produce user transcripts. */
export class TranscribedVoiceSession implements IRealtimeVoiceSession {
	private readonly transcript = new vscode.EventEmitter<IRealtimeTranscript>();
	private readonly interrupted = new vscode.EventEmitter<void>();
	private readonly closed = new vscode.EventEmitter<{ reason: string }>();
	private readonly subscriptions: vscode.Disposable[];
	private readonly cancellation = new AbortController();
	private chunks: Buffer[] = [];
	private samples = 0;
	private quietSamples = 0;
	private speechFrames = 0;
	private active = false;
	private previousFrame: Buffer | undefined;
	private pending = Promise.resolve();
	readonly onTranscript = this.transcript.event;
	readonly onInterrupted = this.interrupted.event;
	readonly onDidClose = this.closed.event;
	readonly onAudio: IRealtimeVoiceSession['onAudio'];

	constructor(private readonly inner: IRealtimeVoiceSession, private readonly transcribe: (audio: Uint8Array, signal: AbortSignal) => Promise<string>) {
		this.onAudio = inner.onAudio;
		this.subscriptions = [inner.onTranscript(event => this.transcript.fire(event)), inner.onDidClose(event => this.closed.fire(event))];
	}

	sendAudio(chunk: Uint8Array): void {
		this.inner.sendAudio(chunk);
		const bytes = Buffer.from(chunk);
		let energy = 0;
		for (let i = 0; i + 1 < bytes.length; i += 2) { energy += (bytes.readInt16LE(i) / 32768) ** 2; }
		const count = Math.floor(bytes.length / 2);
		const speech = count > 0 && Math.sqrt(energy / count) > 0.015;
		this.speechFrames = speech ? this.speechFrames + 1 : 0;
		if (!this.active && this.speechFrames >= 2) {
			this.active = true;
			if (this.previousFrame) { this.chunks.push(this.previousFrame); this.samples += this.previousFrame.length / 2; }
			this.inner.interrupt();
			this.interrupted.fire();
		}
		if (this.active) {
			this.chunks.push(bytes); this.samples += count;
			this.quietSamples = speech ? 0 : this.quietSamples + count;
			if (this.quietSamples >= 24000 * 0.7 || this.samples >= 24000 * 30) { this.flush(); }
		}
		this.previousFrame = bytes;
	}

	private flush(): void {
		if (!this.chunks.length) { return; }
		const pcm = Buffer.concat(this.chunks);
		this.chunks = []; this.samples = 0; this.quietSamples = 0; this.active = false;
		const header = Buffer.alloc(44);
		header.write('RIFF'); header.writeUInt32LE(pcm.length + 36, 4); header.write('WAVEfmt ', 8);
		header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22);
		header.writeUInt32LE(24000, 24); header.writeUInt32LE(48000, 28); header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34);
		header.write('data', 36); header.writeUInt32LE(pcm.length, 40);
		this.pending = this.pending.then(async () => {
			if (this.cancellation.signal.aborted) { return; }
			try {
				const text = await this.transcribe(Buffer.concat([header, pcm]), this.cancellation.signal);
				if (text && !this.cancellation.signal.aborted) { this.transcript.fire({ role: 'user', text, final: true }); }
			} catch {
				if (!this.cancellation.signal.aborted) { this.closed.fire({ reason: 'Companion ASR failed. Check the ASR provider.' }); }
			}
		});
	}

	commitAudio(): void { this.flush(); this.inner.commitAudio(); }
	async finish(): Promise<void> { this.flush(); await this.pending; await this.inner.finish?.(); }
	interrupt(): void { this.inner.interrupt(); }
	dispose(): void {
		this.cancellation.abort();
		this.inner.dispose();
		this.subscriptions.forEach(item => item.dispose());
		this.transcript.dispose(); this.interrupted.dispose(); this.closed.dispose();
		this.chunks = [];
	}
}
