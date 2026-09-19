import { randomBytes } from 'node:crypto';
import { WebSocketServer, WebSocket } from 'ws';
import type { IRealtimeConnection, IRealtimeSessionOptions, IRealtimeVoiceSession } from '../api';

/** A single-use loopback connection. Provider URLs and credentials never cross into the workbench. */
export async function createRealtimeBridge(model: string, providerId: string, open: (options: IRealtimeSessionOptions) => Promise<IRealtimeVoiceSession>): Promise<{ connection: IRealtimeConnection; closed: Promise<void>; dispose: () => void }> {
	const token = randomBytes(32).toString('hex');
	const server = new WebSocketServer({ host: '127.0.0.1', port: 0, maxPayload: 1024 * 1024 });
	let claimed = false;
	let disposed = false;
	let resolveClosed!: () => void;
	const closed = new Promise<void>(resolve => { resolveClosed = resolve; });
	let session: IRealtimeVoiceSession | undefined;
	const subscriptions: { dispose(): void }[] = [];
	const dispose = () => {
		if (disposed) { return; }
		disposed = true;
		clearTimeout(expiry);
		session?.dispose();
		subscriptions.forEach(item => item.dispose());
		for (const socket of server.clients) { socket.close(); }
		server.close();
		resolveClosed();
	};
	const expiry = setTimeout(dispose, 30_000);
	server.on('connection', (socket, request) => {
		if (claimed || request.url !== `/${token}`) { socket.close(1008, 'Invalid voice session'); return; }
		claimed = true;
		const send = (event: object) => { if (socket.readyState === WebSocket.OPEN) { socket.send(JSON.stringify(event)); } };
		let starting = false;
		socket.on('message', async data => {
			let event: { type?: string; audio?: string; session?: { instructions?: string; voice?: string; input_audio_transcription?: { language?: string } } };
			try { event = JSON.parse(data.toString()); } catch { socket.close(1003, 'Invalid voice event'); return; }
			if (event.type === 'session.update' && !starting) {
				starting = true;
				try {
					const opened = await open({ language: event.session?.input_audio_transcription?.language, instructions: event.session?.instructions, voiceId: event.session?.voice });
					if (disposed) { opened.dispose(); return; }
					session = opened;
					clearTimeout(expiry);
					subscriptions.push(opened.onAudio(chunk => send({ type: 'response.audio.delta', delta: Buffer.from(chunk).toString('base64') })));
					subscriptions.push(opened.onTranscript(transcript => send({ type: 'latent.transcript', ...transcript })));
					if (opened.onInterrupted) { subscriptions.push(opened.onInterrupted(() => send({ type: 'input_audio_buffer.speech_started' }))); }
					subscriptions.push(opened.onDidClose(() => { send({ type: 'error' }); dispose(); }));
					send({ type: 'session.updated' });
				} catch {
					// Adapter diagnostics stay in the provider configuration flow, never forward credential-bearing errors.
					send({ type: 'error' }); dispose();
				}
			} else if (session && event.type === 'input_audio_buffer.append' && typeof event.audio === 'string') {
				session.sendAudio(Buffer.from(event.audio, 'base64'));
			} else if (event.type === 'response.cancel') { session?.interrupt(); }
			else if (event.type === 'input_audio_buffer.commit') { session?.commitAudio(); }
			else if (event.type === 'latent.finish') {
				try { await session?.finish?.(); send({ type: 'latent.finished' }); }
				catch { send({ type: 'error' }); }
			}
		});
		socket.on('close', dispose);
		socket.on('error', dispose);
	});
	try {
		await new Promise<void>((resolve, reject) => { server.once('listening', resolve); server.once('error', reject); });
	} catch (error) { dispose(); throw error; }
	const address = server.address();
	if (!address || typeof address === 'string') { dispose(); throw new Error('Unable to start the local voice transport.'); }
	return { connection: { url: `ws://127.0.0.1:${address.port}/${token}`, protocols: [], model, providerId }, closed, dispose };
}
