import * as assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { IExternalProvider } from '../api';
import { computeBindings } from '../capabilities/bindings';
import type { ProviderCatalog } from '../catalog/catalog';
import { externalActiveBindings, externalCatalogProviders, validateExternalProvider } from '../external/externalProviders';

const provider: IExternalProvider = {
	id: 'org',
	name: 'Organization',
	baseUrl: 'https://models.example/v1',
	models: [
		{ id: 'chat-large', name: 'Chat Large', capabilities: ['text', 'imageUnderstanding'], contextWindow: 200000, tools: true },
		{ id: 'speech', name: 'Speech', capabilities: ['asr'] },
		{ id: 'voice', name: 'Voice', capabilities: ['realtimeVoice'] },
	],
	getCredential: async () => 'token',
};

describe('external providers (latentProviderCapabilities)', () => {
	test('maps models to one catalog entry per service and to capability bindings', () => {
		const catalog: ProviderCatalog = { schemaVersion: 1, categories: [], providerGroups: [], providers: externalCatalogProviders(provider), tokenPlans: [] };
		const matrix = computeBindings({ catalog, active: externalActiveBindings(provider), hasSecret: () => true, defaults: {} });
		assert.deepStrictEqual({
			services: catalog.providers.map(entry => `${entry.service}:${entry.type}:${(entry.models ?? []).map(model => model.id).join(',')}`),
			bindings: [...matrix].map(([capability, list]) => `${capability}=${list.map(binding => `${binding.providerName}/${binding.modelId}/${binding.protocol}/${binding.secretRef}/${binding.requiresApiKey}`).join(',')}`),
		}, {
			services: ['llm:openai:chat-large', 'asr:openai:speech', 'realtime:openai-realtime:voice'],
			bindings: [
				'text=Organization/chat-large/openai/external:org/true',
				'imageUnderstanding=Organization/chat-large/openai/external:org/true',
				'asr=Organization/speech/openai/external:org/true',
				'realtimeVoice=Organization/voice/openai-realtime/external:org/true',
			],
		});
	});

	test('rejects invalid registrations', () => {
		const reasons: string[] = [];
		for (const candidate of [{ ...provider, id: 'bad id' }, { ...provider, baseUrl: 'ftp://x' }, { ...provider, baseUrl: 'nope' }]) {
			try {
				validateExternalProvider(candidate);
				reasons.push('ok');
			} catch (error) {
				reasons.push((error as Error).message);
			}
		}
		assert.deepStrictEqual(reasons, ['Invalid external provider id bad id.', 'External provider org must use an HTTP or HTTPS base URL.', 'External provider org has an invalid base URL.']);
	});
});
