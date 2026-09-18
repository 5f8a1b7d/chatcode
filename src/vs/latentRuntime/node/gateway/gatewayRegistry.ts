/* eslint-disable header/header */
import { randomUUID } from 'crypto';
import { IGatewayConfig, IGatewayHealth, IPairingCode } from '../../../platform/latentRuntime/common/runtimeProtocol.js';
import { RuntimeDatabase } from '../runtimeDatabase.js';
import { RuntimeSecrets } from '../runtimeSecrets.js';
import { GatewayAdapterFactory, IGatewayAdapter, IInboundMessage } from './platform.js';
import { TelegramGateway } from './telegramGateway.js';
import { WebhookGateway } from './webhookGateway.js';

const backoffMs = [5_000, 30_000, 120_000, 600_000, 1_800_000];

/** Owns adapters, the pairing model, and the delivery ledger with retries (spec 01 §5). */
export class GatewayRegistry {
	private readonly adapters = new Map<string, IGatewayAdapter>();
	private readonly factories = new Map<string, GatewayAdapterFactory>([
		['webhook', (config, context) => new WebhookGateway(config, context)],
		['telegram', (config, context) => new TelegramGateway(config, context)],
	]);
	private handler: ((message: IInboundMessage, config: IGatewayConfig) => Promise<void>) | undefined;
	private timer: ReturnType<typeof setInterval> | undefined;

	constructor(
		private readonly database: RuntimeDatabase,
		private readonly secrets: RuntimeSecrets,
		private readonly log: (message: string) => void,
		private readonly onHealthChange: () => void,
	) { }

	registerPlatform(platform: string, factory: GatewayAdapterFactory): void {
		this.factories.set(platform, factory);
	}

	onMessage(handler: (message: IInboundMessage, config: IGatewayConfig) => Promise<void>): void {
		this.handler = handler;
	}

	async apply(configs: readonly IGatewayConfig[]): Promise<void> {
		const wanted = new Set(configs.filter(config => config.enabled).map(config => config.id));
		for (const [id, adapter] of this.adapters) {
			if (!wanted.has(id)) {
				await adapter.disconnect().catch(() => undefined);
				this.adapters.delete(id);
			}
		}
		for (const config of configs) {
			if (!config.enabled || this.adapters.has(config.id)) {
				continue;
			}
			const factory = this.factories.get(config.platform);
			if (!factory) {
				this.log(`gateway ${config.id}: unknown platform ${config.platform}`);
				continue;
			}
			const adapter = factory(config, { secret: key => this.secrets.get(key), log: this.log });
			adapter.onMessage(async message => {
				if (!this.isAuthorized(config, message)) {
					const paired = await this.tryPair(config, message);
					if (!paired) {
						await adapter.send(message.chatId, 'This bot is private. Ask its owner for a pairing code and send it as your next message.').catch(() => undefined);
						return;
					}
					await adapter.send(message.chatId, 'Paired. You can talk to the bot now.').catch(() => undefined);
					return;
				}
				await this.handler?.(message, config);
			});
			try {
				await adapter.connect();
				this.adapters.set(config.id, adapter);
			} catch (error) {
				this.log(`gateway ${config.id} failed to connect: ${error instanceof Error ? error.message : String(error)}`);
				this.adapters.set(config.id, adapter);
			}
		}
		this.onHealthChange();
		this.timer ??= setInterval(() => void this.flushDeliveries(), 10_000);
	}

	private isAuthorized(config: IGatewayConfig, message: IInboundMessage): boolean {
		return config.allowedSenders.length === 0 ? false : config.allowedSenders.includes(message.sender) || config.allowedSenders.includes('*');
	}

	private async tryPair(config: IGatewayConfig, message: IInboundMessage): Promise<boolean> {
		const code = message.text.trim().toUpperCase();
		const row = await this.database.get<{ expires_at: number }>('SELECT expires_at FROM pairings WHERE gateway_id = ? AND code = ?', [config.id, code]);
		if (!row || row.expires_at < Date.now()) {
			return false;
		}
		await this.database.run('DELETE FROM pairings WHERE gateway_id = ? AND code = ?', [config.id, code]);
		this.onPaired?.(config.id, message.sender);
		return true;
	}

	onPaired: ((gatewayId: string, sender: string) => void) | undefined;

	async createPairingCode(gatewayId: string): Promise<IPairingCode> {
		const code = randomUUID().replace(/-/g, '').slice(0, 8).toUpperCase();
		const expiresAt = Date.now() + 10 * 60_000;
		await this.database.run('INSERT INTO pairings (gateway_id, code, expires_at) VALUES (?, ?, ?)', [gatewayId, code, expiresAt]);
		return { gatewayId, code, expiresAt };
	}

	/** Queues a delivery in the ledger and tries immediately; failures retry with backoff, nothing is dropped. */
	async deliver(gatewayId: string, chatId: string, text: string): Promise<void> {
		const id = randomUUID();
		await this.database.run('INSERT INTO deliveries (id, gateway_id, chat_id, text, attempts, next_attempt_at) VALUES (?, ?, ?, ?, 0, ?)', [id, gatewayId, chatId, text, Date.now()]);
		await this.flushDeliveries();
	}

	async flushDeliveries(): Promise<void> {
		const rows = await this.database.all<{ id: string; gateway_id: string; chat_id: string; text: string; attempts: number }>('SELECT id, gateway_id, chat_id, text, attempts FROM deliveries WHERE delivered_at IS NULL AND next_attempt_at <= ? ORDER BY next_attempt_at LIMIT 50', [Date.now()]);
		for (const row of rows) {
			const adapter = this.adapters.get(row.gateway_id);
			try {
				if (!adapter) {
					throw new Error('gateway not connected');
				}
				await adapter.send(row.chat_id, row.text);
				await this.database.run('UPDATE deliveries SET delivered_at = ? WHERE id = ?', [Date.now(), row.id]);
			} catch (error) {
				const attempts = row.attempts + 1;
				const delay = backoffMs[Math.min(attempts - 1, backoffMs.length - 1)];
				await this.database.run('UPDATE deliveries SET attempts = ?, next_attempt_at = ?, last_error = ? WHERE id = ?', [attempts, Date.now() + delay, error instanceof Error ? error.message : String(error), row.id]);
			}
		}
		this.onHealthChange();
	}

	async health(): Promise<IGatewayHealth[]> {
		const pending = await this.database.all<{ gateway_id: string; count: number }>('SELECT gateway_id, COUNT(*) AS count FROM deliveries WHERE delivered_at IS NULL GROUP BY gateway_id');
		return [...this.adapters.values()].map(adapter => ({ ...adapter.health(), pendingDeliveries: pending.find(row => row.gateway_id === adapter.config.id)?.count ?? 0 }));
	}

	adapter(id: string): IGatewayAdapter | undefined {
		return this.adapters.get(id);
	}

	async dispose(): Promise<void> {
		if (this.timer) {
			clearInterval(this.timer);
		}
		for (const adapter of this.adapters.values()) {
			await adapter.disconnect().catch(() => undefined);
		}
		this.adapters.clear();
	}
}
