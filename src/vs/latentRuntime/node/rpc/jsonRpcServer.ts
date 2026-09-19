/* eslint-disable header/header */
import * as net from 'net';
import { promises as fs } from 'fs';
import { encodeMessage, isNotification, isRequest, JsonRpcDecoder, JsonRpcError, JsonRpcErrorCodes } from '../../../platform/latentRuntime/common/jsonRpc.js';
import { RuntimeMethods, RuntimeNotification } from '../../../platform/latentRuntime/common/runtimeProtocol.js';

export type RpcHandler = (params: unknown) => Promise<unknown> | unknown;

/** Newline-delimited JSON-RPC server on a local socket with token authentication. */
export class JsonRpcServer {
	private readonly handlers = new Map<string, RpcHandler>();
	private readonly clients = new Set<{ socket: net.Socket; authenticated: boolean }>();
	private server: net.Server | undefined;

	constructor(private readonly token: string, private readonly log: (message: string) => void) { }

	register(method: string, handler: RpcHandler): void {
		this.handlers.set(method, handler);
	}

	get clientCount(): number {
		return [...this.clients].filter(client => client.authenticated).length;
	}

	async listen(socketPath: string): Promise<void> {
		if (!socketPath.startsWith('\\\\.\\pipe\\')) {
			await fs.rm(socketPath, { force: true });
		}
		this.server = net.createServer(socket => this.accept(socket));
		await new Promise<void>((resolve, reject) => {
			this.server!.once('error', reject);
			this.server!.listen(socketPath, () => resolve());
		});
		if (!socketPath.startsWith('\\\\.\\pipe\\')) {
			await fs.chmod(socketPath, 0o600);
		}
	}

	private accept(socket: net.Socket): void {
		const client = { socket, authenticated: false };
		this.clients.add(client);
		const decoder = new JsonRpcDecoder();
		socket.setEncoding('utf8');
		socket.on('data', (chunk: string) => {
			const { messages, malformed } = decoder.accept(chunk);
			for (const line of malformed) {
				this.log(`malformed message from client: ${line.slice(0, 120)}`);
			}
			for (const message of messages) {
				if (isRequest(message)) {
					void this.handle(client, message.id, message.method, message.params);
				} else if (isNotification(message)) {
					void this.handle(client, undefined, message.method, message.params);
				}
			}
		});
		const remove = () => this.clients.delete(client);
		socket.on('close', remove);
		socket.on('error', remove);
	}

	private async handle(client: { socket: net.Socket; authenticated: boolean }, id: number | string | undefined, method: string, params: unknown): Promise<void> {
		const reply = (payload: { result?: unknown; error?: { code: number; message: string; data?: unknown } }) => {
			if (id !== undefined && !client.socket.destroyed) {
				client.socket.write(encodeMessage({ jsonrpc: '2.0', id, ...payload }));
			}
		};
		if (method === RuntimeMethods.Auth) {
			const token = typeof params === 'object' && params !== null ? (params as { token?: string }).token : undefined;
			if (token === this.token) {
				client.authenticated = true;
				reply({ result: { ok: true } });
			} else {
				reply({ error: { code: JsonRpcErrorCodes.Unauthorized, message: 'Invalid runtime token.' } });
				client.socket.destroy();
			}
			return;
		}
		if (!client.authenticated) {
			reply({ error: { code: JsonRpcErrorCodes.Unauthorized, message: 'Authenticate first.' } });
			return;
		}
		const handler = this.handlers.get(method);
		if (!handler) {
			reply({ error: { code: JsonRpcErrorCodes.MethodNotFound, message: `Unknown method ${method}` } });
			return;
		}
		try {
			reply({ result: await handler(params) ?? null });
		} catch (error) {
			if (error instanceof JsonRpcError) {
				reply({ error: { code: error.code, message: error.message, data: error.data } });
			} else {
				this.log(`${method} failed: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
				reply({ error: { code: JsonRpcErrorCodes.Internal, message: error instanceof Error ? error.message : String(error) } });
			}
		}
	}

	notify(notification: RuntimeNotification): void {
		const line = encodeMessage({ jsonrpc: '2.0', method: 'notify', params: notification });
		for (const client of this.clients) {
			if (client.authenticated && !client.socket.destroyed) {
				client.socket.write(line);
			}
		}
	}

	async close(): Promise<void> {
		for (const client of this.clients) {
			client.socket.destroy();
		}
		this.clients.clear();
		await new Promise<void>(resolve => this.server ? this.server.close(() => resolve()) : resolve());
	}
}
