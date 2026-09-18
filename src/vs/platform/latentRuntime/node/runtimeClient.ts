/* eslint-disable header/header */
import * as net from 'net';
import { Emitter, Event } from '../../../base/common/event.js';
import { Disposable } from '../../../base/common/lifecycle.js';
import { encodeMessage, isNotification, isResponse, JsonRpcDecoder, JsonRpcError } from '../common/jsonRpc.js';
import { RuntimeMethods, RuntimeNotification } from '../common/runtimeProtocol.js';

/** JSON-RPC client over the runtime's local socket; authenticates with the shared token first. */
export class RuntimeClient extends Disposable {
	private readonly _onDidNotify = this._register(new Emitter<RuntimeNotification>());
	readonly onDidNotify: Event<RuntimeNotification> = this._onDidNotify.event;
	private readonly _onDidClose = this._register(new Emitter<void>());
	readonly onDidClose: Event<void> = this._onDidClose.event;

	private readonly pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
	private readonly decoder = new JsonRpcDecoder();
	private socket: net.Socket | undefined;
	private nextId = 1;
	private closed = false;

	static async connect(socketPath: string, token: string, timeoutMs = 3000): Promise<RuntimeClient> {
		const socket = await new Promise<net.Socket>((resolve, reject) => {
			const candidate = net.createConnection(socketPath);
			const timer = setTimeout(() => { candidate.destroy(); reject(new Error('Runtime connection timed out.')); }, timeoutMs);
			candidate.once('connect', () => { clearTimeout(timer); resolve(candidate); });
			candidate.once('error', error => { clearTimeout(timer); reject(error); });
		});
		const client = new RuntimeClient(socket);
		await client.call(RuntimeMethods.Auth, { token });
		return client;
	}

	private constructor(socket: net.Socket) {
		super();
		this.socket = socket;
		socket.setEncoding('utf8');
		socket.on('data', (chunk: string) => this.receive(chunk));
		socket.on('close', () => this.handleClose());
		socket.on('error', () => this.handleClose());
	}

	get isConnected(): boolean {
		return !this.closed && !!this.socket && !this.socket.destroyed;
	}

	call<T>(method: string, params?: unknown): Promise<T> {
		if (!this.isConnected || !this.socket) {
			return Promise.reject(new Error('The runtime is not connected.'));
		}
		const id = this.nextId++;
		return new Promise<T>((resolve, reject) => {
			this.pending.set(id, { resolve: value => resolve(value as T), reject });
			this.socket!.write(encodeMessage({ jsonrpc: '2.0', id, method, params }));
		});
	}

	private receive(chunk: string): void {
		const { messages } = this.decoder.accept(chunk);
		for (const message of messages) {
			if (isResponse(message)) {
				const entry = this.pending.get(Number(message.id));
				if (!entry) {
					continue;
				}
				this.pending.delete(Number(message.id));
				if (message.error) {
					entry.reject(new JsonRpcError(message.error.code, message.error.message, message.error.data));
				} else {
					entry.resolve(message.result);
				}
			} else if (isNotification(message) && message.method === 'notify') {
				this._onDidNotify.fire(message.params as RuntimeNotification);
			}
		}
	}

	private handleClose(): void {
		if (this.closed) {
			return;
		}
		this.closed = true;
		for (const entry of this.pending.values()) {
			entry.reject(new Error('The runtime connection closed.'));
		}
		this.pending.clear();
		this._onDidClose.fire();
	}

	override dispose(): void {
		this.socket?.destroy();
		this.socket = undefined;
		this.handleClose();
		super.dispose();
	}
}
