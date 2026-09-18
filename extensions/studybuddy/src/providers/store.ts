import type { CatalogProvider, ProviderCatalog, TokenPlan } from './catalog';
import { providerKey } from './identity';

export interface ProviderStoragePort {
	globalState: {
		get<T>(key: string): T | undefined;
		update(key: string, value: object): PromiseLike<void>;
	};
	secrets: {
		get(key: string): PromiseLike<string | undefined>;
		store(key: string, value: string): PromiseLike<void>;
		delete(key: string): PromiseLike<void>;
	};
}

export interface ProviderConfiguration {
	enabled: boolean;
	baseUrl?: string;
	modelId?: string;
	customModelIds?: string[];
	fields?: Record<string, string>;
}

export interface ActiveProviderBinding {
	service: string;
	providerId: string;
	source: 'direct' | 'plan';
	sourceId: string;
	baseUrl: string;
	secretRef: string;
	modelIds: string[];
	protocol?: string;
}

interface SavedState {
	version: 1;
	providers: Record<string, ProviderConfiguration>;
	plans: Record<string, boolean>;
	customProviders: CatalogProvider[];
}

const stateKey = 'customProviders.state.v1';
const secretPrefix = 'customProviders.secret.v1.';

export class ProviderStore {
	private state: SavedState;

	constructor(private readonly context: ProviderStoragePort) {
		const saved = context.globalState.get<SavedState>(stateKey);
		this.state = saved?.version === 1 ? { ...saved, customProviders: saved.customProviders ?? [] } : { version: 1, providers: {}, plans: {}, customProviders: [] };
	}

	getCustomProviders(): readonly CatalogProvider[] {
		return this.state.customProviders;
	}

	async addCustomProvider(input: Pick<CatalogProvider, 'category' | 'service' | 'name' | 'type' | 'defaultBaseUrl' | 'requiresApiKey'>, modelId?: string, secret?: string): Promise<CatalogProvider> {
		if (!input.name?.trim() || input.name.length > 100) throw new Error('Enter a provider name under 100 characters.');
		if (input.defaultBaseUrl && !isAllowedBaseUrl(input.defaultBaseUrl)) throw new Error('Enter an HTTP or HTTPS Base URL.');
		if (input.service === 'llm' && !['openai', 'azure', 'anthropic', 'google'].includes(input.type || '')) throw new Error('Unsupported LLM protocol.');
		const provider: CatalogProvider = {
			id: `custom-${crypto.randomUUID()}`,
			category: input.category,
			service: input.service,
			name: input.name.trim(),
			...(input.type ? { type: input.type } : {}),
			...(input.defaultBaseUrl ? { defaultBaseUrl: input.defaultBaseUrl.trim() } : {}),
			requiresApiKey: input.requiresApiKey === true,
		...(modelId?.trim() ? { models: [{ id: modelId.trim(), name: modelId.trim() }] } : {}),
		};
		await this.saveProvider(provider, { enabled: true, baseUrl: input.defaultBaseUrl, modelId }, secret);
		this.state.customProviders.push(provider);
		await this.persist();
		return provider;
	}

	async removeCustomProvider(service: string, id: string): Promise<void> {
		const key = providerKey(service, id);
		const index = this.state.customProviders.findIndex(provider => provider.service === service && provider.id === id);
		if (index < 0) throw new Error('Custom provider not found.');
		const extraFields = this.state.customProviders[index].secretFields;
		this.state.customProviders.splice(index, 1);
		delete this.state.providers[key];
		await this.deleteSecrets(key, extraFields);
		await this.persist();
	}

	getProvider(service: string, id: string): ProviderConfiguration {
		return this.state.providers[providerKey(service, id)] ?? { enabled: false };
	}

	getPlan(id: string): boolean {
		return this.state.plans[id] === true;
	}

	listActiveBindings(catalog: ProviderCatalog): ActiveProviderBinding[] {
		const bindings: ActiveProviderBinding[] = [];
		const providers = new Map([...catalog.providers, ...this.state.customProviders].map(provider => [providerKey(provider.service, provider.id), provider]));
		for (const provider of providers.values()) {
			const config = this.getProvider(provider.service, provider.id);
			const baseUrl = config.baseUrl || provider.defaultBaseUrl;
			if (!config.enabled || !baseUrl) continue;
			bindings.push({
				service: provider.service,
				providerId: provider.id,
				source: 'direct',
				sourceId: provider.id,
				baseUrl,
				secretRef: providerKey(provider.service, provider.id),
				modelIds: [...new Set([...(provider.models || []).map(model => model.id), ...(config.customModelIds || []), ...(config.modelId ? [config.modelId] : [])])],
				...(provider.type ? { protocol: provider.type } : {}),
			});
		}
		for (const plan of catalog.tokenPlans) {
			if (!this.getPlan(plan.id)) continue;
			for (const [modality, target] of Object.entries(plan.modalities)) {
				bindings.push({
					service: modality === 'webSearch' ? 'web-search' : modality,
					providerId: target.providerId,
					source: 'plan',
					sourceId: plan.id,
					baseUrl: target.baseUrl,
					secretRef: `plan:${plan.id}`,
					modelIds: target.defaultModels ?? (target.defaultModelId ? [target.defaultModelId] : []),
					...(target.apiFormat ? { protocol: target.apiFormat } : {}),
				});
			}
		}
		return bindings;
	}

