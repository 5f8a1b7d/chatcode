import type { CatalogProvider, ProviderCatalog, TokenPlan } from '../catalog/catalog';
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

/** One capability's default binding as chosen in the Provider Manager (P2-FR-052). */
export interface CapabilityDefault {
	providerId: string;
	modelId: string;
	source: 'direct' | 'plan';
	sourceId: string;
}

interface SavedStateV1 {
	version: 1;
	providers: Record<string, ProviderConfiguration>;
	plans: Record<string, boolean>;
	customProviders: CatalogProvider[];
}

interface SavedState {
	version: 2;
	providers: Record<string, ProviderConfiguration>;
	plans: Record<string, boolean>;
	customProviders: CatalogProvider[];
	capabilityDefaults: Record<string, CapabilityDefault>;
}

/** Legacy key written by the Study Buddy extension; imported once and kept as a read fallback. */
export const legacyStateKey = 'customProviders.state.v1';
export const stateKey = 'latent.provider.state.v2';
/** Secret keys are unchanged so migrated secrets keep working (spec 02 §6.3). */
export const secretPrefix = 'customProviders.secret.v1.';

const supportedLlmProtocols = ['openai', 'azure', 'anthropic', 'google'];
const supportedRealtimeProtocols = ['openai-realtime', 'gemini-live', 'moshi', 'personaplex', 'nemotron-voicechat'];

export class ProviderStore {
	private state: SavedState;

	constructor(private readonly context: ProviderStoragePort) {
		const saved = context.globalState.get<SavedState | SavedStateV1>(stateKey) ?? context.globalState.get<SavedStateV1>(legacyStateKey);
		this.state = upgradeState(saved);
	}

	/** Imports a v1 blob (for example copied from the Study Buddy extension by the workbench migration). */
	async importLegacyState(saved: unknown): Promise<boolean> {
		if (!isSavedStateV1(saved)) {
			return false;
		}
		const upgraded = upgradeState(saved);
		this.state = {
			...this.state,
			providers: { ...upgraded.providers, ...this.state.providers },
			plans: { ...upgraded.plans, ...this.state.plans },
			customProviders: [...upgraded.customProviders.filter(candidate => !this.state.customProviders.some(existing => existing.id === candidate.id)), ...this.state.customProviders],
		};
		await this.persist();
		return true;
	}

	getCapabilityDefault(capability: string): CapabilityDefault | undefined {
		return this.state.capabilityDefaults[capability];
	}

	async setCapabilityDefault(capability: string, value: CapabilityDefault | undefined): Promise<void> {
		if (value) {
			this.state.capabilityDefaults[capability] = value;
		} else {
			delete this.state.capabilityDefaults[capability];
		}
		await this.persist();
	}

	getCapabilityDefaults(): Readonly<Record<string, CapabilityDefault>> {
		return this.state.capabilityDefaults;
	}

	getCustomProviders(): readonly CatalogProvider[] {
		return this.state.customProviders;
	}

	async addCustomProvider(input: Pick<CatalogProvider, 'category' | 'service' | 'name' | 'type' | 'defaultBaseUrl' | 'requiresApiKey'>, modelId?: string, secret?: string): Promise<CatalogProvider> {
		if (!input.name?.trim() || input.name.length > 100) throw new Error('Enter a provider name under 100 characters.');
		if (input.defaultBaseUrl && !isAllowedBaseUrl(input.defaultBaseUrl)) throw new Error('Enter an HTTP, HTTPS, or WSS Base URL.');
		if (input.service === 'llm' && !supportedLlmProtocols.includes(input.type || '')) throw new Error('Unsupported LLM protocol.');
		if (input.service === 'realtime' && !supportedRealtimeProtocols.includes(input.type || '')) throw new Error('Unsupported realtime protocol.');
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
			throw new Error('Base URL must be an HTTP, HTTPS, or WSS URL.');
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
		const safeFields = Object.fromEntries(Object.entries(config.fields ?? {}).filter(([name, value]) => ['region', 'resourceId', 'aspectRatio', 'style', 'duration', 'resolution', 'voiceId', 'instructions', 'format', 'speed', 'language', 'backend', 'source_webSearch', 'source_baike', 'source_scholar'].includes(name) && typeof value === 'string' && value.length <= 500));
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

	async snapshot(catalog: ProviderCatalog): Promise<{ providers: Record<string, ProviderConfiguration>; plans: Record<string, boolean>; hasSecrets: Record<string, boolean>; capabilityDefaults: Record<string, CapabilityDefault> }> {
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
			capabilityDefaults: { ...this.state.capabilityDefaults },
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
		return url.protocol === 'http:' || url.protocol === 'https:' || url.protocol === 'wss:' || (url.protocol === 'ws:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname));
	} catch {
		return false;
	}
}

function isSavedStateV1(value: unknown): value is SavedStateV1 {
	return typeof value === 'object' && value !== null && (value as SavedStateV1).version === 1 && typeof (value as SavedStateV1).providers === 'object';
}

function upgradeState(saved: SavedState | SavedStateV1 | undefined): SavedState {
	if (saved?.version === 2) {
		return { ...saved, customProviders: saved.customProviders ?? [], capabilityDefaults: saved.capabilityDefaults ?? {} };
	}
	if (saved?.version === 1) {
		return { version: 2, providers: { ...saved.providers }, plans: { ...saved.plans }, customProviders: [...(saved.customProviders ?? [])], capabilityDefaults: {} };
	}
	return { version: 2, providers: {}, plans: {}, customProviders: [], capabilityDefaults: {} };
}
