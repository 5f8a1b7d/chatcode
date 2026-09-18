/* eslint-disable header/header */
import type * as http from 'http';
import { IGatewayConfig, IGatewayHealth } from '../../../platform/latentRuntime/common/runtimeProtocol.js';
import { IGatewayAdapter, IGatewayAdapterContext, IInboundMessage } from './platform.js';

/**
 * Generic webhook gateway: inbound `POST /inbound` with `{ chatId, sender, text }`
 * and a shared secret header; outbound `POST <callbackUrl>` with `{ chatId, text }`.
 * Used by the smoke test of P1-AS-019 with a local receiver.
 */
export class WebhookGateway implements IGatewayAdapter {
	private server: http.Server | undefined;
	private handler: ((message: IInboundMessage) => Promise<void>) | undefined;
	private lastError: string | undefined;
	private connected = false;

	constructor(readonly config: IGatewayConfig, private readonly context: IGatewayAdapterContext) { }

	private get port(): number {
		return Number(this.config.options.port ?? 0) || 0;
	}

	private get secret(): string | undefined {
		return this.context.secret(`gateway:${this.config.id}:secret`);
	}

	onMessage(handler: (message: IInboundMessage) => Promise<void>): void {
		this.handler = handler;
	}

	async connect(): Promise<void> {
		const { createServer } = await import('http');
		this.server = createServer((request, response) => void this.handleRequest(request, response));
		await new Promise<void>((resolve, reject) => {
			this.server!.once('error', error => { this.lastError = error.message; reject(error); });
			this.server!.listen(this.port, '127.0.0.1', () => resolve());
		});
		this.connected = true;
		this.lastError = undefined;
		const address = this.server.address();
		this.context.log(`webhook gateway ${this.config.id} listening on ${typeof address === 'object' && address ? address.port : this.port}`);
	}

	/** The bound port, useful when `options.port` was 0. */
	get boundPort(): number | undefined {
		const address = this.server?.address();
		return typeof address === 'object' && address ? address.port : undefined;
	}

	private async handleRequest(request: http.IncomingMessage, response: http.ServerResponse): Promise<void> {
		if (request.method !== 'POST' || request.url !== '/inbound') {
			response.writeHead(404).end();
			return;
		}
		if (this.secret && request.headers['x-latent-secret'] !== this.secret) {
			response.writeHead(401).end();
			return;
		}
		let body = '';
		for await (const chunk of request) {
			body += chunk;
			if (body.length > 1_000_000) {
				response.writeHead(413).end();
				return;
			}
		}
		try {
			const payload = JSON.parse(body) as { chatId?: string; sender?: string; senderName?: string; text?: string; messageId?: string };
			if (typeof payload.chatId !== 'string' || typeof payload.text !== 'string') {
				response.writeHead(400).end('chatId and text are required');
				return;
			}
			response.writeHead(202, { 'content-type': 'application/json' }).end(JSON.stringify({ accepted: true }));
			await this.handler?.({ gatewayId: this.config.id, chatId: payload.chatId, sender: payload.sender ?? 'anonymous', senderName: payload.senderName, text: payload.text, messageId: payload.messageId });
		} catch (error) {
			this.lastError = error instanceof Error ? error.message : String(error);
			if (!response.headersSent) {
				response.writeHead(400).end();
			}
		}
	}

	async send(chatId: string, text: string): Promise<void> {
		const callback = String(this.config.options.callbackUrl ?? '');
		if (!callback) {
			throw new Error(`Webhook gateway ${this.config.id} has no callbackUrl.`);
		}
		const response = await fetch(callback, {
			method: 'POST',
			headers: { 'content-type': 'application/json', ...(this.secret ? { 'x-latent-secret': this.secret } : {}) },
			body: JSON.stringify({ chatId, text }),
		});
		if (!response.ok) {
			throw new Error(`Webhook delivery failed: HTTP ${response.status}`);
		}
	}

	health(): IGatewayHealth {
		return { id: this.config.id, platform: 'webhook', connected: this.connected, degraded: !!this.lastError, lastError: this.lastError, pendingDeliveries: 0 };
	}

	async disconnect(): Promise<void> {
		this.connected = false;
		await new Promise<void>(resolve => this.server ? this.server.close(() => resolve()) : resolve());
		this.server = undefined;
	}
}