	async hasSecret(ref: string): Promise<boolean> {
		return !!(await this.context.secrets.get(secretPrefix + ref));
	}

	async getSecret(ref: string): Promise<string | undefined> {
		return this.context.secrets.get(secretPrefix + ref);
	}

	async saveProvider(provider: CatalogProvider, config: ProviderConfiguration, secret?: string, extraSecrets: Record<string, string> = {}): Promise<void> {
		const key = providerKey(provider.service, provider.id);
		if (config.baseUrl && !isAllowedBaseUrl(config.baseUrl)) {
			throw new Error('Base URL must be an HTTP or HTTPS URL.');
		}
		if (config.modelId && config.modelId.length > 250) throw new Error('Model ID is too long.');
		if (secret && secret.length > 20000) throw new Error('Credential is too long.');
		const allowedSlots = new Set((provider.secretFields ?? []).map(field => field.id));
		for (const [slot, value] of Object.entries(extraSecrets)) {
			if (!allowedSlots.has(slot) || !/^[a-zA-Z][a-zA-Z0-9]*$/.test(slot) || typeof value !== 'string' || value.length > 20000) throw new Error('Invalid credential field.');
		}
		if (config.enabled && provider.requiresApiKey && !secret?.trim() && !(await this.hasSecret(key))) {
			throw new Error('Save a credential before enabling this provider.');
		}
		for (const field of provider.secretFields ?? []) {
			if (config.enabled && !extraSecrets[field.id]?.trim() && !(await this.hasSecret(`${key}.${field.id}`))) throw new Error(`Save ${field.label} before enabling this provider.`);
		}
		if (secret?.trim()) {
			await this.context.secrets.store(secretPrefix + key, secret.trim());
		}
		for (const [slot, value] of Object.entries(extraSecrets)) {
			if (value.trim()) await this.context.secrets.store(secretPrefix + `${key}.${slot}`, value.trim());
		}
		const safeFields = Object.fromEntries(Object.entries(config.fields ?? {}).filter(([name, value]) => ['region', 'resourceId', 'aspectRatio', 'style', 'duration', 'resolution', 'voiceId', 'format', 'speed', 'language', 'backend', 'source_webSearch', 'source_baike', 'source_scholar'].includes(name) && typeof value === 'string' && value.length <= 500));
		this.state.providers[key] = {
			enabled: config.enabled === true,
			...(config.baseUrl ? { baseUrl: config.baseUrl.trim() } : {}),
			...(config.modelId ? { modelId: config.modelId.trim() } : {}),
			...(config.customModelIds?.length ? { customModelIds: config.customModelIds.map(id => id.trim()).filter(Boolean) } : {}),
			...(Object.keys(safeFields).length ? { fields: safeFields } : {}),
		};
		await this.persist();
	}

	async deleteProviderSecret(service: string, id: string, provider?: CatalogProvider): Promise<void> {
		const key = providerKey(service, id);
		await this.deleteSecrets(key, provider?.secretFields);
		if (this.state.providers[key]) {
			this.state.providers[key].enabled = false;
			await this.persist();
		}
	}

	async enablePlan(plan: TokenPlan, secret?: string): Promise<void> {
		if (secret?.trim()) {
			await this.context.secrets.store(secretPrefix + `plan:${plan.id}`, secret.trim());
		}
		if (!(await this.hasSecret(`plan:${plan.id}`))) {
			throw new Error('A token plan needs an API key.');
		}
		this.state.plans[plan.id] = true;
		await this.persist();
	}

	async disablePlan(plan: TokenPlan): Promise<void> {
		this.state.plans[plan.id] = false;
		await this.persist();
	}

	async snapshot(catalog: ProviderCatalog): Promise<{ providers: Record<string, ProviderConfiguration>; plans: Record<string, boolean>; hasSecrets: Record<string, boolean> }> {
		const refs = [
			...catalog.providers.map(provider => providerKey(provider.service, provider.id)),
			...catalog.providers.flatMap(provider => (provider.secretFields ?? []).map(field => `${providerKey(provider.service, provider.id)}.${field.id}`)),
			...catalog.tokenPlans.map(plan => `plan:${plan.id}`),
		];
		const presence = await Promise.all(refs.map(ref => this.hasSecret(ref)));
		return {
			providers: { ...this.state.providers },
			plans: { ...this.state.plans },
			hasSecrets: Object.fromEntries(refs.map((ref, index) => [ref, presence[index]])),
		};
	}

	private async persist(): Promise<void> {
		await this.context.globalState.update(stateKey, this.state);
	}

	private async deleteSecrets(key: string, extraFields?: CatalogProvider['secretFields']): Promise<void> {
		await this.context.secrets.delete(secretPrefix + key);
		for (const field of extraFields ?? []) await this.context.secrets.delete(secretPrefix + `${key}.${field.id}`);
	}
}

function isAllowedBaseUrl(value: string): boolean {
	try {
		const url = new URL(value);
		return url.protocol === 'http:' || url.protocol === 'https:';
	} catch {
		return false;
	}
}
