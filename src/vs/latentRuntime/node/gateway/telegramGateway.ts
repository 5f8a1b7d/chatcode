/* eslint-disable header/header */
import { IGatewayConfig, IGatewayHealth } from '../../../platform/latentRuntime/common/runtimeProtocol.js';
import { IGatewayAdapter, IGatewayAdapterContext, IInboundMessage } from './platform.js';

/** Telegram Bot API over long polling (`getUpdates`), the first external platform of the port. */
export class TelegramGateway implements IGatewayAdapter {
	private handler: ((message: IInboundMessage) => Promise<void>) | undefined;
	private polling = false;
	private offset = 0;
	private lastError: string | undefined;
	private abort: AbortController | undefined;

	constructor(readonly config: IGatewayConfig, private readonly context: IGatewayAdapterContext) { }

	private get token(): string {
		const token = this.context.secret(`gateway:${this.config.id}:token`);
		if (!token) {
			throw new Error(`Telegram gateway ${this.config.id} has no bot token.`);
		}
		return token;
	}

	private api(method: string): string {
		return `https://api.telegram.org/bot${this.token}/${method}`;
	}

	onMessage(handler: (message: IInboundMessage) => Promise<void>): void {
		this.handler = handler;
	}

	async connect(): Promise<void> {
		if (!this.token) {
			throw new Error('missing token');
		}
		this.polling = true;
		this.abort = new AbortController();
		void this.poll();
	}

	private async poll(): Promise<void> {
		while (this.polling) {
			try {
				const response = await fetch(this.api('getUpdates'), {
					method: 'POST',
					headers: { 'content-type': 'application/json' },
					body: JSON.stringify({ offset: this.offset, timeout: 25, allowed_updates: ['message'] }),
					signal: this.abort?.signal,
				});
				if (!response.ok) {
					throw new Error(`getUpdates failed: HTTP ${response.status}`);
				}
				const payload = await response.json() as { ok: boolean; result?: Array<{ update_id: number; message?: { message_id: number; text?: string; chat: { id: number }; from?: { id: number; username?: string; first_name?: string } } }> };
				this.lastError = undefined;
				for (const update of payload.result ?? []) {
					this.offset = update.update_id + 1;
					const message = update.message;
					if (message?.text && this.handler) {
						await this.handler({ gatewayId: this.config.id, chatId: String(message.chat.id), sender: String(message.from?.id ?? message.chat.id), senderName: message.from?.username ?? message.from?.first_name, text: message.text, messageId: String(message.message_id) });
					}
				}
			} catch (error) {
				if (!this.polling) {
					return;
				}
				this.lastError = error instanceof Error ? error.message : String(error);
				this.context.log(`telegram gateway ${this.config.id}: ${this.lastError}`);
				await new Promise(resolve => setTimeout(resolve, 5000));
			}
		}
	}

	async send(chatId: string, text: string): Promise<void> {
		const response = await fetch(this.api('sendMessage'), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ chat_id: chatId, text: text.slice(0, 4000) }) });
		if (!response.ok) {
			throw new Error(`sendMessage failed: HTTP ${response.status}`);
		}
	}

	async sendTyping(chatId: string): Promise<void> {
		await fetch(this.api('sendChatAction'), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ chat_id: chatId, action: 'typing' }) }).catch(() => undefined);
	}

	health(): IGatewayHealth {
		return { id: this.config.id, platform: 'telegram', connected: this.polling && !this.lastError, degraded: !!this.lastError, lastError: this.lastError, pendingDeliveries: 0 };
	}

	async disconnect(): Promise<void> {
		this.polling = false;
		this.abort?.abort();
	}
}
