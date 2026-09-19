/* eslint-disable header/header */
import { IMemoryAdapterState, IMemorySnapshot, IMemoryWriteOp } from '../../../platform/latentRuntime/common/runtimeProtocol.js';
import { IMemoryAdapter, IMemoryComparisonEntry } from '../../../platform/latentRuntime/common/runtimePlugin.js';
import { JsonListStore } from '../runtimeConfig.js';
import { RuntimeSecrets } from '../runtimeSecrets.js';

interface IAdapterRecord {
	readonly id: string;
	readonly enabled: boolean;
}

/** Mem0-compatible REST adapter; only mirrors local writes outward and never replaces the local store (P1-FR-094). */
class Mem0Adapter implements IMemoryAdapter {
	readonly id = 'mem0';
	readonly displayName = 'Mem0';

	constructor(private readonly secrets: RuntimeSecrets) { }

	async mirror(op: IMemoryWriteOp): Promise<void> {
		const apiKey = this.secrets.get('memoryAdapter:mem0:apiKey');
		const baseUrl = this.secrets.get('memoryAdapter:mem0:baseUrl') ?? 'https://api.mem0.ai/v1';
		if (!apiKey) {
			throw new Error('Mem0 needs an API key (memoryAdapter:mem0:apiKey).');
		}
		if (op.action !== 'add' || !op.content) {
			return;
		}
		const response = await fetch(`${baseUrl.replace(/\/$/, '')}/memories/`, {
			method: 'POST',
			headers: { 'content-type': 'application/json', authorization: `Token ${apiKey}` },
			body: JSON.stringify({ messages: [{ role: 'user', content: op.content }], user_id: 'latent', metadata: { target: op.target } }),
		});
		if (!response.ok) {
			throw new Error(`Mem0 rejected the write: HTTP ${response.status}`);
		}
	}
}

/** Adapters are disabled unless the user enables them explicitly; failures mark them degraded without losing local writes. */
export class MemoryAdapterRegistry {
	private readonly adapters: IMemoryAdapter[];
	private readonly errors = new Map<string, string>();

	constructor(private readonly store: JsonListStore<IAdapterRecord>, secrets: RuntimeSecrets) {
		this.adapters = [new Mem0Adapter(secrets)];
	}

	/** Adds an adapter contributed by a runtime plugin (`latent.memoryAdapters`); it starts disabled. */
	register(adapter: IMemoryAdapter): void {
		this.unregister(adapter.id);
		this.adapters.push(adapter);
	}

	unregister(id: string): void {
		const index = this.adapters.findIndex(adapter => adapter.id === id);
		if (index >= 0) {
			this.adapters.splice(index, 1);
		}
	}

	/** Compares an enabled adapter's remote copy with the local snapshot; nothing is written. */
	async compare(id: string, local: IMemorySnapshot): Promise<readonly IMemoryComparisonEntry[]> {
		const adapter = this.adapters.find(candidate => candidate.id === id);
		if (!adapter?.compare) {
			throw new Error(`Memory adapter ${id} cannot compare copies.`);
		}
		if (this.store.get(id)?.enabled !== true) {
			throw new Error(`Memory adapter ${id} is disabled.`);
		}
		try {
			const entries = await adapter.compare(local);
			this.errors.delete(id);
			return entries;
		} catch (error) {
			this.errors.set(id, error instanceof Error ? error.message : String(error));
			throw error;
		}
	}

	list(): IMemoryAdapterState[] {
		return this.adapters.map(adapter => ({
			id: adapter.id,
			displayName: adapter.displayName,
			enabled: this.store.get(adapter.id)?.enabled === true,
			degraded: this.errors.has(adapter.id),
			lastError: this.errors.get(adapter.id),
		}));
	}

	async setEnabled(id: string, enabled: boolean): Promise<void> {
		if (!this.adapters.some(adapter => adapter.id === id)) {
			throw new Error(`Unknown memory adapter ${id}`);
		}
		await this.store.upsert({ id, enabled });
		if (!enabled) {
			this.errors.delete(id);
		}
	}

	async mirror(op: IMemoryWriteOp): Promise<void> {
		for (const adapter of this.adapters) {
			if (this.store.get(adapter.id)?.enabled !== true) {
				continue;
			}
			try {
				await adapter.mirror(op);
				this.errors.delete(adapter.id);
			} catch (error) {
				this.errors.set(adapter.id, error instanceof Error ? error.message : String(error));
			}
		}
	}
}

export function isAdapterRecord(value: unknown): value is IAdapterRecord {
	return typeof value === 'object' && value !== null && typeof (value as IAdapterRecord).id === 'string' && typeof (value as IAdapterRecord).enabled === 'boolean';
}
