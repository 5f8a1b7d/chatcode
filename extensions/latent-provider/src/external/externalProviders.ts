import type { IExternalProvider, ProviderCapability } from '../api';
import type { CatalogProvider, ServiceId } from '../catalog/catalog';
import type { ActiveProviderBinding } from '../store/store';

/** Secret references of external providers resolve through the declaring extension, never the secret store. */
export const externalSecretPrefix = 'external:';

const serviceOf: Record<ProviderCapability, ServiceId> = {
	text: 'llm',
	imageUnderstanding: 'llm',
	asr: 'asr',
	tts: 'tts',
	realtimeVoice: 'realtime',
};

const defaultProtocol: Record<ServiceId, string | undefined> = {
	llm: 'openai',
	asr: 'openai',
	tts: 'openai',
	realtime: 'openai-realtime',
	image: undefined,
	video: undefined,
	pdf: undefined,
	'media-parse': undefined,
	'web-search': undefined,
};

function protocolFor(provider: IExternalProvider, service: ServiceId): string | undefined {
	const capability = (Object.keys(serviceOf) as ProviderCapability[]).find(candidate => serviceOf[candidate] === service && provider.protocols?.[candidate]);
	return capability ? provider.protocols![capability] : defaultProtocol[service];
}

function servicesOf(provider: IExternalProvider): ServiceId[] {
	return [...new Set(provider.models.flatMap(model => model.capabilities.map(capability => serviceOf[capability])))];
}

/** Validates a registration; throws with a user-presentable reason. Pure so tests can load it. */
export function validateExternalProvider(provider: IExternalProvider): void {
	if (!/^[a-z0-9][a-z0-9._-]{0,63}$/i.test(provider.id)) {
		throw new Error(`Invalid external provider id ${provider.id}.`);
	}
	let url: URL;
	try {
		url = new URL(provider.baseUrl);
	} catch {
		throw new Error(`External provider ${provider.id} has an invalid base URL.`);
	}
	if (url.protocol !== 'https:' && url.protocol !== 'http:') {
		throw new Error(`External provider ${provider.id} must use an HTTP or HTTPS base URL.`);
	}
	for (const model of provider.models) {
		if (!model.id || !Array.isArray(model.capabilities)) {
			throw new Error(`External provider ${provider.id} declares an invalid model.`);
		}
	}
}

/** Catalog entries (one per service) so names, models, and vision flags resolve like catalog providers. */
export function externalCatalogProviders(provider: IExternalProvider): CatalogProvider[] {
	return servicesOf(provider).map(service => ({
		id: provider.id,
		service,
		category: 'external',
		name: provider.name,
		...(protocolFor(provider, service) ? { type: protocolFor(provider, service) } : {}),
		defaultBaseUrl: provider.baseUrl,
		requiresApiKey: true,
		models: provider.models.filter(model => model.capabilities.some(capability => serviceOf[capability] === service)).map(model => ({
			id: model.id,
			name: model.name,
			...(model.contextWindow ? { contextWindow: model.contextWindow } : {}),
			...(model.outputWindow ? { outputWindow: model.outputWindow } : {}),
			capabilities: { streaming: true, tools: model.tools === true, vision: model.capabilities.includes('imageUnderstanding') },
		})),
	}));
}

export function externalActiveBindings(provider: IExternalProvider): ActiveProviderBinding[] {
	return externalCatalogProviders(provider).map(entry => ({
		service: entry.service,
		providerId: provider.id,
		source: 'direct' as const,
		sourceId: provider.id,
		baseUrl: provider.baseUrl,
		secretRef: `${externalSecretPrefix}${provider.id}`,
		modelIds: (entry.models ?? []).map(model => model.id),
		...(entry.type ? { protocol: entry.type } : {}),
	}));
}
