import type { ICapabilityBinding, ICapabilityRequest, ProviderCapability } from '../api';
import { CapabilityUnavailableError } from '../api';
import type { CatalogModel, CatalogProvider, ProviderCatalog } from '../catalog/catalog';
import type { ActiveProviderBinding, CapabilityDefault } from '../store/store';
import { supportedRealtimeProtocol, supportedTextProtocol } from './protocols';

/** Maps catalog services to the capabilities they can serve (spec 02 P2-FR-051). */
export function capabilitiesOf(service: string, model: CatalogModel | undefined, protocol: string | undefined): ProviderCapability[] {
	switch (service) {
		case 'llm':
			return supportedTextProtocol(protocol) ? (model?.capabilities?.vision ? ['text', 'imageUnderstanding'] : ['text']) : [];
		case 'asr':
			return ['asr'];
		case 'tts':
			return ['tts'];
		case 'realtime':
			return supportedRealtimeProtocol(protocol) ? ['realtimeVoice'] : [];
		default:
			return [];
	}
}

export interface IBindingInputs {
	readonly catalog: ProviderCatalog;
	readonly active: readonly ActiveProviderBinding[];
	readonly hasSecret: (ref: string) => boolean;
	readonly defaults: Readonly<Record<string, CapabilityDefault>>;
}

/** Pure computation of every binding for every capability; unit-tested without VS Code. */
export function computeBindings(inputs: IBindingInputs): Map<ProviderCapability, ICapabilityBinding[]> {
	const result = new Map<ProviderCapability, ICapabilityBinding[]>();
	for (const active of inputs.active) {
		const provider = inputs.catalog.providers.find(candidate => candidate.service === active.service && candidate.id === active.providerId);
		const plan = active.source === 'plan' ? inputs.catalog.tokenPlans.find(candidate => candidate.id === active.sourceId) : undefined;
		const requiresApiKey = active.source === 'plan' || provider?.requiresApiKey === true;
		const ownerName = plan?.name || provider?.name || active.providerId;
		for (const modelId of active.modelIds) {
			const model = provider?.models?.find(candidate => candidate.id === modelId) || { id: modelId, name: modelId };
			for (const capability of capabilitiesOf(active.service, model, active.protocol)) {
				const isDefault = matchesDefault(inputs.defaults[capability], active, modelId);
				const list = result.get(capability) ?? [];
				list.push({
					capability,
					providerId: active.providerId,
					providerName: ownerName,
					modelId,
					modelName: model.name,
					protocol: active.protocol ?? 'openai',
					baseUrl: active.baseUrl,
					secretRef: active.secretRef,
					requiresApiKey,
					features: featuresOf(capability, provider, model),
					isDefault,
					source: active.source,
					sourceId: active.sourceId,
				});
				result.set(capability, list);
			}
		}
	}
	for (const list of result.values()) {
		list.sort((a, b) => Number(b.isDefault) - Number(a.isDefault) || a.providerName.localeCompare(b.providerName) || a.modelName.localeCompare(b.modelName));
	}
	return result;
}

function matchesDefault(value: CapabilityDefault | undefined, active: ActiveProviderBinding, modelId: string): boolean {
	return !!value && value.providerId === active.providerId && value.modelId === modelId && value.source === active.source && value.sourceId === active.sourceId;
}

function featuresOf(capability: ProviderCapability, provider: CatalogProvider | undefined, model: CatalogModel): Record<string, boolean | readonly string[] | number> {
	switch (capability) {
		case 'text':
			return { streaming: model.capabilities?.streaming !== false, tools: model.capabilities?.tools === true, contextWindow: model.contextWindow ?? 0 };
		case 'imageUnderstanding':
			return { streaming: true };
		case 'asr':
		case 'tts':
			return { languages: provider?.supportedLanguages ?? [], streaming: false };
		case 'realtimeVoice':
			return { duplex: true, streaming: true };
	}
}

/** Picks the binding for a request or explains why none fits (P2-FR-053). */
export function chooseBinding(request: ICapabilityRequest, bindings: readonly ICapabilityBinding[], hasSecret: (ref: string) => boolean, enabled: boolean): ICapabilityBinding {
	if (!enabled) {
		throw new CapabilityUnavailableError(request.capability, 'disabled', []);
	}
	const candidates = bindings.filter(binding => binding.capability === request.capability);
	if (!candidates.length) {
		throw new CapabilityUnavailableError(request.capability, 'noProvider', []);
	}
	const usable = candidates.filter(binding => !binding.requiresApiKey || hasSecret(binding.secretRef));
	if (!usable.length) {
		throw new CapabilityUnavailableError(request.capability, 'missingCredential', candidates.map(binding => binding.providerId));
	}
	const requirements = request.requires ?? {};
	const satisfies = usable.filter(binding => {
		if (requirements.streaming && binding.features.streaming === false) { return false; }
		if (requirements.tools && binding.features.tools !== true) { return false; }
		if (requirements.duplex && binding.features.duplex !== true) { return false; }
		if (requirements.languages?.length) {
			const languages = binding.features.languages;
			if (Array.isArray(languages) && languages.length && !requirements.languages.some(language => languages.some(candidate => String(candidate).toLowerCase().startsWith(language.toLowerCase().split('-')[0])))) {
				return false;
			}
		}
		return true;
	});
	if (!satisfies.length) {
		throw new CapabilityUnavailableError(request.capability, 'unsupportedRequirement', usable.map(binding => binding.providerId));
	}
	return satisfies.find(binding => binding.providerId === request.preferredProviderId && (!request.preferredModelId || binding.modelId === request.preferredModelId))
		?? satisfies.find(binding => binding.isDefault)
		?? satisfies[0];
}
